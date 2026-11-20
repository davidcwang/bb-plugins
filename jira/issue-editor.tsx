// Editor for an existing Jira issue, opened from My issues or Project. Same
// fields as a draft; nothing is saved until "Update in Jira", which sends only
// what changed. Fields the issue's edit screen doesn't allow are disabled.
import { useCallback, useEffect, useState } from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Field, IssueKeyInput, LabelInput, LinksEditor, UserPicker } from "./drafts";
import { IssueTypeIcon } from "./icons";
import type { DraftFields, EditableIssue, User, rpcContract } from "./server";
import { buttonClass, inputClass, message, primaryClass, useOpen } from "./ui";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Link = DraftFields["links"][number];

const CATEGORY_COLOR = { new: "#8590a2", indeterminate: "#1d7afc", done: "#22a06b" } as const;

interface Form {
  summary: string;
  description: string;
  assignee: User | null;
  reporter: User | null;
  labels: string[];
  parent: string | null;
  links: Link[];
}

const formOf = (issue: EditableIssue): Form => ({
  summary: issue.summary,
  description: issue.description,
  assignee: issue.assignee,
  reporter: issue.reporter,
  labels: issue.labels,
  parent: issue.parent,
  links: issue.links.map(({ type, direction, key }) => ({ type, direction, key })),
});

const linkSig = (l: { type: string; direction: string; key?: string | undefined }) => `${l.type}|${l.direction}|${l.key ?? ""}`;
const sameUser = (a: User | null, b: User | null) => (a?.accountId ?? null) === (b?.accountId ?? null);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** What the form changes relative to the loaded issue. */
function diff(issue: EditableIssue, form: Form) {
  const changes: {
    summary?: string;
    description?: string;
    assignee?: User | null;
    reporter?: User;
    labels?: string[];
    parent?: string | null;
  } = {};
  if (form.summary.trim() !== issue.summary) changes.summary = form.summary.trim();
  if (form.description !== issue.description) changes.description = form.description;
  if (!sameUser(form.assignee, issue.assignee)) changes.assignee = form.assignee;
  if (!sameUser(form.reporter, issue.reporter) && form.reporter !== null) changes.reporter = form.reporter;
  if (!sameList(form.labels, issue.labels)) changes.labels = form.labels;
  if (form.parent !== issue.parent) changes.parent = form.parent;
  const before = new Map(issue.links.map((l) => [linkSig(l), l.id]));
  const after = new Set(form.links.map(linkSig));
  const addLinks = form.links
    .filter((l) => l.key !== undefined && !before.has(linkSig(l)))
    .map((l) => ({ type: l.type, direction: l.direction, key: l.key! }));
  const removeLinks = [...before].filter(([sig]) => !after.has(sig)).map(([, id]) => id);
  const count = Object.keys(changes).length + addLinks.length + removeLinks.length;
  return { changes, addLinks, removeLinks, count };
}

