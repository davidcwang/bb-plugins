// Sidecar UI: section chrome (notes, cards, terms), the selection toolbar,
// explainer cards, the Items view (notes / claims / glossary) and the
// Walkthrough view. Data comes from the sidecar RPCs in server.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode, RefObject } from "react";
import { Markdown, ThreadChat, experimental_FileLink as FileLink, experimental_SourceCode as SourceCode, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { CHANGED, type ChangedPayload, type DocSection } from "./shared";
import {
  CARD_MODES,
  CARD_MODE_LABEL,
  CLAIM_STATUSES,
  NOTE_STATUSES,
  sectionMatches,
  termsIn,
  type Anchor,
  type Card,
  type CardMode,
  type Claim,
  type ClaimStatus,
  type CodeRef,
  type Note,
  type NoteStatus,
  type Sidecar,
  type Term,
  type Walkthrough,
} from "./sidecar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "./icons";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export type DiagramRenderer = ComponentType<{ lang: "mermaid" | "d2"; source: string; startLine: number }>;

// ---- data ----------------------------------------------------------------

export function useSidecar(rpc: Rpc, threadId: string, enabled: boolean) {
  const [data, setData] = useState<Sidecar | null>(null);
  const reload = useCallback(() => {
    if (!enabled) return;
    rpc.call("sidecar_get", { threadId }).then((d) => setData(d), () => undefined);
  }, [rpc, threadId, enabled]);
  useEffect(reload, [reload]);
  useRealtime(CHANGED, (payload: unknown) => {
    const p = payload as ChangedPayload;
    if (p.threadId === threadId && (p.kind === "sidecar" || p.kind === "doc")) reload();
  });
  return { sidecar: data, reload };
}

export const noteTone: Record<NoteStatus, string> = {
  open: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  decided: "bg-green-500/15 text-green-700 dark:text-green-400",
  blocked: "bg-destructive/15 text-destructive",
  superseded: "bg-muted text-muted-foreground line-through",
};
export const claimTone: Record<ClaimStatus, string> = {
  verified: "bg-green-500/15 text-green-700 dark:text-green-400",
  assumed: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  stale: "bg-destructive/15 text-destructive",
  superseded: "bg-muted text-muted-foreground line-through",
};
const modeIcon: Record<CardMode, string> = { concept: "Lightbulb", code: "Code", data: "Database", flow: "GitBranch", question: "MessageCircleQuestion" };

/** Items anchored to a section: by heading text, else by line range. */
export function itemsForSection<T extends { anchor: Anchor }>(items: T[], section: DocSection, nextStart: number | null): T[] {
  return items.filter((it) => {
    if (section.heading !== null && it.anchor.section !== null) return sectionMatches(it.anchor.section, section.heading.title);
    if (it.anchor.line !== null) return it.anchor.line >= section.startLine && (nextStart === null || it.anchor.line < nextStart);
    return section.heading === null && it.anchor.section === null;
  });
}

// ---- code refs -----------------------------------------------------------

function CodeRefView({ file, environmentId }: { file: CodeRef; environmentId: string | null }) {
  const [open, setOpen] = useState(file.snippet !== null && file.snippet.split("\n").length <= 12);
  const where = file.startLine === null ? "" : `:${file.startLine}${file.endLine === null || file.endLine === file.startLine ? "" : `-${file.endLine}`}`;
  const location = file.startLine === null ? null : ({ kind: "range", startLine: file.startLine, endLine: file.endLine ?? file.startLine } as const);
  return (
    <div className="rounded border border-border">
      <div className="flex items-center gap-2 px-2 py-1 text-xs">
        {environmentId !== null ? (
          <FileLink target={{ kind: "workspace", environmentId, path: file.path }} location={location} className="font-mono text-primary hover:underline">
            {file.path}
            {where}
          </FileLink>
        ) : (
          <span className="font-mono">
            {file.path}
            {where}
          </span>
        )}
        {file.note !== null ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{file.note}</span> : null}
        {file.snippet !== null ? (
          <button type="button" className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setOpen((v) => !v)}>
            {open ? "hide" : "show"}
          </button>
        ) : null}
      </div>
      {open && file.snippet !== null ? (
        <div className="max-h-72 overflow-auto border-t border-border text-xs">
          <SourceCode content={file.snippet} path={file.path} overflow="scroll" />
        </div>
      ) : null}
    </div>
  );
}

