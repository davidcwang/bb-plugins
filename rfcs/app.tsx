// bb-plugin-rfcs — frontend entry.
//
// Registers an "RFC" tab for the thread panel with four views: Preview (live
// rendered markdown with mermaid + D2 diagrams), Edit (textarea with CAS
// saves), Split (both), and Review (findings with accept/skip/discuss). Also
// registers a markdown file opener that renders diagram fences inline.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import { Markdown, ThreadChat, definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import mermaid from "mermaid";
import { toast } from "sonner";
import type { Candidate, DocRead, DocRef, Finding, LibraryItem, ReviewState, rpcContract } from "./server";
import { CHANGED, PRIORITIES, markdownBlocks, parseFrontmatter, splitSections, type ChangedPayload, type DocSection, type Priority } from "./shared";
import type { Anchor, CardMode } from "./sidecar";
import { CardView, ItemsView, SectionChrome, SelectionToolbar, WalkthroughView, itemsForSection, useSelectionActions, useSidecar, type DiagramRenderer, type ItemsTab } from "./app-sidecar";
import type { Sidecar } from "./sidecar";
import { recall, remember } from "./memory";
import { Button } from "@/components/ui/button";
import { ICON_NAMES, Icon, iconComponent } from "./icons";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const POLL_MS = 1500;

// ---- theme ---------------------------------------------------------------

function readDark(): boolean {
  const root = document.documentElement;
  if (root.classList.contains("dark")) return true;
  if (root.classList.contains("light")) return false;
  const scheme = getComputedStyle(root).colorScheme;
  if (scheme.includes("dark")) return true;
  if (scheme.includes("light")) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(readDark);
  useEffect(() => {
    const update = () => setDark(readDark());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return dark;
}

// ---- data hooks ----------------------------------------------------------

interface ThreadContextInfo {
  environmentId: string | null;
  hostId: string | null;
  workspacePath: string | null;
  rfcDir: string | null;
  doc: DocRef | null;
}

function useThreadContext(rpc: Rpc, threadId: string) {
  const [context, setContext] = useState<ThreadContextInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    rpc.call("context_get", { threadId }).then(
      (c) => {
        setContext(c);
        setError(null);
      },
      (cause: unknown) => setError(describe(cause)),
    );
  }, [rpc, threadId]);
  useEffect(reload, [reload]);
  useRealtime(CHANGED, (payload: unknown) => {
    const p = payload as ChangedPayload;
    if (p.threadId === threadId && p.kind === "doc") reload();
  });
  return { context, error, reload };
}

/** The RFC's content, refreshed by polling and by the server's change signal. */
function useDoc(rpc: Rpc, threadId: string, docPath: string | null, active: boolean) {
  const [doc, setDoc] = useState<DocRead | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const shaRef = useRef<string | null>(null);
  const reload = useCallback(() => {
    if (docPath === null) {
      setDoc(null);
      return;
    }
    rpc.call("doc_read", { threadId }).then(
      (result) => {
        setError(null);
        if (result === null) {
          shaRef.current = null;
          setDoc(null);
          return;
        }
        if (result.sha256 !== shaRef.current) {
          shaRef.current = result.sha256;
          setDoc(result);
        }
      },
      (cause: unknown) => setError(describe(cause)),
    );
  }, [rpc, threadId, docPath]);
  useEffect(() => {
    shaRef.current = null;
    setDoc(undefined);
    reload();
  }, [reload]);
  useEffect(() => {
    if (!active || docPath === null) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload, active, docPath]);
  useRealtime(CHANGED, (payload: unknown) => {
    const p = payload as ChangedPayload;
    if (p.threadId === threadId && p.kind === "doc") reload();
  });
  return { doc, error, reload };
}

/** Unread / needs-input / working state for a few threads, refreshed on thread events. */
function useThreadStates(rpc: Rpc, threadIds: string[]) {
  const [states, setStates] = useState<Record<string, { status: string; unread: boolean; needsInput: boolean }>>({});
  const key = threadIds.join(",");
  const reload = useCallback(() => {
    if (threadIds.length === 0) return;
    rpc.call("threads_state", { threadIds }).then(
      (rows) => setStates(Object.fromEntries(rows.map((r) => [r.id, { status: r.status, unread: r.unread, needsInput: r.needsInput }]))),
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, key]);
  useEffect(reload, [reload]);
  useEffect(() => {
    const t = window.setInterval(reload, 15_000);
    return () => window.clearInterval(t);
  }, [reload]);
  useRealtime(CHANGED, (payload: unknown) => {
    const p = payload as ChangedPayload;
    if (p.kind === "thread" && threadIds.includes(p.threadId)) reload();
  });
  return states;
}

function useReview(rpc: Rpc, threadId: string) {
  const [review, setReview] = useState<ReviewState | null>(null);
  const reload = useCallback(() => {
    rpc.call("review_get", { threadId }).then(setReview, () => undefined);
  }, [rpc, threadId]);
  useEffect(reload, [reload]);
  useRealtime(CHANGED, (payload: unknown) => {
    const p = payload as ChangedPayload;
    if (p.threadId === threadId && p.kind === "review") reload();
  });
  return { review, reload };
}

// ---- diagrams ------------------------------------------------------------

let mermaidTheme: "dark" | "default" | null = null;
function ensureMermaid(dark: boolean) {
  const theme = dark ? "dark" : "default";
  if (mermaidTheme === theme) return;
  mermaidTheme = theme;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme,
    fontFamily: "inherit",
    flowchart: { htmlLabels: false },
  });
}

function hashString(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const mermaidCache = new Map<string, string>();

function DiagramFrame({
  lang,
  source,
  svg,
  error,
  pending,
  startLine,
}: {
  lang: string;
  source: string;
  svg: string | null;
  error: string | null;
  pending: boolean;
  startLine: number;
}) {
  const [showSource, setShowSource] = useState(error !== null);
  useEffect(() => {
    if (error !== null) setShowSource(true);
  }, [error]);
  return (
    <figure data-src-line={startLine} className="group my-3 rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
        <Icon name={lang === "d2" ? "Boxes" : "GitBranch"} className="size-3.5" />
        <span className="font-mono">{lang}</span>
        <span className="opacity-70">line {startLine}</span>
        {pending ? <span className="italic">rendering…</span> : null}
        <span className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => setShowSource((v) => !v)}>
            {showSource ? "Hide source" : "Source"}
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-muted"
            onClick={() => {
              void navigator.clipboard.writeText(source);
              toast.success("Diagram source copied.");
            }}
          >
            Copy
          </button>
          {svg !== null ? (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 hover:bg-muted"
              onClick={() => {
                void navigator.clipboard.writeText(svg);
                toast.success("SVG copied.");
              }}
            >
              Copy SVG
            </button>
          ) : null}
        </span>
      </div>
      {error !== null ? (
        <pre className="m-0 whitespace-pre-wrap border-b border-border px-3 py-2 text-xs text-destructive">{error}</pre>
      ) : null}
      {svg !== null ? <DiagramViewport svg={svg} tall={lang === "d2"} /> : null}
      {showSource ? (
        <pre className="m-0 overflow-auto border-t border-border bg-muted/40 px-3 py-2 font-mono text-xs leading-5">{source}</pre>
      ) : null}
    </figure>
  );
}

/**
 * Pan/zoom viewport for a rendered SVG. Zoom with ⌘/Ctrl + wheel (trackpad
 * pinch arrives the same way) or the buttons; drag to pan; double-click or
 * the reset button returns to fit.
 */
