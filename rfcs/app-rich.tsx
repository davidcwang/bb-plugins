// WYSIWYG section editor: the section's markdown rendered as editable rich
// text (Tiptap/ProseMirror) and serialised back to markdown on save. Only the
// edited section is re-serialised, so the rest of the file is untouched.
import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { toast } from "sonner";
import { markdownBlocks } from "./shared";
import { cn } from "@/lib/utils";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function SectionRichEditor({
  initial,
  startLine,
  focusLine,
  onSave,
  onCancel,
  onRaw,
}: {
  initial: string;
  startLine: number;
  focusLine: number;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
  /** Switch to the raw-markdown textarea for this section. */
  onRaw: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Trailing blank lines separate this section from the next; the serialiser drops them, so keep ours.
  const trailing = useMemo(() => initial.match(/\n*$/)?.[0] ?? "", [initial]);
  const body = useMemo(() => initial.replace(/\n*$/, ""), [initial]);
  const state = useRef({ baseline: null as string | null, busy: false, done: false });
  state.current.busy = busy;
  const commitRef = useRef<() => void>(() => undefined);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true }, heading: { levels: [1, 2, 3, 4, 5, 6] } }),
      TableKit.configure({ table: { resizable: false } }),
      Markdown.configure({ indentation: { style: "space", size: 2 } }),
    ],
    content: body,
    contentType: "markdown",
    editorProps: {
      attributes: { class: "rfc-rich outline-none", spellcheck: "true" },
      handleKeyDown: (_view, event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          state.current.done = true;
          onCancel();
          return true;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          commitRef.current();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor: ed }) => {
      // What this section looks like after a no-op round trip; saving compares against it.
      state.current.baseline = ed.getMarkdown();
      // Caret on the block the user clicked: the nth top-level block before the clicked source line.
      const blocks = markdownBlocks(body);
      const index = Math.max(0, blocks.filter((b) => b.line + startLine - 1 <= focusLine).length - 1);
      const doc = ed.state.doc;
      let pos = 1;
      for (let i = 0; i < Math.min(index, doc.childCount); i++) pos += doc.child(i).nodeSize;
      ed.commands.focus(Math.min(pos, doc.content.size), { scrollIntoView: false });
    },
    onBlur: () => commitRef.current(),
  });

  const commit = () => {
    const s = state.current;
    if (editor === null || editor.isDestroyed || s.busy || s.done || s.baseline === null) return;
    const md = editor.getMarkdown();
    if (md === s.baseline) {
      s.done = true;
      onCancel();
      return;
    }
    s.busy = true;
    setBusy(true);
    onSave(md.replace(/\n*$/, "") + trailing).then(
      () => {
        s.done = true;
      },
      (cause: unknown) => {
        toast.error(describe(cause));
        s.busy = false;
        setBusy(false);
      },
    );
  };
  commitRef.current = commit;

  // Leaving via another route (section re-keyed, panel closed): save pending edits.
  useEffect(() => () => commitRef.current(), []);

  return (
    <div className={cn("rfc-section-editor relative my-1 rounded border border-primary/40", busy && "opacity-60")}>
      <div className="absolute -top-2.5 right-2 flex items-center gap-1 rounded border border-border bg-background px-1.5 text-[10px] text-muted-foreground">
        <span>editing · ⌘↩ save · esc cancel</span>
        <button type="button" className="rounded px-1 hover:bg-muted hover:text-foreground" onMouseDown={(e) => e.preventDefault()} onClick={onRaw} title="Edit the raw markdown of this section instead">
          raw
        </button>
        <button
          type="button"
          className="rounded px-1 hover:bg-muted hover:text-foreground"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            state.current.done = true;
            onCancel();
          }}
        >
          cancel
        </button>
        <button type="button" className="rounded px-1 text-foreground hover:bg-muted" onMouseDown={(e) => e.preventDefault()} onClick={commit} disabled={busy}>
          {busy ? "saving…" : "save"}
        </button>
      </div>
      <EditorContent editor={editor} className="px-3 py-2" />
    </div>
  );
}
