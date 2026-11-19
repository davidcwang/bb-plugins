// The Drafts tab: tickets written in BB that are not in Jira yet. A Draft
// column on the left, and the selected draft's editor on the right. Edits
// autosave to the server; "Create in Jira" files the issue, adds its links,
// and drops the draft.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Avatar, IssueTypeIcon, hashColor } from "./icons";
import type { Draft, DraftFields, JiraConfig, LinkType, User, rpcContract } from "./server";
import { BRAND, ago, buttonClass, inputClass, message, primaryClass, useOpen } from "./ui";

const CHANGED = "jira-changed";
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,19}$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d+$/;

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type IssueType = { id: string; name: string; subtask: boolean };

const fieldsOf = (draft: Draft): DraftFields => ({
  project: draft.project,
  typeId: draft.typeId,
  summary: draft.summary,
  description: draft.description,
  assignee: draft.assignee,
  reporter: draft.reporter,
  labels: draft.labels,
  parent: draft.parent,
  links: draft.links,
});

// ---- the board ---------------------------------------------------------------

export function DraftsBoard({
  config,
  selectedId,
  onSelect,
}: {
  config: JiraConfig;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("drafts_list", null).then(setDrafts, (cause) => setError(message(cause)));
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED, (payload) => {
    if (typeof payload === "object" && payload !== null && ("draft" in payload || "created" in payload)) refetch();
  });

  const create = async () => {
    try {
      const draft = await rpc.call("draft_save", {
        fields: {
          project: config.projects.length === 1 ? config.projects[0]! : null,
          typeId: null,
          summary: "",
          description: "",
          assignee: null,
          reporter: null,
          labels: [],
          parent: null,
          links: [],
        },
      });
      setDrafts((list) => [draft, ...(list ?? [])]);
      onSelect(draft.id);
    } catch (cause) {
      setError(message(cause));
    }
  };

  const selected = drafts?.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(240px,300px)_1fr]">
      <section className="flex min-h-48 flex-col gap-2 rounded-xl border border-border bg-muted/30 p-2">
        <header className="flex items-center gap-2 px-1 pt-1">
          <span className="size-2 rounded-full" style={{ backgroundColor: "#e2a03f" }} />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Draft</h2>
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{drafts?.length ?? 0}</span>
          <button type="button" onClick={() => void create()} className={`${primaryClass} ml-auto px-2 py-1 text-xs`}>
            <Icon name="Plus" className="size-3.5" />
            New draft
          </button>
        </header>
        {error === null ? null : <p className="px-1 text-xs text-destructive">{error}</p>}
        {drafts === null ? (
          <p className="px-1 text-sm text-muted-foreground">Loading…</p>
        ) : drafts.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">
            No drafts. Write a ticket here and create it in Jira when it is ready.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {drafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                active={draft.id === selectedId}
                onOpen={() => onSelect(draft.id)}
              />
            ))}
          </ul>
        )}
      </section>

      {selected === null ? (
        <div className="hidden items-center justify-center rounded-xl border border-dashed border-border p-10 text-sm text-muted-foreground md:flex">
          {selectedId !== null && drafts !== null
            ? "That draft is gone: it was created or deleted."
            : "Select a draft to edit it."}
        </div>
      ) : (
        <DraftEditor
          key={selected.id}
          draft={selected}
          config={config}
          rpc={rpc}
          drafts={drafts ?? []}
          onOpenDraft={onSelect}
          onClose={() => onSelect(null)}
          onSaved={(draft) => setDrafts((list) => list?.map((d) => (d.id === draft.id ? draft : d)) ?? null)}
        />
      )}
    </div>
  );
}

function DraftCard({ draft, active, onOpen }: { draft: Draft; active: boolean; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className={`flex w-full flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-left text-sm shadow-sm transition hover:shadow-md ${
          active ? "border-[#1d7afc] ring-2 ring-[#1d7afc]/25" : "border-border"
        }`}
      >
        <span className={draft.summary.trim() === "" ? "italic text-muted-foreground" : "font-medium text-foreground"}>
          {draft.summary.trim() === "" ? "Untitled draft" : draft.summary}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {draft.project === null ? null : (
            <span className="font-mono font-semibold" style={{ color: hashColor(draft.project) }}>
              {draft.project}
            </span>
          )}
          {draft.labels.slice(0, 3).map((label) => (
            <span key={label} className="rounded bg-muted px-1.5 py-0.5">
              {label}
            </span>
          ))}
          {draft.links.length === 0 ? null : <span>{draft.links.length} link(s)</span>}
          <span className="ml-auto inline-flex items-center gap-1.5">
            {ago(draft.updatedAt)}
            <Avatar name={draft.assignee?.displayName ?? null} className="size-4 text-[8px]" />
          </span>
        </span>
      </button>
    </li>
  );
}

