// Markdown → Atlassian Document Format, for issue descriptions. Jira Cloud's
// v3 API only takes ADF, so drafts written in Markdown are converted on create.
//
// Covers what ticket descriptions use: headings, paragraphs (a single newline
// is a line break), nested bullet and numbered lists, fenced code, pipe tables
// (the separator row is optional), blockquotes, rules, and inline code, links,
// bare URLs, bold and italic. Anything else stays as literal text.

export type AdfMark = { type: "strong" | "em" | "code" | "strike" } | { type: "link"; attrs: { href: string } };

export type AdfNode = {
  version?: 1;
  type: string;
  text?: string;
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
};

const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function markdownToAdf(markdown: string): AdfNode {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  return { version: 1, type: "doc", content: blocks(lines) };
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    LIST_ITEM.test(line) ||
    QUOTE.test(line) ||
    TABLE_ROW.test(line)
  );
}

function blocks(lines: string[]): AdfNode[] {
  const out: AdfNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const close = new RegExp(`^\\s*${fence[1]![0] === "`" ? "`" : "~"}{${fence[1]!.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence, or end of input
      const text = body.join("\n");
      out.push({
        type: "codeBlock",
        ...(fence[2] === "" ? {} : { attrs: { language: fence[2] } }),
        content: text === "" ? [] : [{ type: "text", text }],
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      out.push({ type: "heading", attrs: { level: heading[1]!.length }, content: inline(heading[2]!) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push({ type: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      out.push({ type: "blockquote", content: blocks(body) });
      continue;
    }

    if (TABLE_ROW.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(lines[i++]!);
      out.push(table(rows));
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const body: string[] = [];
      // A list runs until a blank line followed by something that is neither
      // indented nor another item, or a line that starts a different block.
      while (i < lines.length) {
        const current = lines[i]!;
        if (current.trim() === "") {
          const next = lines[i + 1];
          if (next === undefined || !(LIST_ITEM.test(next) || /^\s+\S/.test(next))) break;
          i++;
          continue;
        }
        if (!LIST_ITEM.test(current) && !/^\s+\S/.test(current) && startsBlock(current)) break;
        if (!LIST_ITEM.test(current) && !/^\s+\S/.test(current) && body.length > 0 && lines[i - 1]?.trim() === "") break;
        body.push(current);
        i++;
      }
      out.push(...list(body));
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && (para.length === 0 || !startsBlock(lines[i]!))) {
      para.push(lines[i++]!.trim());
    }
    out.push({ type: "paragraph", content: withBreaks(para) });
  }
  return out;
}

/** Paragraph lines joined by hard breaks, as the plain-text editor intends. */
function withBreaks(lines: string[]): AdfNode[] {
  return lines.flatMap((line, index) => [
    ...(index === 0 ? [] : [{ type: "hardBreak" }]),
    ...inline(line),
  ]);
}

type Item = { indent: number; ordered: boolean; start: number; text: string[]; children: string[] };

/** Items at the shallowest indent; deeper lines belong to the item above them. */
function list(lines: string[]): AdfNode[] {
  const base = Math.min(...lines.filter((l) => LIST_ITEM.test(l)).map((l) => LIST_ITEM.exec(l)![1]!.length));
  const items: Item[] = [];
  for (const line of lines) {
    const match = LIST_ITEM.exec(line);
    if (match !== null && match[1]!.length <= base) {
      const marker = match[2]!;
      const ordered = /\d/.test(marker);
      items.push({ indent: match[1]!.length, ordered, start: ordered ? parseInt(marker, 10) : 1, text: [match[3]!], children: [] });
      continue;
    }
    const last = items[items.length - 1];
    if (last === undefined) continue;
    if (match !== null || last.children.length > 0) last.children.push(line);
    else last.text.push(line.trim()); // continuation of the item's own text
  }
  // Consecutive items of the same kind form one list; a change of kind starts another.
  const out: AdfNode[] = [];
  for (const item of items) {
    const node: AdfNode = {
      type: "listItem",
      content: [{ type: "paragraph", content: withBreaks(item.text) }, ...blocks(dedent(item.children))],
    };
    const prev = out[out.length - 1];
    const type = item.ordered ? "orderedList" : "bulletList";
    if (prev !== undefined && prev.type === type) prev.content!.push(node);
    else {
      out.push({
        type,
        ...(item.ordered && item.start !== 1 ? { attrs: { order: item.start } } : {}),
        content: [node],
      });
    }
  }
  return out;
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)![0].length);
  const cut = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(Math.min(cut, /^\s*/.exec(l)![0].length)));
}

function cells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  // Split on pipes that are not escaped or inside backticks.
  const out: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "\\" && trimmed[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cell += ch;
    } else if (ch === "|" && !inCode) {
      out.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

function table(rows: string[]): AdfNode {
  // The first row is the header, with or without a separator row under it.
  const parsed = rows.filter((row, i) => !(i === 1 && TABLE_SEPARATOR.test(row))).map(cells);
  const width = Math.max(...parsed.map((r) => r.length));
  return {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: parsed.map((row, r) => ({
      type: "tableRow",
      content: Array.from({ length: width }, (_, c) => ({
        type: r === 0 ? "tableHeader" : "tableCell",
        attrs: {},
        content: [{ type: "paragraph", content: inline(row[c] ?? "") }],
      })),
    })),
  };
}

// ---- inline ----------------------------------------------------------------

const URL_CHARS = /^https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*/;

/**
 * Inline Markdown → text nodes with marks. Underscore emphasis needs a
 * non-word character on both sides, so snake_case identifiers stay literal.
 */
export function inline(source: string, marks: AdfMark[] = []): AdfNode[] {
  const out: AdfNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer !== "") out.push(textNode(buffer, marks));
    buffer = "";
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const prev = i === 0 ? " " : source[i - 1]!;

    if (rest[0] === "\\" && rest.length > 1 && /[\\`*_[\]()#|>~-]/.test(rest[1]!)) {
      buffer += rest[1];
      i += 2;
      continue;
    }

    const code = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code !== null) {
      flush();
      out.push(textNode(code[2]!.replace(/^ (.*) $/, "$1"), [...marks.filter((m) => m.type === "link"), { type: "code" }]));
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\(\s*(<[^>]*>|[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)(?:\s+"[^"]*")?\s*\)/.exec(rest);
    if (link !== null) {
      flush();
      const href = link[2]!.replace(/^<|>$/g, "");
      out.push(...inline(link[1]!, [...marks.filter((m) => m.type !== "link"), { type: "link", attrs: { href } }]));
      i += link[0].length;
      continue;
    }

    const auto = /^<(https?:\/\/[^\s>]+)>/.exec(rest);
    const bare = /\w/.test(prev) ? null : URL_CHARS.exec(rest);
    if (auto !== null || bare !== null) {
      flush();
      // Trailing sentence punctuation is not part of a bare URL.
      const href = auto !== null ? auto[1]! : bare![0].replace(/[.,;:!?'"]+$/, "");
      out.push(textNode(href, [...marks.filter((m) => m.type !== "link"), { type: "link", attrs: { href } }]));
      i += auto !== null ? auto[0].length : href.length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong !== null && (strong[1] === "**" || (!/\w/.test(prev) && !/\w/.test(source[i + strong[0].length] ?? " ")))) {
      flush();
      out.push(...inline(strong[2]!, [...marks, { type: "strong" }]));
      i += strong[0].length;
      continue;
    }

    const em = /^([*_])(?=[^\s*_])([\s\S]*?[^\s\\])\1(?![*_])/.exec(rest);
    if (em !== null && (em[1] === "*" || (!/\w/.test(prev) && !/\w/.test(source[i + em[0].length] ?? " ")))) {
      flush();
      out.push(...inline(em[2]!, [...marks, { type: "em" }]));
      i += em[0].length;
      continue;
    }

    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (strike !== null) {
      flush();
      out.push(...inline(strike[1]!, [...marks, { type: "strike" }]));
      i += strike[0].length;
      continue;
    }

    buffer += rest[0];
    i++;
  }
  flush();
  return out;
}

function textNode(text: string, marks: AdfMark[]): AdfNode {
  return marks.length === 0 ? { type: "text", text } : { type: "text", text, marks };
}
