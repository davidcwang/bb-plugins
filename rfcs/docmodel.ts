// Markdown → the paragraph model a Google Doc uses, so the plugin can diff the
// RFC against the Doc's body and describe edits as "replace this paragraph",
// "insert after that one", "delete this one". Plain text with inline runs;
// the Apps Script turns runs into bold/italic/code/link formatting. Tables,
// code fences and diagrams are kept as opaque blocks the script cannot edit;
// those get reported for a manual update. No Node imports.
import { markdownBlocks, parseFrontmatter, splitDocument } from "./shared";

export interface DocRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

export interface DocBlock {
  /** heading | paragraph | list | opaque (table, code fence, diagram, html) */
  kind: "heading" | "paragraph" | "list" | "opaque";
  /** Heading level 1–6, or list nesting level (0-based) for lists. */
  level: number;
  ordered?: boolean;
  /** Plain text as it should appear in the Doc. */
  text: string;
  runs: DocRun[];
  /** For opaque blocks: what it is, for the manual-update report. */
  opaque?: "table" | "code" | "diagram" | "html";
  /** 1-based source line in the markdown. */
  line: number;
}

/** Strip inline markdown into runs with bold/italic/code/link flags. */
export function inlineRuns(md: string): DocRun[] {
  const runs: DocRun[] = [];
  // Tokens: `code`, **bold**, *italic*/_italic_, [text](url), <br>, plain.
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<br\s*\/?>|\\([\\`*_{}[\]()#+\-.!>])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (r: DocRun) => {
    if (r.text === "") return;
    const prev = runs[runs.length - 1];
    if (prev !== undefined && !prev.bold === !r.bold && !prev.italic === !r.italic && !prev.code === !r.code && prev.link === r.link) prev.text += r.text;
    else runs.push(r);
  };
  while ((m = re.exec(md)) !== null) {
    if (m.index > last) push({ text: md.slice(last, m.index) });
    if (m[2] !== undefined) push({ text: m[2].trim(), code: true });
    else if (m[3] !== undefined) for (const r of inlineRuns(m[3])) push({ ...r, bold: true });
    else if (m[4] !== undefined) for (const r of inlineRuns(m[4])) push({ ...r, bold: true });
    else if (m[5] !== undefined) for (const r of inlineRuns(m[5])) push({ ...r, italic: true });
    else if (m[6] !== undefined) for (const r of inlineRuns(m[6])) push({ ...r, italic: true });
    else if (m[7] !== undefined && m[8] !== undefined) for (const r of inlineRuns(m[7])) push({ ...r, link: m[8] });
    else if (m[0].startsWith("<br")) push({ text: "\n" });
    else if (m[9] !== undefined) push({ text: m[9] });
    last = m.index + m[0].length;
  }
  if (last < md.length) push({ text: md.slice(last) });
  return runs;
}

export const plainText = (runs: DocRun[]) => runs.map((r) => r.text).join("");

/** Body of the markdown (frontmatter stripped) as Doc blocks. */
export function markdownToDocBlocks(content: string): DocBlock[] {
  const fm = parseFrontmatter(content);
  const body = fm === null ? content : fm.body;
  const offset = fm === null ? 0 : content.slice(0, content.length - body.length).split("\n").length - 1;
  const out: DocBlock[] = [];
  for (const seg of splitDocument(body)) {
    if (seg.kind === "diagram") {
      out.push({ kind: "opaque", level: 0, text: "", runs: [], opaque: "diagram", line: seg.startLine + offset });
      continue;
    }
    const lines = seg.text.split("\n");
    for (const b of markdownBlocks(seg.text)) {
      const line = b.line + seg.startLine - 1 + offset;
      const raw = lines[b.line - 1] ?? "";
      if (b.kind === "heading") {
        const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
        const level = h?.[1]?.length ?? 2;
        const text = h?.[2] ?? raw.trim();
        const runs = inlineRuns(text);
        out.push({ kind: "heading", level, text: plainText(runs), runs, line });
      } else if (b.kind === "list") {
        for (const itemLine of b.items ?? [b.line]) {
          // Item text: the item line without its marker, plus continuation lines up to the next item.
          const nextItem = (b.items ?? []).find((l) => l > itemLine);
          const endLine = nextItem === undefined ? blockEnd(lines, itemLine) : nextItem - 1;
          const first = lines[itemLine - 1] ?? "";
          const mm = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(first);
          const indent = mm?.[1]?.length ?? 0;
          const ordered = /^\d/.test(mm?.[2] ?? "");
          const parts = [mm?.[3] ?? first.trim()];
          for (let l = itemLine + 1; l <= endLine; l++) {
            const cont = lines[l - 1] ?? "";
            if (/^\s*$/.test(cont)) break;
            if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(cont)) {
              // Nested item: its own block.
              const nm = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(cont)!;
              const nruns = inlineRuns(nm[3]!);
              out.push({ kind: "list", level: Math.max(1, Math.round(nm[1]!.length / 2)), ordered: /^\d/.test(nm[2]!), text: plainText(nruns), runs: nruns, line: itemLine + (l - itemLine) + seg.startLine - 1 + offset });
              continue;
            }
            parts.push(cont.trim());
          }
          const runs = inlineRuns(parts.join(" "));
          out.push({ kind: "list", level: Math.round(indent / 2), ordered, text: plainText(runs), runs, line: itemLine + seg.startLine - 1 + offset });
        }
      } else if (b.kind === "table") {
        out.push({ kind: "opaque", level: 0, text: "", runs: [], opaque: "table", line });
      } else if (b.kind === "code") {
        out.push({ kind: "opaque", level: 0, text: "", runs: [], opaque: "code", line });
      } else if (b.kind === "html") {
        out.push({ kind: "opaque", level: 0, text: "", runs: [], opaque: "html", line });
      } else if (b.kind === "hr") {
        continue;
      } else {
        const endLine = blockEnd(lines, b.line);
        const text = lines
          .slice(b.line - 1, endLine)
          .map((l) => l.replace(/^\s{0,3}>\s?/, "").trim())
          .join(" ");
        const runs = inlineRuns(text);
        out.push({ kind: "paragraph", level: 0, text: plainText(runs), runs, line });
      }
    }
  }
  return out;
}

function blockEnd(lines: string[], start: number): number {
  let i = start;
  while (i < lines.length && !/^\s*$/.test(lines[i] ?? "")) i++;
  return i;
}

/** Normalised text for matching a markdown block to a Doc paragraph. */
export const normBlock = (t: string) => t.toLowerCase().replace(/[\s ]+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();

export interface DocParagraph {
  /** Position in the Doc body. */
  index: number;
  kind: "heading" | "paragraph" | "list" | "table" | "other";
  level: number;
  text: string;
}

export type DocOp =
  | { op: "replace"; find: string; block: DocBlock }
  | { op: "insertAfter"; anchor: string | null; block: DocBlock }
  | { op: "delete"; find: string };

/**
 * Edits that bring the Doc body in line with the markdown. Text anchors, not
 * indexes, so the script survives concurrent edits. Opaque blocks (tables,
 * code, diagrams) are never touched and are listed for a manual update.
 */
export function planDocOps(docParas: DocParagraph[], blocks: DocBlock[], diff: (a: string[], b: string[]) => Array<{ kind: "eq" | "add" | "del"; ai: number | null; bi: number | null }>): { ops: DocOp[]; manual: DocBlock[] } {
  const editable = blocks.filter((b) => b.kind !== "opaque");
  const manual = blocks.filter((b) => b.kind === "opaque");
  const paras = docParas.filter((p) => p.kind !== "table" && p.kind !== "other" && p.text.trim() !== "");
  const seq = diff(
    paras.map((p) => normBlock(p.text)),
    editable.map((b) => normBlock(b.text)),
  );
  const ops: DocOp[] = [];
  let lastAnchor: string | null = null;
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i]!;
    if (s.kind === "eq") {
      lastAnchor = paras[s.ai!]!.text;
      continue;
    }
    if (s.kind === "del") {
      const next = seq[i + 1];
      if (next !== undefined && next.kind === "add") {
        ops.push({ op: "replace", find: paras[s.ai!]!.text, block: editable[next.bi!]! });
        lastAnchor = editable[next.bi!]!.text;
        i++;
        continue;
      }
      ops.push({ op: "delete", find: paras[s.ai!]!.text });
      continue;
    }
    const block = editable[s.bi!]!;
    ops.push({ op: "insertAfter", anchor: lastAnchor, block });
    lastAnchor = block.text;
  }
  return { ops, manual };
}

/** A block for creating a fresh Doc: everything, including the content of tables, code and diagrams. */
export type CreateBlock =
  | DocBlock
  | { kind: "table"; level: 0; text: string; runs: DocRun[]; rows: Array<Array<{ text: string; runs: DocRun[] }>>; line: number }
  | { kind: "code"; level: 0; text: string; runs: DocRun[]; code: string; lang: string | null; line: number }
  | { kind: "diagram"; level: 0; text: string; runs: DocRun[]; code: string; lang: string; imageKey: string; line: number };

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let i = 0;
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  while (i < t.length) {
    const ch = t[i]!;
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "|";
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = t.indexOf("`", i + 1);
      if (end !== -1) {
        cur += t.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
    i++;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * The whole document as blocks for "Create Google Doc". Prose blocks are the
 * same as markdownToDocBlocks; tables carry their cells, code fences their
 * text, diagrams their source plus an image key the app fills with a PNG.
 */
export function markdownToCreateBlocks(content: string): CreateBlock[] {
  const fm = parseFrontmatter(content);
  const body = fm === null ? content : fm.body;
  const offset = fm === null ? 0 : content.slice(0, content.length - body.length).split("\n").length - 1;
  const prose = markdownToDocBlocks(content);
  const out: CreateBlock[] = [];
  let diagramN = 0;
  for (const seg of splitDocument(body)) {
    if (seg.kind === "diagram") {
      diagramN++;
      out.push({ kind: "diagram", level: 0, text: "", runs: [], code: seg.text, lang: seg.lang ?? "mermaid", imageKey: `diagram-${diagramN}`, line: seg.startLine + offset });
      continue;
    }
    const lines = seg.text.split("\n");
    for (const b of markdownBlocks(seg.text)) {
      const line = b.line + seg.startLine - 1 + offset;
      if (b.kind === "table") {
        const rows = (b.rows ?? [b.line]).map((rl) => splitRow(lines[rl - 1] ?? "").map((cell) => {
          const runs = inlineRuns(cell);
          return { text: plainText(runs), runs };
        }));
        out.push({ kind: "table", level: 0, text: "", runs: [], rows, line });
      } else if (b.kind === "code") {
        const open = lines[b.line - 1] ?? "";
        const fence = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/.exec(open);
        const lang = fence?.[2] ? fence[2] : null;
        const codeLines: string[] = [];
        for (let l = b.line; l < lines.length; l++) {
          const cur = lines[l] ?? "";
          if (fence !== null && cur.trim().startsWith(fence[1]!)) break;
          codeLines.push(cur);
        }
        out.push({ kind: "code", level: 0, text: "", runs: [], code: codeLines.join("\n"), lang, line });
      } else if (b.kind === "html" || b.kind === "hr") {
        continue;
      } else {
        // Prose: take the already-built blocks that start on this block's lines.
        const next = markdownBlocks(seg.text).find((x) => x.line > b.line);
        const endLine = (next === undefined ? lines.length : next.line - 1) + seg.startLine - 1 + offset;
        for (const pb of prose) if (pb.kind !== "opaque" && pb.line >= line && pb.line <= endLine) out.push(pb);
      }
    }
  }
  return out;
}