// ---- cards ---------------------------------------------------------------

export function CardView({
  rpc,
  threadId,
  card,
  environmentId,
  Diagram,
  defaultOpen = false,
}: {
  rpc: Rpc;
  threadId: string;
  card: Card;
  environmentId: string | null;
  Diagram: DiagramRenderer;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [chat, setChat] = useState(false);
  return (
    <div className={cn("my-1.5 rounded-md border text-sm", card.status === "pending" ? "border-dashed border-border" : "border-border bg-card")}>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left" onClick={() => setOpen((v) => !v)}>
        <Icon name={modeIcon[card.mode]} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{card.title}</span>
        {card.status === "pending" ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Icon name="LoaderCircle" className="size-3 animate-spin" /> writing…
          </span>
        ) : (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{CARD_MODE_LABEL[card.mode].split(" ").slice(-1)[0]}</span>
        )}
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-2">
          <p className="mb-2 text-[11px] text-muted-foreground">
            {card.mode === "question" ? "Asked" : "About"}: “{card.prompt.length > 160 ? `${card.prompt.slice(0, 160)}…` : card.prompt}”
          </p>
          {card.status === "pending" ? <p className="text-xs text-muted-foreground">The explainer is reading the RFC and writing this card. It appears here when published.</p> : null}
          {card.body !== "" ? <Markdown content={card.body} /> : null}
          {card.diagram !== null ? <Diagram lang={card.diagram.lang} source={card.diagram.source} startLine={card.anchor.line ?? 0} /> : null}
          {card.files.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1.5">
              {card.files.map((f, i) => (
                <CodeRefView key={`${f.path}:${i}`} file={f} environmentId={environmentId} />
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            {card.threadId !== null ? (
              <Button size="sm" variant={chat ? "default" : "outline"} className="h-6 text-xs" onClick={() => setChat((v) => !v)}>
                <Icon name="MessagesSquare" className="size-3.5" />
                {chat ? "Hide conversation" : "Ask a follow-up"}
              </Button>
            ) : null}
            <button
              type="button"
              className="ml-auto text-muted-foreground hover:text-destructive"
              onClick={() => void rpc.call("card_remove", { threadId, id: card.id }).catch((cause: unknown) => toast.error(describe(cause)))}
            >
              Remove
            </button>
          </div>
          {chat && card.threadId !== null ? (
            <div className="mt-2 h-80 overflow-hidden rounded-md border border-border">
              <ThreadChat threadId={card.threadId} variant="compact" layout="contained" permissionPolicy="inherit" className="h-full" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---- section chrome ------------------------------------------------------

export function TermChips({ terms, expanded }: { terms: Term[]; expanded: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (terms.length === 0) return null;
  return (
    <div className="my-1 flex flex-wrap items-start gap-1 text-[11px]">
      <span className="mr-1 text-muted-foreground">Terms:</span>
      {terms.map((t) =>
        expanded || open === t.term ? (
          <span key={t.term} className="rounded border border-border bg-muted/40 px-1.5 py-0.5">
            <button type="button" className="font-medium" onClick={() => setOpen(open === t.term ? null : t.term)}>
              {t.term}
            </button>
            <span className="text-muted-foreground"> — {t.definition}</span>
            {t.see !== null ? <span className="text-muted-foreground"> (see {t.see})</span> : null}
          </span>
        ) : (
          <button
            key={t.term}
            type="button"
            title={t.definition}
            onClick={() => setOpen(t.term)}
            className="rounded border border-border px-1.5 py-0.5 font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t.term}
          </button>
        ),
      )}
    </div>
  );
}

export function SectionChrome({
  section,
  notes,
  claims,
  cards,
  glossary,
  termsExpanded,
  onAddNote,
  onExplain,
  onOpenItems,
}: {
  section: DocSection;
  notes: Note[];
  claims: Claim[];
  cards: Card[];
  glossary: Term[];
  termsExpanded: boolean;
  onAddNote: (anchor: Anchor) => void;
  onExplain: (anchor: Anchor, mode: CardMode, prompt: string) => void;
  onOpenItems: (tab: "notes" | "claims", section: string | null) => void;
}) {
  const terms = useMemo(() => termsIn(section.text, glossary), [section.text, glossary]);
  const openNotes = notes.filter((n) => n.status === "open" || n.status === "blocked");
  const weakClaims = claims.filter((c) => c.status === "assumed" || c.status === "stale");
  const anchor: Anchor = { section: section.heading?.title ?? null, line: section.heading?.line ?? section.startLine, quote: null };
  const title = section.heading?.title ?? "this document";
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  return (
    <div className="rfc-section-chrome -mb-1 mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground opacity-70 transition-opacity hover:opacity-100">
      {openNotes.length > 0 ? (
        <button type="button" onClick={() => onOpenItems("notes", anchor.section)} className={cn("rounded px-1.5 py-0.5", noteTone[openNotes.some((n) => n.status === "blocked") ? "blocked" : "open"])} title="Open notes on this section">
          {openNotes.length} open note{openNotes.length === 1 ? "" : "s"}
        </button>
      ) : null}
      {weakClaims.length > 0 ? (
        <button type="button" onClick={() => onOpenItems("claims", anchor.section)} className={cn("rounded px-1.5 py-0.5", claimTone[weakClaims.some((c) => c.status === "stale") ? "stale" : "assumed"])} title="Unverified claims in this section">
          {weakClaims.length} unverified claim{weakClaims.length === 1 ? "" : "s"}
        </button>
      ) : null}
      {cards.length > 0 ? <span className="rounded bg-muted px-1.5 py-0.5">{cards.length} card{cards.length === 1 ? "" : "s"}</span> : null}
      <span className="ml-auto flex items-center gap-0.5">
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => onAddNote(anchor)} title={`Add a note on ${title}`}>
          + note
        </button>
        <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => onExplain(anchor, "concept", section.heading?.title ?? section.text.slice(0, 200))} title={`Explain ${title}`}>
          explain
        </button>
        <button type="button" className={cn("rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground", asking && "bg-muted text-foreground")} onClick={() => setAsking((v) => !v)} title={`Ask about ${title}`}>
          ask
        </button>
      </span>
      {asking ? (
        <form
          className="flex w-full items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (question.trim() === "") return;
            onExplain(anchor, "question", question.trim());
            setQuestion("");
            setAsking(false);
          }}
        >
          <Input value={question} onChange={(e) => setQuestion(e.target.value)} autoFocus placeholder={`Ask about ${title}…`} className="h-7 flex-1 text-xs" aria-label="Question" />
          <Button size="sm" type="submit" className="h-7 text-xs" disabled={question.trim() === ""}>
            Ask
          </Button>
        </form>
      ) : null}
      <div className="w-full">
        <TermChips terms={terms} expanded={termsExpanded} />
      </div>
    </div>
  );
}

// ---- selection toolbar ---------------------------------------------------

interface SelectionState {
  text: string;
  anchor: Anchor;
  x: number;
  y: number;
}

/** Floating actions for text selected inside the preview container. */
export function useSelectionActions(containerRef: RefObject<HTMLElement | null>, content: string) {
  const [sel, setSel] = useState<SelectionState | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const onUp = () => {
      window.setTimeout(() => {
        const s = window.getSelection();
        if (s === null || s.isCollapsed || s.rangeCount === 0) {
          setSel(null);
          return;
        }
        const range = s.getRangeAt(0);
        if (!el.contains(range.commonAncestorContainer)) {
          setSel(null);
          return;
        }
        const text = s.toString().replace(/\s+/g, " ").trim();
        if (text.length < 3) {
          setSel(null);
          return;
        }
        let node: Node | null = range.startContainer;
        let sectionEl: HTMLElement | null = null;
        while (node !== null && node !== el) {
          if (node instanceof HTMLElement && node.dataset.section !== undefined) {
            sectionEl = node;
            break;
          }
          node = node.parentNode;
        }
        const section = sectionEl?.dataset.section ?? null;
        const sectionLine = Number(sectionEl?.dataset.sectionLine ?? "1");
        const probe = text.slice(0, 40).toLowerCase();
        const lines = content.split("\n");
        let line: number | null = null;
        for (let i = Math.max(0, sectionLine - 1); i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(probe)) {
            line = i + 1;
            break;
          }
        }
        const rect = range.getBoundingClientRect();
        const host = el.getBoundingClientRect();
        setSel({
          text: text.slice(0, 600),
          anchor: { section: section === "" ? null : section, line, quote: text.slice(0, 600) },
          x: Math.max(8, rect.left - host.left + el.scrollLeft),
          y: rect.bottom - host.top + el.scrollTop + 6,
        });
      }, 0);
    };
    const onDown = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest("[data-selection-toolbar]") !== null) return;
      setSel(null);
    };
    el.addEventListener("mouseup", onUp);
    el.addEventListener("mousedown", onDown);
    return () => {
      el.removeEventListener("mouseup", onUp);
      el.removeEventListener("mousedown", onDown);
    };
  }, [containerRef, content]);
  return { selection: sel, clear: () => setSel(null) };
}