export function IssueEditor({
  issueKey,
  onClose,
  onDirtyChange,
}: {
  issueKey: string;
  onClose: () => void;
  /** Lets the list ask before switching away from unsaved edits. */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const openUrl = useOpen();
  const [issue, setIssue] = useState<EditableIssue | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  // Bumped on discard so inputs that keep their own text (parent key) reset too.
  const [revision, setRevision] = useState(0);

  const load = useCallback(() => {
    setError(null);
    setStale(false);
    rpc.call("issue_edit_get", { key: issueKey }).then(
      (loaded) => {
        setIssue(loaded);
        setForm(formOf(loaded));
      },
      (cause) => setError(message(cause)),
    );
  }, [rpc, issueKey]);
  useEffect(load, [load]);

  const pending = issue === null || form === null ? null : diff(issue, form);
  const dirty = (pending?.count ?? 0) > 0;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  if (issue === null || form === null) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 text-sm shadow-sm">
        {error === null ? <span className="text-muted-foreground">Loading {issueKey}…</span> : <span className="text-destructive">{error}</span>}
      </section>
    );
  }

  const update = (patch: Partial<Form>) => setForm((current) => (current === null ? current : { ...current, ...patch }));
  const allowed = (field: string) => issue.editable.includes(field);
  const locked = (field: string) => (allowed(field) ? undefined : "Not on this issue's edit screen");

  const save = async () => {
    if (pending === null || pending.count === 0) return;
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.call("issue_edit_save", {
        key: issue.key,
        baseUpdated: issue.updated,
        changes: pending.changes,
        addLinks: pending.addLinks,
        removeLinks: pending.removeLinks,
      });
      setIssue(result.issue);
      setForm(formOf(result.issue));
      toast(`Updated ${issue.key}`, { action: { label: "Open", onClick: () => openUrl(issue.url) } });
      for (const warning of result.warnings) toast.warning(warning, { duration: 15_000 });
    } catch (cause) {
      const text = message(cause);
      setError(text);
      setStale(text.includes("changed in Jira after you opened it"));
    } finally {
      setSaving(false);
    }
  };

  const color = CATEGORY_COLOR[issue.category];
  const descriptionChanged = form.description !== issue.description;

  return (
    <section
      key={`${issue.updated}:${revision}`}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 shadow-sm md:sticky md:top-0 md:self-start"
    >
      <header className="flex flex-wrap items-center gap-2">
        <IssueTypeIcon type={issue.type} />
        <button
          type="button"
          onClick={() => openUrl(issue.url)}
          className="font-mono text-sm font-semibold text-[#1d7afc] underline-offset-2 hover:underline"
        >
          {issue.key}
        </button>
        <span
          className="rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
          style={{ color, backgroundColor: `${color}26` }}
        >
          {issue.status}
        </span>
        <span className="text-xs text-muted-foreground">{issue.type}</span>
        <span className="text-xs text-muted-foreground">{dirty ? `${pending!.count} unsaved change(s)` : "No changes"}</span>
        <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-muted-foreground hover:text-foreground">
          <Icon name="X" className="size-4" />
        </button>
      </header>

      <input
        value={form.summary}
        onChange={(event) => update({ summary: event.target.value })}
        maxLength={255}
        disabled={!allowed("summary")}
        aria-label="Summary"
        className={`${inputClass} text-base font-medium`}
      />

      <Field label="Description" note={locked("description")}>
        {issue.lossy.length > 0 ? (
          <p
            className="rounded-md border px-3 py-2 text-xs"
            style={{ borderColor: "#e2a03f66", backgroundColor: "#e2a03f14", color: "#e2a03f" }}
          >
            This description has content the editor can't keep: {issue.lossy.join(", ")}. Leave the description
            alone and that content stays; edit it and Update replaces it with what you see here. Other fields are safe
            to edit.
          </p>
        ) : null}
        <textarea
          value={form.description}
          onChange={(event) => update({ description: event.target.value })}
          rows={24}
          disabled={!allowed("description")}
          placeholder="Markdown: headings, lists, code blocks, tables, and links become Jira formatting."
          className={`${inputClass} min-h-[32rem] resize-y leading-relaxed`}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Assignee" note={locked("assignee")}>
          <UserPicker
            rpc={rpc}
            value={form.assignee}
            onChange={(assignee) => update({ assignee })}
            project={issue.project}
            assignable
            disabled={!allowed("assignee")}
            withMe
          />
        </Field>
        <Field label="Reporter" note={locked("reporter")}>
          <UserPicker
            rpc={rpc}
            value={form.reporter}
            onChange={(reporter) => update({ reporter })}
            project={null}
            assignable={false}
            disabled={!allowed("reporter")}
            withMe
          />
        </Field>
      </div>

      <Field label="Labels" note={locked("labels")}>
        <LabelInput value={form.labels} onChange={(labels) => update({ labels })} disabled={!allowed("labels")} />
      </Field>

      <Field label="Parent" note={locked("parent") ?? "An epic, or the parent issue of a sub-task"}>
        <IssueKeyInput rpc={rpc} value={form.parent} onChange={(parent) => update({ parent })} disabled={!allowed("parent")} />
      </Field>

      <Field label="Linked issues">
        <LinksEditor rpc={rpc} value={form.links} onChange={(links) => update({ links })} drafts={[]} onOpenDraft={() => undefined} />
      </Field>

      {error === null ? null : (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1">{error}</span>
          {stale ? (
            <button type="button" className={`${buttonClass} shrink-0 text-xs`} onClick={load}>
              Reload (discards your edits)
            </button>
          ) : null}
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          className={primaryClass}
          disabled={!dirty || saving || form.summary.trim() === ""}
          onClick={() => void save()}
        >
          <Icon name="ArrowUpRight" className="size-4" />
          {saving ? "Updating…" : "Update in Jira"}
        </button>
        {descriptionChanged && issue.lossy.length > 0 ? (
          <span className="text-xs" style={{ color: "#e2a03f" }}>
            Updating replaces the description, dropping {issue.lossy.join(", ")}.
          </span>
        ) : null}
        <button
          type="button"
          className={`${buttonClass} ml-auto`}
          disabled={!dirty || saving}
          onClick={() => {
            setForm(formOf(issue));
            setRevision((r) => r + 1);
          }}
        >
          Discard changes
        </button>
      </footer>
    </section>
  );
}
