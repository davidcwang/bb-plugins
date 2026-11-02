// The document editor: the RFC body rendered as always-editable rich text
// (Tiptap/ProseMirror) that round-trips to markdown. There is no edit mode:
// click anywhere and type. Section chrome (notes, claims, cards, terms) and
// explainer cards are injected between blocks as ProseMirror widget
// decorations rendered through React portals, so everything the read-only
// preview offered still works here.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PmNode } from "@tiptap/pm/model";
import { toast } from "sonner";
import type { DocRead, rpcContract } from "./server";
import { markdownBlocks, parseFrontmatter, splitSections, type DocSection } from "./shared";
import { plainTitle, type Anchor, type Card, type CardMode, type Claim, type Note, type Sidecar } from "./sidecar";
import { CardView, SectionChrome, SelectionToolbar, itemsForSection, useSelectionActions, type DiagramRenderer, type ItemsTab } from "./app-sidecar";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Line-addressable scroll surface: `lineAtTop` is 1-based and fractional. */
export interface LineScroller {
  lineAtTop(): number;
  scrollToLine(line: number): void;
}

export interface DocAnnotations {
  threadId: string;
  sidecar: Sidecar | null;
  environmentId: string | null;
  termsExpanded: boolean;
  onAddNote: (anchor: Anchor, title: string) => void;
  onExplain: (anchor: Anchor, mode: CardMode, prompt: string) => void;
  onOpenItems: (tab: ItemsTab, section: string | null) => void;
}

// ---- diagram code blocks ---------------------------------------------------

const DiagramContext = createContext<DiagramRenderer | null>(null);
const isDiagramLang = (lang: unknown): lang is "mermaid" | "d2" => lang === "mermaid" || lang === "d2";

/** ```mermaid / ```d2 fences draw as diagrams; "edit source" reveals the editable fence. */
function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const Diagram = useContext(DiagramContext);
  const lang = node.attrs.language as string | null;
  const [editing, setEditing] = useState(false);
  const diagram = Diagram !== null && isDiagramLang(lang);
  return (
    <NodeViewWrapper className="rfc-codeblock" data-lang={lang ?? ""}>
      {diagram ? (
        <div contentEditable={false} className={cn("rfc-diagram-node", editing && "hidden")}>
          <Diagram lang={lang} source={node.textContent} startLine={0} />
          <div className="-mt-1 mb-2 flex justify-end">
            <button type="button" className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setEditing(true)}>
              edit source
            </button>
          </div>
        </div>
      ) : null}
      <pre className={cn(diagram && !editing && "hidden")}>
        {diagram ? (
          <div contentEditable={false} className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>{lang} source</span>
            <button type="button" className="ml-auto rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => setEditing(false)}>
              show diagram
            </button>
          </div>
        ) : (
          <input
            contentEditable={false}
            className="rfc-codeblock-lang mb-1 w-24 bg-transparent text-[10px] text-muted-foreground outline-none"
            value={lang ?? ""}
            placeholder="language"
            onChange={(e) => updateAttributes({ language: e.target.value || null })}
          />
        )}
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

const lowlight = createLowlight(common);
const RfcCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
}).configure({ lowlight, defaultLanguage: null });

// ---- section chrome as widget decorations ----------------------------------

interface SectionData {
  section: DocSection;
  notes: Note[];
  claims: Claim[];
  cards: Card[];
}
interface Widget {
  key: string;
  dom: HTMLElement;
  kind: "chrome" | "cards";
  title: string;
  level: number;
  /** Index of the heading among top-level nodes, for line estimation. */
  blockIndex: number;
}

const chromeKey = new PluginKey("rfcs-chrome");
const refreshMeta = "rfcs-chrome-refresh";

function headingsOf(doc: PmNode): Array<{ node: PmNode; pos: number; index: number; endPos: number }> {
  const out: Array<{ node: PmNode; pos: number; index: number; endPos: number }> = [];
  let pos = 0;
  doc.forEach((node, offset, index) => {
    if (node.type.name === "heading") out.push({ node, pos: offset, index, endPos: doc.content.size });
    pos = offset + node.nodeSize;
  });
  for (let i = 0; i + 1 < out.length; i++) out[i]!.endPos = out[i + 1]!.pos;
  return out;
}

