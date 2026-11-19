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
import { Avatar, IssueTypeIcon, PriorityIcon, TicketGlyph, hashColor } from "./icons";
import type { Issue, IssueDetail, JiraConfig, Scope, SyncState, rpcContract } from "./server";

const CHANGED = "jira-changed";
const PANEL = "issues";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Tab = "mine" | "project" | "create" | "source";

const TABS: Array<{ id: Tab; title: string; icon: string }> = [
  { id: "mine", title: "My issues", icon: "UserRound" },
  { id: "project", title: "Project", icon: "ListTodo" },
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

/** Jira's blue, used for the plugin's accents. */
const BRAND = "#1d7afc";

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-[#1d7afc] focus:ring-2 focus:ring-[#1d7afc]/25";
const buttonClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground transition-colors hover:border-[#1d7afc]/60 hover:bg-[#1d7afc]/10 disabled:opacity-50";
const primaryClass =
  "inline-flex items-center gap-1.5 rounded-md bg-[#1d7afc] px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#0c66e4] disabled:opacity-50";

/** Jira's status-category colors: gray to do, blue in progress, green done. */
const CATEGORY: Record<Issue["category"], { label: string; color: string }> = {
  new: { label: "To do", color: "#8590a2" },
  indeterminate: { label: "In progress", color: "#1d7afc" },
  done: { label: "Done", color: "#22a06b" },
};

function StatusPill({ issue }: { issue: Issue }) {
  const { color } = CATEGORY[issue.category];
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
      style={{ color, backgroundColor: `${color}26` }}
    >
      {issue.status}
    </span>
  );
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
    <li
      className="overflow-hidden rounded-lg border border-border border-l-[3px] bg-card text-sm shadow-sm transition hover:shadow-md"
      style={{ borderLeftColor: CATEGORY[issue.category].color }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-start gap-3 p-3 text-left transition-colors hover:bg-[#1d7afc]/5"
      >
        <IssueTypeIcon type={issue.type} className="mt-0.5 size-4" />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className="shrink-0 font-mono text-xs font-semibold"
              style={{ color: hashColor(issue.project) }}
            >
              {issue.key}
            </span>
            <span
              className={`min-w-0 break-words font-medium ${
                issue.category === "done" ? "text-muted-foreground line-through" : "text-foreground"
              }`}
            >
              {issue.summary}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
            <StatusPill issue={issue} />
            <span>{issue.type}</span>
            {issue.priority === null ? null : (
              <span className="inline-flex items-center gap-1">
                <PriorityIcon priority={issue.priority} className="size-3.5" />
                {issue.priority}
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-2">
              updated {ago(issue.updated)}
              <Avatar name={issue.assignee} />
            </span>
          </span>
        </span>
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-border bg-muted/30 p-3 pl-10">
          {error !== null ? (
            <p className="text-destructive">{error}</p>
          ) : detail === null ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Avatar name={detail.reporter} className="size-4 text-[8px]" />
                Reported by {detail.reporter ?? "unknown"} · created {ago(detail.created)}
              </p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-foreground">
                {detail.description === "" ? "No description." : detail.description}
              </pre>
            </>
          )}
          <div>
            <button type="button" className={primaryClass} onClick={() => openUrl(issue.url)}>
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
  const [only, setOnly] = useState<Issue["category"] | null>(null);

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

  const shown = issues?.filter((issue) => only === null || issue.category === only) ?? null;

  return (
    <div className="flex flex-col gap-3">
      {issues === null || issues.length === 0 ? null : (
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(CATEGORY) as Array<Issue["category"]>).map((cat) => {
            const { label, color } = CATEGORY[cat];
            const count = issues.filter((issue) => issue.category === cat).length;
            const active = only === cat;
            return (
              <button
                key={cat}
                type="button"
                aria-pressed={active}
                onClick={() => setOnly(active ? null : cat)}
                className="flex flex-col items-start rounded-lg border px-3 py-2 text-left transition hover:shadow-sm"
                style={{
                  borderColor: active ? color : `${color}40`,
                  backgroundColor: active ? `${color}26` : `${color}0f`,
                }}
              >
                <span className="text-2xl font-semibold leading-none" style={{ color }}>
                  {count}
                </span>
                <span className="mt-1 text-xs text-muted-foreground">
                  {label}
                  {cat === "done" && scope === "mine" ? " (7 days)" : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
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
          <Icon name="RotateCcw" className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </form>
      {scope === "project" && config.projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No source projects set, so this shows issues updated in the last 90 days across every
          project. Add projects on the Source tab to narrow it.
        </p>
      ) : null}
      {error !== null ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : shown === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {scope === "mine"
            ? "Nothing assigned to you in the source projects (finished issues show for a week)."
            : "No issues match."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((issue) => (
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
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm"
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
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Type</span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Issue type">
            {types.length === 0 ? (
              <span className="py-1.5 text-muted-foreground">{validProject ? "Loading…" : "Pick a project"}</span>
            ) : (
              types.map((type) => {
                const active = type.id === typeId;
                return (
                  <button
                    key={type.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTypeId(type.id)}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition ${
                      active
                        ? "border-[#1d7afc] bg-[#1d7afc]/10 font-medium text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <IssueTypeIcon type={type.name} />
                    {type.name}
                  </button>
                );
              })
            )}
          </div>
        </div>
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
        className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className="flex items-center gap-2 font-medium text-foreground">
          <Icon name="Settings" className="size-4" style={{ color: BRAND }} />
          Connection and projects
        </h2>
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
                className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs font-semibold"
                style={{ color: hashColor(key), borderColor: `${hashColor(key)}66`, backgroundColor: `${hashColor(key)}1a` }}
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
          <p className={`text-sm ${status.ok ? "text-[#22a06b]" : "text-destructive"}`}>{status.text}</p>
        )}
      </form>

      <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-sm shadow-sm">
        <h2 className="flex items-center gap-2 font-medium text-foreground">
          <Icon name="RotateCcw" className="size-4" style={{ color: BRAND }} />
          Kanban sync
        </h2>
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
        <header
          className="flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-white shadow-sm"
          style={{ background: `linear-gradient(120deg, ${BRAND} 0%, #0055cc 55%, #6e5dc6 100%)` }}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/15">
            <TicketGlyph className="size-5" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">
              {config.siteUrl === null ? "Not connected" : config.siteUrl.replace(/^https?:\/\//, "")}
            </span>
            <span className="text-xs text-white/75">
              {connected(config) ? "Connected" : "Set up the source to get started"}
            </span>
          </span>
          <span className="ml-auto flex flex-wrap gap-1.5">
            {(config.projects.length === 0 ? ["All projects"] : config.projects).map((key) => (
              <span key={key} className="rounded-md bg-white/15 px-2 py-0.5 font-mono text-xs font-medium">
                {key}
              </span>
            ))}
          </span>
        </header>
        <nav className="flex flex-wrap items-center gap-1 border-b border-border" aria-label="Jira">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => go(t.id)}
                aria-current={active ? "page" : undefined}
                className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
                  active
                    ? "border-[#1d7afc] font-medium text-[#1d7afc]"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon name={t.icon} className="size-4" />
                {t.title}
              </button>
            );
          })}
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
    <span className="rounded-full bg-[#1d7afc] px-1.5 text-xs font-medium text-white">
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
  // BB's icon set has no ticket; kanban's Jira cards use this name too.
  app.experimental_icons.register({ name: "jira.ticket", component: TicketGlyph });
  app.slots.navPanel({
    id: PANEL,
    title: "Jira",
    icon: "jira.ticket",
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