export function SelectionToolbar({
  selection,
  onNote,
  onExplain,
}: {
  selection: SelectionState;
  onNote: (anchor: Anchor, text: string) => void;
  onExplain: (anchor: Anchor, mode: CardMode, prompt: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [q, setQ] = useState("");
  return (
    <div
      data-selection-toolbar=""
      className="absolute z-20 flex max-w-[28rem] flex-wrap items-center gap-0.5 rounded-md border border-border bg-popover p-1 text-xs shadow-md"
      style={{ left: selection.x, top: selection.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button type="button" className="rounded px-2 py-1 hover:bg-muted" onClick={() => onNote(selection.anchor, selection.text)}>
        <Icon name="StickyNote" className="mr-1 inline size-3.5 align-text-bottom" />
        Note
      </button>
      <span className="mx-0.5 h-4 w-px bg-border" />
      {(["concept", "code", "data", "flow"] as CardMode[]).map((m) => (
        <button key={m} type="button" className="rounded px-2 py-1 hover:bg-muted" onClick={() => onExplain(selection.anchor, m, selection.text)} title={CARD_MODE_LABEL[m]}>
          <Icon name={modeIcon[m]} className="mr-1 inline size-3.5 align-text-bottom" />
          {m === "concept" ? "Explain" : m === "code" ? "Code" : m === "data" ? "Data" : "Flow"}
        </button>
      ))}
      <button type="button" className={cn("rounded px-2 py-1 hover:bg-muted", asking && "bg-muted")} onClick={() => setAsking((v) => !v)}>
        <Icon name="MessageCircleQuestion" className="mr-1 inline size-3.5 align-text-bottom" />
        Ask
      </button>
      {asking ? (
        <form
          className="flex w-full items-center gap-1 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim() === "") return;
            onExplain(selection.anchor, "question", `${q.trim()}\n\n(About: "${selection.text}")`);
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Your question about the selection" className="h-7 flex-1 text-xs" aria-label="Question" />
          <Button size="sm" type="submit" className="h-7 text-xs" disabled={q.trim() === ""}>
            Ask
          </Button>
        </form>
      ) : null}
    </div>
  );
}

// ---- notes ---------------------------------------------------------------

function NoteCard({ rpc, threadId, note, onJump }: { rpc: Rpc; threadId: string; note: Note; onJump: (anchor: Anchor) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [resolution, setResolution] = useState(note.resolution ?? "");
  const [chat, setChat] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (cause) {
      toast.error(describe(cause));
    } finally {
      setBusy(false);
    }
  };
  const where = [note.anchor.section, note.anchor.line === null ? null : `line ${note.anchor.line}`].filter(Boolean).join(" · ");
  return (
    <li className={cn("rounded-md border border-border px-3 py-2 text-sm", note.status === "superseded" && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={note.status}
          disabled={busy}
          onChange={(e) => void act(() => rpc.call("note_update", { threadId, id: note.id, status: e.target.value as NoteStatus }))}
          className={cn("h-6 rounded border-0 px-1.5 text-[10px] uppercase", noteTone[note.status])}
          aria-label="Note status"
        >
          {NOTE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {editing ? (
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-7 min-w-40 flex-1 text-sm" aria-label="Note title" />
        ) : (
          <span className="min-w-0 flex-1 font-medium">{note.title}</span>
        )}
        {where !== "" ? (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => onJump(note.anchor)} title="Jump to this place in the preview">
            {where}
          </button>
        ) : null}
        {note.createdBy === "agent" ? <span className="text-[10px] uppercase text-muted-foreground">agent</span> : null}
      </div>
      {note.anchor.quote !== null ? <blockquote className="mt-1 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">“{note.anchor.quote}”</blockquote> : null}
      {editing ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-20 w-full rounded border border-border bg-background p-2 text-xs" aria-label="Note body" placeholder="Why this matters, options, what would settle it" />
          <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} className="min-h-14 w-full rounded border border-border bg-background p-2 text-xs" aria-label="Resolution" placeholder="Resolution: what was decided and why (fill when decided)" />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-6 text-xs"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await rpc.call("note_update", { threadId, id: note.id, title, body, resolution: resolution.trim() === "" ? null : resolution });
                  setEditing(false);
                })
              }
            >
              Save
            </Button>
            <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {note.body.trim() !== "" ? (
            <div className="mt-1 text-sm [&_p]:my-1">
              <Markdown content={note.body} />
            </div>
          ) : null}
          {note.resolution !== null ? (
            <div className="mt-1.5 rounded bg-green-500/10 px-2 py-1.5 text-xs">
              <span className="font-medium">Resolution: </span>
              <Markdown content={note.resolution} />
            </div>
          ) : null}
        </>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => setEditing(true)}>
          <Icon name="Pencil" className="size-3.5" /> Edit
        </Button>
        <Button
          size="sm"
          variant={chat ? "default" : "outline"}
          className="h-6 text-xs"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              if (note.threadId === null) await rpc.call("note_discuss", { threadId, id: note.id });
              setChat((v) => !v);
            })
          }
        >
          <Icon name="MessagesSquare" className="size-3.5" />
          {note.threadId === null ? "Discuss" : chat ? "Hide discussion" : "Discussion"}
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">{new Date(note.updatedAt).toLocaleDateString()}</span>
        <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => void act(() => rpc.call("note_remove", { threadId, id: note.id }))}>
          Remove
        </button>
      </div>
      {chat && note.threadId !== null ? (
        <div className="mt-2 h-96 overflow-hidden rounded-md border border-border">
          <ThreadChat threadId={note.threadId} variant="compact" layout="contained" permissionPolicy="inherit" className="h-full" />
        </div>
      ) : null}
    </li>
  );
}