/** Decorations: heading attrs for jump/selection, a chrome widget before each heading, a cards widget at each section's end. */
function chromeExtension(registry: { current: Map<string, Widget> }, bump: () => void, hasCards: (title: string) => boolean) {
  const build = (doc: PmNode) => {
    const decos: Decoration[] = [];
    const seen = new Map<string, number>();
    for (const h of headingsOf(doc)) {
      const base = h.node.textContent.trim();
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const key = n === 0 ? base : `${base}#${n}`;
      decos.push(Decoration.node(h.pos, h.pos + h.node.nodeSize, { "data-section": base, "data-block-index": String(h.index) }));
      const mk = (kind: Widget["kind"], at: number, side: number) =>
        Decoration.widget(
          at,
          () => {
            const dom = document.createElement("div");
            dom.className = kind === "chrome" ? "rfc-chrome-widget" : "rfc-cards rfc-cards-widget mb-2";
            dom.contentEditable = "false";
            registry.current.set(`${kind}:${key}`, { key: `${kind}:${key}`, dom, kind, title: base, level: h.node.attrs.level as number, blockIndex: h.index });
            bump();
            return dom;
          },
          {
            key: `${kind}:${key}`,
            side,
            ignoreSelection: true,
            stopEvent: () => true,
            destroy: () => {
              registry.current.delete(`${kind}:${key}`);
              bump();
            },
          },
        );
      decos.push(mk("chrome", h.pos, -1));
      // Same position as the next heading's chrome widget (side -1): -2 keeps the cards with their own section.
      if (hasCards(base)) decos.push(mk("cards", h.endPos, -2));
    }
    return DecorationSet.create(doc, decos);
  };
  return Extension.create({
    name: "rfcsChrome",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: chromeKey,
          state: {
            init: (_, state) => build(state.doc),
            apply: (tr, old) => (tr.docChanged || tr.getMeta(refreshMeta) === true ? build(tr.doc) : old),
          },
          props: { decorations: (state) => chromeKey.getState(state) as DecorationSet },
        }),
      ];
    },
  });
}

// ---- the editor ------------------------------------------------------------

type SaveStatus = "saved" | "unsaved" | "saving" | "conflict";
const statusLabel: Record<SaveStatus, string> = { saved: "Saved", unsaved: "Unsaved", saving: "Saving…", conflict: "Conflict" };
const statusDot: Record<SaveStatus, string> = { saved: "bg-green-500", unsaved: "bg-amber-500", saving: "bg-sky-500 animate-pulse", conflict: "bg-destructive" };