// ---- the editor --------------------------------------------------------------

function DraftEditor({
  draft,
  config,
  rpc,
  drafts,
  onOpenDraft,
  onClose,
  onSaved,
}: {
  draft: Draft;
  config: JiraConfig;
  rpc: Rpc;
  /** Every draft, so links to other drafts can show their current summary. */
  drafts: Draft[];
  onOpenDraft: (id: string) => void;
  onClose: () => void;
  onSaved: (draft: Draft) => void;
}) {
  const openUrl = useOpen();
  const [fields, setFields] = useState<DraftFields>(() => fieldsOf(draft));
  const [saveState, setSaveState] = useState<"saved" | "pending" | "saving" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const [types, setTypes] = useState<IssueType[]>([]);
  /** Fields on the create screen for the chosen project and type; null until known. */
  const [screen, setScreen] = useState<Set<string> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef<DraftFields | null>(null);
  const timer = useRef<number | null>(null);
  // Kept in a ref so flush stays stable and the unmount save runs only once.
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;

  const flush = useCallback(async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    if (next === null) return;
    pending.current = null;
    setSaveState("saving");
    try {
      savedRef.current(await rpc.call("draft_save", { id: draft.id, fields: next }));
      setSaveState(pending.current === null ? "saved" : "pending");
    } catch (cause) {
      setSaveState("error");
      setError(message(cause));
    }
  }, [rpc, draft.id]);

  // Save the last edit when the editor closes or switches drafts.
  useEffect(() => () => void flush(), [flush]);

  const update = (patch: Partial<DraftFields>) => {
    setFields((current) => {
      const next = { ...current, ...patch };
      pending.current = next;
      return next;
    });
    setSaveState("pending");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 600);
  };

  const validProject = fields.project !== null && PROJECT_KEY.test(fields.project);
  useEffect(() => {
    setTypes([]);
    if (!validProject) return;
    rpc.call("issue_types", { project: fields.project!, subtasks: true }).then(setTypes, (cause) => setError(message(cause)));
  }, [rpc, fields.project, validProject]);
  useEffect(() => {
    setScreen(null);
    if (!validProject || fields.typeId === null) return;
    rpc
      .call("create_fields", { project: fields.project!, typeId: fields.typeId })
      .then((ids) => setScreen(new Set(ids)), () => setScreen(null));
  }, [rpc, fields.project, fields.typeId, validProject]);

  const type = types.find((t) => t.id === fields.typeId) ?? null;
  const missing = [
    fields.project === null ? "a project" : null,
    fields.typeId === null ? "an issue type" : null,
    fields.summary.trim() === "" ? "a summary" : null,
    type?.subtask === true && fields.parent === null ? "a parent (sub-tasks need one)" : null,
  ].filter((m): m is string => m !== null);
  /** A field the create screen does not show cannot be set on create. */
  const offScreen = (id: string) => screen !== null && !screen.has(id);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await flush();
      const result = await rpc.call("draft_submit", { id: draft.id });
      toast(`Created ${result.key}`, {
        description: fields.summary,
        action: { label: "Open", onClick: () => openUrl(result.url) },
      });
      for (const warning of result.warnings) toast.warning(warning, { duration: 15_000 });
      onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    pending.current = null;
    try {
      await rpc.call("draft_delete", { id: draft.id });
      onClose();
    } catch (cause) {
      setError(message(cause));
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm md:sticky md:top-0 md:self-start">
      <header className="flex items-center gap-2">
        {type === null ? (
          <Icon name="Layers" className="size-4 text-muted-foreground" />
        ) : (
          <IssueTypeIcon type={type.name} />
        )}
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Draft</span>
        <span className="text-xs text-muted-foreground">
          {saveState === "saving" ? "Saving…" : saveState === "pending" ? "Editing…" : saveState === "error" ? "Not saved" : "Saved"}
        </span>
        <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-muted-foreground hover:text-foreground">
          <Icon name="X" className="size-4" />
        </button>
      </header>

      <input
        value={fields.summary}
        onChange={(event) => update({ summary: event.target.value })}
        maxLength={255}
        placeholder="Summary"
        aria-label="Summary"
        className={`${inputClass} text-base font-medium`}
      />

      <div className="flex flex-wrap gap-4">
        <Field label="Project">
          {config.projects.length > 0 ? (
            <select
              value={fields.project ?? ""}
              onChange={(event) => update({ project: event.target.value === "" ? null : event.target.value, typeId: null })}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="">Pick…</option>
              {config.projects.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={fields.project ?? ""}
              onChange={(event) => {
                const key = event.target.value.toUpperCase();
                update({ project: key === "" ? null : key, typeId: null });
              }}
              placeholder="HSS"
              className={`${inputClass} w-28 font-mono`}
            />
          )}
        </Field>
        <Field label="Type" grow>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Issue type">
            {types.length === 0 ? (
              <span className="py-1.5 text-sm text-muted-foreground">{validProject ? "Loading…" : "Pick a project"}</span>
            ) : (
              types.map((t) => {
                const active = t.id === fields.typeId;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => update({ typeId: t.id })}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm transition ${
                      active
                        ? "border-[#1d7afc] bg-[#1d7afc]/10 font-medium text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <IssueTypeIcon type={t.name} className="size-3.5" />
                    {t.name}
                  </button>
                );
              })
            )}
          </div>
        </Field>
      </div>

      <Field label="Description">
        <textarea
          value={fields.description}
          onChange={(event) => update({ description: event.target.value })}
          rows={18}
          placeholder="Plain text. Blank lines separate paragraphs."
          className={`${inputClass} min-h-[24rem] resize-y leading-relaxed`}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Assignee" note={offScreen("assignee") ? "Not on this project's create screen" : undefined}>
          <UserPicker
            rpc={rpc}
            value={fields.assignee}
            onChange={(assignee) => update({ assignee })}
            project={validProject ? fields.project : null}
            assignable
            disabled={offScreen("assignee")}
            withMe
          />
        </Field>
        <Field label="Reporter" note={offScreen("reporter") ? "Not on this project's create screen" : "Empty means you"}>
          <UserPicker
            rpc={rpc}
            value={fields.reporter}
            onChange={(reporter) => update({ reporter })}
            project={null}
            assignable={false}
            disabled={offScreen("reporter")}
            withMe
          />
        </Field>
      </div>

      <Field label="Labels" note={offScreen("labels") ? "Not on this project's create screen" : undefined}>
        <LabelInput value={fields.labels} onChange={(labels) => update({ labels })} disabled={offScreen("labels")} />
      </Field>

      <Field
        label="Parent"
        note={
          offScreen("parent")
            ? "Not on this project's create screen"
            : type?.subtask === true
              ? "Required for sub-tasks"
              : "An epic, or the parent issue of a sub-task"
        }
      >
        <IssueKeyInput
          rpc={rpc}
          value={fields.parent}
          onChange={(parent) => update({ parent })}
          disabled={offScreen("parent")}
        />
      </Field>

      <Field label="Linked issues" note={offScreen("issuelinks") ? "Added after the issue is created" : undefined}>
        <LinksEditor
          rpc={rpc}
          value={fields.links}
          onChange={(links) => update({ links })}
          drafts={drafts}
          onOpenDraft={onOpenDraft}
        />
      </Field>

      {error === null ? null : (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          className={primaryClass}
          disabled={submitting || missing.length > 0}
          title={missing.length > 0 ? `Needs ${missing.join(", ")}` : undefined}
          onClick={() => void submit()}
        >
          <Icon name="ArrowUpRight" className="size-4" />
          {submitting ? "Creating…" : "Create in Jira"}
        </button>
        {missing.length > 0 ? <span className="text-xs text-muted-foreground">Needs {missing.join(", ")}</span> : null}
        <button
          type="button"
          className={`${buttonClass} ml-auto text-destructive`}
          disabled={submitting}
          onClick={() => void remove()}
        >
          Delete draft
        </button>
      </footer>
    </section>
  );
}

function Field({
  label,
  note,
  grow,
  children,
}: {
  label: string;
  note?: string | undefined;
  grow?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 text-sm ${grow ? "flex-1" : ""}`}>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
      {note === undefined ? null : <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

// ---- pickers -----------------------------------------------------------------

function UserPicker({
  rpc,
  value,
  onChange,
  project,
  assignable,
  disabled,
  withMe,
}: {
  rpc: Rpc;
  value: User | null;
  onChange: (user: User | null) => void;
  project: string | null;
  assignable: boolean;
  disabled: boolean;
  withMe?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null);
      return;
    }
    const handle = window.setTimeout(() => {
      rpc
        .call("users_search", { query: query.trim(), project, assignable })
        .then(setResults, (cause) => setError(message(cause)));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [rpc, query, project, assignable]);

  if (value !== null) {
    return (
      <span className="inline-flex items-center gap-2 rounded-md border border-border px-2 py-1">
        <Avatar name={value.displayName} />
        <span className="min-w-0 flex-1 truncate">{value.displayName}</span>
        <button
          type="button"
          aria-label="Clear"
          disabled={disabled}
          onClick={() => onChange(null)}
          className="text-muted-foreground hover:text-foreground"
        >
          <Icon name="X" className="size-3.5" />
        </button>
      </span>
    );
  }
  return (
    <div className="relative">
      <div className="flex gap-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={disabled ? "Unavailable" : "Search people"}
          disabled={disabled}
          className={inputClass}
        />
        {withMe ? (
          <button
            type="button"
            className={`${buttonClass} shrink-0 px-2 text-xs`}
            disabled={disabled}
            onClick={() => rpc.call("me_get", null).then(onChange, (cause) => setError(message(cause)))}
          >
            Me
          </button>
        ) : null}
      </div>
      {error === null ? null : <span className="text-xs text-destructive">{error}</span>}
      {results === null ? null : (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-popover shadow-lg">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">No one matches.</li>
          ) : (
            results.map((user) => (
              <li key={user.accountId}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(user);
                    setQuery("");
                    setResults(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Avatar name={user.displayName} />
                  {user.displayName}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function LabelInput({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (labels: string[]) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const add = () => {
    // Jira labels cannot contain spaces, so spaces and commas separate labels.
    const next = text.split(/[\s,]+/).filter((l) => l !== "" && !value.includes(l));
    if (next.length > 0) onChange([...value, ...next].slice(0, 50));
    setText("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1">
      {value.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium"
          style={{ color: hashColor(label), backgroundColor: `${hashColor(label)}1f` }}
        >
          {label}
          <button
            type="button"
            aria-label={`Remove ${label}`}
            disabled={disabled}
            onClick={() => onChange(value.filter((l) => l !== label))}
          >
            <Icon name="X" className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "," || event.key === " ") {
            event.preventDefault();
            add();
          } else if (event.key === "Backspace" && text === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={add}
        placeholder={value.length === 0 ? (disabled ? "Unavailable" : "Add labels") : ""}
        className="min-w-24 flex-1 bg-transparent py-0.5 text-sm outline-none"
      />
    </div>
  );
}

/** An issue key field that looks the issue up, so a typo shows before Create. */
function IssueKeyInput({
  rpc,
  value,
  onChange,
  disabled,
}: {
  rpc: Rpc;
  value: string | null;
  onChange: (key: string | null) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value ?? "");
  const [found, setFound] = useState<{ summary: string; type: string } | "missing" | null>(null);

  useEffect(() => {
    setFound(null);
    if (value === null) return;
    let live = true;
    rpc.call("issue_get", { key: value }).then(
      (issue) => live && setFound({ summary: issue.summary, type: issue.type }),
      () => live && setFound("missing"),
    );
    return () => {
      live = false;
    };
  }, [rpc, value]);

  const commit = () => {
    const key = text.trim().toUpperCase();
    if (key === "") onChange(null);
    else if (ISSUE_KEY.test(key)) onChange(key);
  };
  const invalid = text.trim() !== "" && !ISSUE_KEY.test(text.trim().toUpperCase());

  return (
    <div className="flex flex-col gap-1">
      <input
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        placeholder={disabled ? "Unavailable" : "HSS-123"}
        className={`${inputClass} font-mono`}
      />
      {invalid ? (
        <span className="text-xs text-destructive">Not an issue key</span>
      ) : found === "missing" ? (
        <span className="text-xs text-destructive">No issue {value} that you can see</span>
      ) : found === null ? null : (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <IssueTypeIcon type={found.type} className="size-3.5" />
          {found.summary}
        </span>
      )}
    </div>
  );
}

/**
 * A link to another draft. It becomes a real Jira link once both drafts are
 * created, whichever goes first, so show which draft it is by its summary.
 */
function DraftLinkTarget({
  link,
  drafts,
  onOpen,
}: {
  link: DraftFields["links"][number];
  drafts: Draft[];
  onOpen: (id: string) => void;
}) {
  const other = drafts.find((d) => d.id === link.draftId);
  const summary = other?.summary.trim() || link.draftSummary?.trim() || "";
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
      <span
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: "#e2a03f", backgroundColor: "#e2a03f24" }}
        title="Not in Jira yet. The link is added when both tickets are created."
      >
        Draft
      </span>
      {other === undefined ? (
        <span className="truncate text-muted-foreground">
          {/* Gone from the list: created (the link then resolves to its key) or deleted. */}
          {summary === "" ? "A draft that was created or deleted" : `${summary} (created or deleted)`}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(other.id)}
          className="truncate font-semibold text-foreground underline-offset-2 hover:underline"
        >
          {summary === "" ? "Untitled draft" : summary}
        </button>
      )}
    </span>
  );
}

function LinksEditor({
  rpc,
  value,
  onChange,
  drafts,
  onOpenDraft,
}: {
  rpc: Rpc;
  value: DraftFields["links"];
  onChange: (links: DraftFields["links"]) => void;
  drafts: Draft[];
  onOpenDraft: (id: string) => void;
}) {
  const [types, setTypes] = useState<LinkType[]>([]);
  const [relation, setRelation] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("link_types", null).then(
      (list) => {
        setTypes(list);
        const blocks = list.find((t) => t.name === "Blocks") ?? list[0];
        if (blocks !== undefined) setRelation(`outward:${blocks.name}`);
      },
      (cause) => setError(message(cause)),
    );
  }, [rpc]);

  const label = (link: DraftFields["links"][number]) => {
    const t = types.find((x) => x.name === link.type);
    return t === undefined ? `${link.type} (${link.direction})` : link.direction === "outward" ? t.outward : t.inward;
  };

  const add = async () => {
    const upper = key.trim().toUpperCase();
    const [direction, ...rest] = relation.split(":");
    const type = rest.join(":");
    if (!ISSUE_KEY.test(upper) || type === "") {
      setError("Enter an issue key such as HSS-123.");
      return;
    }
    try {
      await rpc.call("issue_get", { key: upper });
    } catch {
      setError(`No issue ${upper} that you can see.`);
      return;
    }
    setError(null);
    const link = { type, direction: direction as "outward" | "inward", key: upper };
    if (!value.some((l) => l.type === link.type && l.direction === link.direction && l.key === link.key)) {
      onChange([...value, link]);
    }
    setKey("");
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 ? null : (
        <ul className="flex flex-col gap-1">
          {value.map((link) => (
            <li
              key={`${link.type}:${link.direction}:${link.key ?? link.draftId}`}
              className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm"
            >
              <span className="rounded px-1.5 py-0.5 text-xs font-medium" style={{ color: BRAND, backgroundColor: `${BRAND}1f` }}>
                {label(link)}
              </span>
              {link.key !== undefined ? (
                <span className="font-mono text-xs font-semibold">{link.key}</span>
              ) : (
                <DraftLinkTarget link={link} drafts={drafts} onOpen={onOpenDraft} />
              )}
              <button
                type="button"
                aria-label="Remove link"
                onClick={() => onChange(value.filter((l) => l !== link))}
                className="ml-auto text-muted-foreground hover:text-foreground"
              >
                <Icon name="X" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={relation}
          onChange={(event) => setRelation(event.target.value)}
          aria-label="Link type"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          {types.flatMap((t) => [
            <option key={`o:${t.name}`} value={`outward:${t.name}`}>
              {t.outward}
            </option>,
            ...(t.inward === t.outward
              ? []
              : [
                  <option key={`i:${t.name}`} value={`inward:${t.name}`}>
                    {t.inward}
                  </option>,
                ]),
          ])}
        </select>
        <input
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void add();
            }
          }}
          placeholder="HSS-123"
          className={`${inputClass} w-32 flex-1 font-mono`}
        />
        <button type="button" className={buttonClass} disabled={key.trim() === ""} onClick={() => void add()}>
          <Icon name="Plus" className="size-4" />
          Link
        </button>
      </div>
      {error === null ? null : <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
