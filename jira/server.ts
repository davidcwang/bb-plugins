// bb-plugin-jira — backend entry.
//
// Connects one Jira Cloud site (email + API token) and a set of project keys,
// the "source". The page and CLI list and create issues against it; every five
// minutes the issues assigned to you are pushed to the kanban plugin's
// `jira_sync` RPC so they show up as cards. The token never leaves the server.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  JiraClient,
  buildJql,
  issueKeySchema,
  parseProjects,
  parseSiteUrl,
  projectKeySchema,
  type Issue,
  type IssueDetail,
  type Scope,
} from "./jira";

export type { Issue, IssueDetail, Scope };

const scopeSchema = z.enum(["mine", "project"]);

const configSchema = z.object({
  siteUrl: z.string().nullable(),
  email: z.string().nullable(),
  projects: z.array(z.string()),
  /** Whether an API token is stored; the token itself never leaves the server. */
  hasToken: z.boolean(),
  syncToKanban: z.boolean(),
});
export type JiraConfig = z.infer<typeof configSchema>;

const syncStateSchema = z.object({
  at: z.string().nullable(),
  error: z.string().nullable(),
  /** Open (not Done) issues assigned to you at the last sync. */
  assigned: z.number().nullable(),
});
export type SyncState = z.infer<typeof syncStateSchema>;

const issueOut = z.custom<Issue>();
const detailOut = z.custom<IssueDetail>();

export const rpcContract = defineRpcContract({
  config_get: { input: z.null(), output: configSchema },
  config_set: {
    input: z.object({
      siteUrl: z.string().max(200),
      email: z.string().trim().email().max(200),
      /** Omit or leave empty to keep the stored token. */
      apiToken: z.string().max(500).optional(),
      projects: z.array(projectKeySchema).max(20),
      syncToKanban: z.boolean(),
    }),
    output: configSchema,
  },
  connection_test: {
    input: z.null(),
    output: z.object({ user: z.string().nullable(), error: z.string().nullable() }),
  },
  projects_search: {
    input: z.object({ query: z.string().max(100) }),
    output: z.array(z.object({ key: z.string(), name: z.string() })),
  },
  issues_list: {
    input: z.object({
      scope: scopeSchema,
      /** One project; defaults to every source project. */
      project: projectKeySchema.optional(),
      text: z.string().max(200).optional(),
    }),
    output: z.object({ issues: z.array(issueOut), jql: z.string() }),
  },
  issue_get: { input: z.object({ key: issueKeySchema }), output: detailOut },
  issue_types: {
    input: z.object({ project: projectKeySchema }),
    output: z.array(z.object({ id: z.string(), name: z.string() })),
  },
  issue_create: {
    input: z.object({
      project: projectKeySchema,
      typeId: z.string().regex(/^\d+$/),
      summary: z.string().trim().min(1).max(255),
      description: z.string().max(20_000).default(""),
      assignToMe: z.boolean().default(true),
    }),
    output: z.object({ key: z.string(), url: z.string() }),
  },
  sync_get: { input: z.null(), output: syncStateSchema },
  sync_now: { input: z.null(), output: syncStateSchema },
});