export function DocEditor({
  rpc,
  threadId,
  doc,
  annotate,
  header,
  Diagram,
  onSaved,
  onScroller,
  containerRef,
  onScroll,
  toolbar,
}: {
  rpc: Rpc;
  threadId: string;
  doc: DocRead;
  annotate: DocAnnotations;
  /** Rendered above the body (frontmatter). */
  header?: ReactNode;
  Diagram: DiagramRenderer;
  onSaved: () => void;
  /** Receives a line-addressable scroller for split-view sync. */
  onScroller?: (s: LineScroller | null) => void;
  containerRef?: RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  toolbar?: ReactNode;
}) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = containerRef ?? ownRef;
  const split = useMemo(() => {
    const fm = parseFrontmatter(doc.content);
    const body = fm === null ? doc.content : fm.body;
    const prefix = doc.content.slice(0, doc.content.length - body.length);
    return { body: body.replace(/\n+$/, ""), prefix, offset: prefix.split("\n").length - 1, trailing: /\n$/.test(doc.content) ? "\n" : "" };
  }, [doc.content]);

  // Sidecar items per section, from the saved file (positions come from it).
  const sections = useMemo(() => splitSections(split.body, split.offset), [split.body, split.offset]);
  const sectionData = useMemo(() => {
    const map = new Map<string, SectionData>();
    const sc = annotate.sidecar;
    const headings = sections.flatMap((x) => (x.heading === null ? [] : [x.heading.title]));
    sections.forEach((section, i) => {
      if (section.heading === null) return;
      const next = sections[i + 1]?.startLine ?? null;
      // Keyed as the reader sees it; editor headings are matched by DOM text.
      const title = plainTitle(section.heading.title);
      if (map.has(title)) return;
      map.set(title, {
        section,
        notes: sc === null ? [] : itemsForSection(sc.notes, section, next, headings),
        claims: sc === null ? [] : itemsForSection(sc.claims, section, next, headings),
        cards: sc === null ? [] : itemsForSection(sc.cards, section, next, headings),
      });
    });
    return map;
  }, [sections, annotate.sidecar]);
  const sectionDataRef = useRef(sectionData);
  sectionDataRef.current = sectionData;

  // Widget registry → React portals.
  const registry = useRef(new Map<string, Widget>());
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const extensions = useMemo(
    () => [
      StarterKit.configure({ codeBlock: false, link: { openOnClick: false, autolink: true }, heading: { levels: [1, 2, 3, 4, 5, 6] } }),
      RfcCodeBlock,
      TableKit.configure({ table: { resizable: false } }),
      Markdown.configure({ indentation: { style: "space", size: 2 } }),
      chromeExtension(registry, bump, (title) => (sectionDataRef.current.get(plainTitle(title))?.cards.length ?? 0) > 0),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Save state, kept in a ref because autosave paths run outside render.
  const st = useRef({ baseSha: doc.sha256, baseline: null as string | null, dirty: false, saving: false });
  const [status, setStatus] = useState<SaveStatus>("saved");
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const timer = useRef(0);

  const editor = useEditor({
    extensions,
    content: split.body,
    contentType: "markdown",
    editorProps: {
      attributes: { class: "rfc-rich rfc-doc outline-none", spellcheck: "true" },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void saveRef.current();
          return true;
        }
        return false;
      },
      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement).closest("a[href]");
        if (a !== null && (event.metaKey || event.ctrlKey)) {
          window.open((a as HTMLAnchorElement).href, "_blank", "noopener");
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor: ed }) => {
      st.current.baseline = ed.getMarkdown();
    },
    onUpdate: ({ transaction }) => {
      if (!transaction.docChanged) return;
      st.current.dirty = true;
      setStatus((s) => (s === "conflict" ? s : "unsaved"));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void saveRef.current(), 1500);
    },
    onBlur: () => void saveRef.current(),
  });

  const save = useCallback(
    async (force = false) => {
      const s = st.current;
      if (editor === null || editor.isDestroyed || s.saving) return;
      if (!s.dirty && !force) return;
      const md = editor.getMarkdown();
      if (!force && md === s.baseline) {
        s.dirty = false;
        setStatus("saved");
        return;
      }
      s.saving = true;
      setStatus("saving");
      try {
        const content = split.prefix + md + split.trailing;
        const result = await rpc.call("doc_write", { threadId, content, expectedSha256: force ? null : s.baseSha });
        if (result.outcome === "written") {
          s.baseSha = result.sha256;
          s.baseline = md;
          s.dirty = false;
          setStatus("saved");
          onSaved();
        } else {
          setStatus("conflict");
        }
      } catch (cause) {
        toast.error(describe(cause));
        setStatus("unsaved");
      } finally {
        s.saving = false;
      }
    },
    [editor, rpc, threadId, split.prefix, split.trailing, onSaved],
  );
  saveRef.current = () => save(false);

  // The file changed on disk (agent, raw editor, external) and we have nothing pending → adopt it.
  const adopt = useCallback(() => {
    if (editor === null || editor.isDestroyed) return;
    const s = st.current;
    const focused = editor.isFocused;
    const from = editor.state.selection.from;
    editor.commands.setContent(split.body, { contentType: "markdown", emitUpdate: false });
    s.baseSha = doc.sha256;
    s.baseline = editor.getMarkdown();
    s.dirty = false;
    setStatus("saved");
    if (focused) editor.commands.setTextSelection(Math.min(from, editor.state.doc.content.size));
  }, [editor, split.body, doc.sha256]);
  useEffect(() => {
    if (editor === null || doc.sha256 === st.current.baseSha) return;
    if (!st.current.dirty) adopt();
  }, [editor, doc.sha256, adopt]);
  // Sidecar or terms changed → rebuild decorations so chrome counts update.
  useEffect(() => {
    if (editor === null || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(refreshMeta, true));
  }, [editor, sectionData]);
  // Flush on unmount / window blur.
  useEffect(() => {
    const onWindowBlur = () => void saveRef.current();
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      window.clearTimeout(timer.current);
      void saveRef.current();
    };
  }, []);

  // Split-view scroll sync: top-level editor blocks ↔ source lines.
  useEffect(() => {
    if (editor === null || onScroller === undefined) return;
    const container = scrollRef.current;
    if (container === null) return;
    let cache: { size: string; chain: Array<{ line: number; top: number }> } | null = null;
    const totalLines = doc.content.split("\n").length;
    const chainNow = () => {
      const size = `${container.scrollHeight}|${container.clientWidth}|${editor.state.doc.content.size}`;
      if (cache !== null && cache.size === size) return cache.chain;
      const blocks = markdownBlocks(split.body);
      const view = editor.view;
      const docNode = editor.state.doc;
      const n = docNode.childCount;
      const aligned = blocks.length === n;
      const host = container.getBoundingClientRect();
      const chain: Array<{ line: number; top: number }> = [{ line: 1, top: 0 }];
      let pos = 0;
      for (let i = 0; i < n; i++) {
        const dom = view.nodeDOM(pos) as HTMLElement | null;
        pos += docNode.child(i).nodeSize;
        if (dom === null || typeof dom.getBoundingClientRect !== "function") continue;
        const top = dom.getBoundingClientRect().top - host.top + container.scrollTop;
        const line = aligned ? blocks[i]!.line + split.offset : 1 + split.offset + ((totalLines - split.offset - 1) * i) / Math.max(1, n - 1);
        if (line > chain[chain.length - 1]!.line) chain.push({ line, top });
      }
      chain.push({ line: totalLines + 1, top: container.scrollHeight });
      cache = { size, chain };
      return chain;
    };
    const scroller: LineScroller = {
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
    onScroller(scroller);
    return () => onScroller(null);
  }, [editor, onScroller, scrollRef, doc.content, split.body, split.offset]);

  // Selection toolbar (note / explain / ask on highlighted text).
  const { selection, clear } = useSelectionActions(scrollRef, doc.content);

  const widgets = Array.from(registry.current.values());
  const blockLines = useMemo(() => markdownBlocks(split.body).map((b) => b.line + split.offset), [split.body, split.offset]);
  const sectionFor = (w: Widget): SectionData => {
    const hit = sectionData.get(plainTitle(w.title));
    if (hit !== undefined) return hit;
    const line = blockLines[w.blockIndex] ?? split.offset + 1;
    return { section: { heading: { level: w.level, title: w.title, line }, startLine: line, text: "", segments: [] }, notes: [], claims: [], cards: [] };
  };

  return (
    <DiagramContext.Provider value={Diagram}>
      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto">
        {toolbar}
        <article className="rfc-preview relative px-4 py-3">
          {header}
          <EditorContent editor={editor} />
          {selection !== null ? (
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
        {widgets.map((w) => {
          const data = sectionFor(w);
          if (w.kind === "cards") {
            return createPortal(
              <>
                {data.cards.map((card) => (
                  <CardView key={card.id} rpc={rpc} threadId={annotate.threadId} card={card} environmentId={annotate.environmentId} Diagram={Diagram} defaultOpen={card.status === "pending"} />
                ))}
              </>,
              w.dom,
              w.key,
            );
          }
          return createPortal(
            <div data-section={data.section.heading?.title ?? ""} data-section-line={data.section.startLine}>
              <SectionChrome
                section={data.section}
                notes={data.notes}
                claims={data.claims}
                cards={data.cards}
                glossary={annotate.sidecar?.glossary ?? []}
                termsExpanded={annotate.termsExpanded}
                onAddNote={annotate.onAddNote}
                onExplain={annotate.onExplain}
                onOpenItems={annotate.onOpenItems}
              />
            </div>,
            w.dom,
            w.key,
          );
        })}
        <div className="pointer-events-none sticky bottom-1 flex justify-end px-2">
          <div className={cn("pointer-events-auto flex items-center gap-1.5 rounded border border-border bg-background/90 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur", status === "conflict" && "border-destructive")}>
            <span className={cn("inline-block size-1.5 rounded-full", statusDot[status])} />
            {status === "conflict" ? (
              <>
                <span>The file changed on disk while you had unsaved edits.</span>
                <button type="button" className="rounded px-1 text-foreground hover:bg-muted" onClick={() => void save(true)}>
                  Keep mine
                </button>
                <button type="button" className="rounded px-1 text-foreground hover:bg-muted" onClick={() => { st.current.dirty = false; adopt(); }}>
                  Take theirs
                </button>
              </>
            ) : (
              <span>{statusLabel[status]}</span>
            )}
          </div>
        </div>
      </div>
    </DiagramContext.Provider>
  );
}
