// bb-plugin-code-review — frontend entry.
//
// Registers a "Code review" tab for the thread panel (Changes + Findings) and
// the `::code-review-walkthrough{id="…"}` chat directive. Workspace diffs
// come straight from bb's SDK in the browser; PR diffs, comments, findings,
// and definition lookups go through the plugin server.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Markdown,
  definePluginApp,
  experimental_Diff as Diff,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Comment, Finding, PrFile, PrRef, ReviewState, Walkthrough, rpcContract } from "./server";
import { PRIORITIES, type Priority } from "./shared";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Sdk = ReturnType<typeof useSdk>;

// ---- patch parsing -------------------------------------------------------

export interface DiffLine {
  kind: "context" | "add" | "del" | "hunk";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

/** Parse a unified patch (git or GitHub REST style) for one file into lines. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      inHunk = true;
      out.push({ kind: "hunk", oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      out.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    } else if (raw.startsWith(" ") || raw === "") {
      out.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
    } else if (raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      inHunk = false; // next file's header in a multi-file patch
    }
  }
  return out;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// ---- shared hooks --------------------------------------------------------

interface ThreadContextInfo {
  environmentId: string | null;
  isGit: boolean;
  mergeBaseBranch: string | null;
  workspacePath: string | null;
  definitionsAvailable: boolean;
  pr: PrRef | null;
  kanban: { cardId: string; phase: string | null } | null;
}

function useThreadContext(rpc: Rpc, threadId: string) {
  const [context, setContext] = useState<ThreadContextInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    rpc.call("context_get", { threadId }).then(setContext, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc, threadId]);
  useEffect(reload, [reload]);
  return { context, error, reload };
}

function useComments(rpc: Rpc, threadId: string) {
  const [comments, setComments] = useState<Comment[]>([]);
  const reload = useCallback(() => {
    rpc.call("comments_list", { threadId }).then(setComments, () => undefined);
  }, [rpc, threadId]);
  useEffect(reload, [reload]);
  useRealtime("code-review-changed", reload);
  return { comments, reload };
}

function useReview(rpc: Rpc, threadId: string) {
  const [review, setReview] = useState<ReviewState | null>(null);
  const reload = useCallback(() => {
    rpc.call("review_get", { threadId }).then(setReview, () => undefined);
  }, [rpc, threadId]);
  useEffect(reload, [reload]);
  useRealtime("code-review-changed", reload);
  return { review, reload };
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// ---- diff sources --------------------------------------------------------

type Source =
  | { kind: "workspace"; target: "uncommitted" }
  | { kind: "workspace"; target: "all"; mergeBaseBranch: string }
  | { kind: "pr"; pr: PrRef };

interface FileEntry {
  path: string;
  previousPath: string | null;
  changeKind: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Loaded lazily for large files. */
  patch: string | null;
}

function sourceLabel(source: Source): string {
  if (source.kind === "pr") return `${source.pr.repo}#${source.pr.number}`;
  return source.target === "uncommitted" ? "Uncommitted changes" : `All changes vs ${source.mergeBaseBranch}`;
}

async function loadWorkspaceFiles(sdk: Sdk, environmentId: string, source: Source & { kind: "workspace" }): Promise<{
  files: FileEntry[];
  shortstat: string;
}> {
  const result =
    source.target === "uncommitted"
      ? await sdk.environments.diffFiles({ environmentId, target: "uncommitted" })
      : await sdk.environments.diffFiles({ environmentId, target: "all", mergeBaseBranch: source.mergeBaseBranch });
  if (result.outcome !== "available") {
    throw new Error(result.outcome === "not_applicable" ? result.message : result.failure.message);
  }
  const patches = new Map(result.initialPatches.map((p) => [p.path, p.patch]));
  return {
    shortstat: result.shortstat,
    files: result.files.map((f) => ({
      path: f.path,
      previousPath: f.previousPath,
      changeKind: f.changeKind,
      additions: f.additions,
      deletions: f.deletions,
      binary: f.binary,
      patch: patches.get(f.path) ?? null,
    })),
  };
}

