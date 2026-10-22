// Values shared by server.ts and app.tsx. Keep this file free of Node imports:
// the frontend bundle includes it.
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Fenced code block languages the preview renders as diagrams. */
export const DIAGRAM_LANGS = ["mermaid", "d2"] as const;
export type DiagramLang = (typeof DIAGRAM_LANGS)[number];

export const CHANGED = "rfcs-changed";

/** Realtime payload published by the server after any state change. */
export interface ChangedPayload {
  threadId: string;
  kind: "doc" | "review" | "library" | "sidecar";
}

export interface DocSegment {
  kind: "markdown" | "diagram";
  /** For diagrams: the fence language. */
  lang: DiagramLang | null;
  text: string;
  /** 1-based line of the first line of this segment in the document. */
  startLine: number;
}

/**
 * Split a markdown document into prose and diagram segments. Prose goes to
 * bb's Markdown renderer; ```mermaid and ```d2 fences render as diagrams.
 * Fences inside other fences stay literal (we track the opening fence string).
 */
export function splitDocument(content: string): DocSegment[] {
  const lines = content.split("\n");
  const out: DocSegment[] = [];
  let prose: string[] = [];
  let proseStart = 1;
  let open: { fence: string; lang: DiagramLang; start: number; body: string[] } | null = null;
  let otherFence: string | null = null;

  const flushProse = () => {
    if (prose.length === 0) return;
    out.push({ kind: "markdown", lang: null, text: prose.join("\n"), startLine: proseStart });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^(\s{0,3})(`{3,}|~{3,})\s*([\w-]*)\s*$/);
    if (open !== null) {
      if (fence && fence[2]!.startsWith(open.fence[0]!) && fence[2]!.length >= open.fence.length && fence[3] === "") {
        out.push({ kind: "diagram", lang: open.lang, text: open.body.join("\n"), startLine: open.start });
        open = null;
        proseStart = i + 2;
      } else {
        open.body.push(line);
      }
      continue;
    }
    if (otherFence !== null) {
      prose.push(line);
      if (fence && fence[2]!.startsWith(otherFence[0]!) && fence[2]!.length >= otherFence.length && fence[3] === "") {
        otherFence = null;
      }
      continue;
    }
    if (fence) {
      const lang = fence[3]!.toLowerCase();
      if ((DIAGRAM_LANGS as readonly string[]).includes(lang)) {
        flushProse();
        open = { fence: fence[2]!, lang: lang as DiagramLang, start: i + 1, body: [] };
        continue;
      }
      otherFence = fence[2]!;
    }
    if (prose.length === 0) proseStart = i + 1;
    prose.push(line);
  }
  if (open !== null) {
    // Unterminated diagram fence (likely mid-edit): render what we have.
    out.push({ kind: "diagram", lang: open.lang, text: open.body.join("\n"), startLine: open.start });
  }
  flushProse();
  return out;
}

/** Parse a leading YAML-ish frontmatter block into flat key/value pairs. */
export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const raw of match[1]!.split(/\r?\n/)) {
    const kv = raw.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return { meta, body: content.slice(match[0].length) };
}

/** Headings of the document, for the outline and finding anchors. */
export function outline(content: string): Array<{ level: number; title: string; line: number }> {
  const out: Array<{ level: number; title: string; line: number }> = [];
  let fence: string | null = null;
  content.split("\n").forEach((line, i) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (fence === null) fence = f[1]!;
      else if (f[1]!.startsWith(fence[0]!) && f[1]!.length >= fence.length) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) out.push({ level: h[1]!.length, title: h[2]!, line: i + 1 });
  });
  return out;
}

export interface MdBlock {
  kind: "heading" | "paragraph" | "list" | "table" | "code" | "quote" | "hr" | "html";
  /** 1-based line of the block's first line, relative to the scanned text. */
  line: number;
  /** For tables: the line of each rendered row (header first, separator skipped). */
  rows?: number[];
  /** For lists: the line of each top-level item. */
  items?: number[];
}

/**
 * A light CommonMark block scanner: enough to line up top-level rendered
 * elements (and table rows / list items) with their source lines for
 * editor-preview scroll sync. It does not need to be a full parser; the
 * matcher tolerates the odd mismatch.
 */
export function markdownBlocks(text: string): MdBlock[] {
  const L = text.split("\n");
  const out: MdBlock[] = [];
  const isBlank = (l: string) => /^\s*$/.test(l);
  const fenceRe = /^\s{0,3}(`{3,}|~{3,})/;
  const headRe = /^\s{0,3}#{1,6}(\s|$)/;
  const hrRe = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const quoteRe = /^\s{0,3}>/;
  const itemRe = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
  const sepRe = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const htmlRe = /^\s{0,3}<[a-zA-Z!/]/;
  const setextRe = /^\s{0,3}(=+|-+)\s*$/;
  const indentOf = (l: string) => l.match(/^\s*/)![0].length;
  let i = 0;
  while (i < L.length) {
    const l = L[i]!;
    if (isBlank(l)) {
      i++;
      continue;
    }
    const f = l.match(fenceRe);
    if (f) {
      const start = i;
      const ch = f[1]![0]!;
      const len = f[1]!.length;
      i++;
      while (i < L.length) {
        const close = L[i]!.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        i++;
        if (close && close[1]![0] === ch && close[1]!.length >= len) break;
      }
      out.push({ kind: "code", line: start + 1 });
      continue;
    }
    if (headRe.test(l)) {
      out.push({ kind: "heading", line: i + 1 });
      i++;
      continue;
    }
    if (hrRe.test(l)) {
      out.push({ kind: "hr", line: i + 1 });
      i++;
      continue;
    }
    if (l.includes("|") && i + 1 < L.length && L[i + 1]!.includes("-") && sepRe.test(L[i + 1]!)) {
      const rows = [i + 1];
      i += 2;
      while (i < L.length && !isBlank(L[i]!) && L[i]!.includes("|")) {
        rows.push(i + 1);
        i++;
      }
      out.push({ kind: "table", line: rows[0]!, rows });
      continue;
    }
    if (quoteRe.test(l)) {
      const start = i;
      while (i < L.length && !isBlank(L[i]!)) i++;
      out.push({ kind: "quote", line: start + 1 });
      continue;
    }
    const m = l.match(itemRe);
    if (m) {
      const indent = m[1]!.length;
      const start = i;
      const items = [i + 1];
      const sameLevel = (s: string) => {
        const mm = s.match(itemRe);
        return mm !== null && mm[1]!.length >= indent && mm[1]!.length <= indent + 1;
      };
      i++;
      while (i < L.length) {
        const cur = L[i]!;
        if (isBlank(cur)) {
          let k = i + 1;
          while (k < L.length && isBlank(L[k]!)) k++;
          if (k < L.length && (sameLevel(L[k]!) || indentOf(L[k]!) > indent)) {
            i = k;
            continue;
          }
          break;
        }
        if (sameLevel(cur)) {
          items.push(i + 1);
          i++;
          continue;
        }
        if (indentOf(cur) <= indent && (headRe.test(cur) || fenceRe.test(cur) || hrRe.test(cur))) break;
        i++;
      }
      out.push({ kind: "list", line: start + 1, items });
      continue;
    }
    if (htmlRe.test(l)) {
      const start = i;
      while (i < L.length && !isBlank(L[i]!)) i++;
      out.push({ kind: "html", line: start + 1 });
      continue;
    }
    const start = i;
    let kind: MdBlock["kind"] = "paragraph";
    i++;
    while (i < L.length) {
      const cur = L[i]!;
      if (isBlank(cur) || headRe.test(cur) || fenceRe.test(cur) || quoteRe.test(cur)) break;
      if (setextRe.test(cur)) {
        kind = "heading";
        i++;
        break;
      }
      if (/^\s{0,3}[-*+]\s+/.test(cur)) break;
      i++;
    }
    out.push({ kind, line: start + 1 });
  }
  return out;
}

export interface DocSection {
  /** null for content before the first heading. */
  heading: { level: number; title: string; line: number } | null;
  /** 1-based line where the section starts (the heading line). */
  startLine: number;
  /** Plain text of the section (for term matching). */
  text: string;
  segments: DocSegment[];
}

/** Split a markdown segment at headings (outside fences), keeping line numbers. */
function splitAtHeadings(segment: DocSegment): DocSegment[] {
  if (segment.kind !== "markdown") return [segment];
  const lines = segment.text.split("\n");
  const out: DocSegment[] = [];
  let buf: string[] = [];
  let bufStart = segment.startLine;
  let fence: string | null = null;
  const flush = () => {
    if (buf.length === 0) return;
    out.push({ kind: "markdown", lang: null, text: buf.join("\n"), startLine: bufStart });
    buf = [];
  };
  lines.forEach((line, i) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (fence === null) fence = f[1]!;
      else if (f[1]!.startsWith(fence[0]!) && f[1]!.length >= fence.length) fence = null;
    } else if (fence === null && /^\s{0,3}#{1,6}\s+\S/.test(line)) {
      flush();
      bufStart = segment.startLine + i;
    }
    if (buf.length === 0) bufStart = segment.startLine + i;
    buf.push(line);
  });
  flush();
  return out;
}

/** Group a document body into heading-delimited sections of renderable segments. */
export function splitSections(body: string, lineOffset = 0): DocSection[] {
  const segments = splitDocument(body).flatMap(splitAtHeadings);
  const sections: DocSection[] = [];
  for (const seg of segments) {
    const startLine = seg.startLine + lineOffset;
    const headingMatch = seg.kind === "markdown" ? seg.text.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/m) : null;
    const startsWithHeading = headingMatch !== null && seg.text.trimStart().startsWith(headingMatch[0].trim());
    const shifted: DocSegment = { ...seg, startLine };
    if (startsWithHeading || sections.length === 0) {
      sections.push({
        heading: startsWithHeading ? { level: headingMatch![1]!.length, title: headingMatch![2]!, line: startLine } : null,
        startLine,
        text: seg.text,
        segments: [shifted],
      });
    } else {
      const cur = sections[sections.length - 1]!;
      cur.segments.push(shifted);
      cur.text += `\n${seg.text}`;
    }
  }
  return sections;
}