// ---- items view ----------------------------------------------------------

export type ItemsTab = "notes" | "claims" | "glossary";

export function ItemsView({
  rpc,
  threadId,
  sidecar,
  initialTab,
  sectionFilter,
  onJump,
}: {
  rpc: Rpc;
  threadId: string;
  sidecar: Sidecar | null;
  initialTab: ItemsTab;
  sectionFilter: string | null;
  onJump: (anchor: Anchor) => void;
}) {
  const [tab, setTab] = useState<ItemsTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const [noteFilter, setNoteFilter] = useState<NoteStatus | "all">("all");
  const [claimFilter, setClaimFilter] = useState<ClaimStatus | "all">("all");
  const [section, setSection] = useState<string | null>(sectionFilter);
  useEffect(() => setSection(sectionFilter), [sectionFilter]);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState("");
  const [termDraft, setTermDraft] = useState<{ term: string; definition: string; see: string } | null>(null);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (cause) {
      toast.error(`${label} failed: ${describe(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const notes = (sidecar?.notes ?? []).filter((n) => (noteFilter === "all" || n.status === noteFilter) && (section === null || sectionMatches(n.anchor.section, section)));
  const claims = (sidecar?.claims ?? []).filter((c) => (claimFilter === "all" || c.status === claimFilter) && (section === null || sectionMatches(c.anchor.section, section)));
  const noteCounts = Object.fromEntries(NOTE_STATUSES.map((s) => [s, (sidecar?.notes ?? []).filter((n) => n.status === s).length])) as Record<NoteStatus, number>;
  const claimCounts = Object.fromEntries(CLAIM_STATUSES.map((s) => [s, (sidecar?.claims ?? []).filter((c) => c.status === s).length])) as Record<ClaimStatus, number>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1 text-xs">
        {(
          [
            ["notes", `Notes ${sidecar?.notes.length ?? 0}`],
            ["claims", `Claims ${sidecar?.claims.length ?? 0}`],
            ["glossary", `Glossary ${sidecar?.glossary.length ?? 0}`],
          ] as Array<[ItemsTab, string]>
        ).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={cn("rounded px-2 py-1", tab === id ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
            {label}
          </button>
        ))}
        {section !== null ? (
          <button type="button" className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setSection(null)} title="Clear section filter">
            § {section} <Icon name="X" className="size-3" />
          </button>
        ) : null}
      </div>

      {tab === "notes" ? (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-[11px]">
            {(["all", ...NOTE_STATUSES] as Array<NoteStatus | "all">).map((s) => (
              <button key={s} type="button" onClick={() => setNoteFilter(s)} className={cn("rounded-full px-2 py-0.5 uppercase", s === "all" ? "bg-muted" : noteTone[s], noteFilter === s && "ring-1 ring-primary")}>
                {s} {s === "all" ? sidecar?.notes.length ?? 0 : noteCounts[s]}
              </button>
            ))}
            <form
              className="ml-auto flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (newTitle.trim() === "") return;
                void act("Add note", async () => {
                  await rpc.call("note_add", { threadId, anchor: { section, line: null, quote: null }, title: newTitle.trim(), body: "", status: "open", discuss: false });
                  setNewTitle("");
                });
              }}
            >
              <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={section === null ? "New note…" : `New note on ${section}…`} className="h-7 w-56 text-xs" aria-label="New note" />
              <Button size="sm" type="submit" className="h-7 text-xs" disabled={busy || newTitle.trim() === ""}>
                Add
              </Button>
            </form>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
            {notes.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">
                No notes{section === null ? "" : " on this section"}. Select text in the preview and choose Note, use “+ note” on a section, or ask the agent to record a decision.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {[...notes]
                  .sort((a, b) => (a.status === "open" || a.status === "blocked" ? 0 : 1) - (b.status === "open" || b.status === "blocked" ? 0 : 1) || b.updatedAt.localeCompare(a.updatedAt))
                  .map((n) => (
                    <NoteCard key={n.id} rpc={rpc} threadId={threadId} note={n} onJump={onJump} />
                  ))}
              </ul>
            )}
          </div>
        </>
      ) : null}

      {tab === "claims" ? (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-[11px]">
            {(["all", ...CLAIM_STATUSES] as Array<ClaimStatus | "all">).map((s) => (
              <button key={s} type="button" onClick={() => setClaimFilter(s)} className={cn("rounded-full px-2 py-0.5 uppercase", s === "all" ? "bg-muted" : claimTone[s], claimFilter === s && "ring-1 ring-primary")}>
                {s} {s === "all" ? sidecar?.claims.length ?? 0 : claimCounts[s]}
              </button>
            ))}
            <form
              className="ml-auto flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void act("Audit", async () => {
                  await rpc.call("claims_audit", { threadId, focus });
                  toast.success("Asked the RFC thread to audit the claims register.");
                  setFocus("");
                });
              }}
            >
              <Input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Focus (optional), e.g. vendor API claims" className="h-7 w-56 text-xs" aria-label="Audit focus" />
              <Button size="sm" type="submit" className="h-7 text-xs" disabled={busy}>
                <Icon name="ListChecks" className="size-3.5" /> Audit claims
              </Button>
            </form>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {claims.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No claims recorded{section === null ? "" : " for this section"}. Run an audit to extract the facts the design depends on, with sources and verification status.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-2 py-1">Key</th>
                    <th className="px-2 py-1">Claim</th>
                    <th className="px-2 py-1">Source</th>
                    <th className="px-2 py-1">Status</th>
                    <th className="px-2 py-1">Verified</th>
                    <th className="px-2 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {[...claims]
                    .sort((a, b) => CLAIM_STATUSES.indexOf(b.status) - CLAIM_STATUSES.indexOf(a.status) || (a.key ?? "").localeCompare(b.key ?? ""))
                    .map((c) => (
                      <tr key={c.id} className="border-t border-border align-top">
                        <td className="px-2 py-1.5 font-mono">{c.key ?? ""}</td>
                        <td className="px-2 py-1.5">
                          <div>{c.text}</div>
                          {c.note !== null ? <div className="mt-0.5 text-muted-foreground">{c.note}</div> : null}
                          {c.anchor.section !== null ? (
                            <button type="button" className="mt-0.5 text-[11px] text-muted-foreground hover:underline" onClick={() => onJump(c.anchor)}>
                              § {c.anchor.section}
                            </button>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">{c.source ?? ""}</td>
                        <td className="px-2 py-1.5">
                          <select
                            value={c.status}
                            disabled={busy}
                            onChange={(e) => void act("Update", () => rpc.call("claim_upsert", { threadId, claim: { ...c, status: e.target.value as ClaimStatus } }))}
                            className={cn("h-6 rounded border-0 px-1 text-[10px] uppercase", claimTone[c.status])}
                            aria-label="Claim status"
                          >
                            {CLAIM_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {c.verifiedAt ?? ""}
                          {c.against !== null ? <div>{c.against}</div> : null}
                        </td>
                        <td className="px-2 py-1.5">
                          <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => void act("Remove", () => rpc.call("claim_remove", { threadId, id: c.id }))}>
                            <Icon name="X" className="size-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}

      {tab === "glossary" ? (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-[11px]">
            <span className="text-muted-foreground">Terms and IDs the document uses. Each section lists the ones it mentions.</span>
            <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" disabled={busy} onClick={() => setTermDraft({ term: "", definition: "", see: "" })}>
              <Icon name="Plus" className="size-3.5" /> Term
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() =>
                void act("Glossary", async () => {
                  await rpc.call("glossary_request", { threadId });
                  toast.success("Asked the RFC thread to build the glossary.");
                })
              }
            >
              <Icon name="BookOpen" className="size-3.5" /> Build from document
            </Button>
          </div>
          {termDraft !== null ? (
            <form
              className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (termDraft.term.trim() === "" || termDraft.definition.trim() === "") return;
                void act("Save term", async () => {
                  await rpc.call("term_set", { threadId, term: { term: termDraft.term.trim(), definition: termDraft.definition.trim(), aliases: [], see: termDraft.see.trim() === "" ? null : termDraft.see.trim() } });
                  setTermDraft(null);
                });
              }}
            >
              <Input value={termDraft.term} onChange={(e) => setTermDraft({ ...termDraft, term: e.target.value })} placeholder="Term or ID" className="h-7 w-28 text-xs" aria-label="Term" autoFocus />
              <Input value={termDraft.definition} onChange={(e) => setTermDraft({ ...termDraft, definition: e.target.value })} placeholder="One-line definition" className="h-7 min-w-48 flex-1 text-xs" aria-label="Definition" />
              <Input value={termDraft.see} onChange={(e) => setTermDraft({ ...termDraft, see: e.target.value })} placeholder="See (section or ref)" className="h-7 w-40 text-xs" aria-label="See" />
              <Button size="sm" type="submit" className="h-7 text-xs" disabled={busy}>
                Save
              </Button>
              <Button size="sm" variant="outline" type="button" className="h-7 text-xs" onClick={() => setTermDraft(null)}>
                Cancel
              </Button>
            </form>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
            {(sidecar?.glossary ?? []).length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No terms yet. “Build from document” asks the agent to define every acronym and requirement ID the RFC uses.</p>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                {(sidecar?.glossary ?? []).map((t) => (
                  <div key={t.term} className="group contents">
                    <dt className="font-mono font-medium">{t.term}</dt>
                    <dd className="flex items-start gap-2">
                      <span className="min-w-0 flex-1">
                        {t.definition}
                        {t.see !== null ? <span className="text-muted-foreground"> — see {t.see}</span> : null}
                        {t.aliases.length > 0 ? <span className="text-muted-foreground"> (also: {t.aliases.join(", ")})</span> : null}
                      </span>
                      <button type="button" className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100" onClick={() => setTermDraft({ term: t.term, definition: t.definition, see: t.see ?? "" })} title="Edit">
                        <Icon name="Pencil" className="size-3.5" />
                      </button>
                      <button type="button" className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100" onClick={() => void act("Remove", () => rpc.call("term_remove", { threadId, term: t.term }))} title="Remove">
                        <Icon name="X" className="size-3.5" />
                      </button>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---- walkthrough view ----------------------------------------------------

export function WalkthroughView({
  rpc,
  threadId,
  sidecar,
  environmentId,
  Diagram,
  onJump,
}: {
  rpc: Rpc;
  threadId: string;
  sidecar: Sidecar | null;
  environmentId: string | null;
  Diagram: DiagramRenderer;
  onJump: (anchor: Anchor) => void;
}) {
  const list = sidecar?.walkthroughs ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const current: Walkthrough | null = list.find((w) => w.id === selectedId) ?? list[list.length - 1] ?? null;
  const [step, setStep] = useState(0);
  const [audience, setAudience] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setStep(0), [current?.id]);
  const stepRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stepRef.current?.scrollTo({ top: 0 });
  }, [step, current?.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (current === null) return;
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
      if (e.key === "ArrowRight" || e.key === "j") setStep((s) => Math.min(current.steps.length - 1, s + 1));
      if (e.key === "ArrowLeft" || e.key === "k") setStep((s) => Math.max(0, s - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  const generate = async () => {
    setBusy(true);
    try {
      await rpc.call("walkthrough_request", { threadId, audience });
      toast.success("Asked the RFC thread to write a walkthrough. It appears here when published.");
      setAudience("");
    } catch (cause) {
      toast.error(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const s = current?.steps[step] ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-xs">
        {list.length > 1 ? (
          <select value={current?.id ?? ""} onChange={(e) => setSelectedId(e.target.value)} className="h-7 rounded border border-border bg-background px-1 text-xs" aria-label="Walkthrough">
            {list.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title}
              </option>
            ))}
          </select>
        ) : current !== null ? (
          <span className="font-medium">{current.title}</span>
        ) : null}
        {current?.audience ? <span className="text-muted-foreground">for {current.audience}</span> : null}
        <form
          className="ml-auto flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <Input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Audience (optional): first read, security review…" className="h-7 w-64 text-xs" aria-label="Audience" />
          <Button size="sm" type="submit" className="h-7 text-xs" disabled={busy}>
            <Icon name="Play" className="size-3.5" /> {list.length === 0 ? "Generate walkthrough" : "New walkthrough"}
          </Button>
        </form>
        {current !== null ? (
          <button type="button" className="text-muted-foreground hover:text-destructive" title="Remove this walkthrough" onClick={() => void rpc.call("walkthrough_remove", { threadId, id: current.id }).catch((cause: unknown) => toast.error(describe(cause)))}>
            <Icon name="X" className="size-3.5" />
          </button>
        ) : null}
      </div>
      {current === null || s === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          <div>
            <Icon name="Play" className="mx-auto mb-2 size-8 opacity-40" />
            <p>No walkthrough yet. Generate one and the agent will teach the design step by step: problem, answer, moving parts, main flow, hard decisions, and what is still unverified.</p>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ol className="w-60 shrink-0 overflow-auto border-r border-border py-2 text-xs">
            {current.steps.map((st, i) => (
              <li key={i}>
                <button type="button" onClick={() => setStep(i)} className={cn("flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-muted/60", i === step && "bg-muted font-medium")}>
                  <span className="w-4 shrink-0 text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 flex-1">{st.title}</span>
                </button>
              </li>
            ))}
          </ol>
          <div ref={stepRef} className="min-h-0 min-w-0 flex-1 overflow-auto px-5 py-3">
            <div className="mx-auto max-w-3xl">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  Step {step + 1} of {current.steps.length}
                </span>
                {s.anchor.section !== null ? (
                  <button type="button" className="hover:text-foreground hover:underline" onClick={() => onJump(s.anchor)}>
                    § {s.anchor.section}
                  </button>
                ) : null}
              </div>
              <h2 className="mb-2 text-lg font-semibold">{s.title}</h2>
              <Markdown content={s.body} />
              {s.diagram !== null ? <Diagram lang={s.diagram.lang} source={s.diagram.source} startLine={s.anchor.line ?? 0} /> : null}
              {s.files.length > 0 ? (
                <div className="mt-3 flex flex-col gap-1.5">
                  {s.files.map((f, i) => (
                    <CodeRefView key={`${f.path}:${i}`} file={f} environmentId={environmentId} />
                  ))}
                </div>
              ) : null}
              <div className="mt-4 flex items-center gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={step === 0} onClick={() => setStep((x) => x - 1)}>
                  <Icon name="ChevronLeft" className="size-3.5" /> Back
                </Button>
                <Button size="sm" className="h-7 text-xs" disabled={step >= current.steps.length - 1} onClick={() => setStep((x) => x + 1)}>
                  Next <Icon name="ChevronRight" className="size-3.5" />
                </Button>
                <span className="text-[11px] text-muted-foreground">← → or j/k</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export type { Anchor, CardMode, ReactNode };
export { CARD_MODES };
