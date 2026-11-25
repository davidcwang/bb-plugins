// bb-plugin-github-prs — frontend: a "Pull Requests" sidebar page.
//
// Root: your open PRs (server search query). A PR opens a GitHub-like view —
// Overview / Files / Comments — where each review thread carries triage state,
// an AI-draftable reply you edit and post, reactions, resolve, and a proposed
// fix you can preview as a diff and apply to the local checkout.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_Diff as Diff,
  experimental_SourceCode as SourceCode,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useCodeTheme as useCodeTheme,
  Markdown,
  ThreadChat,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { PatchDiff } from "@pierre/diffs/react";
import type { rpcContract } from "./server";
import {
  CHANGED,
  REACTIONS,
  REACTION_EMOJI,
  emptyItem,
  prKey,
  type Finding,
  type FindingRef,
  commentTarget,
  describeTarget,
  type IssueComment,
  type ItemState,
  type PrDetail,
  type PrFile,
  type PrRef,
  type PrSummary,
  type ReactionGroup,
  type Reaction,
  type ReviewThread,
  type Triage,
  type Priority,
  PRIORITY_RANK,
  type RunModel,
  type Walkthrough,
  type WorkerModel,
} from "./shared";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Split a possibly multi-file unified patch into per-file patches for <Diff>. */
function splitPatch(patch: string): Array<{ path: string; patch: string }> {
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p.trim() !== "");
  if (parts.length === 0) return [];
  if (parts.length === 1 && !parts[0].startsWith("diff --git")) {
    return [{ path: "patch", patch: parts[0] }];
  }
  return parts.map((p) => {
    const m = p.match(/^diff --git a\/(.+?) b\//);
    return { path: m?.[1] ?? "patch", patch: p };
  });
}

function Chip({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "good" | "bad" | "warn" | "accent" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone === "muted" && "border-border text-muted-foreground",
        tone === "good" && "border-green-600/40 text-green-600 dark:text-green-400",
        tone === "bad" && "border-destructive/40 text-destructive",
        tone === "warn" && "border-yellow-600/40 text-yellow-600 dark:text-yellow-400",
        tone === "accent" && "border-primary/40 text-primary",
      )}
    >
      {children}
    </span>
  );
}

function checksChip(state: string | null): ReactNode {
  if (state === null) return null;
  const tone = state === "SUCCESS" ? "good" : state === "PENDING" || state === "EXPECTED" ? "warn" : "bad";
  return <Chip tone={tone}>checks {state.toLowerCase()}</Chip>;
}

function decisionChip(decision: string | null): ReactNode {
  if (decision === null) return null;
  const tone = decision === "APPROVED" ? "good" : decision === "CHANGES_REQUESTED" ? "bad" : "warn";
  return <Chip tone={tone}>{decision.toLowerCase().replace("_", " ")}</Chip>;
}

function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon name="Loader" className="size-3.5 animate-spin" />
      {label}
    </span>
  );
}

/** Non-blocking freshness indicator: GitHub data refreshes in the background. */
function SyncBadge({ syncing, fetchedAt }: { syncing: boolean; fetchedAt: string | null }) {
  return syncing ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-yellow-600/40 px-2 py-0.5 text-[11px] text-yellow-600 dark:text-yellow-400">
      <Icon name="RefreshCw" className="size-3 animate-spin" /> syncing
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
      <Icon name="Check" className="size-3" /> synced{fetchedAt === null ? "" : ` ${ago(fetchedAt)}`}
    </span>
  );
}

// ---------------------------------------------------------------- stacks

/**
 * Group PRs into stacks: a PR whose base branch is another listed PR's head
 * branch sits on top of it. Each block is one stack ordered bottom-first
 * (the review order); standalone PRs are single-element blocks. Blocks keep
 * the recency order of their most recently updated member.
 */
function stackBlocks(prs: PrSummary[]): PrSummary[][] {
  const key = (p: PrSummary) => prKey(p);
  const byHead = new Map(prs.map((p) => [`${p.owner}/${p.repo}:${p.headRefName}`, p]));
  const parentOf = (p: PrSummary): PrSummary | undefined => {
    const par = byHead.get(`${p.owner}/${p.repo}:${p.baseRefName}`);
    return par !== undefined && key(par) !== key(p) ? par : undefined;
  };
  const rootOf = (p: PrSummary): PrSummary => {
    const seen = new Set([key(p)]);
    let cur = p;
    for (;;) {
      const par = parentOf(cur);
      if (par === undefined || seen.has(key(par))) return cur;
      seen.add(key(par));
      cur = par;
    }
  };
  const depthOf = (p: PrSummary): number => {
    const seen = new Set([key(p)]);
    let cur = p;
    let d = 0;
    for (;;) {
      const par = parentOf(cur);
      if (par === undefined || seen.has(key(par))) return d;
      d += 1;
      seen.add(key(par));
      cur = par;
    }
  };
  const groups = new Map<string, PrSummary[]>();
  for (const p of prs) {
    const r = key(rootOf(p));
    groups.set(r, [...(groups.get(r) ?? []), p]);
  }
  const blocks: PrSummary[][] = [];
  const emitted = new Set<string>();
  for (const p of prs) {
    const r = key(rootOf(p));
    if (emitted.has(r)) continue;
    emitted.add(r);
    blocks.push([...(groups.get(r) ?? [p])].sort((a, b) => depthOf(a) - depthOf(b)));
  }
  return blocks;
}

// ---------------------------------------------------------------- PR list

