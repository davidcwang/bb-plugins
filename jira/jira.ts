// Jira Cloud REST v3 client and the pieces of it that are pure enough to test:
// site URL parsing, JQL building, and Atlassian Document Format conversion.
import { z } from "zod";

/** A Jira project key as it appears in issue keys (ABC in ABC-123). */
export const projectKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,19}$/, "Not a Jira project key (e.g. ENG)");

export const issueKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{0,19}-\d+$/, "Not a Jira issue key (e.g. ENG-123)");

/**
 * The site's origin, e.g. https://acme.atlassian.net. Plain http is accepted
 * only for localhost so a local mock server can stand in during testing.
 */
export function parseSiteUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(`Not a URL: ${JSON.stringify(trimmed)}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Jira site URL must use https.");
  }
  return url.origin;
}

/** Parse a comma/space separated project key list, dropping invalid entries. */
export function parseProjects(raw: string | undefined | null): string[] {
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const parsed = projectKeySchema.safeParse(part.toUpperCase());
    if (parsed.success) seen.add(parsed.data);
  }
  return [...seen];
}

/** Quote a value for a JQL string literal. */
export function jqlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export type Scope = "mine" | "project";

/** Days a finished issue stays in "mine" results (and so on the Kanban board). */
export const DONE_DAYS = 7;

export function buildJql(input: { scope: Scope; projects: string[]; text?: string }): string {
  const clauses: string[] = [];
  if (input.projects.length > 0) clauses.push(`project in (${input.projects.join(", ")})`);
  if (input.scope === "mine") {
    clauses.push("assignee = currentUser()");
    clauses.push(`(statusCategory != Done OR statusCategoryChangedDate >= -${DONE_DAYS}d)`);
  }
  const text = input.text?.trim() ?? "";
  if (text !== "") {
    const key = issueKeySchema.safeParse(text);
    clauses.push(
      key.success
        ? `(key = ${key.data} OR text ~ ${jqlString(text)})`
        : `text ~ ${jqlString(text)}`,
    );
  }
  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

// ---- Atlassian Document Format -------------------------------------------

type AdfNode = {
  version?: 1;
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
};

/** Plain text → ADF: blank lines separate paragraphs, single newlines break lines. */
export function textToAdf(text: string): AdfNode {
  const paragraphs = text
    .replaceAll("\r\n", "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return {
    version: 1,
    type: "doc",
    content: paragraphs.map((p) => ({
      type: "paragraph",
      content: p.split("\n").flatMap((line, i): AdfNode[] => [
        ...(i === 0 ? [] : [{ type: "hardBreak" }]),
        ...(line === "" ? [] : [{ type: "text", text: line }]),
      ]),
    })),
  };
}

const BLOCKS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "rule",
  "panel",
  "table",
  "tableRow",
  "mediaSingle",
]);

/** ADF → readable plain text, bounded. Unknown nodes contribute their children. */
export function adfToText(doc: unknown, limit = 20_000): string {
  let out = "";
  const walk = (node: AdfNode, depth: number, inItem: boolean): void => {
    if (out.length > limit) return;
    switch (node.type) {
      case "text":
        out += node.text ?? "";
        return;
      case "hardBreak":
        out += "\n";
        return;
      case "mention":
      case "emoji":
        out += typeof node.attrs?.text === "string" ? node.attrs.text : "";
        return;
      case "inlineCard":
      case "blockCard":
        out += typeof node.attrs?.url === "string" ? node.attrs.url : "";
        return;
      case "listItem":
        out += `${"  ".repeat(Math.max(0, depth - 1))}- `;
        break;
      case "rule":
        out += "---";
        break;
    }
    for (const child of node.content ?? []) {
      walk(
        child,
        node.type === "bulletList" || node.type === "orderedList" ? depth + 1 : depth,
        node.type === "listItem" || (inItem && node.type !== "bulletList" && node.type !== "orderedList"),
      );
    }
    // A list item's paragraph ends its line; the item adds no second break.
    if (node.type === "listItem") return;
    if (BLOCKS.has(node.type)) out += "\n";
    if (!inItem && (node.type === "paragraph" || node.type === "heading")) out += "\n";
  };
  if (typeof doc === "object" && doc !== null) walk(doc as AdfNode, 0, false);
  return out.replace(/\n{3,}/g, "\n\n").trim().slice(0, limit);
}

// ---- REST client -----------------------------------------------------------

export const ISSUE_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "project",
  "updated",
];

const userSchema = z.object({ displayName: z.string() }).nullable().optional();

const issueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().default(""),
    status: z
      .object({
        name: z.string(),
        statusCategory: z.object({ key: z.string() }).optional(),
      })
      .optional(),
    issuetype: z.object({ name: z.string() }).optional(),
    priority: z.object({ name: z.string() }).nullable().optional(),
    assignee: userSchema,
    reporter: userSchema,
    project: z.object({ key: z.string(), name: z.string().optional() }).optional(),
    updated: z.string().optional(),
    created: z.string().optional(),
    description: z.unknown().optional(),
  }),
});

export type Category = "new" | "indeterminate" | "done";

export interface Issue {
  key: string;
  url: string;
  summary: string;
  status: string;
  category: Category;
  type: string;
  priority: string | null;
  assignee: string | null;
  project: string;
  updated: string | null;
}

export interface IssueDetail extends Issue {
  description: string;
  reporter: string | null;
  created: string | null;
}

function category(key: string | undefined): Category {
  return key === "indeterminate" || key === "done" ? key : "new";
}

function toIssue(site: string, raw: z.infer<typeof issueSchema>): Issue {
  const f = raw.fields;
  return {
    key: raw.key,
    url: `${site}/browse/${raw.key}`,
    summary: f.summary === "" ? raw.key : f.summary,
    status: f.status?.name ?? "Unknown",
    category: category(f.status?.statusCategory?.key),
    type: f.issuetype?.name ?? "Issue",
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    project: f.project?.key ?? raw.key.split("-")[0]!,
    updated: f.updated ?? null,
  };
}

const errorBody = z
  .object({
    errorMessages: z.array(z.string()).optional(),
    errors: z.record(z.string(), z.string()).optional(),
    message: z.string().optional(),
  })
  .passthrough();

export class JiraError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface Credentials {
  site: string;
  email: string;
  token: string;
}

export class JiraClient {
  private readonly creds: Credentials;
  constructor(creds: Credentials) {
    this.creds = creds;
  }

  get site(): string {
    return this.creds.site;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const auth = Buffer.from(`${this.creds.email}:${this.creds.token}`).toString("base64");
    const response = await fetch(`${this.creds.site}${path}`, {
      method,
      signal: signal ?? AbortSignal.timeout(20_000),
      headers: {
        accept: "application/json",
        authorization: `Basic ${auth}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "user-agent": "bb-plugin-jira",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      // not JSON; handled below
    }
    if (!response.ok) {
      const parsed = errorBody.safeParse(json);
      const details = parsed.success
        ? [
            ...(parsed.data.errorMessages ?? []),
            ...Object.entries(parsed.data.errors ?? {}).map(([k, v]) => `${k}: ${v}`),
            ...(parsed.data.message === undefined ? [] : [parsed.data.message]),
          ].join("; ")
        : "";
      const hint =
        response.status === 401
          ? " Check the email and API token."
          : response.status === 403
            ? " The account lacks permission for this."
            : "";
      throw new JiraError(
        `Jira ${method} ${path.split("?")[0]} failed: HTTP ${response.status}${
          details === "" ? "" : ` (${details.slice(0, 500)})`
        }.${hint}`,
        response.status,
      );
    }
    return json;
  }

  async myself(signal?: AbortSignal): Promise<{ accountId: string; displayName: string }> {
    return z
      .object({ accountId: z.string(), displayName: z.string() })
      .parse(await this.request("GET", "/rest/api/3/myself", undefined, signal));
  }

  async search(jql: string, max = 50, signal?: AbortSignal): Promise<Issue[]> {
    const page = z.object({
      issues: z.array(issueSchema).default([]),
      nextPageToken: z.string().nullable().optional(),
      isLast: z.boolean().optional(),
    });
    const issues: Issue[] = [];
    let nextPageToken: string | undefined;
    while (issues.length < max) {
      const result = page.parse(
        await this.request(
          "POST",
          "/rest/api/3/search/jql",
          {
            jql,
            fields: ISSUE_FIELDS,
            maxResults: Math.min(100, max - issues.length),
            ...(nextPageToken === undefined ? {} : { nextPageToken }),
          },
          signal,
        ),
      );
      issues.push(...result.issues.map((raw) => toIssue(this.site, raw)));
      if (result.isLast !== false || !result.nextPageToken || result.issues.length === 0) break;
      nextPageToken = result.nextPageToken;
    }
    return issues.slice(0, max);
  }

  async issue(key: string, signal?: AbortSignal): Promise<IssueDetail> {
    const fields = [...ISSUE_FIELDS, "description", "reporter", "created"].join(",");
    const raw = issueSchema.parse(
      await this.request(
        "GET",
        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`,
        undefined,
        signal,
      ),
    );
    return {
      ...toIssue(this.site, raw),
      description: adfToText(raw.fields.description),
      reporter: raw.fields.reporter?.displayName ?? null,
      created: raw.fields.created ?? null,
    };
  }

  async projects(query: string, signal?: AbortSignal): Promise<Array<{ key: string; name: string }>> {
    const params = new URLSearchParams({ maxResults: "50", orderBy: "name" });
    if (query.trim() !== "") params.set("query", query.trim());
    const result = z
      .object({ values: z.array(z.object({ key: z.string(), name: z.string() })).default([]) })
      .parse(await this.request("GET", `/rest/api/3/project/search?${params}`, undefined, signal));
    return result.values;
  }

  async issueTypes(project: string, signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
    const type = z.object({ id: z.string(), name: z.string(), subtask: z.boolean().optional() });
    const result = z
      .object({ issueTypes: z.array(type).optional(), values: z.array(type).optional() })
      .parse(
        await this.request(
          "GET",
          `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes?maxResults=50`,
          undefined,
          signal,
        ),
      );
    // Sub-tasks need a parent issue, which this plugin does not ask for.
    return (result.issueTypes ?? result.values ?? [])
      .filter((t) => t.subtask !== true)
      .map(({ id, name }) => ({ id, name }));
  }

  async create(input: {
    project: string;
    typeId: string;
    summary: string;
    description: string;
    assigneeId: string | null;
  }): Promise<{ key: string; url: string }> {
    const created = z.object({ key: z.string() }).parse(
      await this.request("POST", "/rest/api/3/issue", {
        fields: {
          project: { key: input.project },
          issuetype: { id: input.typeId },
          summary: input.summary,
          ...(input.description.trim() === "" ? {} : { description: textToAdf(input.description) }),
          ...(input.assigneeId === null ? {} : { assignee: { accountId: input.assigneeId } }),
        },
      }),
    );
    return { key: created.key, url: `${this.site}/browse/${created.key}` };
  }
}