async function loadWorkspacePatch(
  sdk: Sdk,
  environmentId: string,
  source: Source & { kind: "workspace" },
  path: string,
): Promise<string | null> {
  const result = await sdk.environments.diffPatch({
    environmentId,
    paths: [path],
    target:
      source.target === "uncommitted"
        ? { type: "uncommitted" }
        : { type: "all", mergeBaseBranch: source.mergeBaseBranch },
  });
  if (result.outcome !== "available") return null;
  return result.patches[0]?.patch ?? null;
}

// ---- diff view -----------------------------------------------------------

function CommentBubble({
  comment,
  onSave,
  onRemove,
}: {
  comment: Comment;
  onSave: (body: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  return (
    <div
      className={cn(
        "ml-16 my-1 rounded-md border px-3 py-2 text-sm",
        comment.status === "sent" ? "border-border bg-muted/40 text-muted-foreground" : "border-primary/40 bg-primary/5",
      )}
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={3}
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={body.trim() === ""}
              onClick={() => {
                onSave(body.trim());
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <Icon name="MessageSquare" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{comment.body}</span>
          <span className="text-xs">{comment.status === "sent" ? "sent" : "draft"}</span>
          {comment.status === "sent" ? null : (
            <>
              <button type="button" className="text-xs underline" onClick={() => setEditing(true)}>
                edit
              </button>
              <button type="button" className="text-xs underline" onClick={onRemove}>
                delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NewComment({ onSubmit, onCancel }: { onSubmit: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="ml-16 my-1 flex flex-col gap-2 rounded-md border border-primary/40 bg-background p-2">
      <textarea
        ref={ref}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && body.trim() !== "") {
            onSubmit(body.trim());
          }
          if (event.key === "Escape") onCancel();
        }}
        placeholder="Leave a comment for the agent… (⌘⏎ to add)"
        rows={3}
        className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={body.trim() === ""} onClick={() => onSubmit(body.trim())}>
          Add comment
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface DefinitionHit {
  path: string;
  line: number;
  text: string;
}

function DiffView({
  path,
  patch,
  comments,
  sourceKind,
  onAddComment,
  onSaveComment,
  onRemoveComment,
  onLookup,
}: {
  path: string;
  patch: string;
  comments: Comment[];
  sourceKind: "workspace" | "pr";
  onAddComment: (line: number, side: "new" | "old", body: string) => void;
  onSaveComment: (id: string, body: string) => void;
  onRemoveComment: (id: string) => void;
  onLookup: ((symbol: string) => void) | null;
}) {
  const lines = useMemo(() => parsePatch(patch), [patch]);
  const [composing, setComposing] = useState<{ line: number; side: "new" | "old" } | null>(null);
  const byLine = useMemo(() => {
    const map = new Map<string, Comment[]>();
    for (const c of comments) {
      const k = `${c.side}:${c.line}`;
      map.set(k, [...(map.get(k) ?? []), c]);
    }
    return map;
  }, [comments]);

  const lookup = () => {
    if (onLookup === null) return;
    const text = window.getSelection()?.toString().trim() ?? "";
    if (IDENTIFIER.test(text)) onLookup(text);
  };

  return (
    <div className="overflow-x-auto rounded-md border border-border font-mono text-xs leading-5">
      {lines.map((line, index) => {
        if (line.kind === "hunk") {
          return (
            <div key={index} className="bg-muted/60 px-3 py-0.5 text-muted-foreground">
              {line.text}
            </div>
          );
        }
        const side: "new" | "old" = line.kind === "del" ? "old" : "new";
        const number = side === "old" ? line.oldNo! : line.newNo!;
        const attached = byLine.get(`${side}:${number}`) ?? [];
        return (
          <div key={index}>
            <div
              className={cn(
                "group flex min-w-max items-stretch",
                line.kind === "add" && "bg-emerald-500/10",
                line.kind === "del" && "bg-rose-500/10",
              )}
            >
              <span className="w-10 shrink-0 select-none border-r border-border/60 pr-1 text-right text-muted-foreground/70">
                {line.oldNo ?? ""}
              </span>
              <span className="w-10 shrink-0 select-none border-r border-border/60 pr-1 text-right text-muted-foreground/70">
                {line.newNo ?? ""}
              </span>
              <button
                type="button"
                aria-label={`Comment on line ${number}`}
                title="Add a comment"
                onClick={() => setComposing({ line: number, side })}
                className="w-5 shrink-0 select-none text-primary opacity-0 group-hover:opacity-100 focus:opacity-100"
              >
                +
              </button>
              <span
                className={cn(
                  "w-3 shrink-0 select-none",
                  line.kind === "add" && "text-emerald-600",
                  line.kind === "del" && "text-rose-600",
                )}
              >
                {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
              </span>
              <span className="whitespace-pre pr-4" onDoubleClick={lookup}>
                {line.text}
              </span>
            </div>
            {attached.map((c) => (
              <CommentBubble
                key={c.id}
                comment={c}
                onSave={(body) => onSaveComment(c.id, body)}
                onRemove={() => onRemoveComment(c.id)}
              />
            ))}
            {composing !== null && composing.line === number && composing.side === side ? (
              <NewComment
                onSubmit={(body) => {
                  onAddComment(number, side, body);
                  setComposing(null);
                }}
                onCancel={() => setComposing(null)}
              />
            ) : null}
          </div>
        );
      })}
      {lines.length === 0 ? (
        <p className="p-3 text-muted-foreground">
          {sourceKind === "pr" ? "GitHub returned no patch for this file (binary or too large)." : "No hunks."}
        </p>
      ) : null}
    </div>
  );
}

// ---- Changes tab ---------------------------------------------------------

function ChangesTab({
  threadId,
  rpc,
  context,
}: {
  threadId: string;
  rpc: Rpc;
  context: ThreadContextInfo;
}) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { comments, reload: reloadComments } = useComments(rpc, threadId);

  const sources = useMemo<Source[]>(() => {
    const list: Source[] = [];
    if (context.environmentId !== null && context.isGit) {
      list.push({ kind: "workspace", target: "uncommitted" });
      if (context.mergeBaseBranch !== null) {
        list.push({ kind: "workspace", target: "all", mergeBaseBranch: context.mergeBaseBranch });
      }
    }
    if (context.pr !== null) list.push({ kind: "pr", pr: context.pr });
    return list;
  }, [context]);
  const [extraPr, setExtraPr] = useState<PrRef | null>(null);
  const allSources = extraPr === null ? sources : [...sources, { kind: "pr" as const, pr: extraPr }];
  const [sourceIndex, setSourceIndex] = useState(0);
  const source = allSources[sourceIndex] ?? allSources[0] ?? null;

  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [stat, setStat] = useState<string>("");
  const [prMeta, setPrMeta] = useState<{ headSha: string; title: string; state: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [rich, setRich] = useState(false);
  const [prInput, setPrInput] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [hits, setHits] = useState<{ symbol: string; results: DefinitionHit[]; note: string | null } | null>(null);
  const [filesOpen, setFilesOpen] = useState(true);

  const load = useCallback(async () => {
    if (source === null) return;
    setLoadError(null);
    setFiles(null);
    setPrMeta(null);
    try {
      if (source.kind === "workspace") {
        const result = await loadWorkspaceFiles(sdk, context.environmentId!, source);
        setFiles(result.files);
        setStat(result.shortstat);
      } else {
        const result = await rpc.call("pr_files", { repo: source.pr.repo, number: source.pr.number });
        setPrMeta({ headSha: result.headSha, title: result.title, state: result.state });
        setStat(`${result.files.length} files`);
        setFiles(
          result.files.map((f: PrFile) => ({
            path: f.path,
            previousPath: f.previousPath,
            changeKind: f.status,
            additions: f.additions,
            deletions: f.deletions,
            binary: f.patch === null,
            patch: f.patch,
          })),
        );
      }
    } catch (cause) {
      setLoadError(describe(cause));
    }
  }, [source, sdk, rpc, context.environmentId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (files === null) return;
    if (selected === null || !files.some((f) => f.path === selected)) {
      setSelected(files[0]?.path ?? null);
    }
  }, [files, selected]);
  useEffect(() => {
    if (files === null || selected === null || source === null) {
      setPatch(null);
      return;
    }
    const file = files.find((f) => f.path === selected);
    if (file === undefined) return;
    if (file.patch !== null || source.kind === "pr") {
      setPatch(file.patch);
      return;
    }
    let cancelled = false;
    loadWorkspacePatch(sdk, context.environmentId!, source, selected).then(
      (loaded) => {
        if (!cancelled) setPatch(loaded);
      },
      (cause: unknown) => {
        if (!cancelled) setLoadError(describe(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [files, selected, source, sdk, context.environmentId]);

  const sourceKind = source?.kind ?? "workspace";
  const fileComments = comments.filter((c) => c.path === selected && c.source === sourceKind);
  const drafts = comments.filter((c) => c.status === "draft");

  const addComment = (line: number, side: "new" | "old", body: string) => {
    if (selected === null) return;
    rpc
      .call("comments_add", { threadId, path: selected, line, side, body, source: sourceKind })
      .then(reloadComments, (cause: unknown) => toast.error(describe(cause)));
  };
  const sendDrafts = async () => {
    setSending(true);
    try {
      const result = await rpc.call("comments_send", { threadId, note });
      toast.success(`Sent ${result.sent} comment(s) to the agent.`);
      setNote("");
      reloadComments();
    } catch (cause) {
      toast.error(describe(cause));
    } finally {
      setSending(false);
    }
  };
  const addPr = async () => {
    const parsed = await rpc.call("pr_parse", { text: prInput });
    if (parsed === null) {
      toast.error("Enter owner/repo#123 or a pull request URL.");
      return;
    }
    setExtraPr(parsed);
    setSourceIndex(sources.length);
    setPrInput("");
  };
  const lookup = (symbol: string) => {
    rpc.call("definition_find", { threadId, symbol }).then(
      (result) => setHits({ symbol, results: result.results, note: result.note }),
      (cause: unknown) => toast.error(describe(cause)),
    );
  };
  const openAt = (path: string, line: number) => {
    if (context.environmentId === null) return;
    const ok = navigate.experimental_openFilePreview({
      target: { kind: "workspace", environmentId: context.environmentId, path },
      location: { kind: "line", line, column: null },
    });
    if (!ok) toast.error("Could not open the file preview here.");
  };
  const requestWalkthrough = () => {
    rpc.call("walkthrough_request", { threadId }).then(
      () => toast.success("Asked the agent to narrate the changes; watch the chat."),
      (cause: unknown) => toast.error(describe(cause)),
    );
  };

  if (allSources.length === 0) {
    return (
      <div className="flex flex-col gap-3 p-3 text-sm">
        <p className="text-muted-foreground">
          This thread has no git workspace and no linked pull request. Paste a PR to review it here.
        </p>
        <PrPicker value={prInput} onChange={setPrInput} onAdd={addPr} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <select
          aria-label="Diff source"
          value={sourceIndex}
          onChange={(event) => setSourceIndex(Number(event.target.value))}
          className="rounded border border-border bg-background px-2 py-1 text-sm"
        >
          {allSources.map((s, i) => (
            <option key={i} value={i}>
              {sourceLabel(s)}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">{stat}</span>
        <Button size="sm" variant="ghost" onClick={() => void load()} aria-label="Reload">
          <Icon name="RefreshCw" className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" onClick={requestWalkthrough} aria-label="Ask the agent to narrate the changes in chat">
          <Icon name="BookOpen" className="size-4" />
          Narrate
        </Button>
        <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={rich} onChange={(event) => setRich(event.target.checked)} />
          Rich view
        </label>
      </div>
      {prMeta === null ? null : (
        <p className="border-b border-border px-3 py-1 text-xs text-muted-foreground">
          {prMeta.title} · {prMeta.state} · {prMeta.headSha.slice(0, 7)}
        </p>
      )}
      {loadError === null ? null : (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {loadError}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="border-b border-border">
          <button
            type="button"
            className="flex w-full items-center gap-1 px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            onClick={() => setFilesOpen((v) => !v)}
          >
            <Icon name={filesOpen ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
            Files · {files?.length ?? "…"}
          </button>
          {filesOpen && files !== null ? (
            <ul className="max-h-48 overflow-y-auto pb-1">
              {files.map((file) => {
                const count = comments.filter((c) => c.path === file.path && c.source === sourceKind && c.status === "draft").length;
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => setSelected(file.path)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-0.5 text-left text-xs hover:bg-muted/60",
                        selected === file.path && "bg-muted",
                      )}
                    >
                      <span className="w-14 shrink-0 font-mono text-[11px]">
                        <span className="text-emerald-600">+{file.additions}</span>{" "}
                        <span className="text-rose-600">-{file.deletions}</span>
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
                        {file.path}
                      </span>
                      {count > 0 ? (
                        <span className="rounded bg-primary/15 px-1 text-[10px] text-primary">{count}</span>
                      ) : null}
                      <span className="text-muted-foreground">{file.changeKind[0]?.toUpperCase()}</span>
                    </button>
                  </li>
                );
              })}
              {files.length === 0 ? <li className="px-3 py-1 text-xs text-muted-foreground">No changes.</li> : null}
            </ul>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {selected === null ? null : patch === null ? (
            <p className="p-2 text-xs text-muted-foreground">Loading patch…</p>
          ) : rich ? (
            <Diff patch={patch} path={selected} view="unified" />
          ) : (
            <DiffView
              path={selected}
              patch={patch}
              comments={fileComments}
              sourceKind={sourceKind}
              onAddComment={addComment}
              onSaveComment={(id, body) =>
                rpc.call("comments_update", { threadId, id, body }).then(reloadComments, (c: unknown) => toast.error(describe(c)))
              }
              onRemoveComment={(id) =>
                rpc.call("comments_remove", { threadId, id }).then(reloadComments, (c: unknown) => toast.error(describe(c)))
              }
              onLookup={context.definitionsAvailable ? lookup : null}
            />
          )}
          {!rich && context.definitionsAvailable ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Hover a line and press + to comment. Double-click an identifier to find its definition.
            </p>
          ) : null}
        </div>
      </div>
      {hits === null ? null : (
        <div className="max-h-48 overflow-y-auto border-t border-border bg-muted/30 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-medium">
              <span className="font-mono">{hits.symbol}</span>
              {hits.note === null ? "" : ` · ${hits.note}`}
            </span>
            <button type="button" className="ml-auto underline" onClick={() => setHits(null)}>
              close
            </button>
          </div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {hits.results.map((hit) => (
              <li key={`${hit.path}:${hit.line}`}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-2 text-left hover:underline"
                  onClick={() => openAt(hit.path, hit.line)}
                >
                  <span className="shrink-0 font-mono text-primary">
                    {hit.path}:{hit.line}
                  </span>
                  <span className="truncate font-mono text-muted-foreground">{hit.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <PrPicker value={prInput} onChange={setPrInput} onAdd={addPr} compact />
        <span className="ml-auto text-xs text-muted-foreground">
          {drafts.length} draft comment{drafts.length === 1 ? "" : "s"}
        </span>
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Note to the agent (optional)"
          aria-label="Note to the agent"
          className="h-8 w-48 text-xs"
        />
        <Button size="sm" disabled={drafts.length === 0 || sending} onClick={() => void sendDrafts()}>
          <Icon name="Send" className="size-4" />
          Send to agent
        </Button>
      </div>
    </div>
  );
}

function PrPicker({
  value,
  onChange,
  onAdd,
  compact = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void | Promise<void>;
  compact?: boolean;
}) {
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void onAdd();
      }}
    >
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={compact ? "owner/repo#123" : "owner/repo#123 or PR URL"}
        aria-label="Pull request reference"
        className={cn("h-8 text-xs", compact ? "w-40" : "w-72")}
      />
      <Button type="submit" size="sm" variant="outline" disabled={value.trim() === ""}>
        Open PR
      </Button>
    </form>
  );
}

// ---- Findings tab --------------------------------------------------------

const SEVERITY_STYLE: Record<Finding["severity"], string> = {
  high: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  low: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

function FindingCard({
  finding,
  onUpdate,
  onOpen,
}: {
  finding: Finding;
  onUpdate: (patch: { status?: "pending" | "accepted" | "skipped"; priority?: Priority; edited?: string | null }) => void;
  onOpen: ((file: string, line: number) => void) | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(finding.edited ?? finding.body);
  const locked = finding.status === "sent";
  return (
    <li
      className={cn(
        "rounded-md border p-3 text-sm",
        finding.status === "accepted" && "border-emerald-500/40",
        finding.status === "skipped" && "border-border opacity-60",
        finding.status === "sent" && "border-border bg-muted/30",
        finding.status === "pending" && "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium uppercase", SEVERITY_STYLE[finding.severity])}>
          {finding.severity}
        </span>
        <span className="min-w-0 flex-1 font-medium">{finding.title}</span>
        <span className="text-xs text-muted-foreground">{finding.status}</span>
      </div>
      <button
        type="button"
        disabled={onOpen === null || finding.line === null}
        onClick={() => finding.line !== null && onOpen?.(finding.file, finding.line)}
        className="mt-1 font-mono text-xs text-primary disabled:text-muted-foreground"
      >
        {finding.file}
        {finding.line === null ? "" : `:${finding.line}`}
      </button>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={4}
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                onUpdate({ edited: draft.trim() === finding.body ? null : draft.trim() });
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(finding.body);
                onUpdate({ edited: null });
                setEditing(false);
              }}
            >
              Reset to original
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 whitespace-pre-wrap text-sm">
          {finding.edited ?? finding.body}
          {finding.edited !== null ? <span className="ml-1 text-xs text-muted-foreground">(edited)</span> : null}
        </div>
      )}
      {finding.suggestion !== null && !editing ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Suggestion</summary>
          <pre className="mt-1 whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono">{finding.suggestion}</pre>
        </details>
      ) : null}
      {locked ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={finding.status === "accepted" ? "default" : "outline"}
            onClick={() => onUpdate({ status: finding.status === "accepted" ? "pending" : "accepted" })}
          >
            <Icon name="Check" className="size-4" />
            Accept
          </Button>
          <Button
            size="sm"
            variant={finding.status === "skipped" ? "default" : "outline"}
            onClick={() => onUpdate({ status: finding.status === "skipped" ? "pending" : "skipped" })}
          >
            <Icon name="X" className="size-4" />
            Skip
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <Icon name="Pencil" className="size-4" />
            Edit
          </Button>
          <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            Priority
            <select
              value={finding.priority}
              onChange={(event) => onUpdate({ priority: event.target.value as Priority })}
              className="rounded border border-border bg-background px-1 py-0.5 text-xs"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </li>
  );
}

function FindingsTab({ threadId, rpc, context }: { threadId: string; rpc: Rpc; context: ThreadContextInfo }) {
  const navigate = useBbNavigate();
  const { review, reload } = useReview(rpc, threadId);
  const [instructions, setInstructions] = useState("");
  const [source, setSource] = useState<"auto" | "workspace" | "pr">("auto");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [showOld, setShowOld] = useState(false);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (cause) {
      toast.error(`${label}: ${describe(cause)}`);
    } finally {
      setBusy(false);
    }
  };
  const update = (id: string, patch: { status?: "pending" | "accepted" | "skipped"; priority?: Priority; edited?: string | null }) =>
    void act("Update", () => rpc.call("findings_update", { threadId, id, ...patch }));
  const openAt = (file: string, line: number) => {
    if (context.environmentId === null) return;
    navigate.experimental_openFilePreview({
      target: { kind: "workspace", environmentId: context.environmentId, path: file },
      location: { kind: "line", line, column: null },
    });
  };

  if (review === null) return <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  const current = review.findings.filter((f) => f.round === review.round);
  const older = review.findings.filter((f) => f.round !== review.round);
  const pending = current.filter((f) => f.status === "pending").length;
  const accepted = review.findings.filter((f) => f.status === "accepted").length;
  const running = review.status === "running";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Round {review.round}</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-xs",
              running ? "bg-amber-500/15" : review.status === "failed" ? "bg-rose-500/15" : "bg-muted",
            )}
          >
            {running ? "running…" : review.status}
          </span>
          {review.finishedAt === null ? null : (
            <span className="text-xs text-muted-foreground">{new Date(review.finishedAt).toLocaleTimeString()}</span>
          )}
          <select
            aria-label="Review source"
            value={source}
            onChange={(event) => setSource(event.target.value as typeof source)}
            className="ml-auto rounded border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="auto">Auto</option>
            <option value="workspace" disabled={!context.isGit}>
              Workspace
            </option>
            <option value="pr" disabled={context.pr === null}>
              Pull request
            </option>
          </select>
          <Button
            size="sm"
            disabled={busy || running}
            onClick={() =>
              void act("Run review", async () => {
                const result = await rpc.call("review_run", { threadId, source, instructions });
                toast.success(result.started ? "Review round started." : "A round is already running.");
              })
            }
          >
            <Icon name="Play" className="size-4" />
            Run review
          </Button>
        </div>
        <Input
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Focus for this round (optional), e.g. concurrency in the sync path"
          aria-label="Review instructions"
          className="h-8 text-xs"
        />
        {review.error === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            {review.error}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {current.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {running
              ? "The reviewer is reading the changes. Findings appear here as they are reported."
              : review.round === 0
                ? "No review rounds yet. Run one to get findings you can triage before they reach the agent."
                : "This round reported no findings."}
          </p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">{pending} pending</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || pending === 0}
                onClick={() => void act("Accept all", () => rpc.call("findings_bulk", { threadId, status: "accepted", ids: current.filter((f) => f.status === "pending").map((f) => f.id) }))}
              >
                Accept all pending
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || pending === 0}
                onClick={() => void act("Skip all", () => rpc.call("findings_bulk", { threadId, status: "skipped", ids: current.filter((f) => f.status === "pending").map((f) => f.id) }))}
              >
                Skip all pending
              </Button>
            </div>
            <ul className="flex flex-col gap-2">
              {[...current]
                .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority))
                .map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    onUpdate={(patch) => update(finding.id, patch)}
                    onOpen={context.environmentId === null ? null : openAt}
                  />
                ))}
            </ul>
          </>
        )}
        {older.length === 0 ? null : (
          <div className="mt-4">
            <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setShowOld((v) => !v)}>
              {showOld ? "Hide" : "Show"} {older.length} finding(s) from earlier rounds
            </button>
            {showOld ? (
              <ul className="mt-2 flex flex-col gap-2">
                {older.map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    onUpdate={(patch) => update(finding.id, patch)}
                    onOpen={context.environmentId === null ? null : openAt}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <span className="text-xs text-muted-foreground">{accepted} accepted</span>
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Note to the agent (optional)"
          aria-label="Note to the agent"
          className="ml-auto h-8 w-48 text-xs"
        />
        <Button
          size="sm"
          disabled={busy || accepted === 0}
          onClick={() =>
            void act("Send", async () => {
              const result = await rpc.call("findings_send", { threadId, note });
              toast.success(`Sent ${result.sent} finding(s) to the agent.`);
              setNote("");
            })
          }
        >
          <Icon name="Send" className="size-4" />
          Send accepted
        </Button>
      </div>
    </div>
  );
}

// ---- panel ---------------------------------------------------------------

type Tab = "changes" | "findings";

function ReviewPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const rpc = useRpc<typeof rpcContract>();
  const { context, error, reload } = useThreadContext(rpc, threadId);
  const initial = typeof params === "object" && params !== null && (params as { tab?: unknown }).tab === "findings" ? "findings" : "changes";
  const [tab, setTab] = useState<Tab>(initial);
  const { review } = useReview(rpc, threadId);
  const pending = review?.findings.filter((f) => f.status === "pending" && f.round === review.round).length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 pt-1">
        {(
          [
            { id: "changes", title: "Changes", icon: "FileDiff" },
            { id: "findings", title: "Findings", icon: "ListChecks" },
          ] as Array<{ id: Tab; title: string; icon: string }>
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-1 rounded-t px-3 py-1.5 text-sm",
              tab === t.id ? "border-b-2 border-primary font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon name={t.icon} className="size-4" />
            {t.title}
            {t.id === "findings" && pending > 0 ? (
              <span className="rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">{pending}</span>
            ) : null}
          </button>
        ))}
        {context?.kanban ? (
          <span className="ml-auto truncate text-xs text-muted-foreground" title={context.kanban.cardId}>
            Kanban {context.kanban.phase ?? ""}
          </span>
        ) : null}
      </div>
      {error !== null ? (
        <div className="p-3 text-sm text-destructive">
          {error}{" "}
          <button type="button" className="underline" onClick={reload}>
            retry
          </button>
        </div>
      ) : context === null ? (
        <p className="p-3 text-sm text-muted-foreground">Loading…</p>
      ) : tab === "changes" ? (
        <ChangesTab threadId={threadId} rpc={rpc} context={context} />
      ) : (
        <FindingsTab threadId={threadId} rpc={rpc} context={context} />
      )}
    </div>
  );
}

// ---- walkthrough directive ----------------------------------------------

function WalkthroughDirective({
  attributes,
  openWorkspaceFile,
}: {
  attributes: Readonly<Record<string, string>>;
  openWorkspaceFile: ((path: string) => boolean) | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const id = attributes.id ?? "";
  const [walkthrough, setWalkthrough] = useState<Walkthrough | null | undefined>(undefined);
  useEffect(() => {
    if (!/^w_[a-z0-9]+$/.test(id)) {
      setWalkthrough(null);
      return;
    }
    rpc.call("walkthrough_get", { id }).then(setWalkthrough, () => setWalkthrough(null));
  }, [rpc, id]);
  const [open, setOpen] = useState<number | null>(0);

  if (walkthrough === undefined) return <p className="text-sm text-muted-foreground">Loading walkthrough…</p>;
  if (walkthrough === null) return <p className="text-sm text-muted-foreground">Walkthrough not found.</p>;
  return (
    <section className="my-2 rounded-lg border border-border">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="BookOpen" className="size-4 text-muted-foreground" />
        <span className="font-medium">{walkthrough.title}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {walkthrough.groups.length} change set{walkthrough.groups.length === 1 ? "" : "s"}
        </span>
      </header>
      <ol className="divide-y divide-border">
        {walkthrough.groups.map((group, index) => (
          <li key={index}>
            <button
              type="button"
              onClick={() => setOpen(open === index ? null : index)}
              className="flex w-full items-start gap-2 px-3 py-2 text-left"
            >
              <span className="mt-0.5 w-5 shrink-0 text-xs text-muted-foreground">{index + 1}.</span>
              <span className="min-w-0 flex-1 font-medium">{group.title}</span>
              <Icon name={open === index ? "ChevronDown" : "ChevronRight"} className="mt-0.5 size-4 text-muted-foreground" />
            </button>
            {open === index ? (
              <div className="px-3 pb-3 pl-10">
                <Markdown content={group.summary} />
                <ul className="mt-2 flex flex-col gap-2">
                  {group.hunks.map((hunk, h) => (
                    <li key={h}>
                      <div className="flex items-center gap-2 text-xs">
                        <button
                          type="button"
                          disabled={openWorkspaceFile === null}
                          onClick={() => openWorkspaceFile?.(hunk.path)}
                          className="font-mono text-primary disabled:text-muted-foreground"
                        >
                          {hunk.path}
                          {hunk.startLine === null ? "" : `:${hunk.startLine}${hunk.endLine === null ? "" : `-${hunk.endLine}`}`}
                        </button>
                      </div>
                      {hunk.patch === null ? null : <Diff patch={hunk.patch} path={hunk.path} className="mt-1" />}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "review",
    title: "Code review",
    icon: "GitPullRequestArrow",
    layout: "flush",
    component: ReviewPanel,
  });
  app.slots.messageDirective({
    id: "code-review-walkthrough",
    component: WalkthroughDirective,
  });
});