function DiagramViewport({ svg, tall }: { svg: string; tall: boolean }) {
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const zoomed = t.scale !== 1 || t.x !== 0 || t.y !== 0;
  const clamp = (v: number) => Math.min(8, Math.max(0.25, v));
  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    setT((cur) => {
      const next = clamp(cur.scale * factor);
      const el = ref.current;
      if (el === null || cx === undefined || cy === undefined) return { ...cur, scale: next };
      const rect = el.getBoundingClientRect();
      const px = cx - rect.left - rect.width / 2;
      const py = cy - rect.top - rect.height / 2;
      const k = next / cur.scale;
      return { scale: next, x: px - (px - cur.x) * k, y: py - (py - cur.y) * k };
    });
  };
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) && !zoomed) return; // leave page scrolling alone until zoomed in
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      else setT((cur) => ({ ...cur, x: cur.x - e.deltaX, y: cur.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomed]);
  const reset = () => setT({ scale: 1, x: 0, y: 0 });
  return (
    <div className="relative">
      <div
        ref={ref}
        className={cn("rfc-diagram overflow-hidden px-3 py-3 select-none", tall ? "max-h-[70vh]" : "", drag.current !== null ? "cursor-grabbing" : "cursor-grab")}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d === null) return;
          setT((cur) => ({ ...cur, x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onDoubleClick={reset}
      >
        <div
          className="[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`, transformOrigin: "center center", transition: drag.current ? "none" : "transform 60ms linear" }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded border border-border bg-background/90 text-[11px] text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100">
        <button type="button" className="px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => zoomAt(1 / 1.25)} title="Zoom out (⌘/Ctrl + wheel)">
          −
        </button>
        <button type="button" className="min-w-10 px-1 py-0.5 tabular-nums hover:bg-muted hover:text-foreground" onClick={reset} title="Reset (double-click the diagram)">
          {Math.round(t.scale * 100)}%
        </button>
        <button type="button" className="px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => zoomAt(1.25)} title="Zoom in (⌘/Ctrl + wheel)">
          +
        </button>
      </div>
    </div>
  );
}

function MermaidBlock({ source, startLine, dark }: { source: string; startLine: number; dark: boolean }) {
  const [state, setState] = useState<{ svg: string | null; error: string | null; pending: boolean }>({
    svg: null,
    error: null,
    pending: true,
  });
  useEffect(() => {
    let cancelled = false;
    ensureMermaid(dark);
    const cacheKey = `${dark}|${source}`;
    const hit = mermaidCache.get(cacheKey);
    if (hit !== undefined) {
      setState({ svg: hit, error: null, pending: false });
      return;
    }
    setState((s) => ({ ...s, pending: true }));
    const id = `rfc-m${hashString(cacheKey)}-${Math.random().toString(36).slice(2, 6)}`;
    const timer = window.setTimeout(() => {
      mermaid
        .render(id, source.trim() === "" ? "graph TD\n  empty[empty diagram]" : source)
        .then(({ svg }) => {
          if (cancelled) return;
          mermaidCache.set(cacheKey, svg);
          setState({ svg, error: null, pending: false });
        })
        .catch((cause: unknown) => {
          document.getElementById(`d${id}`)?.remove();
          if (cancelled) return;
          setState((s) => ({ svg: s.svg, error: describe(cause), pending: false }));
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, dark]);
  return <DiagramFrame lang="mermaid" source={source} startLine={startLine} {...state} />;
}

function D2Block({ rpc, source, startLine, dark }: { rpc: Rpc; source: string; startLine: number; dark: boolean }) {
  const [state, setState] = useState<{ svg: string | null; error: string | null; pending: boolean }>({
    svg: null,
    error: null,
    pending: true,
  });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, pending: true }));
    const timer = window.setTimeout(() => {
      rpc.call("diagram_render", { lang: "d2", source, dark }).then(
        (result) => {
          if (cancelled) return;
          if (result.ok) setState({ svg: result.svg, error: null, pending: false });
          else setState((s) => ({ svg: s.svg, error: result.error, pending: false }));
        },
        (cause: unknown) => {
          if (!cancelled) setState((s) => ({ svg: s.svg, error: describe(cause), pending: false }));
        },
      );
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rpc, source, dark]);
  return <DiagramFrame lang="d2" source={source} startLine={startLine} {...state} />;
}

// ---- view memory ---------------------------------------------------------

/**
 * Remember an element's scroll position under `key`. Restores once `ready`
 * turns true, retrying briefly while async content (diagrams) changes height,
 * and stops retrying as soon as the user scrolls.
 */
function useScrollMemory<T extends HTMLElement>(key: string, ready: boolean) {
  const ref = useRef<T>(null);
  const userScrolled = useRef(false);
  const restoring = useRef(false);
  useEffect(() => {
    userScrolled.current = false;
  }, [key]);
  useEffect(() => {
    const el = ref.current;
    if (!ready || el === null) return;
    const target = Number(recall(`scroll:${key}`) ?? "0");
    if (!(target > 0)) return;
    const apply = () => {
      if (userScrolled.current || ref.current === null) return;
      restoring.current = true;
      ref.current.scrollTop = target;
      requestAnimationFrame(() => {
        restoring.current = false;
      });
    };
    const frame = requestAnimationFrame(apply);
    const timers = [150, 400, 900, 1800].map((ms) => window.setTimeout(apply, ms));
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [key, ready]);
  const saveTimer = useRef(0);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el === null || restoring.current) return;
    userScrolled.current = true;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => remember(`scroll:${key}`, String(Math.round(el.scrollTop))), 150);
  }, [key]);
  return { ref, onScroll };
}

// ---- split pane ----------------------------------------------------------

/** Two panes side by side with a draggable divider; ratio persists per key. */
function SplitPane({
  storageKey,
  initial = 0.5,
  min = 0.2,
  max = 0.8,
  left,
  right,
  className,
  minLeftPx = 0,
  minRightPx = 0,
  collapsed = false,
  collapsedRail,
}: {
  storageKey: string;
  initial?: number;
  min?: number;
  max?: number;
  left: React.ReactNode;
  right: React.ReactNode;
  className?: string;
  /** Pixel floors for each pane; the ratio is clamped so neither collapses. */
  minLeftPx?: number;
  minRightPx?: number;
  /** Hide the right pane (kept mounted, so its state survives) and show `collapsedRail` instead. */
  collapsed?: boolean;
  collapsedRail?: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  const [ratio, setRatio] = useState(() => {
    const saved = Number(recall(`split:${storageKey}`));
    return Number.isFinite(saved) && saved > min && saved < max ? saved : initial;
  });
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const dragging = useRef(false);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || rootRef.current === null) return;
    const rect = rootRef.current.getBoundingClientRect();
    setRatio(Math.min(max, Math.max(min, (event.clientX - rect.left) / rect.width)));
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    remember(`split:${storageKey}`, String(ratioRef.current));
  };
  const onDoubleClick = () => {
    setRatio(initial);
    remember(`split:${storageKey}`, null);
  };
  // Apply pixel floors on top of the ratio so a narrow window never squeezes
  // a pane (bb's chat composer needs ~380px to lay out).
  let effective = ratio;
  if (width !== null && width > 0) {
    const lo = minLeftPx / width;
    const hi = 1 - minRightPx / width;
    if (lo <= hi) effective = Math.min(hi, Math.max(lo, ratio));
  }
  return (
    <div ref={rootRef} className={cn("flex min-h-0 min-w-0 flex-1", className)}>
      <div className="flex min-h-0 min-w-0 flex-col transition-[width] duration-200 ease-out" style={{ width: collapsed ? "100%" : `${effective * 100}%` }}>
        {left}
      </div>
      {collapsed ? (
        collapsedRail ?? null
      ) : (
        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize; double-click to reset"
          className="w-1.5 shrink-0 cursor-col-resize touch-none border-x border-border bg-muted/40 transition-colors hover:bg-primary/40 active:bg-primary/60"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
        />
      )}
      <div className={cn("flex min-h-0 min-w-0 flex-col", collapsed ? "w-0 overflow-hidden opacity-0" : "flex-1 opacity-100")} aria-hidden={collapsed} inert={collapsed ? true : undefined}>
        {right}
      </div>
    </div>
  );
}

// ---- preview -------------------------------------------------------------

function Frontmatter({ meta }: { meta: Record<string, string> }) {
  const entries = Object.entries(meta).filter(([, v]) => v.trim() !== "");
  if (entries.length === 0) return null;
  const status = meta.status?.toLowerCase();
  return (
    <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
      {entries.map(([k, v]) => (
        <span key={k} className="flex items-center gap-1">
          <span className="text-muted-foreground">{k}</span>
          <span
            className={cn(
              "font-medium",
              k === "status" &&
                (status === "approved" || status === "accepted"
                  ? "text-green-600 dark:text-green-400"
                  : status === "rejected" || status === "withdrawn"
                    ? "text-destructive"
                    : status === "draft"
                      ? "text-amber-600 dark:text-amber-400"
                      : ""),
            )}
          >
            {v}
          </span>
        </span>
      ))}
    </div>
  );
}

export interface PreviewAnnotations {
  threadId: string;
  sidecar: Sidecar | null;
  environmentId: string | null;
  termsExpanded: boolean;
  onAddNote: (anchor: Anchor, title: string) => void;
  onExplain: (anchor: Anchor, mode: CardMode, prompt: string) => void;
  onOpenItems: (tab: ItemsTab, section: string | null) => void;
}

