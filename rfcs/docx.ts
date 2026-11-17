// Reads reviewer comments out of a .docx (as Google Docs exports it): each
// comment's author, date, text, the text it was anchored to, the paragraph
// around it, and the nearest heading above it. Replies are comments that
// share an anchor range. Regex over the two XML parts is enough here; we never
// need a full OOXML model. Server-side only (Node Buffer, fflate).
import { unzipSync, strFromU8 } from "fflate";

export interface DocxReply {
  author: string;
  date: string | null;
  text: string;
}
export interface DocxComment {
  /** Comment id inside this export (not stable across exports). */
  docxId: string;
  author: string;
  date: string | null;
  text: string;
  /** Text the comment was anchored to; empty for images/tables. */
  quoted: string;
  /** Full text of the paragraph that holds the anchor (or the nearest one with text). */
  context: string;
  /** Nearest Heading1–3 above the anchor, as plain text. */
  heading: string | null;
  /** True when the anchor paragraph was an image rather than text. */
  onImage: boolean;
  replies: DocxReply[];
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)));

/** Visible text of a run of WordprocessingML: w:t contents, tabs/breaks as spaces. */
function textOf(xml: string): string {
  const parts: string[] = [];
  // Paragraph and table-cell boundaries become spaces so a range spanning cells reads "vendor text …", not "vendortext…".
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:p>|<\/w:tc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) parts.push(m[1] === undefined ? " " : decode(m[1]));
  return parts.join("").replace(/\s+/g, " ").trim();
}

function paragraphsOf(xml: string): Array<{ text: string; start: number; end: number; style: string | null; drawing: boolean }> {
  const out: Array<{ text: string; start: number; end: number; style: string | null; drawing: boolean }> = [];
  const re = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1] ?? "";
    const style = /<w:pStyle w:val="([^"]+)"/.exec(body)?.[1] ?? null;
    out.push({ text: textOf(body), start: m.index, end: m.index + m[0].length, style, drawing: /<w:drawing|<pic:pic|<v:imagedata/.test(body) });
  }
  return out;
}

export function parseDocxComments(file: Uint8Array): DocxComment[] {
  const zip = unzipSync(file);
  const commentsXml = zip["word/comments.xml"];
  const documentXml = zip["word/document.xml"];
  if (commentsXml === undefined || documentXml === undefined) return [];
  const cxml = strFromU8(commentsXml);
  const dxml = strFromU8(documentXml);

  // 1. Comment bodies.
  const bodies = new Map<string, { author: string; date: string | null; text: string }>();
  const cre = /<w:comment\s([^>]*)>([\s\S]*?)<\/w:comment>/g;
  let m: RegExpExecArray | null;
  while ((m = cre.exec(cxml)) !== null) {
    const attrs = m[1]!;
    const id = /w:id="([^"]+)"/.exec(attrs)?.[1];
    if (id === undefined) continue;
    const author = decode(/w:author="([^"]*)"/.exec(attrs)?.[1] ?? "Unknown");
    const date = /w:date="([^"]*)"/.exec(attrs)?.[1] ?? null;
    const text = paragraphsOf(m[2]!)
      .map((p) => p.text)
      .filter((t) => t !== "")
      .join("\n");
    bodies.set(id, { author, date, text });
  }

  // 2. Anchors in the body.
  const paras = paragraphsOf(dxml);
  const headingAt = (pos: number): string | null => {
    for (let i = paras.length - 1; i >= 0; i--) {
      const p = paras[i]!;
      if (p.start <= pos && p.style !== null && /^Heading[1-3]$/.test(p.style) && p.text !== "") return p.text;
    }
    return null;
  };
  const paragraphAt = (pos: number) => paras.findIndex((p) => p.start <= pos && pos <= p.end);
  interface Anchor {
    id: string;
    start: number;
    end: number;
    quoted: string;
    context: string;
    heading: string | null;
    onImage: boolean;
  }
  const anchors: Anchor[] = [];
  const sre = /<w:commentRangeStart w:id="([^"]+)"\/>/g;
  while ((m = sre.exec(dxml)) !== null) {
    const id = m[1]!;
    const start = m.index;
    const endTag = `<w:commentRangeEnd w:id="${id}"/>`;
    const endIdx = dxml.indexOf(endTag, start);
    const end = endIdx === -1 ? start : endIdx;
    const quoted = endIdx === -1 ? "" : textOf(dxml.slice(start, end));
    let pi = paragraphAt(start);
    const onImage = pi >= 0 && paras[pi]!.drawing && paras[pi]!.text === "";
    // Images and empty paragraphs: context is the nearest paragraph with text above.
    let context = pi >= 0 ? paras[pi]!.text : "";
    while (context === "" && pi > 0) {
      pi--;
      context = paras[pi]!.text;
    }
    anchors.push({ id, start, end, quoted, context, heading: headingAt(start), onImage });
  }
  anchors.sort((a, b) => a.start - b.start);

  // 3. Group replies: comments whose range (nearly) coincides with the previous one.
  const groups: Anchor[][] = [];
  for (const a of anchors) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    const sameSpan = prev !== undefined && Math.abs(a.start - prev.start) <= 80 && Math.abs(a.end - prev.end) <= 80;
    const sameText = prev !== undefined && a.quoted !== "" && a.quoted === prev.quoted && Math.abs(a.start - prev.start) <= 200;
    if (prev !== undefined && (sameSpan || sameText)) g!.push(a);
    else groups.push([a]);
  }
  const out: DocxComment[] = [];
  for (const g of groups) {
    const withBody = g.map((a) => ({ a, b: bodies.get(a.id) })).filter((x): x is { a: Anchor; b: { author: string; date: string | null; text: string } } => x.b !== undefined);
    if (withBody.length === 0) continue;
    withBody.sort((x, y) => (x.b.date ?? "").localeCompare(y.b.date ?? ""));
    const root = withBody[0]!;
    out.push({
      docxId: root.a.id,
      author: root.b.author,
      date: root.b.date,
      text: root.b.text,
      quoted: root.a.quoted,
      context: root.a.context,
      heading: root.a.heading,
      onImage: root.a.onImage,
      replies: withBody.slice(1).map((x) => ({ author: x.b.author, date: x.b.date, text: x.b.text })),
    });
  }
  // Comments with a body but no anchor (rare): keep them, unanchored.
  const seen = new Set(anchors.map((a) => a.id));
  for (const [id, b] of bodies) {
    if (seen.has(id)) continue;
    out.push({ docxId: id, author: b.author, date: b.date, text: b.text, quoted: "", context: "", heading: null, onImage: false, replies: [] });
  }
  return out;
}