export const CHANGED = "jira-changed";
const SYNC_KEY = "sync";
const KANBAN_PLUGIN_ID = "kanban";
/** The kanban plugin caps one sync at 500 cards. */
const MAX_SYNC = 500;
const MAX_CLI_ROWS = 100;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    siteUrl: {
      type: "string",
      label: "Jira site",
      description: "Your Jira Cloud site, e.g. https://acme.atlassian.net.",
      experimental_schema: z.string().refine((value) => {
        if (value.trim() === "") return true;
        try {
          parseSiteUrl(value);
          return true;
        } catch {
          return false;
        }
      }, "Must be an https URL such as https://acme.atlassian.net"),
    },
    email: {
      type: "string",
      label: "Atlassian account email",
      description: "The email you sign in to Jira with; used with the API token.",
    },
    apiToken: {
      type: "string",
      label: "API token",
      description:
        "Create one at id.atlassian.com → Security → API tokens. It acts as you, so the plugin can see and create whatever you can.",
      secret: true,
    },
    projects: {
      type: "string",
      label: "Projects",
      description:
        "Comma-separated project keys (e.g. ENG, OPS) the plugin lists and creates issues in. Empty means every project you can see.",
    },
    syncToKanban: {
      type: "boolean",
      label: "Sync to Kanban",
      description:
        "Every five minutes, put issues assigned to you on the Kanban board (needs the kanban plugin).",
      default: true,
    },
    openInBrowser: {
      type: "boolean",
      label: "Open in system browser",
      description: "Open issues in your browser instead of BB's, which is usually not signed in to Jira.",
      default: true,
    },
  });

  async function readConfig(): Promise<JiraConfig> {
    const values = await settings.get();
    let siteUrl: string | null = null;
    try {
      siteUrl = (values.siteUrl ?? "").trim() === "" ? null : parseSiteUrl(values.siteUrl!);
    } catch {
      // invalid stored value; shown as not configured
    }
    const email = (values.email ?? "").trim();
    return {
      siteUrl,
      email: email === "" ? null : email,
      projects: parseProjects(values.projects),
      hasToken: (values.apiToken ?? "") !== "",
      syncToKanban: values.syncToKanban,
    };
  }

  async function client(): Promise<{ jira: JiraClient; config: JiraConfig }> {
    const config = await readConfig();
    const { apiToken } = await settings.get();
    if (config.siteUrl === null || config.email === null || (apiToken ?? "") === "") {
      throw new Error("Jira is not connected: set the site, email, and API token on the Jira page's Source tab.");
    }
    return {
      jira: new JiraClient({ site: config.siteUrl, email: config.email, token: apiToken! }),
      config,
    };
  }

  // The accountId only changes with the credentials, so cache it per email.
  let me: { email: string; accountId: string; displayName: string } | null = null;
  async function myself(jira: JiraClient, email: string) {
    if (me?.email !== email) me = { email, ...(await jira.myself()) };
    return me;
  }
  settings.onChange(() => {
    me = null;
  });

  // ---- Kanban sync -------------------------------------------------------

  const readSync = async (): Promise<SyncState> =>
    (await bb.storage.kv.get<SyncState>(SYNC_KEY)) ?? { at: null, error: null, assigned: null };

  let syncing: Promise<SyncState> | null = null;
  function syncKanban(): Promise<SyncState> {
    // Overlapping triggers (schedule, save, create) share one run.
    syncing ??= runSync().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  async function runSync(): Promise<SyncState> {
    const previous = await readSync();
    let state: SyncState;
    try {
      const { jira, config } = await client();
      if (!config.syncToKanban) return previous;
      const issues = await jira.search(
        buildJql({ scope: "mine", projects: config.projects }),
        MAX_SYNC,
      );
      try {
        await bb.sdk.plugins.callRpc({
          pluginId: KANBAN_PLUGIN_ID,
          method: "jira_sync",
          input: {
            items: issues.map((issue) => ({
              key: issue.key,
              url: issue.url,
              title: issue.summary.slice(0, 300),
              status: issue.status,
              category: issue.category,
              type: issue.type,
            })),
          },
          outputSchema: z.object({ cards: z.number() }),
        });
      } catch (cause) {
        throw new Error(
          `Kanban sync failed (is the kanban plugin installed and up to date?): ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
      state = { at: new Date().toISOString(), error: null, assigned: issues.filter((issue) => issue.category !== "done").length };
    } catch (cause) {
      state = { ...previous, error: cause instanceof Error ? cause.message : String(cause) };
    }
    await bb.storage.kv.set(SYNC_KEY, state);
    bb.realtime.publish(CHANGED, { synced: true });
    return state;
  }

  bb.background.schedule("sync-kanban", "*/5 * * * *", async () => {
    const { syncToKanban } = await readConfig();
    if (syncToKanban) await syncKanban();
  });

  // ---- operations shared by RPC, CLI, and agent tools ---------------------

  async function listIssues(input: { scope: Scope; project?: string; text?: string }, max = 50) {
    const { jira, config } = await client();
    const jql = buildJql({
      scope: input.scope,
      projects: input.project === undefined ? config.projects : [input.project],
      ...(input.text === undefined ? {} : { text: input.text }),
    });
    return { issues: await jira.search(jql, max), jql };
  }

  async function createIssue(input: {
    project: string;
    typeId?: string;
    typeName?: string;
    summary: string;
    description: string;
    assignToMe: boolean;
  }): Promise<{ key: string; url: string }> {
    const { jira, config } = await client();
    let typeId = input.typeId;
    if (typeId === undefined) {
      const types = await jira.issueTypes(input.project);
      const wanted = (input.typeName ?? "Task").toLowerCase();
      const match = types.find((t) => t.name.toLowerCase() === wanted);
      if (match === undefined) {
        throw new Error(
          `No issue type "${input.typeName ?? "Task"}" in ${input.project}; available: ${types.map((t) => t.name).join(", ")}`,
        );
      }
      typeId = match.id;
    }
    const assigneeId = input.assignToMe
      ? (await myself(jira, config.email!)).accountId
      : null;
    const created = await jira.create({
      project: input.project,
      typeId,
      summary: input.summary,
      description: input.description,
      assigneeId,
    });
    bb.log.info(`created ${created.key}`);
    bb.realtime.publish(CHANGED, { created: created.key });
    if (input.assignToMe && config.syncToKanban) void syncKanban();
    return created;
  }

  // ---- RPC ---------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    config_get: () => readConfig(),
    config_set: async ({ siteUrl, email, apiToken, projects, syncToKanban }) => {
      await settings.experimental_set({
        siteUrl: parseSiteUrl(siteUrl),
        email: email.trim(),
        ...(apiToken === undefined || apiToken.trim() === "" ? {} : { apiToken: apiToken.trim() }),
        projects: projects.length === 0 ? null : [...new Set(projects)].join(", "),
        syncToKanban,
      });
      bb.realtime.publish(CHANGED, { config: true });
      void syncKanban();
      return readConfig();
    },
    connection_test: async () => {
      try {
        const { jira, config } = await client();
        return { user: (await myself(jira, config.email!)).displayName, error: null };
      } catch (cause) {
        return { user: null, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    projects_search: async ({ query }) => (await client()).jira.projects(query),
    issues_list: (input) => listIssues(input),
    issue_get: async ({ key }) => (await client()).jira.issue(key),
    issue_types: async ({ project }) => (await client()).jira.issueTypes(project),
    issue_create: (input) => createIssue(input),
    sync_get: () => readSync(),
    sync_now: () => syncKanban(),
  });

  // ---- CLI ---------------------------------------------------------------

  const line = (issue: Issue) =>
    `${issue.key.padEnd(12)} ${issue.status.slice(0, 14).padEnd(14)} ${(issue.assignee ?? "unassigned").slice(0, 18).padEnd(18)} ${issue.summary}`;
  const cliError = (cause: unknown) =>
    new PluginCliError(cause instanceof Error ? cause.message : String(cause));
  const parseProject = (raw: string | undefined) => {
    if (raw === undefined) return undefined;
    const parsed = projectKeySchema.safeParse(raw.toUpperCase());
    if (!parsed.success) throw new PluginCliError(`"${raw}" is not a Jira project key`);
    return parsed.data;
  };

  bb.cli.register(
    defineCli({
      name: "jira",
      summary: "List, show, and create Jira issues in the configured source",
      commands: {
        status: cliCommand({
          summary: "Show the connected site, projects, and last Kanban sync",
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            const config = await readConfig();
            const sync = await readSync();
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ ...config, sync }) };
            }
            return {
              exitCode: 0,
              stdout: [
                `site:     ${config.siteUrl ?? "(not set)"}`,
                `email:    ${config.email ?? "(not set)"}`,
                `token:    ${config.hasToken ? "set" : "(not set)"}`,
                `projects: ${config.projects.length === 0 ? "(all)" : config.projects.join(", ")}`,
                `kanban:   ${config.syncToKanban ? "sync on" : "sync off"}; last ${sync.at ?? "never"}${
                  sync.assigned === null ? "" : `, ${sync.assigned} open assigned`
                }${sync.error === null ? "" : `\nerror:    ${sync.error}`}`,
              ].join("\n"),
            };
          },
        }),
        list: cliCommand({
          summary: "List issues assigned to you (or every issue in the source with --all)",
          options: {
            all: { type: "boolean", description: "Every issue in the source projects, not only yours" },
            project: { type: "string", description: "Only this project key" },
            search: { type: "string", description: "Text or issue key to search for" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            try {
              const project = parseProject(input.options.project);
              const { issues } = await listIssues(
                {
                  scope: input.options.all ? "project" : "mine",
                  ...(project === undefined ? {} : { project }),
                  ...(input.options.search === undefined ? {} : { text: input.options.search }),
                },
                MAX_CLI_ROWS,
              );
              return input.options.json
                ? { exitCode: 0, stdout: JSON.stringify(issues) }
                : { exitCode: 0, stdout: issues.length === 0 ? "No issues." : issues.map(line).join("\n") };
            } catch (cause) {
              throw cause instanceof PluginCliError ? cause : cliError(cause);
            }
          },
        }),
        show: cliCommand({
          summary: "Show one issue with its description",
          positionals: [{ name: "key", description: "Issue key, e.g. ENG-123", required: true }],
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            const key = issueKeySchema.safeParse(input.positionals.key);
            if (!key.success) throw new PluginCliError(`"${input.positionals.key}" is not an issue key`);
            try {
              const issue = await (await client()).jira.issue(key.data);
              return input.options.json
                ? { exitCode: 0, stdout: JSON.stringify(issue) }
                : {
                    exitCode: 0,
                    stdout: `${issue.key} · ${issue.type} · ${issue.status} · ${issue.assignee ?? "unassigned"}\n${issue.summary}\n${issue.url}\n\n${issue.description.slice(0, 4000) || "(no description)"}`,
                  };
            } catch (cause) {
              throw cliError(cause);
            }
          },
        }),
        create: cliCommand({
          summary: "Create an issue in a source project, assigned to you unless --unassigned",
          positionals: [{ name: "summary", description: "Issue summary (title)", required: true }],
          options: {
            project: { type: "string", description: "Project key; defaults to the only source project" },
            type: { type: "string", description: "Issue type name (default Task)" },
            description: { type: "string", description: "Plain-text description" },
            unassigned: { type: "boolean", description: "Leave the issue unassigned" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            try {
              let project = parseProject(input.options.project);
              if (project === undefined) {
                const { projects } = await readConfig();
                if (projects.length !== 1) {
                  throw new PluginCliError("pass --project", {
                    hint: projects.length === 0
                      ? "No source projects are configured."
                      : `Source projects: ${projects.join(", ")}`,
                  });
                }
                project = projects[0]!;
              }
              const created = await createIssue({
                project,
                ...(input.options.type === undefined ? {} : { typeName: input.options.type }),
                summary: input.positionals.summary,
                description: input.options.description ?? "",
                assignToMe: !input.options.unassigned,
              });
              return {
                exitCode: 0,
                stdout: input.options.json ? JSON.stringify(created) : `${created.key} ${created.url}`,
              };
            } catch (cause) {
              throw cause instanceof PluginCliError ? cause : cliError(cause);
            }
          },
        }),
        sync: cliCommand({
          summary: "Push issues assigned to you to the Kanban board now",
          async run() {
            const state = await syncKanban();
            if (state.error !== null) throw new PluginCliError(state.error);
            return { exitCode: 0, stdout: `Synced to Kanban; ${state.assigned ?? 0} open issue(s) assigned to you.` };
          },
        }),
      },
    }),
  );

  // ---- agent tools -----------------------------------------------------------

  const toolError = (cause: unknown) => ({
    content: [{ type: "text" as const, text: cause instanceof Error ? cause.message : String(cause) }],
    isError: true,
  });

  bb.agents.registerTool({
    name: "jira_search",
    description:
      "Search Jira issues in the configured source projects. scope 'mine' is issues assigned to the user; 'project' is every issue. Returns up to 50 rows: key, status, assignee, summary.",
    parameters: z.object({
      scope: scopeSchema.default("mine"),
      project: projectKeySchema.optional(),
      text: z.string().max(200).optional(),
    }),
    async execute(input) {
      try {
        const { issues } = await listIssues(input);
        return issues.length === 0 ? "No issues." : issues.map(line).join("\n");
      } catch (cause) {
        return toolError(cause);
      }
    },
  });

  bb.agents.registerTool({
    name: "jira_create_issue",
    description:
      "Create a Jira issue in one of the configured source projects. Returns the new key and URL.",
    instructions:
      "Creating an issue is visible to the user's team. Only call this when the user asked for a Jira ticket; confirm the summary and project with them first unless they already gave both.",
    parameters: z.object({
      project: projectKeySchema,
      summary: z.string().trim().min(1).max(255),
      description: z.string().max(20_000).default(""),
      type: z.string().max(50).default("Task"),
      assignToMe: z.boolean().default(true),
    }),
    async execute({ project, summary, description, type, assignToMe }) {
      try {
        const created = await createIssue({ project, typeName: type, summary, description, assignToMe });
        return `${created.key} ${created.url}`;
      } catch (cause) {
        return toolError(cause);
      }
    },
  });

  bb.agents.configure(() => ({ tools: ["jira_search", "jira_create_issue"], skills: ["jira"] }));

  bb.log.info("loaded");
}
