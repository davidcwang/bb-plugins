// bb-plugin-jira — frontend.
//
// The Jira sidebar page has four tabs, each its own sub-path so back/forward
// work: My issues (assigned to you), Project (every issue in the source),
// Create, and Source (site, credentials, projects, Kanban sync). The sidebar
// entry shows how many open issues are assigned to you as of the last sync.
// The plugin's Settings page adds a connection check below the settings form.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Issue, IssueDetail, JiraConfig, Scope, SyncState, rpcContract } from "./server";

const CHANGED = "jira-changed";
const PANEL = "issues";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Tab = "mine" | "project" | "create" | "source";

const TABS: Array<{ id: Tab; title: string; icon: string }> = [
  { id: "mine", title: "My issues", icon: "User" },
  { id: "project", title: "Project", icon: "List" },
  { id: "create", title: "Create", icon: "Plus" },
  { id: "source", title: "Source", icon: "Settings" },
];

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Opens an issue. BB's in-app browser is usually not signed in to Jira, so by
 * default a `_blank` window hands the URL to the system browser instead.
 */
function useOpen(): (url: string) => void {
  const { values } = useSettings();
  const navigate = useBbNavigate();
  const external = values?.openInBrowser !== false;
  return useCallback(
    (url: string) => {
      if (!external || window.open(url, "_blank", "noopener,noreferrer") === null) navigate.openUrl(url);
    },
    [external, navigate],
  );
}