function PrListPage({ onOpen }: { onOpen: (ref: PrRef) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [prs, setPrs] = useState<PrSummary[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [listTab, setListTab] = useState<"mine" | "review">(() =>
    window.localStorage.getItem("ghpr:listTab") === "review" ? "review" : "mine",
  );
  const mine = (prs ?? []).filter((p) => p.role !== "reviewer");
  const toReview = (prs ?? []).filter((p) => p.role === "reviewer");
  const load = useCallback(
    (refresh: boolean) => {
      if (refresh) setSyncing(true);
      rpc
        .call("prs_list", { refresh })
        .then((r) => {
          setPrs(r.prs);
          setFetchedAt(r.fetchedAt);
          setSyncing(r.syncing);
          setError(r.error);
        })
        .catch((cause) => {
          setSyncing(false);
          setError(describe(cause));
        });
    },
    [rpc],
  );
  useEffect(() => load(false), [load]);
  useRealtime(CHANGED, (payload: unknown) => {
    const p = payload as { kind?: string; message?: string };
    if (p?.kind === "list") load(false);
    else if (p?.kind === "list-error") {
      setSyncing(false);
      setError(p.message ?? "Background refresh failed.");
    }
  });
  return (
    <div className="mx-auto w-full max-w-3xl space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {prs === null ? "Loading…" : `${prs.length} open PR${prs.length === 1 ? "" : "s"}`}
        </p>
        <div className="flex items-center gap-2">
          <SyncBadge syncing={syncing} fetchedAt={fetchedAt} />
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={syncing}>
            <Icon name="RefreshCw" className="size-3.5" />
            Refresh
          </Button>
        </div>
      </div>
      {error !== null && (
        <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-1 border-b border-border">
        {(
          [
            ["mine", "My PRs", mine.length],
            ["review", "Needs review", toReview.length],
          ] as Array<["mine" | "review", string, number]>
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setListTab(id);
              window.localStorage.setItem("ghpr:listTab", id);
            }}
            className={cn(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm transition-colors",
              listTab === id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {count > 0 && <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{count}</span>}
          </button>
        ))}
      </div>
      {prs !== null && (listTab === "mine" ? mine : toReview).length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {listTab === "mine" ? "No open PRs match the search query (plugin settings)." : "Nothing waiting on your review."}
        </div>
      )}
      <div className="space-y-2">
        {stackBlocks(listTab === "mine" ? mine : toReview).map((block) =>
          block.length === 1 ? (
            <PrRows key={prKey(block[0])} prs={block} onOpen={onOpen} />
          ) : (
            <div key={prKey(block[0])} className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-2">
              <p className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
                <Icon name="Layers" className="size-3.5" />
                Stack of {block.length} — review in this order
              </p>
              <PrRows prs={block} onOpen={onOpen} numbered />
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function PrRows({ prs, onOpen, numbered = false }: { prs: PrSummary[]; onOpen: (ref: PrRef) => void; numbered?: boolean }) {
  return (
      <ul className="space-y-2">
        {prs.map((pr, i) => (
          <li key={prKey(pr)} className={cn(numbered && "flex items-start gap-2")}>
            {numbered && (
              <span className="mt-3 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                {i + 1}
              </span>
            )}
            <button
              type="button"
              onClick={() => onOpen(pr)}
              className="w-full min-w-0 flex-1 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{pr.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-mono">
                      {pr.owner}/{pr.repo}#{pr.number}
                    </span>
                    <span className="font-mono">
                      {pr.headRefName} → {pr.baseRefName}
                    </span>
                    <span>updated {ago(pr.updatedAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <div className="flex items-center gap-1.5">
                    {pr.isDraft && <Chip>draft</Chip>}
                    {decisionChip(pr.reviewDecision)}
                    {checksChip(pr.checksState)}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="text-green-600 dark:text-green-400">+{pr.additions}</span>
                    <span className="text-destructive">−{pr.deletions}</span>
                    {pr.unresolvedThreads > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Icon name="MessageSquare" className="size-3.5" />
                        {pr.unresolvedThreads}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
  );
}

// ---------------------------------------------------------- shared pieces

function ReactionBar({
  groups,
  busy,
  onToggle,
}: {
  groups: ReactionGroup[];
  busy: boolean;
  onToggle: (content: Reaction, on: boolean) => void;
}) {
  const [picking, setPicking] = useState(false);
  const have = new Map(groups.map((g) => [g.content, g]));
  return (
    <div className="flex flex-wrap items-center gap-1">
      {groups.map((g) => (
        <button
          key={g.content}
          type="button"
          disabled={busy}
          onClick={() => onToggle(g.content, !g.viewerReacted)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors",
            g.viewerReacted ? "border-primary/50 bg-primary/10" : "border-border hover:border-primary/40",
          )}
          title={g.viewerReacted ? "Remove your reaction" : "React"}
        >
          <span>{REACTION_EMOJI[g.content]}</span>
          <span className="text-muted-foreground">{g.count}</span>
        </button>
      ))}
      {picking ? (
        <span className="inline-flex items-center gap-0.5 rounded-full border border-border px-1 py-0.5">
          {REACTIONS.filter((r) => !have.get(r)?.viewerReacted).map((r) => (
            <button
              key={r}
              type="button"
              disabled={busy}
              className="rounded px-0.5 text-sm hover:bg-accent"
              onClick={() => {
                setPicking(false);
                onToggle(r, true);
              }}
            >
              {REACTION_EMOJI[r]}
            </button>
          ))}
          <button type="button" className="px-1 text-xs text-muted-foreground" onClick={() => setPicking(false)}>
            ×
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setPicking(true)}
          className="rounded-full border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:border-primary/40"
          title="Add reaction"
        >
          <Icon name="Smile" className="size-3.5" />
        </button>
      )}
    </div>
  );
}

const TRIAGE_LABEL: Record<Triage, string> = {
  pending: "Pending",
  address: "Address",
  "wont-fix": "Won't fix",
  done: "Done",
};
const TRIAGE_ICON: Record<Triage, string> = {
  pending: "Circle",
  address: "CircleDot",
  "wont-fix": "CircleX",
  done: "CircleCheck",
};

function TriageControl({ value, onChange }: { value: Triage; onChange: (t: Triage) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border">
      {(Object.keys(TRIAGE_LABEL) as Triage[]).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          className={cn(
            "inline-flex items-center gap-1 px-2 py-1 text-[11px] transition-colors",
            value === t
              ? t === "address"
                ? "bg-primary/15 text-primary"
                : t === "done"
                  ? "bg-green-600/15 text-green-600 dark:text-green-400"
                  : t === "wont-fix"
                    ? "bg-muted text-foreground"
                    : "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-accent",
          )}
        >
          <Icon name={TRIAGE_ICON[t]} className="size-3" />
          {TRIAGE_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

function Textarea({
  value,
  onChange,
  onBlur,
  placeholder,
  rows = 4,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      rows={rows}
      className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/50"
    />
  );
}

/** Reply drafting + posting + fix proposal for one item (review thread or issue comment). */
function ItemWorkbench({
  rpc,
  refObj,
  item,
  state,
  replyTo,
  resolveId,
  canFix,
  onChanged,
  onError,
  onDiscuss,
}: {
  rpc: Rpc;
  refObj: PrRef;
  item: string;
  state: ItemState;
  /** REST comment id to reply to; null = top-level issue comment. */
  replyTo: number | null;
  /** GraphQL thread id to resolve on "Post & resolve"; null hides that button. */
  resolveId: string | null;
  canFix: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
  /** Opens this comment's discussion pane (e.g. to revise the proposed fix). */
  onDiscuss?: () => void;
}) {
  const [text, setText] = useState(state.draft ?? "");
  const [guidance, setGuidance] = useState("");
  const [showGuidance, setShowGuidance] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [fixOpen, setFixOpen] = useState(true);
  const lastDraft = useRef(state.draft);
  // Adopt a newly arrived AI draft unless the user has typed something else.
  useEffect(() => {
    if (state.draft !== lastDraft.current) {
      if (text === "" || text === lastDraft.current) setText(state.draft ?? "");
      lastDraft.current = state.draft;
    }
  }, [state.draft, text]);

  const act = useCallback(
    (label: string, work: () => Promise<unknown>) => {
      setBusy(label);
      work()
        .then(onChanged)
        .catch((cause) => onError(describe(cause)))
        .finally(() => setBusy(null));
    },
    [onChanged, onError],
  );

  const saveDraft = useCallback(() => {
    if (text !== (state.draft ?? "")) {
      rpc.call("draft_save", { ref: refObj, item, text }).catch(() => undefined);
    }
  }, [rpc, refObj, item, text, state.draft]);

  const drafting = state.draftStatus === "pending";
  const fix = state.fix;

  // Rendered above and below the patch so neither end needs scrolling.
  const fixActions = (
    <div className="flex items-center gap-2">
      <Button size="sm" disabled={busy !== null} onClick={() => act("apply", () => rpc.call("fix_apply", { ref: refObj, item }))}>
        {busy === "apply" ? <Icon name="Loader" className="size-3.5 animate-spin" /> : <Icon name="Download" className="size-3.5" />}
        Apply locally
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy !== null}
        onClick={() => act("fix", () => rpc.call("fix_start", { ref: refObj, item, guidance }))}
      >
        Regenerate
      </Button>
    </div>
  );

  return (
    <div className="space-y-2">
      <Textarea
        value={text}
        onChange={setText}
        onBlur={saveDraft}
        placeholder={drafting ? "Drafting a reply…" : "Write a reply, or let the agent draft one…"}
      />
      {showGuidance && (
        <Input
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          placeholder="Guidance for the agent, e.g. “agree, we'll fix it in a follow-up” or “push back: the lock is held”"
          className="text-sm"
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={drafting || busy !== null}
          onClick={() =>
            act("draft", () => rpc.call("draft_start", { ref: refObj, item, guidance }))
          }
        >
          {drafting ? <Icon name="Loader" className="size-3.5 animate-spin" /> : <Icon name="Bot" className="size-3.5" />}
          {state.draftStatus === "failed" ? "Draft failed — retry" : "Draft reply"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setShowGuidance((s) => !s)}
          aria-label="Add guidance for the draft/fix agent"
        >
          <Icon name="SlidersHorizontal" className="size-3.5" />
        </Button>
        <div className="flex-1" />
        {canFix && fix === null && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => act("fix", () => rpc.call("fix_start", { ref: refObj, item, guidance }))}
          >
            <Icon name="Code" className="size-3.5" />
            Propose fix
          </Button>
        )}
        <Button
          size="sm"
          disabled={text.trim() === "" || busy !== null}
          onClick={() =>
            act("post", () => rpc.call("reply_post", { ref: refObj, item, body: text, replyTo, resolve: null }).then(() => setText("")))
          }
        >
          {busy === "post" ? <Icon name="Loader" className="size-3.5 animate-spin" /> : <Icon name="Send" className="size-3.5" />}
          Post
        </Button>
        {resolveId !== null && (
          <Button
            size="sm"
            variant="secondary"
            disabled={text.trim() === "" || busy !== null}
            onClick={() =>
              act("post", () =>
                rpc.call("reply_post", { ref: refObj, item, body: text, replyTo, resolve: resolveId }).then(() => setText("")),
              )
            }
          >
            Post &amp; resolve
          </Button>
        )}
      </div>
      {fix !== null && (
        <div className="rounded-md border border-border bg-muted/30">
          <div className="flex items-center gap-2 px-2.5 py-2 text-xs font-medium">
            <button type="button" onClick={() => setFixOpen((o) => !o)} className="inline-flex items-center gap-1.5">
              <Icon name={fixOpen ? "ChevronDown" : "ChevronRight"} className="size-3.5 text-muted-foreground" />
              <Icon name="Code" className="size-3.5" />
              Proposed fix
            </button>
            {fix.status === "pending" && <Spinner label="working…" />}
            {fix.status === "ready" && !fixOpen && <Chip tone="accent">ready</Chip>}
            {fix.status === "applied" && <Chip tone="good">applied {fix.appliedAt === null ? "" : ago(fix.appliedAt)}</Chip>}
            {fix.status === "failed" && <Chip tone="bad">failed</Chip>}
            <div className="flex-1" />
            {onDiscuss !== undefined && fix.status !== "pending" && (
              <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={onDiscuss}>
                <Icon name="MessagesSquare" className="size-3" />
                Revise in discussion
              </Button>
            )}
            {fix.status !== "pending" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs text-muted-foreground"
                onClick={() => act("discard", () => rpc.call("fix_discard", { ref: refObj, item }))}
              >
                Discard
              </Button>
            )}
          </div>
          {fixOpen && (
            <div className="space-y-2 px-2.5 pb-2.5">
              {fix.error !== null && <p className="text-xs text-destructive">{fix.error}</p>}
              {fix.summary !== "" && <Markdown content={fix.summary} className="text-sm" />}
              {fix.status === "ready" && fixActions}
              {fix.patch !== "" && (
                <div className="space-y-2">
                  {splitPatch(fix.patch).map((f, i) => (
                    <div key={i} className="overflow-hidden rounded-md border border-border">
                      <div className="border-b border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                        {f.path}
                      </div>
                      <Diff patch={f.patch} path={f.path} />
                    </div>
                  ))}
                </div>
              )}
              {fix.status === "ready" && fix.patch !== "" && fixActions}
              {fix.status === "failed" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => act("fix", () => rpc.call("fix_start", { ref: refObj, item, guidance }))}
                >
                  Retry
                </Button>
              )}
              <button
                type="button"
                onClick={() => setFixOpen(false)}
                className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent"
              >
                <Icon name="ChevronUp" className="size-3" />
                Collapse proposed fix
              </button>
            </div>
          )}
        </div>
      )}
      {state.postedAt !== null && (
        <p className="text-[11px] text-muted-foreground">Last reply posted {ago(state.postedAt)}.</p>
      )}
    </div>
  );
}

function CommentBody({ author: who, createdAt, body, children }: { author: string; createdAt: string; body: string; children?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-semibold">{who}</span>
        <span className="text-muted-foreground">{ago(createdAt)}</span>
      </div>
      <Markdown content={body} className="text-sm" />
      {children}
    </div>
  );
}

// ------------------------------------------------------ review thread card

function ThreadCard({
  rpc,
  refObj,
  thread,
  state,
  canFix,
  onChanged,
  onError,
  onDiscuss,
  discussBusy,
  discussActive,
}: {
  rpc: Rpc;
  refObj: PrRef;
  thread: ReviewThread;
  state: ItemState;
  canFix: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
  onDiscuss: (item: string, label: string) => void;
  discussBusy: boolean;
  discussActive: boolean;
}) {
  const [open, setOpen] = useState(!thread.isResolved);
  const [reactBusy, setReactBusy] = useState(false);
  const first = thread.comments[0];
  const toggleReaction = (commentId: number) => (content: Reaction, on: boolean) => {
    setReactBusy(true);
    rpc
      .call("react", { ref: refObj, commentId, kind: "review", content, on })
      .then(onChanged)
      .catch((cause) => onError(describe(cause)))
      .finally(() => setReactBusy(false));
  };
  return (
    <div className={cn("rounded-lg border bg-card", thread.isResolved ? "border-border opacity-70" : "border-border")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {thread.path}
          {thread.line !== null && <span className="text-muted-foreground">:{thread.line}</span>}
        </span>
        {state.triage !== "pending" && (
          <Chip tone={state.triage === "address" ? "accent" : state.triage === "done" ? "good" : "muted"}>
            {TRIAGE_LABEL[state.triage]}
          </Chip>
        )}
        {thread.isOutdated && <Chip tone="warn">outdated</Chip>}
        {thread.isResolved ? <Chip tone="good">resolved</Chip> : <Chip>{thread.comments.length}</Chip>}
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TriageControl
              value={state.triage}
              onChange={(t) => {
                rpc.call("triage_set", { ref: refObj, item: thread.id, triage: t }).then(onChanged, (c) => onError(describe(c)));
              }}
            />
            <div className="flex items-center gap-2">
              {first !== undefined && (
                <UrlLink href={first.url} className="text-xs text-muted-foreground hover:text-foreground">
                  <Icon name="ExternalLink" className="inline size-3" /> GitHub
                </UrlLink>
              )}
              <Button
                variant={discussActive ? "secondary" : "ghost"}
                size="sm"
                className="h-6 text-xs"
                disabled={discussBusy}
                onClick={() =>
                  onDiscuss(thread.id, `${thread.path}${thread.line === null ? "" : `:${thread.line}`}`)
                }
              >
                <Icon name={discussBusy ? "Loader" : "MessagesSquare"} className={cn("size-3", discussBusy && "animate-spin")} />
                {state.discussThreadId !== null ? "Resume discussion" : "Discuss"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs text-muted-foreground"
                onClick={() => {
                  rpc
                    .call("thread_resolve", { ref: refObj, threadId: thread.id, resolved: !thread.isResolved })
                    .then(onChanged, (c) => onError(describe(c)));
                }}
              >
                {thread.isResolved ? "Unresolve" : "Resolve"}
              </Button>
            </div>
          </div>
          {thread.diffHunk !== "" && (
            <div className="overflow-hidden rounded-md border border-border">
              <Diff patch={thread.diffHunk} path={thread.path} />
            </div>
          )}
          <div className="space-y-3">
            {thread.comments.map((c) => (
              <CommentBody key={c.id} author={c.author} createdAt={c.createdAt} body={c.body}>
                <ReactionBar groups={c.reactions} busy={reactBusy} onToggle={toggleReaction(c.id)} />
              </CommentBody>
            ))}
          </div>
          <ItemWorkbench
            rpc={rpc}
            refObj={refObj}
            item={thread.id}
            state={state}
            replyTo={first?.id ?? null}
            resolveId={thread.isResolved ? null : thread.id}
            canFix={canFix}
            onChanged={onChanged}
            onError={onError}
            onDiscuss={() => onDiscuss(thread.id, `${thread.path}${thread.line === null ? "" : `:${thread.line}`}`)}
          />
        </div>
      )}
    </div>
  );
}

function IssueCommentCard({
  rpc,
  refObj,
  comment,
  state,
  onChanged,
  onError,
  onDiscuss,
  discussBusy,
  discussActive,
}: {
  rpc: Rpc;
  refObj: PrRef;
  comment: IssueComment;
  state: ItemState;
  onChanged: () => void;
  onError: (message: string) => void;
  onDiscuss: (item: string, label: string) => void;
  discussBusy: boolean;
  discussActive: boolean;
}) {
  const [showReply, setShowReply] = useState(false);
  const [reactBusy, setReactBusy] = useState(false);
  const item = `ic:${comment.id}`;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-3">
      <CommentBody author={comment.author} createdAt={comment.createdAt} body={comment.body}>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <ReactionBar
            groups={comment.reactions}
            busy={reactBusy}
            onToggle={(content, on) => {
              setReactBusy(true);
              rpc
                .call("react", { ref: refObj, commentId: comment.id, kind: "issue", content, on })
                .then(onChanged)
                .catch((cause) => onError(describe(cause)))
                .finally(() => setReactBusy(false));
            }}
          />
          <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={() => setShowReply((s) => !s)}>
            <Icon name="Reply" className="size-3" /> Reply
          </Button>
          <Button
            variant={discussActive ? "secondary" : "ghost"}
            size="sm"
            className="h-6 text-xs text-muted-foreground"
            disabled={discussBusy}
            onClick={() => onDiscuss(item, `${comment.author}'s comment`)}
          >
            <Icon name={discussBusy ? "Loader" : "MessagesSquare"} className={cn("size-3", discussBusy && "animate-spin")} />
            {state.discussThreadId !== null ? "Resume discussion" : "Discuss"}
          </Button>
          <UrlLink href={comment.url} className="text-xs text-muted-foreground hover:text-foreground">
            <Icon name="ExternalLink" className="inline size-3" />
          </UrlLink>
        </div>
        {showReply && (
          <div className="pt-2">
            <ItemWorkbench
              rpc={rpc}
              refObj={refObj}
              item={item}
              state={state}
              replyTo={null}
              resolveId={null}
              canFix={false}
              onChanged={onChanged}
              onError={onError}
              onDiscuss={() => onDiscuss(item, `${comment.author}'s comment`)}
            />
          </div>
        )}
      </CommentBody>
    </div>
  );
}

// ---------------------------------------------------------------- detail

type Tab = "overview" | "files" | "comments" | "review" | "walkthrough";

const SEVERITY_TONE: Record<string, "bad" | "warn" | "muted"> = { bug: "bad", question: "warn", nit: "muted" };

// ------------------------------------------------- finding code context

/** The finding's refs, or one synthesized from its path/line for older findings. */
function refsOf(f: Finding): FindingRef[] {
  if (f.refs.length > 0) return f.refs;
  return [{ path: f.path, startLine: f.line ?? 1, endLine: f.line ?? 1, note: f.title }];
}

const fileMemo = new Map<string, string>();

interface MergedLine {
  kind: "context" | "added" | "removed";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** The head file interleaved with the lines this PR removed, from its unified patch. */
function mergeWithPatch(head: string[], patch: string | null): MergedLine[] {
  const out: MergedLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  const pushContextTo = (limit: number) => {
    while (newNo < limit && newNo <= head.length) {
      out.push({ kind: "context", text: head[newNo - 1], oldNo: oldNo++, newNo: newNo++ });
    }
  };
  if (patch !== null) {
    for (const l of patch.split("\n")) {
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m !== null) {
        pushContextTo(Number(m[2]));
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
        continue;
      }
      if (out.length === 0 && newNo === 1 && !l.startsWith(" ") && !l.startsWith("+") && !l.startsWith("-")) continue;
      if (l.startsWith("+")) out.push({ kind: "added", text: head[newNo - 1] ?? l.slice(1), oldNo: null, newNo: newNo++ });
      else if (l.startsWith("-")) out.push({ kind: "removed", text: l.slice(1), oldNo: oldNo++, newNo: null });
      else if (l.startsWith(" ")) out.push({ kind: "context", text: head[newNo - 1] ?? l.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  pushContextTo(head.length + 1);
  return out;
}

/** One unified-patch file for a slice of merged lines (a single hunk; no gaps inside). */
function patchOf(path: string, slice: MergedLine[], all: MergedLine[], startIndex: number): string | null {
  if (slice.length === 0) return null;
  const prev = (side: "oldNo" | "newNo") => {
    for (let i = startIndex - 1; i >= 0; i--) if (all[i][side] !== null) return (all[i][side] as number) + 1;
    return 1;
  };
  const a = slice.find((x) => x.oldNo !== null)?.oldNo ?? prev("oldNo");
  const c = slice.find((x) => x.newNo !== null)?.newNo ?? prev("newNo");
  const b = slice.filter((x) => x.kind !== "added").length;
  const d = slice.filter((x) => x.kind !== "removed").length;
  const body = slice.map((x) => `${x.kind === "added" ? "+" : x.kind === "removed" ? "-" : " "}${x.text}`).join("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${a},${b} +${c},${d} @@\n${body}\n`;
}

// Our own "show more" buttons replace Pierre's collapsed-lines bars.
const HIDE_SEPARATORS = "[data-separator]{display:none!important}";

function FileContext({
  rpc,
  refObj,
  path,
  active,
  patch,
}: {
  rpc: Rpc;
  refObj: PrRef;
  path: string;
  active: FindingRef;
  /** This PR's unified patch for the file, if it changed. */
  patch: string | null;
}) {
  const codeTheme = useCodeTheme();
  const memoKey = `${prKey(refObj)}:${path}`;
  const [content, setContent] = useState<string | null>(() => fileMemo.get(memoKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [padAbove, setPadAbove] = useState(20);
  const [padBelow, setPadBelow] = useState(20);

  useEffect(() => {
    const hit = fileMemo.get(memoKey);
    if (hit !== undefined) {
      setContent(hit);
      return;
    }
    setContent(null);
    setError(null);
    rpc.call("file_at_head", { ref: refObj, path }).then(
      (r) => {
        if (r.content !== null) {
          fileMemo.set(memoKey, r.content);
          setContent(r.content);
        } else setError(r.error ?? "Could not load the file.");
      },
      (c) => setError(describe(c)),
    );
  }, [memoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPadAbove(20);
    setPadBelow(20);
  }, [active]);

  const merged = useMemo(() => {
    if (content === null) return null;
    const head = content.split("\n");
    if (head.length > 0 && head[head.length - 1] === "") head.pop();
    return { head, lines: mergeWithPatch(head, patch) };
  }, [content, patch]);

  if (error !== null) return <p className="px-3 py-4 text-xs text-destructive">{error}</p>;
  if (merged === null) return <div className="px-3 py-4"><Spinner label={`Loading ${path}…`} /></div>;

  const all = merged.lines;
  const total = Math.max(merged.head.length, 1);
  const start = Math.min(Math.max(1, active.startLine), total);
  const end = Math.min(Math.max(active.endLine, start), total);
  const lo = Math.max(1, start - padAbove);
  const hi = Math.min(total, end + padBelow);
  const idxOf = (n: number) => Math.max(0, all.findIndex((x) => x.newNo === n));
  let from = idxOf(lo);
  while (lo > 1 && from > 0 && all[from - 1].kind === "removed") from--;
  let to = idxOf(hi);
  while (to + 1 < all.length && all[to + 1].kind === "removed") to++;
  const windowPatch = patchOf(path, all.slice(from, to + 1), all, from);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="max-h-[60vh] overflow-auto bg-background">
        {lo > 1 && (
          <button type="button" onClick={() => setPadAbove((p) => p + 40)} className="w-full py-1 text-[11px] text-muted-foreground hover:bg-accent">
            ↑ Show more above ({lo - 1} lines hidden)
          </button>
        )}
        {windowPatch !== null && (
          <PatchDiff<string, undefined>
            patch={windowPatch}
            selectedLines={{ start, end, side: "additions" }}
            lineAnnotations={[{ side: "additions", lineNumber: end, metadata: active.note }]}
            renderAnnotation={(a) => (
              <div className="mx-2 my-1.5 rounded-md border border-yellow-500/60 bg-card px-3 py-2 font-sans text-xs text-foreground">
                <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Icon name="MessageSquare" className="size-3" />
                  {start === end ? `line ${start}` : `lines ${start}–${end}`}
                </div>
                {a.metadata}
              </div>
            )}
            options={{
              theme: codeTheme.name as never,
              themeType: codeTheme.mode,
              diffStyle: "unified",
              disableFileHeader: true,
              overflow: "scroll",
              hunkSeparators: "simple",
              unsafeCSS: HIDE_SEPARATORS,
            }}
          />
        )}
        {hi < total && (
          <button type="button" onClick={() => setPadBelow((p) => p + 40)} className="w-full py-1 text-[11px] text-muted-foreground hover:bg-accent">
            ↓ Show more below ({total - hi} lines hidden)
          </button>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
        <span>highlighted = finding · green = added in this PR · red = removed · uncolored = existing code</span>
        <div className="flex-1" />
        {(lo > 1 || hi < total) && (
          <button
            type="button"
            className="hover:text-foreground"
            onClick={() => {
              setPadAbove(total);
              setPadBelow(total);
            }}
          >
            Show whole file
          </button>
        )}
      </div>
    </div>
  );
}

/** Left: the finding's locations. Right: the selected file at the PR head, lines highlighted, notes inline. */
function FindingContext({
  rpc,
  refObj,
  finding,
  files,
  locating,
  onLocate,
}: {
  rpc: Rpc;
  refObj: PrRef;
  finding: Finding;
  files: PrFile[];
  locating: boolean;
  onLocate: () => void;
}) {
  const refs = refsOf(finding);
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [finding.id]);
  const active = refs[Math.min(index, refs.length - 1)];
  const patch = files.find((f) => f.path === active.path)?.patch ?? null;
  return (
    <div className="flex overflow-hidden rounded-md border border-border">
      <div className="w-60 shrink-0 space-y-0.5 overflow-y-auto border-r border-border bg-card py-1.5">
        <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Where to look</div>
        {finding.refs.length === 0 && (
          <div className="mx-2 mb-1.5 space-y-1.5 rounded-md border border-dashed border-border p-2 text-[11px] text-muted-foreground">
            <p>Only the flagged line is known for this finding — it predates related-code locations.</p>
            <Button variant="outline" size="sm" className="h-7 w-full text-xs" disabled={locating} onClick={onLocate}>
              <Icon name={locating ? "Loader" : "Search"} className={cn("size-3.5", locating && "animate-spin")} />
              {locating ? "Finding related code…" : "Find related code"}
            </Button>
          </div>
        )}
        {refs.map((r, i) => {
          const name = r.path.split("/").pop() ?? r.path;
          const dir = r.path.slice(0, r.path.length - name.length);
          const changed = files.some((f) => f.path === r.path);
          return (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              title={r.path}
              className={cn(
                "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors",
                r === active ? "bg-primary/10" : "hover:bg-accent",
              )}
            >
              <span className="flex items-center gap-1.5 text-xs">
                <span
                  className={cn(
                    "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold",
                    i === 0 ? "bg-yellow-500/30 text-yellow-700 dark:text-yellow-300" : "bg-muted text-muted-foreground",
                  )}
                >
                  {i + 1}
                </span>
                <span className={cn("min-w-0 flex-1 truncate font-mono", r === active && "font-semibold")}>{name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  :{r.startLine}
                  {r.endLine !== r.startLine ? `–${r.endLine}` : ""}
                </span>
              </span>
              <span className="truncate pl-5 font-mono text-[10px] text-muted-foreground">{dir}</span>
              <span className="pl-5 text-[10px] text-muted-foreground">{changed ? "changed in this PR" : "existing file"}</span>
            </button>
          );
        })}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{active.path}</span>
          <Button variant="ghost" size="sm" className="h-5 px-1" disabled={index === 0} onClick={() => setIndex((i) => i - 1)} aria-label="Previous location">
            <Icon name="ChevronUp" className="size-3.5" />
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {index + 1}/{refs.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1"
            disabled={index >= refs.length - 1}
            onClick={() => setIndex((i) => i + 1)}
            aria-label="Next location"
          >
            <Icon name="ChevronDown" className="size-3.5" />
          </Button>
        </div>
        <FileContext rpc={rpc} refObj={refObj} path={active.path} active={active} patch={patch} />
      </div>
    </div>
  );
}

function PriorityChip({ priority }: { priority: Priority }) {
  const cls: Record<Priority, string> = {
    critical: "border-destructive bg-destructive text-white",
    high: "border-destructive/50 text-destructive",
    medium: "border-yellow-600/40 text-yellow-600 dark:text-yellow-400",
    low: "border-border text-muted-foreground",
  };
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase", cls[priority])}>
      {priority}
    </span>
  );
}

/** Open first; then priority (critical → low); then confirmed before plausible. */
function sortFindings(findings: Finding[]): Finding[] {
  const statusRank = (f: Finding) => (f.status === "open" ? 0 : f.status === "posted" ? 1 : 2);
  return findings
    .slice()
    .sort(
      (a, b) =>
        statusRank(a) - statusRank(b) ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        (a.confidence === "confirmed" ? 0 : 1) - (b.confidence === "confirmed" ? 0 : 1),
    );
}

/** One finding at a time: a grouped dropdown plus previous/next. */
function FindingPager({
  rpc,
  refObj,
  findings,
  render,
}: {
  rpc: Rpc;
  refObj: PrRef;
  findings: Finding[];
  render: (f: Finding) => ReactNode;
}) {
  const sorted = useMemo(() => sortFindings(findings), [findings]);
  // Warm every "where to look" file up front so switching locations is instant.
  const pathsKey = useMemo(
    () => [...new Set(findings.flatMap((f) => refsOf(f).map((r) => r.path)))].sort().join("\n"),
    [findings],
  );
  useEffect(() => {
    const prefix = `${prKey(refObj)}:`;
    const paths = pathsKey === "" ? [] : pathsKey.split("\n").filter((p) => !fileMemo.has(prefix + p));
    if (paths.length === 0) return;
    rpc.call("files_at_head", { ref: refObj, paths }).then(
      (r) => {
        for (const [p, content] of Object.entries(r.files)) if (content !== null) fileMemo.set(prefix + p, content);
      },
      () => undefined,
    );
  }, [pathsKey, prKey(refObj)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sorted.find((f) => f.id === selectedId) ?? sorted[0];
  const index = sorted.findIndex((f) => f.id === selected?.id);
  if (selected === undefined) return null;
  const groups: Array<[string, Finding[]]> = [
    ["Open — confirmed", sorted.filter((f) => f.status === "open" && f.confidence === "confirmed")],
    ["Open — lower confidence", sorted.filter((f) => f.status === "open" && f.confidence === "plausible")],
    ["Posted", sorted.filter((f) => f.status === "posted")],
    ["Dismissed", sorted.filter((f) => f.status === "dismissed")],
  ];
  const label = (f: Finding) =>
    `${f.priority.toUpperCase()} · ${f.title} — ${f.path.split("/").pop()}${f.line === null ? "" : `:${f.line}`}${f.confidence === "plausible" ? " (unverified)" : ""}`;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={selected.id}
          onChange={(e) => setSelectedId(e.target.value)}
          aria-label="Select a finding"
          className="h-8 min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary/50"
        >
          {groups
            .filter(([, list]) => list.length > 0)
            .map(([name, list]) => (
              <optgroup key={name} label={`${name} (${list.length})`}>
                {list.map((f) => (
                  <option key={f.id} value={f.id}>
                    {label(f)}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
        <Button variant="outline" size="sm" disabled={index <= 0} onClick={() => setSelectedId(sorted[index - 1].id)} aria-label="Previous finding">
          <Icon name="ChevronLeft" className="size-3.5" />
        </Button>
        <span className="text-xs text-muted-foreground">
          {index + 1}/{sorted.length}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={index >= sorted.length - 1}
          onClick={() => setSelectedId(sorted[index + 1].id)}
          aria-label="Next finding"
        >
          <Icon name="ChevronRight" className="size-3.5" />
        </Button>
      </div>
      {render(selected)}
    </div>
  );
}

/** One finding of a plugin-run review round: triage, discuss, edit, post. */
function FindingCard({
  rpc,
  refObj,
  finding,
  state,
  files,
  locating,
  onLocate,
  onChanged,
  onError,
  onDiscuss,
  discussBusy,
  discussActive,
}: {
  rpc: Rpc;
  refObj: PrRef;
  finding: Finding;
  state: ItemState;
  files: PrFile[];
  locating: boolean;
  onLocate: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onDiscuss: (item: string, label: string) => void;
  discussBusy: boolean;
  discussActive: boolean;
}) {
  const [text, setText] = useState(state.draft ?? "");
  const [busy, setBusy] = useState(false);
  const lastDraft = useRef(state.draft);
  useEffect(() => {
    if (state.draft !== lastDraft.current) {
      if (text === "" || text === lastDraft.current) setText(state.draft ?? "");
      lastDraft.current = state.draft;
    }
  }, [state.draft, text]);
  const item = `f:${finding.id}`;
  const where = `${finding.path}${finding.line === null ? "" : `:${finding.line}`}`;
  // Where Post attaches the comment: the best inline-commentable location unless you pick another.
  const locations = refsOf(finding);
  const targets = locations.map((r) => commentTarget(files, r));
  const bestIndex = Math.max(0, targets.findIndex((t) => t.mode === "inline"));
  const [targetIndex, setTargetIndex] = useState<number | null>(null);
  useEffect(() => setTargetIndex(null), [finding.id]);
  const chosen = Math.min(targetIndex ?? bestIndex, locations.length - 1);
  const [postedWhere, setPostedWhere] = useState<string | null>(null);
  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    work()
      .then(onChanged)
      .catch((cause) => onError(describe(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <div className={cn("rounded-lg border border-border bg-card", finding.status === "dismissed" && "opacity-60")}>
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <PriorityChip priority={finding.priority} />
        <Chip tone={SEVERITY_TONE[finding.severity] ?? "muted"}>{finding.severity}</Chip>
        {finding.confidence === "plausible" && <Chip tone="muted">unverified</Chip>}
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium">{finding.title}</span>
          <span className="ml-2 font-mono text-muted-foreground">{where}</span>
        </span>
        {finding.status === "posted" && <Chip tone="good">posted{finding.postedAt === null ? "" : ` ${ago(finding.postedAt)}`}</Chip>}
        {finding.status === "dismissed" && <Chip>dismissed</Chip>}
      </div>

        <div className="space-y-2 border-t border-border px-3 py-3">
          {finding.scenario !== null && finding.scenario !== "" && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
              <span className="font-medium">Failure scenario: </span>
              {finding.scenario}
            </div>
          )}
          {postedWhere !== null && <p className="text-[11px] text-green-600 dark:text-green-400">Posted {postedWhere}.</p>}
          <Markdown content={finding.body} className="text-sm" />
          <FindingContext rpc={rpc} refObj={refObj} finding={finding} files={files} locating={locating} onLocate={onLocate} />
          {finding.status !== "posted" && (
            <>
              <Textarea
                value={text}
                onChange={setText}
                onBlur={() => {
                  if (text !== (state.draft ?? "")) rpc.call("draft_save", { ref: refObj, item, text }).catch(() => undefined);
                }}
                placeholder="The review comment to post…"
                rows={3}
              />
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>Attach to</span>
                <select
                  value={chosen}
                  onChange={(e) => setTargetIndex(Number(e.target.value))}
                  aria-label="Where to attach the comment"
                  className="h-7 min-w-0 max-w-full flex-1 truncate rounded-md border border-border bg-background px-2 font-mono text-[11px] outline-none focus:border-primary/50"
                >
                  {locations.map((r, i) => (
                    <option key={i} value={i}>
                      {r.path.split("/").pop()}:{r.startLine}
                      {r.endLine !== r.startLine ? `–${r.endLine}` : ""}
                      {targets[i].mode === "inline" ? "" : targets[i].mode === "file" ? " (file comment)" : " (not in diff)"}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-[11px] text-muted-foreground">Posts {describeTarget(targets[chosen])}.</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={discussActive ? "secondary" : "outline"}
                  size="sm"
                  disabled={discussBusy}
                  onClick={() => onDiscuss(item, where)}
                >
                  <Icon name={discussBusy ? "Loader" : "MessagesSquare"} className={cn("size-3.5", discussBusy && "animate-spin")} />
                  {state.discussThreadId !== null ? "Resume discussion" : "Discuss"}
                </Button>
                <div className="flex-1" />
                {finding.status === "open" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    disabled={busy}
                    onClick={() => act(() => rpc.call("finding_set", { ref: refObj, findingId: finding.id, status: "dismissed" }))}
                  >
                    Dismiss
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    disabled={busy}
                    onClick={() => act(() => rpc.call("finding_set", { ref: refObj, findingId: finding.id, status: "open" }))}
                  >
                    Restore
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy || text.trim() === ""}
                  onClick={() =>
                    act(() =>
                      rpc
                        .call("finding_post", {
                          ref: refObj,
                          findingId: finding.id,
                          body: text,
                          target: {
                            path: locations[chosen].path,
                            startLine: locations[chosen].startLine,
                            endLine: locations[chosen].endLine,
                          },
                        })
                        .then((r) => setPostedWhere(r.where)),
                    )
                  }
                >
                  {busy ? <Icon name="Loader" className="size-3.5 animate-spin" /> : <Icon name="Send" className="size-3.5" />}
                  Post comment
                </Button>
              </div>
            </>
          )}
        </div>

    </div>
  );
}

/** Last detail per PR for this window, so re-opening renders instantly. */
const detailMemo = new Map<string, PrDetail>();

function PrDetailPage({ refObj, onBack }: { refObj: PrRef; onBack: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [detail, setDetail] = useState<PrDetail | null>(() => detailMemo.get(prKey(refObj)) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("comments");
  const [syncing, setSyncing] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [discuss, setDiscuss] = useState<{ item: string; threadId: string; label: string } | null>(null);
  const [discussBusy, setDiscussBusy] = useState<string | null>(null);
  const [paneWidth, setPaneWidth] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem("ghpr:paneWidth"));
    return Number.isFinite(saved) && saved >= 320 && saved <= 1000 ? saved : 480;
  });
  const key = prKey(refObj);

  const startPaneResize = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = paneWidth;
      const move = (ev: PointerEvent) => {
        setPaneWidth(Math.min(1000, Math.max(320, startW + (startX - ev.clientX))));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setPaneWidth((w) => {
          window.localStorage.setItem("ghpr:paneWidth", String(w));
          return w;
        });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [paneWidth],
  );

  const openDiscuss = useCallback(
    (item: string, label: string) => {
      setDiscussBusy(item);
      rpc
        .call("discuss_open", { ref: refObj, item })
        .then(({ threadId }) => setDiscuss({ item, threadId, label }))
        .catch((cause) => setError(describe(cause)))
        .finally(() => setDiscussBusy(null));
    },
    [rpc, refObj.owner, refObj.repo, refObj.number], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const load = useCallback(() => {
    rpc
      .call("pr_get", refObj)
      .then((r) => {
        detailMemo.set(prKey(refObj), r.detail);
        setDetail(r.detail);
        setSyncing(r.syncing);
        setError(null);
      })
      .catch((cause) => setError(describe(cause)));
  }, [rpc, refObj.owner, refObj.repo, refObj.number]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDetail(detailMemo.get(key) ?? null);
    load();
  }, [key, load]); // eslint-disable-line react-hooks/exhaustive-deps
  const sync = useCallback(() => {
    setSyncing(true);
    rpc.call("pr_refresh", refObj).catch((cause) => {
      setSyncing(false);
      setError(describe(cause));
    });
  }, [rpc, refObj.owner, refObj.repo, refObj.number]); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtime(CHANGED, (payload: unknown) => {
    const p = payload as { key?: string; kind?: string; message?: string };
    if (p?.key !== key) return;
    if (p.kind === "error") {
      setSyncing(false);
      setError(p.message ?? "Background refresh failed.");
    } else {
      load();
    }
  });

  const onError = useCallback((message: string) => setError(message), []);
  const item = (id: string): ItemState => detail?.items[id] ?? emptyItem();

  // The PR's stack (if any), from the cached list: siblings sharing a branch chain.
  const [stack, setStack] = useState<PrSummary[] | null>(null);
  useEffect(() => {
    rpc
      .call("prs_list", { refresh: false })
      .then((r) => {
        const block = stackBlocks(r.prs).find((b) => b.some((p) => prKey(p) === key));
        setStack(block !== undefined && block.length > 1 ? block : null);
      })
      .catch(() => setStack(null));
  }, [rpc, key]);

  // PRs you were asked to review open on the Review tab.
  const tabSeeded = useRef(false);
  useEffect(() => {
    if (detail !== null && !tabSeeded.current) {
      tabSeeded.current = true;
      if (detail.summary.role === "reviewer") setTab("review");
    }
  }, [detail]);

  const threads = useMemo(() => {
    const all = detail?.threads ?? [];
    return showResolved ? all : all.filter((t) => !t.isResolved);
  }, [detail, showResolved]);

  /** Every discussable comment, for the pane's thread-switcher dropdown. */
  const discussTargets = useMemo(() => {
    const short = (s: string) => {
      const text = s.replace(/\s+/g, " ").trim();
      return text.length > 48 ? `${text.slice(0, 47)}…` : text;
    };
    const mark = (id: string) => (detail?.items[id]?.discussThreadId ? "● " : "");
    const fromThreads = (detail?.threads ?? []).map((t) => {
      const label = `${t.path}${t.line === null ? "" : `:${t.line}`}`;
      const first = t.comments[0];
      return {
        item: t.id,
        label,
        group: "thread" as const,
        option: `${mark(t.id)}${label}${t.isResolved ? " (resolved)" : ""} — ${first?.author ?? "?"}: ${short(first?.body ?? "")}`,
      };
    });
    const fromComments = (detail?.issueComments ?? []).map((c) => ({
      item: `ic:${c.id}`,
      label: `${c.author}'s comment`,
      group: "comment" as const,
      option: `${mark(`ic:${c.id}`)}${c.author}: ${short(c.body)}`,
    }));
    const fromFindings = (detail?.review.findings ?? [])
      .filter((f) => f.status !== "dismissed")
      .map((f) => ({
        item: `f:${f.id}`,
        label: `${f.path}${f.line === null ? "" : `:${f.line}`}`,
        group: "finding" as const,
        option: `${mark(`f:${f.id}`)}[${f.severity}] ${f.path}${f.line === null ? "" : `:${f.line}`} — ${short(f.title)}`,
      }));
    return [...fromThreads, ...fromComments, ...fromFindings];
  }, [detail]);

  if (detail === null) {
    return (
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto box-border w-full max-w-[1800px] space-y-3 px-4 pb-6 pt-3 md:px-5 md:pt-4">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <Icon name="ArrowLeft" className="size-3.5" /> All PRs
          </Button>
          {error === null ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              Loading {key}…
            </div>
          ) : (
            <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }

  const s = detail.summary;
  const canFix = detail.checkout !== null;
  const unresolvedCount = detail.threads.filter((t) => !t.isResolved).length;

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="box-border w-full px-4 pb-6 pt-3 md:px-5 md:pt-4">
    <div className="mx-auto w-full max-w-[1800px] space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <Icon name="ArrowLeft" className="size-3.5" /> All PRs
        </Button>
        <div className="flex-1" />
        <SyncBadge syncing={syncing} fetchedAt={detail?.fetchedAt ?? null} />
        <Button variant="ghost" size="sm" onClick={sync} disabled={syncing} aria-label="Refresh from GitHub">
          <Icon name="RefreshCw" className="size-3.5" />
        </Button>
        <UrlLink href={s.url} className="text-xs text-muted-foreground hover:text-foreground">
          <Icon name="ExternalLink" className="inline size-3.5" /> Open on GitHub
        </UrlLink>
      </div>
      <div>
        <h2 className="text-base font-semibold leading-snug">{s.title}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{key}</span>
          <span className="font-mono">
            {s.headRefName} → {s.baseRefName}
          </span>
          {s.isDraft && <Chip>draft</Chip>}
          <Chip tone={detail.state === "OPEN" ? "good" : "muted"}>{detail.state.toLowerCase()}</Chip>
          {decisionChip(s.reviewDecision)}
          {checksChip(s.checksState)}
          <span className="text-green-600 dark:text-green-400">+{s.additions}</span>
          <span className="text-destructive">−{s.deletions}</span>
        </div>
        {stack !== null && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <Icon name="Layers" className="size-3" />
            <span>Stack (review order):</span>
            {stack.map((p, i) => {
              const current = prKey(p) === key;
              return (
                <button
                  key={prKey(p)}
                  type="button"
                  title={p.title}
                  disabled={current}
                  onClick={() => navigate.toPluginPanel("prs", { subPath: `${p.owner}/${p.repo}/${p.number}` })}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono",
                    current
                      ? "border-primary/50 bg-primary/10 font-semibold text-primary"
                      : "border-border hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  {i + 1}. #{p.number}
                  {current && " (this)"}
                </button>
              );
            })}
          </div>
        )}
        {detail.checkout !== null && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Local checkout: <span className="font-mono">{detail.checkout.path}</span> on{" "}
            <span className={cn("font-mono", !detail.checkout.onPrBranch && "text-yellow-600 dark:text-yellow-400")}>
              {detail.checkout.branch ?? "?"}
            </span>
            {!detail.checkout.onPrBranch && " (not the PR branch — applied fixes land on this branch)"}
            {detail.checkout.dirty && " · dirty working tree"}
          </p>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-1 border-b border-border">
        {(
          [
            ["overview", "Overview", null],
            ["files", "Files", detail.files.length],
            ["comments", "Comments", unresolvedCount],
            ["review", "Review", detail.review.findings.filter((f) => f.status === "open").length || null],
            ["walkthrough", "Walkthrough", detail.walkthrough.steps.length || null],
          ] as Array<[Tab, string, number | null]>
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm transition-colors",
              tab === id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {count !== null && count > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <div className="mb-1 text-xs text-muted-foreground">
              {detail.author} opened {ago(s.createdAt)}
            </div>
            <Markdown content={detail.body === "" ? "_No description._" : detail.body} className="text-sm" />
          </div>
          {detail.checks.length > 0 && (
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="mb-2 text-xs font-medium">Checks</div>
              <ul className="space-y-1">
                {detail.checks.map((c, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs">
                    <Icon
                      name={
                        c.status === "SUCCESS" ? "CircleCheck" : c.status === "PENDING" || c.status === "IN_PROGRESS" || c.status === "QUEUED" ? "Clock" : "CircleX"
                      }
                      className={cn(
                        "size-3.5",
                        c.status === "SUCCESS"
                          ? "text-green-600 dark:text-green-400"
                          : c.status === "PENDING" || c.status === "IN_PROGRESS" || c.status === "QUEUED"
                            ? "text-yellow-600 dark:text-yellow-400"
                            : "text-destructive",
                      )}
                    />
                    {c.url === null ? <span>{c.name}</span> : <UrlLink href={c.url}>{c.name}</UrlLink>}
                    <span className="text-muted-foreground">{c.status.toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.reviews.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium">Reviews</div>
              {detail.reviews.map((r, i) => (
                <div key={i} className="rounded-lg border border-border bg-card px-4 py-3">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold">{r.author}</span>
                    <Chip tone={r.state === "APPROVED" ? "good" : r.state === "CHANGES_REQUESTED" ? "bad" : "muted"}>
                      {r.state.toLowerCase().replace("_", " ")}
                    </Chip>
                    {r.submittedAt !== null && <span className="text-muted-foreground">{ago(r.submittedAt)}</span>}
                  </div>
                  {r.body !== "" && <Markdown content={r.body} className="mt-1.5 text-sm" />}
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <div className="text-xs font-medium">Conversation</div>
            {detail.issueComments.map((c) => (
              <IssueCommentCard
                key={c.id}
                rpc={rpc}
                refObj={refObj}
                comment={c}
                state={item(`ic:${c.id}`)}
                onChanged={load}
                onError={onError}
                onDiscuss={openDiscuss}
                discussBusy={discussBusy === `ic:${c.id}`}
                discussActive={discuss?.item === `ic:${c.id}`}
              />
            ))}
            <div className="rounded-lg border border-border bg-card px-3 py-3">
              <div className="mb-1.5 text-xs font-medium">Add a comment</div>
              <ItemWorkbench
                rpc={rpc}
                refObj={refObj}
                item="pr"
                state={item("pr")}
                replyTo={null}
                resolveId={null}
                canFix={false}
                onChanged={load}
                onError={onError}
              />
            </div>
          </div>
        </div>
      )}

      {tab === "files" && <FilesView files={detail.files} threads={detail.threads} />}

      {tab === "review" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {detail.review.round === 0
                ? "No review run yet. The worker reads the full diff and your checkout, then reports findings here for you to triage."
                : detail.review.status === "running"
                  ? `Round ${detail.review.round} running…`
                  : detail.review.status === "failed"
                    ? `Round ${detail.review.round} failed`
                    : `Round ${detail.review.round}: ${
                        (["critical", "high", "medium", "low"] as const)
                          .map((p) => [p, detail.review.findings.filter((f) => f.status === "open" && f.priority === p).length] as const)
                          .filter(([, n]) => n > 0)
                          .map(([p, n]) => `${n} ${p}`)
                          .join(" · ") || "0 open"
                      }, ${detail.review.findings.filter((f) => f.status === "posted").length} posted`}
              {runModelLabel(detail.review.model) !== null && (
                <span className="ml-2 font-mono text-[10px]">· {runModelLabel(detail.review.model)}</span>
              )}
            </p>
            <div className="flex-1" />
            <WorkerModelControl />
            <Button
              variant="outline"
              size="sm"
              disabled={detail.review.status === "running"}
              onClick={() => {
                rpc.call("review_start", { ref: refObj, guidance: "" }).then(load, (c) => onError(describe(c)));
              }}
            >
              {detail.review.status === "running" ? (
                <Icon name="Loader" className="size-3.5 animate-spin" />
              ) : (
                <Icon name="Bot" className="size-3.5" />
              )}
              {detail.review.round === 0 ? "Run review" : "Run another round"}
            </Button>
          </div>
          {detail.review.error !== null && (
            <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">{detail.review.error}</p>
          )}
          {detail.review.status === "done" && detail.review.findings.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No findings — the review came back clean.
            </div>
          )}
          {detail.review.findings.length > 0 && (
            <FindingPager
              rpc={rpc}
              refObj={refObj}
              findings={detail.review.findings}
              render={(f) => (
                <FindingCard
                  key={f.id}
                  rpc={rpc}
                  refObj={refObj}
                  finding={f}
                  state={item(`f:${f.id}`)}
                  files={detail.files}
                  locating={detail.review.locating}
                  onLocate={() => {
                    rpc.call("finding_locate", refObj).then(load, (c) => onError(describe(c)));
                  }}
                  onChanged={load}
                  onError={onError}
                  onDiscuss={openDiscuss}
                  discussBusy={discussBusy === `f:${f.id}`}
                  discussActive={discuss?.item === `f:${f.id}`}
                />
              )}
            />
          )}
        </div>
      )}

      {tab === "walkthrough" && (
        <WalkthroughView
          walkthrough={detail.walkthrough}
          onRun={() => {
            rpc.call("walkthrough_start", refObj).then(load, (c) => onError(describe(c)));
          }}
        />
      )}

      {tab === "comments" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {unresolvedCount} unresolved thread{unresolvedCount === 1 ? "" : "s"}
              {detail.threads.length - unresolvedCount > 0 && ` · ${detail.threads.length - unresolvedCount} resolved`}
            </p>
            <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={() => setShowResolved((s2) => !s2)}>
              {showResolved ? "Hide resolved" : "Show resolved"}
            </Button>
          </div>
          {threads.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No {showResolved ? "" : "unresolved "}review threads.
            </div>
          ) : (
            threads.map((t) => (
              <ThreadCard
                key={t.id}
                rpc={rpc}
                refObj={refObj}
                thread={t}
                state={item(t.id)}
                canFix={canFix}
                onChanged={load}
                onError={onError}
                onDiscuss={openDiscuss}
                discussBusy={discussBusy === t.id}
                discussActive={discuss?.item === t.id}
              />
            ))
          )}
        </div>
      )}
    </div>
        </div>
      </div>
      {discuss !== null && (
        <div
          role="separator"
          aria-orientation="vertical"
          className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/50"
          onPointerDown={startPaneResize}
        />
      )}
      {discuss !== null && (
        <div style={{ width: paneWidth }} className="flex shrink-0 flex-col bg-background">
          <div className="space-y-1 border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <Icon name="MessagesSquare" className="size-4 shrink-0 text-muted-foreground" />
              <select
                value={discuss.item}
                onChange={(e) => {
                  const picked = discussTargets.find((t) => t.item === e.target.value);
                  if (picked !== undefined && picked.item !== discuss.item) openDiscuss(picked.item, picked.label);
                }}
                aria-label="Switch comment thread"
                className="h-7 min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 font-mono text-xs outline-none focus:border-primary/50"
              >
                {discussTargets.every((t) => t.item !== discuss.item) && (
                  <option value={discuss.item}>{discuss.label}</option>
                )}
                <optgroup label="Review threads">
                  {discussTargets
                    .filter((t) => t.group === "thread")
                    .map((t) => (
                      <option key={t.item} value={t.item}>
                        {t.option}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="Conversation">
                  {discussTargets
                    .filter((t) => t.group === "comment")
                    .map((t) => (
                      <option key={t.item} value={t.item}>
                        {t.option}
                      </option>
                    ))}
                </optgroup>
                {discussTargets.some((t) => t.group === "finding") && (
                  <optgroup label="Review findings">
                    {discussTargets
                      .filter((t) => t.group === "finding")
                      .map((t) => (
                        <option key={t.item} value={t.item}>
                          {t.option}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
              <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => setDiscuss(null)} aria-label="Close discussion">
                <Icon name="X" className="size-3.5" />
              </Button>
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {discussBusy !== null
                ? "Opening discussion…"
                : "Ask for a reply draft or a code change — results land on the comment card."}
            </div>
          </div>
          <ThreadChat
            threadId={discuss.threadId}
            variant="compact"
            layout="contained"
            permissionPolicy="editable"
            className="min-h-0 flex-1"
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------- worker model

function runModelLabel(m: RunModel | null): string | null {
  return m === null ? null : `${m.model} · ${m.reasoningLevel}`;
}

/** Picker for the model review/walkthrough/draft workers spawn with (shared across PRs). */
function WorkerModelControl() {
  const rpc = useRpc<typeof rpcContract>();
  const [selection, setSelection] = useState<WorkerModel | null>(null);
  const [fallback, setFallback] = useState<WorkerModel | null>(null);
  const load = useCallback(() => {
    rpc.call("model_get", null).then(
      (r) => {
        setSelection(r.selection);
        setFallback(r.fallback);
      },
      () => undefined,
    );
  }, [rpc]);
  useEffect(() => load(), [load]);
  useRealtime(CHANGED, (payload: unknown) => {
    if ((payload as { kind?: string })?.kind === "model") load();
  });
  const value = selection ?? fallback;
  if (value === null) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span>Runs on</span>
      <ProviderModelPicker
        value={value as ComponentProps<typeof ProviderModelPicker>["value"]}
        align="end"
        onChange={(next) => {
          setSelection(next as WorkerModel);
          rpc.call("model_set", { selection: next as WorkerModel }).catch(() => undefined);
        }}
      />
      {selection !== null && (
        <button
          type="button"
          className="underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => {
            setSelection(null);
            rpc.call("model_set", { selection: null }).catch(() => undefined);
          }}
        >
          use default
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------- walkthrough

function WalkthroughView({ walkthrough, onRun }: { walkthrough: Walkthrough; onRun: () => void }) {
  const [step, setStep] = useState(0);
  const steps = walkthrough.steps;
  // A fresh walkthrough restarts the tour.
  const stamp = walkthrough.finishedAt;
  const lastStamp = useRef(stamp);
  useEffect(() => {
    if (stamp !== lastStamp.current) {
      lastStamp.current = stamp;
      setStep(0);
    }
  }, [stamp]);
  const current = steps[Math.min(step, Math.max(steps.length - 1, 0))];

  if (walkthrough.status === "running") {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        <Spinner label="Building the walkthrough — reading the diff and the surrounding code. This can take a few minutes." />
      </div>
    );
  }
  if (steps.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed border-border px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          A walkthrough builds the context for this PR from the ground up: the existing code it builds on first, then the
          new pieces, one step at a time.
        </p>
        {walkthrough.error !== null && <p className="text-sm text-destructive">{walkthrough.error}</p>}
        <Button onClick={onRun}>
          <Icon name="Layers" className="size-4" />
          {walkthrough.status === "failed" ? "Retry walkthrough" : "Build walkthrough"}
        </Button>
        <div className="flex justify-center">
          <WorkerModelControl />
        </div>
      </div>
    );
  }

  const nav = (
    <div className="flex items-center justify-between gap-2">
      <Button variant="outline" size="sm" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
        <Icon name="ChevronLeft" className="size-3.5" /> Previous
      </Button>
      <span className="text-xs text-muted-foreground">
        Step {Math.min(step + 1, steps.length)} of {steps.length}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={step >= steps.length - 1}
        onClick={() => setStep((s) => Math.min(steps.length - 1, s + 1))}
      >
        Next <Icon name="ChevronRight" className="size-3.5" />
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start">
      <div className="w-full shrink-0 self-start rounded-lg border border-border bg-card py-1.5 md:sticky md:top-2 md:max-h-[calc(100vh-10rem)] md:w-64 md:overflow-y-auto">
        <div className="space-y-2 border-b border-border px-3 pb-2 pt-1">
          <div className="text-xs font-medium">{walkthrough.title ?? "Walkthrough"}</div>
          {runModelLabel(walkthrough.model) !== null && (
            <div className="font-mono text-[10px] text-muted-foreground">Built with {runModelLabel(walkthrough.model)}</div>
          )}
          <Button variant="outline" size="sm" className="w-full" onClick={onRun}>
            <Icon name="RefreshCw" className="size-3.5" />
            Rebuild walkthrough
          </Button>
          <WorkerModelControl />
        </div>
        {steps.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setStep(i)}
            className={cn(
              "flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors",
              i === step ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent",
            )}
          >
            <span
              className={cn(
                "mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                i === step ? "bg-primary/20 text-primary" : "bg-muted",
              )}
            >
              {i + 1}
            </span>
            <span className="min-w-0 flex-1">{s.title}</span>
          </button>
        ))}
      </div>
      {current !== undefined && (
        <div className="min-w-0 flex-1 space-y-3">
          {nav}
          <div className="space-y-3 rounded-lg border border-border bg-card px-4 py-3">
            <h3 className="text-sm font-semibold">
              {step + 1}. {current.title}
            </h3>
            <Markdown content={current.body} className="text-sm" />
            {current.sections.map((sec, i) => (
              <div key={i} className="overflow-hidden rounded-md border border-border">
                <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                    {sec.path}
                    {sec.kind === "context" && sec.startLine !== null ? `:${sec.startLine}` : ""}
                  </span>
                  {sec.kind === "added" ? (
                    <Chip tone="accent">changed in this PR</Chip>
                  ) : (
                    <Chip>existing code</Chip>
                  )}
                </div>
                {sec.kind === "added" ? (
                  <Diff patch={sec.code} path={sec.path} />
                ) : (
                  <SourceCode content={sec.code} path={sec.path} />
                )}
              </div>
            ))}
          </div>
          {nav}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------- files: tree + diff

interface TreeDir {
  name: string;
  path: string;
  dirs: TreeDir[];
  files: PrFile[];
}

/** Nest files into directories, compressing single-child directory chains (GitHub-style). */
function buildTree(files: PrFile[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      let next = node.dirs.find((d) => d.path === dirPath);
      if (next === undefined) {
        next = { name: parts[i], path: dirPath, dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(f);
  }
  const compress = (d: TreeDir): TreeDir => {
    let out = d;
    while (out.files.length === 0 && out.dirs.length === 1) {
      const child = out.dirs[0];
      out = { ...child, name: `${out.name}/${child.name}` };
    }
    return { ...out, dirs: out.dirs.map(compress) };
  };
  const sortTree = (d: TreeDir): TreeDir => ({
    ...d,
    dirs: [...d.dirs].sort((a, b) => a.name.localeCompare(b.name)).map(sortTree),
    files: [...d.files].sort((a, b) => a.path.localeCompare(b.path)),
  });
  return sortTree({ ...root, dirs: root.dirs.map(compress) });
}

function fileStatusIcon(status: string): { icon: string; className: string } {
  switch (status) {
    case "added":
      return { icon: "Plus", className: "text-green-600 dark:text-green-400" };
    case "removed":
      return { icon: "Minus", className: "text-destructive" };
    case "renamed":
      return { icon: "ArrowRight", className: "text-yellow-600 dark:text-yellow-400" };
    default:
      return { icon: "FileDiff", className: "text-muted-foreground" };
  }
}

function TreeNode({
  dir,
  depth,
  selected,
  commentCounts,
  onSelect,
}: {
  dir: TreeDir;
  depth: number;
  selected: string | null;
  commentCounts: Map<string, number>;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const pad = (d: number) => ({ paddingLeft: `${d * 14 + 8}px` });
  return (
    <>
      {dir.name !== "" && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={pad(depth)}
          className="flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-xs text-muted-foreground hover:bg-accent"
        >
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0" />
          <Icon name="Folder" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{dir.name}</span>
        </button>
      )}
      {(dir.name === "" || open) && (
        <>
          {dir.dirs.map((d) => (
            <TreeNode key={d.path} dir={d} depth={dir.name === "" ? depth : depth + 1} selected={selected} commentCounts={commentCounts} onSelect={onSelect} />
          ))}
          {dir.files.map((f) => {
            const st = fileStatusIcon(f.status);
            const comments = commentCounts.get(f.path) ?? 0;
            const name = f.path.split("/").pop() ?? f.path;
            return (
              <button
                key={f.path}
                type="button"
                onClick={() => onSelect(f.path)}
                style={pad(dir.name === "" ? depth : depth + 1)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-xs transition-colors",
                  selected === f.path ? "bg-primary/10 font-medium text-foreground" : "hover:bg-accent",
                )}
                title={f.path}
              >
                <span className="size-3 shrink-0" />
                <Icon name={st.icon} className={cn("size-3.5 shrink-0", st.className)} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {comments > 0 && (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
                    <Icon name="MessageSquare" className="size-3" />
                    {comments}
                  </span>
                )}
              </button>
            );
          })}
        </>
      )}
    </>
  );
}

function FilesView({ files, threads }: { files: PrFile[]; threads: ReviewThread[] }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const commentCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of threads) {
      if (!t.isResolved) map.set(t.path, (map.get(t.path) ?? 0) + 1);
    }
    return map;
  }, [threads]);
  const [selected, setSelected] = useState<string | null>(files[0]?.path ?? null);
  const current = files.find((f) => f.path === selected) ?? files[0];
  const index = current === undefined ? -1 : files.findIndex((f) => f.path === current.path);
  if (files.length === 0) {
    return <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">No files.</div>;
  }
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-start">
      <div className="w-full shrink-0 self-start rounded-lg border border-border bg-card py-1.5 pr-1 md:sticky md:top-2 md:max-h-[calc(100vh-10rem)] md:w-64 md:overflow-y-auto">
        <TreeNode dir={tree} depth={0} selected={current?.path ?? null} commentCounts={commentCounts} onSelect={setSelected} />
      </div>
      {current !== undefined && (
        <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{current.path}</span>
            {current.status !== "modified" && <Chip>{current.status}</Chip>}
            <span className="text-xs text-green-600 dark:text-green-400">+{current.additions}</span>
            <span className="text-xs text-destructive">−{current.deletions}</span>
            <span className="mx-1 h-4 w-px bg-border" />
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5"
              disabled={index <= 0}
              onClick={() => setSelected(files[index - 1].path)}
              aria-label="Previous file"
            >
              <Icon name="ChevronUp" className="size-3.5" />
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {index + 1}/{files.length}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5"
              disabled={index >= files.length - 1}
              onClick={() => setSelected(files[index + 1].path)}
              aria-label="Next file"
            >
              <Icon name="ChevronDown" className="size-3.5" />
            </Button>
          </div>
          {current.patch === null ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">No text diff (binary or too large).</div>
          ) : (
            <Diff patch={current.patch} path={current.path} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- routing

function parseSubPath(subPath: string): PrRef | null {
  const m = subPath.match(/^([^/]+)\/([^/]+)\/(\d+)$/);
  return m === null ? null : { owner: m[1], repo: m[2], number: Number(m[3]) };
}

const LAST_SUBPATH_KEY = "ghpr:lastSubPath";

function PrsPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const refObj = parseSubPath(subPath);
  // Opening the page at its root (sidebar click) returns to the last-viewed
  // PR; "All PRs" clears the memory so it really goes to the list.
  const restored = subPath === "" ? window.localStorage.getItem(LAST_SUBPATH_KEY) : null;
  const restoreTo = restored !== null && parseSubPath(restored) !== null ? restored : null;
  useEffect(() => {
    if (restoreTo !== null) navigate.toPluginPanel("prs", { subPath: restoreTo, replace: true });
    else if (subPath !== "") window.localStorage.setItem(LAST_SUBPATH_KEY, subPath);
  }, [subPath, restoreTo]); // eslint-disable-line react-hooks/exhaustive-deps
  if (refObj === null) {
    if (restoreTo !== null) return null; // redirecting to the last-viewed PR
    return (
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="box-border w-full px-4 pb-6 pt-3 md:px-5 md:pt-4">
          <PrListPage
            onOpen={(ref) => navigate.toPluginPanel("prs", { subPath: `${ref.owner}/${ref.repo}/${ref.number}` })}
          />
        </div>
      </div>
    );
  }
  // The detail page owns its own scrolling so the discussion pane can take full height.
  return (
    <PrDetailPage
      refObj={refObj}
      onBack={() => {
        window.localStorage.removeItem(LAST_SUBPATH_KEY);
        navigate.toPluginPanel("prs", { subPath: "" });
      }}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "prs",
    title: "Pull Requests",
    icon: "GitPullRequest",
    path: "prs",
    component: PrsPage,
  });
});