/** Diagram renderer handed to sidecar cards and walkthrough steps. */
function DiagramAny({ lang, source, startLine }: { lang: "mermaid" | "d2"; source: string; startLine: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const dark = useIsDark();
  return lang === "mermaid" ? <MermaidBlock source={source} startLine={startLine} dark={dark} /> : <D2Block rpc={rpc} source={source} startLine={startLine} dark={dark} />;
}
const DiagramForCards: DiagramRenderer = DiagramAny;

export function docSections(content: string): { meta: Record<string, string> | null; sections: DocSection[] } {
  const fm = parseFrontmatter(content);
  if (fm === null) return { meta: null, sections: splitSections(content, 0) };
  const offset = content.slice(0, content.length - fm.body.length).split("\n").length - 1;
  return { meta: fm.meta, sections: splitSections(fm.body, offset) };
}

export function RfcPreview({ rpc, content, className, annotate }: { rpc: Rpc; content: string; className?: string; annotate?: PreviewAnnotations }) {
  const dark = useIsDark();
  const { meta, sections } = useMemo(() => docSections(content), [content]);
  const articleRef = useRef<HTMLElement>(null);
  const { selection, clear } = useSelectionActions(articleRef, annotate === undefined ? "" : content);
  const sidecar = annotate?.sidecar ?? null;
  return (
    <article ref={articleRef} className={cn("rfc-preview relative px-4 py-3", className)}>
      {meta !== null ? <Frontmatter meta={meta} /> : null}
      {sections.map((section, index) => {
        const next = sections[index + 1]?.startLine ?? null;
        const notes = sidecar === null ? [] : itemsForSection(sidecar.notes, section, next);
        const claims = sidecar === null ? [] : itemsForSection(sidecar.claims, section, next);
        const cards = sidecar === null ? [] : itemsForSection(sidecar.cards, section, next);
        const key = `s:${section.startLine}:${hashString(section.text)}`;
        return (
          <section key={key} data-section={section.heading?.title ?? ""} data-section-line={section.startLine} className="rfc-section">
            {annotate !== undefined && (section.heading !== null || notes.length + claims.length + cards.length > 0) ? (
              <SectionChrome
                section={section}
                notes={notes}
                claims={claims}
                cards={cards}
                glossary={sidecar?.glossary ?? []}
                termsExpanded={annotate.termsExpanded}
                onAddNote={annotate.onAddNote}
                onExplain={annotate.onExplain}
                onOpenItems={annotate.onOpenItems}
              />
            ) : null}
            {section.segments.map((segment) => {
              const segKey = `${segment.kind}:${segment.startLine}:${hashString(segment.text)}`;
              if (segment.kind === "markdown")
                return (
                  <div key={segKey} data-src-line={segment.startLine} data-md="">
                    <Markdown content={segment.text} />
                  </div>
                );
              if (segment.lang === "mermaid") return <MermaidBlock key={segKey} source={segment.text} startLine={segment.startLine} dark={dark} />;
              return <D2Block key={segKey} rpc={rpc} source={segment.text} startLine={segment.startLine} dark={dark} />;
            })}
            {annotate !== undefined && cards.length > 0 ? (
              <div className="rfc-cards mb-2">
                {cards.map((card) => (
                  <CardView key={card.id} rpc={rpc} threadId={annotate.threadId} card={card} environmentId={annotate.environmentId} Diagram={DiagramForCards} defaultOpen={card.status === "pending"} />
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
      {sections.length === 0 ? <p className="text-sm text-muted-foreground">Empty document.</p> : null}
      {annotate !== undefined && selection !== null ? (
        <SelectionToolbar
          selection={selection}
          onNote={(anchor, title) => {
            annotate.onAddNote(anchor, title);
            clear();
            window.getSelection()?.removeAllRanges();
          }}
          onExplain={(anchor, mode, prompt) => {
            annotate.onExplain(anchor, mode, prompt);
            clear();
            window.getSelection()?.removeAllRanges();
          }}
        />
      ) : null}
    </article>
  );
}

// ---- editor/preview scroll sync -------------------------------------------

/** Line-addressable scroll surface: `lineAtTop` is 1-based and fractional. */
interface LineScroller {
  lineAtTop(): number;
  scrollToLine(line: number): void;
}

/** Normalize text for matching a source block against its rendered element. */
function matchKey(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/[`*_~#>|\[\]()!\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Source units worth anchoring: blocks, plus each table row and list item. */
function sourceUnits(text: string, firstLine: number): Array<{ line: number; key: string }> {
  const lines = text.split("\n");
  const at = (rel: number) => lines[rel - 1] ?? "";
  const units: Array<{ line: number; key: string }> = [];
  const push = (rel: number, raw: string) => {
    const key = matchKey(raw).slice(0, 32);
    if (key.length >= 3) units.push({ line: firstLine + rel - 1, key });
  };
  for (const block of markdownBlocks(text)) {
    if (block.kind === "table" && block.rows !== undefined) {
      for (const row of block.rows) {
        const cells = at(row).split("|").map((c) => c.trim()).filter((c) => c !== "");
        push(row, cells[0] ?? "");
      }
    } else if (block.kind === "list" && block.items !== undefined) {
      for (const item of block.items) push(item, at(item).replace(/^\s*([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/, ""));
    } else if (block.kind === "code") {
      let rel = block.line + 1;
      while (rel <= lines.length && at(rel).trim() === "") rel++;
      push(block.line, at(rel));
    } else if (block.kind !== "hr") {
      push(block.line, at(block.line));
    }
  }
  return units;
}

/**
 * Anchors for a rendered preview: elements whose source line is known, with
 * their offset inside the scroll container. Source units are matched to
 * rendered block elements in document order by their leading text, so the
 * mapping does not depend on how the host's Markdown renderer nests its DOM.
 * Between anchors, position is interpolated linearly in both directions.
 */
function previewAnchors(container: HTMLElement, content: string): Array<{ line: number; top: number }> {
  const base = container.getBoundingClientRect().top - container.scrollTop;
  const topOf = (el: Element) => el.getBoundingClientRect().top - base;
  const anchors: Array<{ line: number; top: number }> = [{ line: 1, top: 0 }];
  const mdSegments = docSections(content).sections.flatMap((sec) => sec.segments).filter((seg) => seg.kind === "markdown");
  const wrappers = Array.from(container.querySelectorAll("[data-md]"));
  wrappers.forEach((wrapper, w) => {
    const seg = mdSegments[w];
    if (seg === undefined) return;
    const segLine = seg.startLine;
    anchors.push({ line: segLine, top: topOf(wrapper) });
    const elems = Array.from(wrapper.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, tr, pre, blockquote"));
    const keys = elems.map((el) => matchKey(el.textContent ?? ""));
    let p = 0;
    for (const unit of sourceUnits(seg.text, segLine)) {
      const limit = Math.min(elems.length, p + 60);
      let found = -1;
      for (let k = p; k < limit; k++) {
        if (keys[k]!.startsWith(unit.key)) {
          found = k;
          break;
        }
      }
      if (found === -1) {
        for (let k = p; k < limit; k++) {
          if (keys[k]!.includes(unit.key)) {
            found = k;
            break;
          }
        }
      }
      if (found === -1) continue;
      anchors.push({ line: unit.line, top: topOf(elems[found]!) });
      p = found + 1;
    }
  });
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("figure[data-src-line]"))) {
    const line = Number(el.dataset.srcLine);
    if (Number.isFinite(line)) anchors.push({ line, top: topOf(el) });
  }
  const totalLines = content.split("\n").length;
  anchors.push({ line: totalLines + 1, top: container.scrollHeight });
  anchors.sort((a, b) => a.line - b.line || a.top - b.top);
  // Keep a strictly increasing chain so interpolation never runs backwards.
  const chain: Array<{ line: number; top: number }> = [];
  for (const a of anchors) {
    const last = chain[chain.length - 1];
    if (last === undefined || (a.line > last.line && a.top >= last.top)) chain.push(a);
    else if (a.line === last.line) last.top = Math.min(last.top, a.top);
  }
  (window as unknown as { __rfcsAnchors?: unknown }).__rfcsAnchors = chain;
  return chain;
}

function previewScroller(container: HTMLElement, content: string): LineScroller {
  // Anchor offsets are scroll-independent; recompute only when layout changes.
  let cache: { size: string; chain: Array<{ line: number; top: number }> } | null = null;
  const chainNow = () => {
    const size = `${container.scrollHeight}|${container.clientWidth}`;
    if (cache === null || cache.size !== size) cache = { size, chain: previewAnchors(container, content) };
    return cache.chain;
  };
  return {
    lineAtTop() {
      const chain = chainNow();
      const y = container.scrollTop;
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i]!;
        const b = chain[i + 1]!;
        if (y < b.top || i === chain.length - 2) {
          const span = b.top - a.top;
          const t = span <= 0 ? 0 : Math.min(1, Math.max(0, (y - a.top) / span));
          return a.line + t * (b.line - a.line);
        }
      }
      return 1;
    },
    scrollToLine(line) {
      const chain = chainNow();
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i]!;
        const b = chain[i + 1]!;
        if (line < b.line || i === chain.length - 2) {
          const t = Math.min(1, Math.max(0, (line - a.line) / (b.line - a.line)));
          container.scrollTop = Math.max(0, a.top + t * (b.top - a.top));
          return;
        }
      }
    },
  };
}

/**
 * Two-way sync between the editor and the preview, keyed on the first line
 * at the top of each pane. Whichever side the user scrolls drives the other;
 * the follower's own scroll event is ignored for a moment so they never
 * bounce off each other.
 */
function useScrollSync() {
  const editor = useRef<LineScroller | null>(null);
  const preview = useRef<LineScroller | null>(null);
  const leader = useRef<{ side: "editor" | "preview"; until: number } | null>(null);
  const frame = useRef(0);
  const follow = useCallback((from: "editor" | "preview") => {
    const now = performance.now();
    const lead = leader.current;
    if (lead !== null && lead.side !== from && now < lead.until) return;
    leader.current = { side: from, until: now + 180 };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const src = from === "editor" ? editor.current : preview.current;
      const dst = from === "editor" ? preview.current : editor.current;
      if (src === null || dst === null) return;
      dst.scrollToLine(src.lineAtTop());
    });
  }, []);
  return { editor, preview, follow };
}
type ScrollSync = ReturnType<typeof useScrollSync>;

// ---- editor --------------------------------------------------------------

function RfcEditor({ rpc, threadId, doc, onSaved, sync }: { rpc: Rpc; threadId: string; doc: DocRead; onSaved: () => void; sync?: ScrollSync }) {
  const [text, setText] = useState(doc.content);
  const [baseSha, setBaseSha] = useState(doc.sha256);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const dirty = text !== doc.content && baseSha === doc.sha256 ? true : text !== doc.content;
  // The file changed on disk (agent or external editor) while we hold the same sha → adopt it.
  const changedOnDisk = doc.sha256 !== baseSha;
  useEffect(() => {
    if (changedOnDisk && !dirty) {
      setText(doc.content);
      setBaseSha(doc.sha256);
    }
  }, [changedOnDisk, dirty, doc.content, doc.sha256]);

  // Latest values for the blur / unmount autosave paths, which run outside React's render cycle.
  const latest = useRef({ text, baseSha, dirty, saving: false });
  latest.current = { ...latest.current, text, baseSha, dirty };

  const save = useCallback(
    async (mode: "manual" | "auto" = "manual") => {
      const cur = latest.current;
      if (cur.saving) return;
      if (mode === "auto" && !cur.dirty) return;
      latest.current.saving = true;
      setSaving(true);
      try {
        const result = await rpc.call("doc_write", { threadId, content: cur.text, expectedSha256: cur.baseSha });
        if (result.outcome === "written") {
          latest.current.baseSha = result.sha256;
          setBaseSha(result.sha256);
          setConflict(false);
          onSaved();
          if (mode === "manual") toast.success("Saved.");
        } else {
          setConflict(true);
          if (mode === "auto") toast.warning("Autosave skipped: the file changed on disk. Reload or overwrite in the editor.");
        }
      } catch (cause) {
        toast.error(describe(cause));
      } finally {
        latest.current.saving = false;
        setSaving(false);
      }
    },
    [rpc, threadId, onSaved],
  );

  // Autosave: shortly after typing stops, when focus leaves the editor or the
  // window, and when the editor unmounts (panel closed, thread switched).
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => void save("auto"), 1500);
    return () => window.clearTimeout(timer);
  }, [text, dirty, save]);
  useEffect(() => {
    const onWindowBlur = () => void save("auto");
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, [save]);
  useEffect(() => {
    return () => {
      const cur = latest.current;
      if (!cur.dirty || cur.saving) return;
      rpc.call("doc_write", { threadId, content: cur.text, expectedSha256: cur.baseSha }).then(
        (result) => {
          if (result.outcome !== "written") toast.warning("Unsaved RFC edits were not written: the file changed on disk.");
        },
        (cause: unknown) => toast.error(`Autosave failed: ${describe(cause)}`),
      );
    };
  }, [rpc, threadId]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [wrap, setWrap] = useState(() => window.localStorage.getItem("rfcs:editorWrap") !== "off");
  const [lineHeights, setLineHeights] = useState<number[] | null>(null);
  const lineHeightsRef = useRef<number[] | null>(null);
  lineHeightsRef.current = lineHeights;
  const lines = useMemo(() => text.split("\n"), [text]);
  // With soft wrap on, a logical line can span several rows. A hidden mirror
  // with the same width and font measures each line so the gutter lines up.
  useEffect(() => {
    if (!wrap) {
      setLineHeights(null);
      return;
    }
    const mirror = mirrorRef.current;
    const ta = textareaRef.current;
    if (mirror === null || ta === null) return;
    let frame = 0;
    const measure = () => {
      mirror.style.width = `${ta.clientWidth}px`;
      const heights: number[] = [];
      for (const child of Array.from(mirror.children)) heights.push((child as HTMLElement).offsetHeight);
      setLineHeights(heights);
    };
    frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(ta);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [wrap, lines]);
  // Expose the textarea as a line-addressable scroller for split-view sync.
  useEffect(() => {
    if (sync === undefined) return;
    const rowHeights = (ta: HTMLTextAreaElement) => {
      const measured = lineHeightsRef.current;
      const count = ta.value.split("\n").length;
      if (measured !== null && measured.length === count) return measured;
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 24;
      return new Array<number>(count).fill(lh);
    };
    const padTop = (ta: HTMLTextAreaElement) => parseFloat(getComputedStyle(ta).paddingTop) || 0;
    sync.editor.current = {
      lineAtTop() {
        const ta = textareaRef.current;
        if (ta === null) return 1;
        let y = ta.scrollTop - padTop(ta);
        const heights = rowHeights(ta);
        for (let i = 0; i < heights.length; i++) {
          const h = heights[i]!;
          if (y < h) return i + 1 + Math.max(0, y) / h;
          y -= h;
        }
        return heights.length;
      },
      scrollToLine(line) {
        const ta = textareaRef.current;
        if (ta === null) return;
        if (line <= 1) {
          ta.scrollTop = 0;
        } else {
          const heights = rowHeights(ta);
          const idx = Math.min(heights.length - 1, Math.floor(line) - 1);
          let top = padTop(ta);
          for (let i = 0; i < idx; i++) top += heights[i]!;
          top += (line - Math.floor(line)) * (heights[idx] ?? 0);
          ta.scrollTop = top;
        }
        if (gutterRef.current !== null) gutterRef.current.scrollTop = ta.scrollTop;
      },
    };
    return () => {
      if (sync.editor.current !== null) sync.editor.current = null;
    };
  }, [sync]);

  const syncScroll = () => {
    const ta = textareaRef.current;
    if (gutterRef.current !== null && ta !== null) gutterRef.current.scrollTop = ta.scrollTop;
    if (ta !== null) remember(`editor:${threadId}`, JSON.stringify({ top: Math.round(ta.scrollTop), start: ta.selectionStart, end: ta.selectionEnd }));
  };
  const rememberCaret = () => {
    const ta = textareaRef.current;
    if (ta !== null) remember(`editor:${threadId}`, JSON.stringify({ top: Math.round(ta.scrollTop), start: ta.selectionStart, end: ta.selectionEnd }));
  };
  useEffect(() => {
    const ta = textareaRef.current;
    const raw = recall(`editor:${threadId}`);
    if (ta === null || raw === null) return;
    try {
      const saved = JSON.parse(raw) as { top?: number; start?: number; end?: number };
      const apply = () => {
        if (typeof saved.start === "number" && typeof saved.end === "number") {
          const max = ta.value.length;
          ta.setSelectionRange(Math.min(saved.start, max), Math.min(saved.end, max));
        }
        if (typeof saved.top === "number") ta.scrollTop = saved.top;
        if (gutterRef.current !== null) gutterRef.current.scrollTop = ta.scrollTop;
      };
      requestAnimationFrame(apply);
      // Gutter heights are measured after layout; re-apply once they settle.
      const timer = window.setTimeout(apply, 200);
      return () => window.clearTimeout(timer);
    } catch {
      return;
    }
    // Only on mount for this thread: later edits must not jump the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const el = event.currentTarget;
      const { selectionStart, selectionEnd } = el;
      const next = `${text.slice(0, selectionStart)}  ${text.slice(selectionEnd)}`;
      setText(next);
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = selectionStart + 2;
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {changedOnDisk && dirty ? (
        <div className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs">
          <Icon name="TriangleAlert" className="size-3.5" />
          The file changed on disk while you were editing.
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-6 text-xs"
            onClick={() => {
              setText(doc.content);
              setBaseSha(doc.sha256);
              setConflict(false);
            }}
          >
            Discard mine and reload
          </Button>
          <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => setBaseSha(doc.sha256)}>
            Keep mine (overwrite on save)
          </Button>
        </div>
      ) : null}
      {conflict ? (
        <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          Save refused: the file changed since you loaded it. Reload or choose to overwrite above.
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={gutterRef}
          aria-hidden
          className="shrink-0 select-none overflow-hidden border-r border-border bg-muted/30 py-3 pl-2 pr-1.5 text-right font-mono text-[13px] leading-6 text-muted-foreground/70"
          style={{ width: `calc(${String(lines.length).length}ch + 0.875rem)` }}
        >
          {lines.map((_, i) => (
            <div key={i} style={lineHeights !== null && lineHeights[i] !== undefined ? { height: lineHeights[i] } : undefined}>
              {i + 1}
            </div>
          ))}
          <div className="h-6" />
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onScroll={() => {
            syncScroll();
            sync?.follow("editor");
          }}
          onBlur={() => {
            rememberCaret();
            void save("auto");
          }}
          onSelect={rememberCaret}
          spellCheck
          wrap={wrap ? "soft" : "off"}
          className={cn("min-h-0 min-w-0 flex-1 resize-none bg-transparent py-3 pl-2 pr-4 font-mono text-[13px] leading-6 outline-none", !wrap && "overflow-x-auto whitespace-pre")}
          aria-label="RFC markdown source"
        />
        {wrap ? (
          <div ref={mirrorRef} aria-hidden className="pointer-events-none invisible absolute left-0 top-0 whitespace-pre-wrap break-words py-0 pl-2 pr-4 font-mono text-[13px] leading-6">
            {lines.map((line, i) => (
              <div key={i}>{line === "" ? " " : line}</div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3 whitespace-nowrap border-t border-border px-3 py-1 text-[11px] text-muted-foreground">
        <span
          className="flex items-center gap-1.5"
          title={conflict ? "The file changed on disk; reload or overwrite above." : dirty ? "Autosaves when you pause or click away. ⌘S saves now." : "All changes saved."}
        >
          <span
            className={cn(
              "size-2 rounded-full",
              conflict ? "bg-destructive" : saving ? "animate-pulse bg-blue-500" : dirty ? "bg-amber-500" : "bg-green-500",
            )}
          />
          {conflict ? "Not saved: file changed on disk" : saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}
        </span>
        <span className="ml-auto">{lines.length} lines</span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          onClick={() => {
            const next = !wrap;
            setWrap(next);
            window.localStorage.setItem("rfcs:editorWrap", next ? "on" : "off");
          }}
          title="Toggle soft wrap"
        >
          Wrap: {wrap ? "on" : "off"}
        </button>
      </div>
    </div>
  );
}

// ---- review --------------------------------------------------------------

const severityTone: Record<Finding["severity"], string> = {
  high: "bg-destructive/15 text-destructive",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  low: "bg-muted text-muted-foreground",
};

function FindingCard({
  rpc,
  threadId,
  finding,
  onUpdate,
}: {
  rpc: Rpc;
  threadId: string;
  finding: Finding;
  onUpdate: (patch: { status?: "pending" | "accepted" | "skipped"; priority?: Priority; edited?: string | null }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(finding.edited ?? finding.body);
  const [discussOpen, setDiscussOpen] = useState(finding.discussThreadId !== null && finding.status === "pending");
  const [opening, setOpening] = useState(false);
  const locked = finding.status === "sent";
  const where = [finding.section, finding.line === null ? null : `line ${finding.line}`].filter(Boolean).join(" · ");

  const discuss = async () => {
    if (finding.discussThreadId !== null) {
      setDiscussOpen((v) => !v);
      return;
    }
    setOpening(true);
    try {
      await rpc.call("discuss_open", { threadId, id: finding.id });
      setDiscussOpen(true);
    } catch (cause) {
      toast.error(describe(cause));
    } finally {
      setOpening(false);
    }
  };

  return (
    <li
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        finding.status === "accepted"
          ? "border-primary/50 bg-primary/5"
          : finding.status === "skipped"
            ? "border-border opacity-60"
            : finding.status === "sent"
              ? "border-border bg-muted/30 text-muted-foreground"
              : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase", severityTone[finding.severity])}>{finding.severity}</span>
        <span className="font-medium">{finding.title}</span>
        {where !== "" ? <span className="text-xs text-muted-foreground">{where}</span> : null}
        <span className="ml-auto flex items-center gap-1">
          <select
            value={finding.priority}
            disabled={locked}
            onChange={(event) => onUpdate({ priority: event.target.value as Priority })}
            className="h-6 rounded border border-border bg-background px-1 text-xs"
            aria-label="Priority"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">{finding.status}</span>
        </span>
      </div>
      {finding.quote !== null ? (
        <blockquote className="mt-1.5 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">“{finding.quote}”</blockquote>
      ) : null}
      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-24 w-full rounded border border-border bg-background p-2 font-mono text-xs"
            aria-label="Edit finding"
          />
          <div className="mt-1 flex gap-2">
            <Button
              size="sm"
              className="h-6 text-xs"
              onClick={() => {
                onUpdate({ edited: draft === finding.body ? null : draft });
                setEditing(false);
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 text-sm [&_p]:my-1">
          <Markdown content={finding.edited ?? finding.body} />
          {finding.edited !== null ? <span className="text-[10px] uppercase text-muted-foreground">edited</span> : null}
          {finding.suggestion !== null && finding.edited === null ? (
            <div className="mt-1.5 rounded bg-muted/40 px-2 py-1.5 text-xs">
              <span className="font-medium">Suggestion: </span>
              <Markdown content={finding.suggestion} />
            </div>
          ) : null}
        </div>
      )}
      {locked ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={finding.status === "accepted" ? "default" : "outline"}
            className="h-6 text-xs"
            onClick={() => onUpdate({ status: finding.status === "accepted" ? "pending" : "accepted" })}
          >
            <Icon name="Check" className="size-3.5" />
            {finding.status === "accepted" ? "Accepted" : "Accept"}
          </Button>
          <Button
            size="sm"
            variant={finding.status === "skipped" ? "default" : "outline"}
            className="h-6 text-xs"
            onClick={() => onUpdate({ status: finding.status === "skipped" ? "pending" : "skipped" })}
          >
            <Icon name="X" className="size-3.5" />
            {finding.status === "skipped" ? "Skipped" : "Skip"}
          </Button>
          <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => setEditing(true)}>
            <Icon name="Pencil" className="size-3.5" />
            Edit
          </Button>
          <Button size="sm" variant={discussOpen ? "default" : "outline"} className="h-6 text-xs" disabled={opening} onClick={() => void discuss()}>
            <Icon name="MessagesSquare" className="size-3.5" />
            {finding.discussThreadId === null ? (opening ? "Opening…" : "Discuss") : discussOpen ? "Hide discussion" : "Discussion"}
          </Button>
        </div>
      )}
      {finding.discussThreadId !== null && (discussOpen || locked) ? (
        <div className="mt-2 h-96 overflow-hidden rounded-md border border-border">
          <ThreadChat threadId={finding.discussThreadId} variant="compact" layout="contained" permissionPolicy="inherit" className="h-full" />
        </div>
      ) : null}
    </li>
  );
}

function ReviewTab({ rpc, threadId, hasDoc }: { rpc: Rpc; threadId: string; hasDoc: boolean }) {
  const { review, reload } = useReview(rpc, threadId);
  const [instructions, setInstructions] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [showOld, setShowOld] = useState(false);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (cause) {
      toast.error(`${label} failed: ${describe(cause)}`);
    } finally {
      setBusy(false);
    }
  };
  const update = (id: string, patch: Parameters<typeof rpc.call<"findings_update">>[1] extends infer T ? Omit<T, "threadId" | "id"> : never) =>
    void act("Update", () => rpc.call("findings_update", { threadId, id, ...patch }));

  if (review === null) return <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  const current = review.findings.filter((f) => f.round === review.round);
  const older = review.findings.filter((f) => f.round !== review.round);
  const pending = current.filter((f) => f.status === "pending").length;
  const accepted = review.findings.filter((f) => f.status === "accepted").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Input
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Focus for this round (optional), e.g. security, migration"
          aria-label="Review instructions"
          className="h-8 min-w-48 flex-1 text-xs"
        />
        <Button
          size="sm"
          disabled={busy || !hasDoc || review.status === "running"}
          onClick={() =>
            void act("Review", async () => {
              const result = await rpc.call("review_run", { threadId, instructions });
              toast.success(result.started ? "Review round started." : "A review round is already running.");
              setInstructions("");
            })
          }
        >
          <Icon name={review.status === "running" ? "LoaderCircle" : "Play"} className={cn("size-4", review.status === "running" && "animate-spin")} />
          {review.status === "running" ? "Reviewing…" : review.round === 0 ? "Run review" : "Run again"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {!hasDoc ? (
          <p className="text-sm text-muted-foreground">Open or create an RFC first.</p>
        ) : review.status === "failed" ? (
          <p className="text-sm text-destructive">Round {review.round} failed: {review.error}</p>
        ) : current.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {review.status === "running"
              ? "A reviewer is reading the RFC. Findings appear here as they are reported."
              : review.round === 0
                ? "No review yet. Run one to get findings you can accept, skip, edit, or discuss before the agent acts on them."
                : "This round reported no findings."}
          </p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">
                round {review.round} · {pending} pending
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                disabled={busy || pending === 0}
                onClick={() => void act("Accept all", () => rpc.call("findings_bulk", { threadId, status: "accepted", ids: current.filter((f) => f.status === "pending").map((f) => f.id) }))}
              >
                Accept all pending
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs"
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
                  <FindingCard key={finding.id} rpc={rpc} threadId={threadId} finding={finding} onUpdate={(patch) => update(finding.id, patch)} />
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
                  <FindingCard key={finding.id} rpc={rpc} threadId={threadId} finding={finding} onUpdate={(patch) => update(finding.id, patch)} />
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

// ---- document chooser ----------------------------------------------------

function DocChooser({ rpc, threadId, context, onChanged }: { rpc: Rpc; threadId: string; context: ThreadContextInfo; onChanged: () => void }) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    rpc.call("docs_list", { threadId }).then(
      (result) => {
        setCandidates(result.candidates);
        setNote(result.note);
      },
      (cause: unknown) => setNote(describe(cause)),
    );
  }, [rpc, threadId, context.doc?.path]);

  const pick = async (path: string) => {
    if (path === "") return;
    setBusy(true);
    try {
      await rpc.call("doc_set", { threadId, path });
      onChanged();
    } catch (cause) {
      toast.error(describe(cause));
    } finally {
      setBusy(false);
    }
  };
  const currentRelative = context.doc === null ? "" : candidates.find((c) => c.path === context.doc?.path)?.relative ?? context.doc.path;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <select
        value={context.doc?.path ?? ""}
        disabled={busy}
        onChange={(event) => void pick(event.target.value)}
        className="h-8 min-w-0 max-w-full flex-1 truncate rounded border border-border bg-background px-2 text-xs"
        aria-label="RFC document"
        title={context.doc?.path ?? ""}
      >
        <option value="">{context.doc === null ? "Choose an RFC…" : currentRelative}</option>
        {candidates
          .filter((c) => c.path !== context.doc?.path)
          .map((c) => (
            <option key={c.path} value={c.path}>
              {c.relative}
            </option>
          ))}
      </select>
      {candidates.length === 0 || context.doc === null ? (
        <form
          className="flex w-full items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void pick(custom);
          }}
        >
          <Input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="…or a path, relative to the workspace" className="h-7 flex-1 text-xs" aria-label="RFC path" />
          <Button size="sm" variant="outline" type="submit" className="h-7 text-xs" disabled={busy || custom.trim() === ""}>
            Open
          </Button>
        </form>
      ) : null}
      {note !== null ? <span className="w-full text-[11px] text-muted-foreground">{note}</span> : null}
    </div>
  );
}

// ---- panel ---------------------------------------------------------------

type View = "preview" | "edit" | "split" | "review" | "items" | "walkthrough";
const VIEWS: View[] = ["split", "edit", "preview", "review", "items", "walkthrough"];
const DEFAULT_VIEW: View = "split";
const VIEW_TABS: Array<{ id: View; title: string; icon: string }> = [
  { id: "split", title: "Split", icon: "Columns2" },
  { id: "edit", title: "Edit", icon: "Pencil" },
  { id: "preview", title: "Preview", icon: "Eye" },
  { id: "review", title: "Review", icon: "ListChecks" },
  { id: "items", title: "Items", icon: "ListTodo" },
  { id: "walkthrough", title: "Walkthrough", icon: "Play" },
];
const isView = (v: string | null): v is View => v !== null && (VIEWS as string[]).includes(v);

function ViewTabs({ view, onChange, pending, badges = {}, compact = false }: { view: View; onChange: (v: View) => void; pending: number; badges?: Partial<Record<View, number>>; compact?: boolean }) {
  return (
    <>
      {VIEW_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            "flex shrink-0 items-center gap-1",
            compact ? "rounded px-2 py-0.5 text-xs" : "rounded-t px-3 py-1.5 text-sm",
            view === t.id
              ? compact
                ? "bg-muted font-medium text-foreground"
                : "border-b-2 border-primary font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon name={t.icon} className={compact ? "size-3.5" : "size-4"} />
          {t.title}
          {t.id === "review" && pending > 0 ? <span className="rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">{pending}</span> : null}
          {t.id !== "review" && (badges[t.id] ?? 0) > 0 ? <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-400">{badges[t.id]}</span> : null}
        </button>
      ))}
    </>
  );
}

function PreviewToolbar({ termsExpanded, onToggleTerms, hasTerms }: { termsExpanded: boolean; onToggleTerms: () => void; hasTerms: boolean }) {
  if (!hasTerms) return null;
  return (
    <div className="sticky top-0 z-10 flex justify-end px-3 pt-1">
      <button type="button" onClick={onToggleTerms} className="rounded border border-border bg-background/90 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur hover:text-foreground">
        {termsExpanded ? "Collapse terms" : "Expand terms"}
      </button>
    </div>
  );
}

function RfcPanel({
  threadId,
  params,
  embedded = false,
  controlledView,
}: {
  threadId: string;
  params: unknown;
  /** Inside the RFCs workspace: the workspace header owns the tabs and file actions. */
  embedded?: boolean;
  controlledView?: View;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { context, error, reload } = useThreadContext(rpc, threadId);
  const requested = typeof params === "object" && params !== null && typeof (params as { view?: unknown }).view === "string" ? (params as { view: string }).view : null;
  const stored = recall(`view:${threadId}`);
  const initial = [stored, requested].find(isView) ?? DEFAULT_VIEW;
  const [ownView, setViewState] = useState<View>(initial);
  const view = controlledView ?? ownView;
  const setView = (next: View) => {
    setViewState(next);
    remember(`view:${threadId}`, next);
  };
  const docPath = context?.doc?.path ?? null;
  const { doc, error: docError, reload: reloadDoc } = useDoc(rpc, threadId, docPath, view !== "review");
  const { review } = useReview(rpc, threadId);
  const { sidecar } = useSidecar(rpc, threadId, true);
  const openNotes = sidecar?.notes.filter((n) => n.status === "open" || n.status === "blocked").length ?? 0;
  const [itemsTab, setItemsTab] = useState<ItemsTab>("notes");
  const [itemsSection, setItemsSection] = useState<string | null>(null);
  const [termsExpanded, setTermsExpandedState] = useState(() => recall("termsExpanded") === "on");
  const setTermsExpanded = (v: boolean) => {
    setTermsExpandedState(v);
    remember("termsExpanded", v ? "on" : "off");
  };
  const pendingJump = useRef<Anchor | null>(null);
  const jumpTo = (anchor: Anchor) => {
    pendingJump.current = anchor;
    if (view !== "preview" && view !== "split") setView("preview");
    else performJump();
  };
  const performJump = () => {
    const anchor = pendingJump.current;
    if (anchor === null) return;
    const root = document;
    let target: Element | null = null;
    if (anchor.section !== null) {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("section[data-section]"))) {
        if (el.dataset.section !== undefined && el.dataset.section !== "" && anchor.section.toLowerCase().startsWith(el.dataset.section.toLowerCase().slice(0, 20))) {
          target = el;
          break;
        }
      }
    }
    if (target === null && anchor.line !== null) {
      let best: { el: Element; line: number } | null = null;
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("section[data-section-line]"))) {
        const line = Number(el.dataset.sectionLine);
        if (line <= anchor.line && (best === null || line > best.line)) best = { el, line };
      }
      target = best?.el ?? null;
    }
    if (target !== null) {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
      target.classList.add("rfc-jump-flash");
      window.setTimeout(() => target?.classList.remove("rfc-jump-flash"), 1600);
      pendingJump.current = null;
    }
  };
  useEffect(() => {
    if (pendingJump.current === null) return;
    const t = window.setTimeout(performJump, 120);
    return () => window.clearTimeout(t);
  });
  const addNote = (anchor: Anchor, title: string) => {
    void rpc
      .call("note_add", { threadId, anchor, title: title.trim(), body: "", status: "open", discuss: false })
      .then(() => toast.success("Note added. Find it under Items."), (cause: unknown) => toast.error(describe(cause)));
  };
  const explain = (anchor: Anchor, mode: CardMode, prompt: string) => {
    void rpc
      .call("card_open", { threadId, anchor, mode, prompt })
      .then(() => toast.success("Writing an explainer card; it appears under the section."), (cause: unknown) => toast.error(describe(cause)));
  };
  const openItems = (tab: ItemsTab, section: string | null) => {
    setItemsTab(tab);
    setItemsSection(section);
    setView("items");
  };
  const annotate: PreviewAnnotations = {
    threadId,
    sidecar,
    environmentId: context?.environmentId ?? null,
    termsExpanded,
    onAddNote: addNote,
    onExplain: explain,
    onOpenItems: openItems,
  };
  // In Split view the editor is the source of truth for position (it restores
  // its own scroll and the preview follows), so only Preview restores itself.
  const previewScroll = useScrollMemory<HTMLDivElement>(`preview:${threadId}`, doc !== undefined && doc !== null && view === "preview");
  const sync = useScrollSync();
  const splitPreviewRef = useRef<HTMLDivElement | null>(null);
  const docContent = doc?.content ?? "";
  useEffect(() => {
    const el = splitPreviewRef.current;
    if (view !== "split" || el === null) {
      sync.preview.current = null;
      return;
    }
    sync.preview.current = previewScroller(el, docContent);
    // Align the preview to the editor once diagrams have had a moment to lay out.
    const timers = [250, 900].map((ms) =>
      window.setTimeout(() => {
        if (sync.editor.current !== null && sync.preview.current !== null) sync.preview.current.scrollToLine(sync.editor.current.lineAtTop());
      }, ms),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [view, docContent, sync]);
  const pending = review?.findings.filter((f) => f.status === "pending" && f.round === review.round).length ?? 0;

  const openExternally = () => {
    if (context?.doc === null || context === null) return;
    const target =
      context.hostId !== null
        ? ({ kind: "host", hostId: context.hostId, path: context.doc.path } as const)
        : null;
    if (target === null || !navigate.experimental_openFileExternally({ target, location: null })) {
      void navigator.clipboard.writeText(context.doc.path);
      toast.message("Path copied; open it in your editor.");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {embedded ? null : (
        <div className="flex items-center gap-1 border-b border-border px-2 pt-1">
          <ViewTabs view={view} onChange={setView} pending={pending} badges={{ items: openNotes }} />
          {context?.doc ? (
            <button type="button" className="ml-auto flex items-center gap-1 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={openExternally} title={context.doc.path}>
              <Icon name="ExternalLink" className="size-3.5" />
              Open in editor
            </button>
          ) : null}
        </div>
      )}
      {error !== null ? (
        <div className="p-3 text-sm text-destructive">
          {error}{" "}
          <button type="button" className="underline" onClick={reload}>
            retry
          </button>
        </div>
      ) : context === null ? (
        <p className="p-3 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {view === "review" || embedded ? null : <DocChooser rpc={rpc} threadId={threadId} context={context} onChanged={reload} />}
          {view === "review" ? (
            <ReviewTab rpc={rpc} threadId={threadId} hasDoc={context.doc !== null} />
          ) : view === "items" ? (
            <ItemsView rpc={rpc} threadId={threadId} sidecar={sidecar} initialTab={itemsTab} sectionFilter={itemsSection} onJump={jumpTo} />
          ) : view === "walkthrough" ? (
            <WalkthroughView rpc={rpc} threadId={threadId} sidecar={sidecar} environmentId={context.environmentId} Diagram={DiagramForCards} onJump={jumpTo} />
          ) : context.doc === null ? (
            <div className="p-4 text-sm text-muted-foreground">
              <p>No RFC is open on this thread.</p>
              <p className="mt-2">Pick one above, create a new one, or ask the agent to start one: it calls <code>rfc_set_document</code> and the preview follows the file.</p>
            </div>
          ) : docError !== null ? (
            <p className="p-3 text-sm text-destructive">{docError}</p>
          ) : doc === undefined ? (
            <p className="p-3 text-sm text-muted-foreground">Loading…</p>
          ) : doc === null ? (
            <div className="p-4 text-sm text-muted-foreground">
              <p className="font-mono text-xs">{context.doc.path}</p>
              <p className="mt-2">This file does not exist yet. The preview fills in as soon as the agent (or you) writes it.</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() =>
                  void rpc.call("doc_write", { threadId, content: `# ${context.doc?.path.split("/").pop()?.replace(/\.md$/, "") ?? "RFC"}\n`, expectedSha256: null }).then(reloadDoc, (cause: unknown) => toast.error(describe(cause)))
                }
              >
                Create empty file
              </Button>
            </div>
          ) : view === "preview" ? (
            <div ref={previewScroll.ref} onScroll={previewScroll.onScroll} className="relative min-h-0 flex-1 overflow-auto">
              <PreviewToolbar termsExpanded={termsExpanded} onToggleTerms={() => setTermsExpanded(!termsExpanded)} hasTerms={(sidecar?.glossary.length ?? 0) > 0} />
              <RfcPreview rpc={rpc} content={doc.content} annotate={annotate} />
            </div>
          ) : view === "edit" ? (
            <RfcEditor key={context.doc.path} rpc={rpc} threadId={threadId} doc={doc} onSaved={reloadDoc} />
          ) : (
            <SplitPane
              storageKey="editor"
              left={<RfcEditor key={context.doc.path} rpc={rpc} threadId={threadId} doc={doc} onSaved={reloadDoc} sync={sync} />}
              right={
                <div ref={splitPreviewRef} onScroll={() => sync.follow("preview")} className="relative min-h-0 flex-1 overflow-auto">
                  <PreviewToolbar termsExpanded={termsExpanded} onToggleTerms={() => setTermsExpanded(!termsExpanded)} hasTerms={(sidecar?.glossary.length ?? 0) > 0} />
                  <RfcPreview rpc={rpc} content={doc.content} annotate={annotate} />
                </div>
              }
            />
          )}
        </>
      )}
    </div>
  );
}

// ---- markdown file opener ------------------------------------------------

interface OpenerSource {
  kind: "workspace" | "host" | "thread-storage";
  threadId: string | null;
  environmentId: string | null;
  projectId: string | null;
  experimental_hostId?: string | null;
}

function MarkdownOpener({ path, source, Original }: { path: string; source: OpenerSource; Original: ComponentType }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ content: string } | "original" | "loading">("loading");
  useEffect(() => {
    let cancelled = false;
    if (source.kind === "thread-storage") {
      setState("original");
      return;
    }
    rpc
      .call("file_read", {
        source: source.kind,
        environmentId: source.environmentId,
        hostId: source.experimental_hostId ?? null,
        path,
      })
      .then(
        (result) => {
          if (cancelled) return;
          // Only take over files that actually contain a diagram fence; bb's
          // own preview is the right renderer for everything else.
          if (result === null || !/^\s{0,3}(`{3,}|~{3,})\s*(mermaid|d2)\s*$/m.test(result.content)) setState("original");
          else setState({ content: result.content });
        },
        () => {
          if (!cancelled) setState("original");
        },
      );
    return () => {
      cancelled = true;
    };
  }, [rpc, path, source.kind, source.environmentId, source.experimental_hostId]);
  if (state === "loading") return <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  if (state === "original") return <Original />;
  return (
    <div className="h-full overflow-auto">
      <RfcPreview rpc={rpc} content={state.content} />
    </div>
  );
}

// ---- library page (sidebar) ----------------------------------------------

const statusTone = (status: string | null) => {
  const s = status?.toLowerCase() ?? "";
  if (s === "approved" || s === "accepted" || s === "final") return "bg-green-500/15 text-green-700 dark:text-green-400";
  if (s === "rejected" || s === "withdrawn" || s === "superseded") return "bg-destructive/15 text-destructive";
  if (s === "draft" || s === "wip") return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  if (s === "review" || s === "in-review" || s === "proposed") return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
  return "bg-muted text-muted-foreground";
};

const relativeTime = (ms: number | null) => {
  if (ms === null) return "";
  const diff = Date.now() - ms;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
};

/** Last library result, so a remount paints at once. */
let libraryMemo: { items: LibraryItem[]; notes: string[] } | null = null;

function useLibrary(rpc: Rpc) {
  const [items, setItems] = useState<LibraryItem[] | null>(libraryMemo?.items ?? null);
  const [notes, setNotes] = useState<string[]>(libraryMemo?.notes ?? []);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    (force = false) =>
      rpc.call("library_list", { force }).then(
        (result) => {
          libraryMemo = result;
          setItems(result.items);
          setNotes(result.notes);
          setError(null);
        },
        (cause: unknown) => setError(describe(cause)),
      ),
    [rpc],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  useRealtime(CHANGED, (payload: unknown) => {
    if ((payload as ChangedPayload).kind === "library") reload();
  });
  return { items, notes, error, reload };
}

function LibraryList({
  rpc,
  items,
  notes,
  error,
  reload,
  onOpen,
}: {
  rpc: Rpc;
  items: LibraryItem[] | null;
  notes: string[];
  error: string | null;
  reload: (force?: boolean) => Promise<void>;
  onOpen: (threadId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [busyCreate, setBusyCreate] = useState(false);
  const rescan = async () => {
    setRefreshing(true);
    const started = Date.now();
    try {
      await reload(true);
    } finally {
      // Keep the spin visible long enough to register as feedback.
      window.setTimeout(() => setRefreshing(false), Math.max(0, 400 - (Date.now() - started)));
    }
  };
  const create = async () => {
    const title = newTitle.trim();
    if (title === "") return;
    setBusyCreate(true);
    try {
      const projectId = items?.find((i) => i.projectId !== null)?.projectId ?? null;
      const result = await rpc.call("library_create", { title, projectId });
      toast.success(`Created ${result.path.split("/").pop()}`);
      setCreating(false);
      setNewTitle("");
      void reload(true);
      onOpen(result.threadId);
    } catch (cause) {
      toast.error(describe(cause));
    } finally {
      setBusyCreate(false);
    }
  };

  const open = async (item: LibraryItem, options: { fresh?: boolean; threadId?: string } = {}) => {
    setOpening(item.path);
    try {
      const result = await rpc.call("library_open", {
        path: item.path,
        hostId: item.hostId,
        projectId: item.projectId,
        threadId: options.threadId ?? null,
        fresh: options.fresh ?? false,
      });
      if (result.created) toast.success("Started a thread on this RFC.");
      onOpen(result.threadId);
    } catch (cause) {
      toast.error(describe(cause));
    } finally {
      setOpening(null);
    }
  };

  const statuses = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items ?? []) {
      const s = (i.status ?? "none").toLowerCase();
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((i) => {
      if (status !== null && (i.status ?? "none").toLowerCase() !== status) return false;
      if (q === "") return true;
      return `${i.title} ${i.relative} ${i.authors ?? ""} ${i.projectName ?? ""}`.toLowerCase().includes(q);
    });
  }, [items, query, status]);
  const grouped = useMemo(() => {
    const groups = new Map<string, LibraryItem[]>();
    for (const i of filtered) groups.set(i.projectName ?? "Other", [...(groups.get(i.projectName ?? "Other") ?? []), i]);
    return [...groups.entries()];
  }, [filtered]);

  return (
    <aside className="flex h-full w-[22rem] shrink-0 flex-col border-r border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="FileText" className="size-4 text-muted-foreground" />
        <span className="font-medium">RFCs</span>
        <span className="text-xs text-muted-foreground">{items?.length ?? "…"}</span>
        <button
          type="button"
          className={cn("ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-muted", creating ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
          onClick={() => setCreating((v) => !v)}
          title="New RFC from the template"
        >
          <Icon name="Plus" className="size-3.5" />
          New
        </button>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => void rescan()} title="Rescan for RFCs">
          <Icon name="RefreshCw" className={cn("size-3.5", refreshing && "animate-spin")} />
        </button>
      </div>
      {creating ? (
        <form
          className="flex flex-col gap-1.5 border-b border-border px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="flex items-center gap-2">
            <Input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="RFC title" autoFocus className="h-8 flex-1 text-xs" aria-label="New RFC title" />
            <Button size="sm" type="submit" className="h-8" disabled={busyCreate || newTitle.trim() === ""}>
              {busyCreate ? "Creating…" : "Create"}
            </Button>
          </div>
          <span className="text-[11px] text-muted-foreground">Creates the file from the template in the RFC directory and opens a thread on it.</span>
        </form>
      ) : null}
      <div className="border-b border-border px-3 py-2">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, path, author" className="h-8 text-xs" aria-label="Search RFCs" />
        {statuses.length > 1 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {statuses.map(([s, n]) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(status === s ? null : s)}
                className={cn("rounded-full px-2 py-0.5 text-[10px] uppercase", statusTone(s === "none" ? null : s), status === s && "ring-1 ring-primary")}
              >
                {s} {n}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error !== null ? (
          <p className="p-3 text-sm text-destructive">{error}</p>
        ) : items === null ? (
          <p className="p-3 text-sm text-muted-foreground">Scanning…</p>
        ) : filtered.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">
            <p>No RFCs found.</p>
            <p className="mt-2 text-xs">Markdown in the RFC directory, any <code>*rfc*.md</code> in a project, and files open in a thread's RFC tab appear here.</p>
          </div>
        ) : (
          grouped.map(([group, list]) => (
            <div key={group}>
              {grouped.length > 1 ? (
                <div className="sticky top-0 bg-background/95 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">{group}</div>
              ) : null}
              <ul>
                {list.map((item) => {
                  const busy = opening === item.path;
                  const live = item.threads.filter((t) => t.status !== "archived");
                  return (
                    <li key={`${item.hostId ?? ""}|${item.path}`} className="group">
                      <button type="button" disabled={busy} onClick={() => void open(item)} className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-muted/60">
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
                          {busy ? <Icon name="LoaderCircle" className="size-3.5 animate-spin text-muted-foreground" /> : null}
                          {item.status !== null ? <span className={cn("rounded px-1.5 py-0.5 text-[10px] uppercase", statusTone(item.status))}>{item.status}</span> : null}
                        </span>
                        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="min-w-0 flex-1 truncate font-mono">{item.relative}</span>
                          {live.some((t) => t.unread) ? (
                            <span className="flex items-center gap-1 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary" title="A thread on this RFC has a reply you have not seen">
                              <span className="size-1.5 rounded-full bg-primary" />
                              {live.filter((t) => t.unread).length === 1 ? "new reply" : `${live.filter((t) => t.unread).length} new`}
                            </span>
                          ) : live.some((t) => t.status === "active" || t.status === "starting") ? (
                            <Icon name="LoaderCircle" className="size-3 animate-spin" />
                          ) : null}
                          {live.length > 0 ? (
                            <span className="flex items-center gap-0.5" title={`${live.length} thread(s)`}>
                              <Icon name="MessagesSquare" className="size-3" />
                              {live.length}
                            </span>
                          ) : null}
                          <span>{relativeTime(item.modifiedAtMs)}</span>
                        </span>
                      </button>
                      {live.length > 0 ? (
                        <div className="hidden flex-wrap gap-1 px-3 pb-2 group-hover:flex">
                          {live.slice(0, 3).map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              disabled={busy}
                              onClick={() => void open(item, { threadId: t.id })}
                              className="flex max-w-full items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              <Icon name="MessagesSquare" className="size-3" />
                              <span className="truncate">{t.title ?? "Thread"}</span>
                              {t.unread ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
                            </button>
                          ))}
                          {item.projectId !== null ? (
                            <button type="button" disabled={busy} onClick={() => void open(item, { fresh: true })} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground">
                              <Icon name="Plus" className="size-3" />
                              New
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
        {notes.map((n) => (
          <p key={n} className="px-3 py-1 text-[11px] text-muted-foreground">
            {n}
          </p>
        ))}
      </div>
    </aside>
  );
}

/** Chat on the left, RFC panel on the right, with a draggable divider. */
function RfcWorkspace({ threadId, item, onBack }: { threadId: string; item: LibraryItem | null; onBack: () => void }) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const { review } = useReview(rpc, threadId);
  const pending = review?.findings.filter((f) => f.status === "pending" && f.round === review.round).length ?? 0;
  const { sidecar: wsSidecar } = useSidecar(rpc, threadId, true);
  const openNotes = wsSidecar?.notes.filter((n) => n.status === "open" || n.status === "blocked").length ?? 0;
  const [view, setViewState] = useState<View>(() => {
    const stored = recall(`view:${threadId}`);
    return isView(stored) ? stored : DEFAULT_VIEW;
  });
  useEffect(() => {
    const stored = recall(`view:${threadId}`);
    setViewState(isView(stored) ? stored : DEFAULT_VIEW);
  }, [threadId]);
  const setView = (next: View) => {
    setViewState(next);
    remember(`view:${threadId}`, next);
  };
  const [chatOpen, setChatOpenState] = useState(() => recall("chatOpen") !== "off");
  const setChatOpen = (open: boolean) => {
    setChatOpenState(open);
    remember("chatOpen", open ? "on" : "off");
  };
  const chat = <ThreadChat threadId={threadId} variant="compact" layout="contained" permissionPolicy="editable" className="h-full" />;
  const panel = <RfcPanel threadId={threadId} params={null} embedded controlledView={view} />;
  const threadIds = useMemo(() => [threadId], [threadId]);
  const states = useThreadStates(rpc, threadIds);
  const st = states[threadId];
  const unread = st?.unread === true;
  const needsInput = st?.needsInput === true;
  const working = st?.status === "active" || st?.status === "starting";
  // Looking at the open chat counts as reading it.
  useEffect(() => {
    if (!chatOpen || !unread || !document.hasFocus()) return;
    const t = window.setTimeout(() => void rpc.call("thread_mark_read", { threadId }), 1200);
    return () => window.clearTimeout(t);
  }, [chatOpen, unread, rpc, threadId]);
  const attention = !chatOpen && (unread || needsInput);
  const attentionLabel = needsInput ? "needs your input" : unread ? "new reply" : working ? "working…" : null;
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-1.5">
        <button
          type="button"
          className="flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onBack}
          title="Back to all RFCs"
        >
          <Icon name="ChevronLeft" className="size-3.5" />
          RFCs
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={item?.path ?? undefined}>
          {item?.title ?? "RFC"}
        </span>
        {item?.status ? <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase", statusTone(item.status))}>{item.status}</span> : null}
        <div className="mx-1 flex shrink-0 items-center gap-0.5 border-l border-border pl-2">
          <ViewTabs view={view} onChange={setView} pending={pending} badges={{ items: openNotes }} compact />
        </div>
        <div className="flex shrink-0 items-center border-l border-border pl-1">
          {item !== null ? (
            <button
              type="button"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                const target = item.hostId === null ? null : ({ kind: "host", hostId: item.hostId, path: item.path } as const);
                if (target === null || !navigate.experimental_openFileExternally({ target, location: null })) {
                  void navigator.clipboard.writeText(item.path);
                  toast.message("Path copied; open it in your editor.");
                }
              }}
              title={item.path}
            >
              <Icon name="ExternalLink" className="size-3.5" />
              Editor
            </button>
          ) : null}
          <button
            type="button"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => navigate.toThread(threadId)}
            title="Open this conversation as a full thread"
          >
            <Icon name="MessagesSquare" className="size-3.5" />
            Thread
          </button>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-muted hover:text-foreground",
              chatOpen ? "text-foreground" : "text-muted-foreground",
            )}
            onClick={() => setChatOpen(!chatOpen)}
            title={chatOpen ? "Hide the conversation" : "Show the conversation"}
          >
            <Icon name={chatOpen ? "PanelRightClose" : "PanelRightOpen"} className="size-3.5" />
            Chat
            {attention ? <span className={cn("size-2 rounded-full", needsInput ? "bg-destructive" : "bg-primary")} title={attentionLabel ?? undefined} /> : null}
            {!chatOpen && !attention && working ? <Icon name="LoaderCircle" className="size-3 animate-spin" /> : null}
          </button>
        </div>
      </div>
      <SplitPane
        storageKey="workspace-chat-right"
        initial={0.62}
        min={0.3}
        max={0.85}
        minLeftPx={360}
        minRightPx={400}
        left={panel}
        right={chat}
        collapsed={!chatOpen}
        collapsedRail={
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            className={cn(
              "relative flex w-7 shrink-0 flex-col items-center gap-2 border-l border-border pt-2 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              attention && "text-foreground",
            )}
            title={attentionLabel === null ? "Show the conversation" : `Show the conversation (${attentionLabel})`}
          >
            <span className="relative">
              <Icon name={working && !attention ? "LoaderCircle" : "MessagesSquare"} className={cn("size-4", working && !attention && "animate-spin")} />
              {attention ? <span className={cn("absolute -right-1 -top-1 size-2.5 rounded-full ring-2 ring-background", needsInput ? "bg-destructive" : "bg-primary")} /> : null}
            </span>
            <span className="text-[10px] [writing-mode:vertical-rl]">{attentionLabel === null ? "Chat" : attentionLabel}</span>
          </button>
        }
      />
    </div>
  );
}

function LibraryPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const library = useLibrary(rpc);
  const routeThreadId = subPath.replace(/^\/+|\/+$/g, "");
  // Re-entering the page from the sidebar returns to the last workspace.
  // "All RFCs" clears it so the list is reachable.
  const [threadId, setThreadId] = useState(() => (routeThreadId !== "" ? routeThreadId : (recall("lastWorkspace") ?? "")));
  useEffect(() => {
    if (routeThreadId !== "") {
      setThreadId(routeThreadId);
      remember("lastWorkspace", routeThreadId);
    }
  }, [routeThreadId]);
  const go = (id: string | null) => {
    setThreadId(id ?? "");
    remember("lastWorkspace", id);
    navigate.toPluginPanel("rfcs", { subPath: id ?? "" });
  };

  if (threadId !== "") {
    const item = library.items?.find((i) => i.threads.some((t) => t.id === threadId)) ?? null;
    return <RfcWorkspace threadId={threadId} item={item} onBack={() => go(null)} />;
  }
  return (
    <div className="flex h-full min-h-0 w-full">
      <LibraryList rpc={rpc} {...library} onOpen={go} />
      <div className="flex min-w-0 flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <div>
          <Icon name="FileText" className="mx-auto mb-2 size-8 opacity-40" />
          <p>Pick an RFC to open its conversation with the editor and preview beside it.</p>
          <p className="mt-1 text-xs">Hover a row to jump to a specific thread or start a new one.</p>
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  for (const name of ICON_NAMES) app.experimental_icons.register({ name: `rfcs:${name}`, component: iconComponent(name) });
  app.slots.navPanel({
    id: "rfcs",
    title: "RFCs",
    icon: "FileText",
    path: "rfcs",
    component: LibraryPage,
  });
  app.slots.threadPanelAction({
    id: "rfc",
    title: "RFC",
    icon: "FileText",
    layout: "flush",
    component: RfcPanel,
  });
  app.slots.fileOpener({
    id: "rfc-markdown",
    title: "RFC preview (diagrams)",
    extensions: ["md", "markdown"],
    component: MarkdownOpener,
  });
});