function useConfig(): { config: JiraConfig | null; refetch: () => void } {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<JiraConfig | null>(null);
  const refetch = useCallback(() => {
    rpc.call("config_get", null).then(setConfig, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  return { config, refetch };
}

function useSync(): SyncState | null {
  const rpc = useRpc<typeof rpcContract>();
  const [sync, setSync] = useState<SyncState | null>(null);
  const refetch = useCallback(() => {
    rpc.call("sync_get", null).then(setSync, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, refetch);
  return sync;
}

const connected = (config: JiraConfig) =>
  config.siteUrl !== null && config.email !== null && config.hasToken;

function ago(iso: string | null): string {
  if (iso === null) return "never";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground";
const buttonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-50";
const primaryClass =
  "inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50";

function categoryTone(issue: Issue): string {
  switch (issue.category) {
    case "done":
      return "bg-muted text-muted-foreground";
    case "indeterminate":
      return "bg-primary/15 text-foreground";
    default:
      return "bg-accent text-foreground";
  }
}

// ---- issue lists -------------------------------------------------------------

function IssueRow({ issue, rpc }: { issue: Issue; rpc: Rpc }) {
  const openUrl = useOpen();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || detail !== null) return;
    rpc.call("issue_get", { key: issue.key }).then(setDetail, (cause) => setError(message(cause)));
  }, [open, detail, issue.key, rpc]);

  return (
    <li className="rounded-lg border border-border bg-card text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-start gap-3 p-3 text-left hover:bg-accent"
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.key}</span>
            <span className="min-w-0 break-words text-foreground">{issue.summary}</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className={`rounded px-1.5 py-0.5 ${categoryTone(issue)}`}>{issue.status}</span>
            <span>{issue.type}</span>
            {issue.priority === null ? null : <span>{issue.priority}</span>}
            <span>{issue.assignee ?? "unassigned"}</span>
            <span className="ml-auto">updated {ago(issue.updated)}</span>
          </span>
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          {error !== null ? (
            <p className="text-destructive">{error}</p>
          ) : detail === null ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Reported by {detail.reporter ?? "unknown"} · created {ago(detail.created)}
              </p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-foreground">
                {detail.description === "" ? "No description." : detail.description}
              </pre>
            </>
          )}
          <div>
            <button type="button" className={buttonClass} onClick={() => openUrl(issue.url)}>
              <Icon name="ExternalLink" className="size-4" />
              Open in Jira
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function IssueList({ scope, config }: { scope: Scope; config: JiraConfig }) {
  const rpc = useRpc<typeof rpcContract>();
  const [project, setProject] = useState("");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    rpc
      .call("issues_list", {
        scope,
        ...(project === "" ? {} : { project }),
        ...(query === "" ? {} : { text: query }),
      })
      .then(
        (result) => setIssues(result.issues),
        (cause) => setError(message(cause)),
      )
      .finally(() => setLoading(false));
  }, [rpc, scope, project, query]);
  useEffect(load, [load]);
  // A create or a source change can change the list.
  useRealtime(CHANGED, (payload) => {
    if (typeof payload === "object" && payload !== null && !("synced" in payload)) load();
  });

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(text.trim());
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Search text or issue key"
          aria-label="Search"
          className={`${inputClass} min-w-48 flex-1`}
        />
        {config.projects.length > 1 ? (
          <select
            aria-label="Project"
            value={project}
            onChange={(event) => setProject(event.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          >
            <option value="">All source projects</option>
            {config.projects.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        ) : null}
        <button type="submit" className={buttonClass} disabled={loading}>
          <Icon name="Search" className="size-4" />
          Search
        </button>
        <button type="button" className={buttonClass} disabled={loading} onClick={load} aria-label="Refresh">
          <Icon name="RefreshCw" className="size-4" />
        </button>
      </form>
      {error !== null ? (
        <p className="rounded-md border border-border p-3 text-sm text-destructive">{error}</p>
      ) : issues === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : issues.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {scope === "mine"
            ? "Nothing assigned to you in the source projects (finished issues show for a week)."
            : "No issues match."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {issues.map((issue) => (
            <IssueRow key={issue.key} issue={issue} rpc={rpc} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- create ----------------------------------------------------------------

function CreateForm({ config, onCreated }: { config: JiraConfig; onCreated: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const openUrl = useOpen();
  const [project, setProject] = useState(config.projects[0] ?? "");
  const [types, setTypes] = useState<Array<{ id: string; name: string }>>([]);
  const [typeId, setTypeId] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [assignToMe, setAssignToMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validProject = /^[A-Z][A-Z0-9_]{0,19}$/.test(project);

  useEffect(() => {
    setTypes([]);
    setTypeId("");
    if (!validProject) return;
    rpc.call("issue_types", { project }).then(
      (list) => {
        setTypes(list);
        setTypeId((list.find((t) => t.name === "Task") ?? list[0])?.id ?? "");
        setError(null);
      },
      (cause) => setError(message(cause)),
    );
  }, [rpc, project, validProject]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await rpc.call("issue_create", { project, typeId, summary, description, assignToMe });
      toast(`Created ${created.key}`, {
        description: summary,
        action: { label: "Open", onClick: () => openUrl(created.url) },
      });
      setSummary("");
      setDescription("");
      onCreated();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Project</span>
          {config.projects.length > 0 ? (
            <select
              value={project}
              onChange={(event) => setProject(event.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              {config.projects.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={project}
              onChange={(event) => setProject(event.target.value.toUpperCase())}
              placeholder="ENG"
              className={`${inputClass} w-28 font-mono`}
            />
          )}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Type</span>
          <select
            value={typeId}
            onChange={(event) => setTypeId(event.target.value)}
            disabled={types.length === 0}
            className="min-w-32 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          >
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Summary</span>
        <input
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          maxLength={255}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Description</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={8}
          placeholder="Plain text. Blank lines separate paragraphs."
          className={inputClass}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={assignToMe} onChange={(event) => setAssignToMe(event.target.checked)} />
        Assign to me{config.syncToKanban ? " (adds it to the Kanban board)" : ""}
      </label>
      {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
      <div>
        <button
          type="submit"
          className={primaryClass}
          disabled={busy || !validProject || typeId === "" || summary.trim() === ""}
        >
          <Icon name="Plus" className="size-4" />
          {busy ? "Creating…" : "Create issue"}
        </button>
      </div>
    </form>
  );
}

// ---- source ------------------------------------------------------------------

function SourceForm({ config, onSaved }: { config: JiraConfig; onSaved: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const sync = useSync();
  const [siteUrl, setSiteUrl] = useState(config.siteUrl ?? "");
  const [email, setEmail] = useState(config.email ?? "");
  const [apiToken, setApiToken] = useState("");
  const [projects, setProjects] = useState<string[]>(config.projects);
  const [projectText, setProjectText] = useState("");
  const [syncToKanban, setSyncToKanban] = useState(config.syncToKanban);
  const [found, setFound] = useState<Array<{ key: string; name: string }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(label);
    setStatus(null);
    try {
      setStatus({ ok: true, text: await action() });
    } catch (cause) {
      setStatus({ ok: false, text: message(cause) });
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      await rpc.call("config_set", {
        siteUrl,
        email,
        ...(apiToken === "" ? {} : { apiToken }),
        projects,
        syncToKanban,
      });
      setApiToken("");
      onSaved();
      const test = await rpc.call("connection_test", null);
      if (test.error !== null) throw new Error(`Saved, but the connection failed: ${test.error}`);
      return `Saved. Connected as ${test.user}.`;
    });

  const addProject = (key: string) => {
    const upper = key.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9_]{0,19}$/.test(upper) && !projects.includes(upper)) setProjects([...projects, upper]);
  };

  return (
    <div className="flex flex-col gap-5">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Jira site</span>
          <input
            value={siteUrl}
            onChange={(event) => setSiteUrl(event.target.value)}
            placeholder="https://acme.atlassian.net"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Atlassian account email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            API token (id.atlassian.com → Security → API tokens)
          </span>
          <input
            type="password"
            autoComplete="off"
            value={apiToken}
            onChange={(event) => setApiToken(event.target.value)}
            placeholder={config.hasToken ? "Stored. Leave empty to keep it." : "Paste a token"}
            className={inputClass}
          />
        </label>

        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1 text-muted-foreground">Projects (none means every project you can see)</legend>
          <div className="flex flex-wrap gap-2">
            {projects.map((key) => (
              <span
                key={key}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 font-mono text-xs"
              >
                {key}
                <button
                  type="button"
                  aria-label={`Remove ${key}`}
                  onClick={() => setProjects(projects.filter((p) => p !== key))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Icon name="X" className="size-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={projectText}
              onChange={(event) => setProjectText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addProject(projectText);
                  setProjectText("");
                }
              }}
              placeholder="Project key, or a name to look up"
              className={`${inputClass} min-w-48 flex-1`}
            />
            <button
              type="button"
              className={buttonClass}
              disabled={projectText.trim() === ""}
              onClick={() => {
                addProject(projectText);
                setProjectText("");
              }}
            >
              Add
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy !== null || !connected(config)}
              title={connected(config) ? undefined : "Save the site, email, and token first"}
              onClick={() =>
                void run("find", async () => {
                  const list = await rpc.call("projects_search", { query: projectText });
                  setFound(list);
                  return `${list.length} project(s) found.`;
                })
              }
            >
              <Icon name="Search" className="size-4" />
              Look up
            </button>
          </div>
          {found === null || found.length === 0 ? null : (
            <ul className="flex max-h-56 flex-col overflow-auto rounded-md border border-border">
              {found.map((p) => (
                <li key={p.key}>
                  <button
                    type="button"
                    disabled={projects.includes(p.key)}
                    onClick={() => addProject(p.key)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                  >
                    <span className="w-20 shrink-0 font-mono text-xs">{p.key}</span>
                    <span className="truncate">{p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={syncToKanban}
            onChange={(event) => setSyncToKanban(event.target.checked)}
          />
          Put issues assigned to me on the Kanban board (every five minutes)
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className={primaryClass}
            disabled={busy !== null || siteUrl.trim() === "" || email.trim() === "" || (!config.hasToken && apiToken === "")}
          >
            {busy === "save" ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy !== null || !connected(config)}
            onClick={() =>
              void run("test", async () => {
                const test = await rpc.call("connection_test", null);
                if (test.error !== null) throw new Error(test.error);
                return `Connected as ${test.user}.`;
              })
            }
          >
            Test connection
          </button>
        </div>
        {status === null ? null : (
          <p className={`text-sm ${status.ok ? "text-foreground" : "text-destructive"}`}>{status.text}</p>
        )}
      </form>

      <section className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
        <h2 className="font-medium text-foreground">Kanban sync</h2>
        <p className="text-muted-foreground">
          {config.syncToKanban
            ? `Last synced ${ago(sync?.at ?? null)}${
                sync?.assigned == null ? "" : `; ${sync.assigned} open issue(s) assigned to you`
              }. Unassigned or finished issues move to Done and drop off after a week.`
            : "Off."}
        </p>
        {sync?.error == null ? null : <p className="text-destructive">{sync.error}</p>}
        <div>
          <button
            type="button"
            className={buttonClass}
            disabled={busy !== null || !config.syncToKanban || !connected(config)}
            onClick={() =>
              void run("sync", async () => {
                const state = await rpc.call("sync_now", null);
                if (state.error !== null) throw new Error(state.error);
                return `Synced; ${state.assigned ?? 0} open issue(s) assigned to you.`;
              })
            }
          >
            <Icon name="RefreshCw" className="size-4" />
            Sync now
          </button>
        </div>
      </section>
    </div>
  );
}

// ---- page, sidebar badge, settings section --------------------------------

function tabFor(subPath: string, config: JiraConfig): Tab {
  const head = subPath.split("/")[0];
  if (head === "project" || head === "create" || head === "source") return head;
  return connected(config) ? "mine" : "source";
}

function JiraPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const { config, refetch } = useConfig();
  if (config === null) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  const tab = tabFor(subPath, config);
  const go = (next: Tab) => navigate.toPluginPanel(PANEL, { subPath: next === "mine" ? "" : next });

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-5">
        <nav className="flex flex-wrap items-center gap-1 border-b border-border pb-2" aria-label="Jira">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => go(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
                tab === t.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon name={t.icon} className="size-4" />
              {t.title}
            </button>
          ))}
          <span className="ml-auto truncate text-xs text-muted-foreground">
            {config.siteUrl === null
              ? "not connected"
              : `${config.siteUrl.replace(/^https?:\/\//, "")} · ${
                  config.projects.length === 0 ? "all projects" : config.projects.join(", ")
                }`}
          </span>
        </nav>
        {tab === "source" ? (
          <SourceForm key={JSON.stringify(config)} config={config} onSaved={refetch} />
        ) : !connected(config) ? (
          <p className="text-sm text-muted-foreground">
            Connect a Jira site on the{" "}
            <button type="button" className="underline" onClick={() => go("source")}>
              Source
            </button>{" "}
            tab first.
          </p>
        ) : tab === "create" ? (
          <CreateForm config={config} onCreated={() => go("mine")} />
        ) : (
          <IssueList key={tab} scope={tab} config={config} />
        )}
      </div>
    </div>
  );
}

function AssignedBadge() {
  const sync = useSync();
  const count = sync?.assigned ?? 0;
  if (count === 0) return null;
  return (
    <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-foreground">
      {count > 99 ? "99+" : count}
    </span>
  );
}

function ConnectionSection() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [result, setResult] = useState<{ user: string | null; error: string | null } | null>(null);
  useEffect(() => {
    rpc.call("connection_test", null).then(setResult, (cause) => setResult({ user: null, error: message(cause) }));
  }, [rpc]);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className={result?.error == null ? "text-foreground" : "text-destructive"}>
        {result === null ? "Checking…" : result.error ?? `Connected as ${result.user}.`}
      </p>
      <div>
        <button
          type="button"
          className={buttonClass}
          onClick={() => navigate.toPluginPanel(PANEL, { subPath: "source" })}
        >
          Open the Source tab
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL,
    title: "Jira",
    icon: "Ticket",
    path: PANEL,
    component: JiraPage,
    experimental_sidebarAccessory: AssignedBadge,
  });
  app.slots.settingsSection({
    id: "connection",
    title: "Connection",
    description: "Checks the site, email, and token above against Jira.",
    component: ConnectionSection,
  });
});
