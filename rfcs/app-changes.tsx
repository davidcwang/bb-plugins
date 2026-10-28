// The Changes view: revision history of the RFC file and a line diff between
// any two revisions, defaulting to "what changed last".
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { CHANGED, type ChangedPayload } from "./shared";
import { diffStats, hunks, lineDiff, type DiffOp } from "./diff";
import { recall, remember } from "./memory";
import { Icon } from "./icons";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
export interface RevisionSummary {
  id: string;
  at: string;
  by: "user" | "agent" | "external";
  sha256: string;
  threadId: string | null;
  lines: number;
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Revision summaries for the thread's RFC, refreshed on the server's change signal. */
export function useRevisions(rpc: Rpc, threadId: string, enabled: boolean) {
  const [items, setItems] = useState<RevisionSummary[]>([]);
  const reload = useCallback(() => {
    if (!enabled) return;
    rpc.call("revisions_list", { threadId }).then((r) => setItems(r.items as RevisionSummary[]), () => undefined);
  }, [rpc, threadId, enabled]);
  useEffect(reload, [reload]);
  useRealtime(CHANGED, (payload: unknown) => {
    const p = payload as ChangedPayload;
    if (p.threadId === threadId && (p.kind === "revisions" || p.kind === "doc")) reload();
  });
  return items;
}

const seenKey = (threadId: string) => `revSeen:${threadId}`;

/** Agent/external revisions newer than the last one the user looked at in the Changes view. */
export function unseenChanges(threadId: string, items: RevisionSummary[]): number {
  const seen = recall(seenKey(threadId));
  return items.filter((r, i) => i > 0 && r.by !== "user" && (seen === null || r.at > seen)).length;
}

const byLabel: Record<RevisionSummary["by"], string> = { user: "you", agent: "Claude", external: "on disk" };
const byTone: Record<RevisionSummary["by"], string> = {
  user: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  agent: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  external: "bg-muted text-muted-foreground",
};

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function ChangesView({ rpc, threadId, items, currentSha, onRestore }: { rpc: Rpc; threadId: string; items: RevisionSummary[]; currentSha: string | null; onRestore: (content: string) => Promise<void> }) {
  const [sel, setSel] = useState<{ base: string | null; target: string | null }>({ base: null, target: null });
  const latest = items[items.length - 1] ?? null;
  const target = items.find((r) => r.id === sel.target) ?? latest;
  const targetIndex = target === null ? -1 : items.indexOf(target);
  const base = items.find((r) => r.id === sel.base) ?? (targetIndex > 0 ? items[targetIndex - 1]! : null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [restoring, setRestoring] = useState<"idle" | "confirm" | "busy">("idle");
  const [context, setContext] = useState(3);
  // Looking at the list marks everything as seen.
  useEffect(() => {
    if (latest !== null) remember(seenKey(threadId), latest.at);
  }, [latest, threadId]);
  useEffect(() => {
    for (const r of [base, target]) {
      if (r === null || texts[r.id] !== undefined) continue;
      rpc.call("revision_get", { threadId, id: r.id }).then(
        (rev) => {
          if (rev !== null) setTexts((t) => ({ ...t, [rev.id]: rev.content }));
        },
        (cause: unknown) => toast.error(describe(cause)),
      );
    }
    // texts intentionally omitted: fetch once per id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, target, rpc, threadId]);
  const ops = useMemo(() => {
    if (target === null) return null;
    const after = texts[target.id];
    const before = base === null ? "" : texts[base.id];
    if (after === undefined || before === undefined) return null;
    return lineDiff(before, after);
  }, [texts, base, target]);
  const stats = ops === null ? null : diffStats(ops);
  const grouped = useMemo(() => (ops === null ? [] : hunks(ops, context)), [ops, context]);

  if (items.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        <p>No revisions yet.</p>
        <p className="mt-2">Every change to the file, by you or by Claude, is snapshotted from here on. Come back after the next edit to see exactly what changed.</p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-56 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
          <Icon name="History" className="size-3.5" />
          {items.length} revision{items.length === 1 ? "" : "s"}
          <span className="ml-auto">click: show · ⇧click: compare from</span>
        </div>
        <ol className="min-h-0 flex-1 overflow-auto py-1">
          {[...items].reverse().map((r, i) => {
            const isTarget = target?.id === r.id;
            const isBase = base?.id === r.id;
            const isCurrent = r.sha256 === currentSha;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={(e) => {
                    if (e.shiftKey) setSel((s) => ({ ...s, base: r.id }));
                    else setSel({ base: null, target: r.id });
                  }}
                  className={cn(
                    "flex w-full flex-col gap-0.5 px-2 py-1 text-left text-xs hover:bg-muted/60",
                    isTarget && "bg-muted",
                    isBase && "border-l-2 border-amber-500",
                  )}
                  title={`${r.lines} lines · ${r.sha256.slice(0, 10)}`}
                >
                  <span className="flex items-center gap-1">
                    <span className={cn("rounded px-1 text-[10px]", byTone[r.by])}>{i === items.length - 1 ? "baseline" : byLabel[r.by]}</span>
                    <span className="text-muted-foreground">{when(r.at)}</span>
                    {isCurrent ? <span className="ml-auto text-[10px] text-green-700 dark:text-green-400">current</span> : null}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {isTarget ? "showing" : isBase ? "comparing from" : `${r.lines} lines`}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-xs">
          {target !== null ? (
            <span>
              <span className="text-muted-foreground">{base === null ? "Everything in" : `${byLabel[base.by]} ${when(base.at)} → `}</span>
              <span className="font-medium">
                {byLabel[target.by]} {when(target.at)}
              </span>
            </span>
          ) : null}
          {stats !== null ? (
            <span className="font-mono text-[11px]">
              <span className="text-green-700 dark:text-green-400">+{stats.added}</span> <span className="text-destructive">−{stats.removed}</span>
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-1">
            <button type="button" className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setContext((c) => (c >= 1000 ? 3 : 1000))}>
              {context >= 1000 ? "Collapse unchanged" : "Show whole file"}
            </button>
            {target !== null && target.sha256 !== currentSha && texts[target.id] !== undefined ? (
              <button
                type="button"
                disabled={restoring === "busy"}
                className={cn("rounded border border-border px-1.5 py-0.5", restoring === "confirm" ? "border-destructive text-destructive" : "text-muted-foreground hover:text-foreground")}
                onClick={() => {
                  if (restoring === "idle") {
                    setRestoring("confirm");
                    window.setTimeout(() => setRestoring((s) => (s === "confirm" ? "idle" : s)), 4000);
                    return;
                  }
                  setRestoring("busy");
                  onRestore(texts[target.id]!).then(
                    () => setRestoring("idle"),
                    (cause: unknown) => {
                      toast.error(describe(cause));
                      setRestoring("idle");
                    },
                  );
                }}
              >
                {restoring === "confirm" ? "Click again to overwrite the file" : "Restore this revision"}
              </button>
            ) : null}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5">
          {ops === null ? (
            <p className="p-3 text-sm text-muted-foreground">Loading…</p>
          ) : stats!.added + stats!.removed === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No differences.</p>
          ) : (
            <table className="w-full border-collapse">
              <tbody>
                {grouped.map((h, hi) => (
                  <HunkRows key={hi} ops={h.ops} skipped={h.skipped} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function HunkRows({ ops, skipped }: { ops: DiffOp[]; skipped: number }) {
  return (
    <>
      {skipped > 0 ? (
        <tr className="bg-muted/40 text-muted-foreground">
          <td colSpan={3} className="px-3 py-0.5 text-[11px]">
            ⋯ {skipped} unchanged line{skipped === 1 ? "" : "s"}
          </td>
        </tr>
      ) : null}
      {ops.map((op, i) => (
        <tr
          key={i}
          className={cn(
            op.kind === "add" && "bg-green-500/15",
            op.kind === "del" && "bg-destructive/10",
          )}
        >
          <td className="w-10 select-none pr-1 text-right text-[10px] text-muted-foreground/70">{op.a ?? ""}</td>
          <td className="w-10 select-none pr-2 text-right text-[10px] text-muted-foreground/70">{op.b ?? ""}</td>
          <td className={cn("whitespace-pre-wrap break-words pr-3", op.kind === "del" && "text-destructive", op.kind === "add" && "text-green-800 dark:text-green-300")}>
            <span className="inline-block w-3 select-none text-muted-foreground/70">{op.kind === "add" ? "+" : op.kind === "del" ? "−" : " "}</span>
            {op.text}
          </td>
        </tr>
      ))}
    </>
  );
}
