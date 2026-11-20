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

// ---- ADF → Markdown ----------------------------------------------------------

/**
 * ADF → Markdown, for editing an existing description. The inverse of
 * markdownToAdf for everything it produces. Content Markdown cannot carry
 * (images, panels, mentions, colors, ...) is listed in `lossy`; saving the
 * Markdown back would drop or flatten it.
 */
export function adfToMarkdown(doc: unknown): { markdown: string; lossy: string[] } {
  const lossy = new Set<string>();
  const root = typeof doc === "object" && doc !== null ? (doc as AdfNode) : { type: "doc", content: [] };
  const markdown = mdBlocks(root.content ?? [], lossy).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return { markdown, lossy: [...lossy].sort() };
}

const LOSSY_BLOCK: Record<string, string> = {
  mediaSingle: "images or attachments",
  mediaGroup: "images or attachments",
  media: "images or attachments",
  panel: "panels (kept as quotes)",
  expand: "expand sections (kept as plain content)",
  nestedExpand: "expand sections (kept as plain content)",
  decisionList: "decisions (kept as a list)",
  taskList: "checklists (kept as a list)",
  extension: "macros",
  bodiedExtension: "macros",
  embedCard: "embedded cards (kept as links)",
  blockCard: "link cards (kept as links)",
  layoutSection: "column layouts (kept as plain content)",
};

function mdBlocks(nodes: AdfNode[], lossy: Set<string>): string[] {
  return nodes.map((n) => mdBlock(n, lossy)).filter((s) => s !== "");
}

function mdBlock(node: AdfNode, lossy: Set<string>): string {
  const children = node.content ?? [];
  switch (node.type) {
    case "paragraph":
      return escapeLineStart(mdInline(children, lossy));
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${"#".repeat(level)} ${mdInline(children, lossy).replaceAll("\n", " ")}`;
    }
    case "bulletList":
    case "orderedList":
    case "taskList":
    case "decisionList": {
      if (LOSSY_BLOCK[node.type] !== undefined) lossy.add(LOSSY_BLOCK[node.type]!);
      const start = Number(node.attrs?.order ?? 1);
      return children
        .map((item, index) => {
          const marker = node.type === "orderedList" ? `${start + index}. ` : "- ";
          const parts = item.type === "listItem" ? mdBlocks(item.content ?? [], lossy) : [mdInline(item.content ?? [], lossy)];
          const pad = " ".repeat(marker.length);
          const body = parts
            .map((part, i) => (i === 0 ? part : `\n${part}`))
            .join("\n")
            .split("\n")
            .map((line, i) => (i === 0 || line === "" ? line : pad + line))
            .join("\n");
          return marker + body;
        })
        .join("\n");
    }
    case "codeBlock": {
      const text = children.map((c) => c.text ?? "").join("");
      const fence = text.includes("```") ? "~~~" : "```";
      return `${fence}${typeof node.attrs?.language === "string" ? node.attrs.language : ""}\n${text}\n${fence}`;
    }
    case "blockquote":
    case "panel":
      if (node.type === "panel") lossy.add(LOSSY_BLOCK.panel!);
      return mdBlocks(children, lossy)
        .join("\n\n")
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
    case "rule":
      return "---";
    case "table": {
      const rows = children.map((row) =>
        (row.content ?? []).map((cell) =>
          mdBlocks(cell.content ?? [], lossy).join(" ").replaceAll("\n", " ").replaceAll("|", "\\|"),
        ),
      );
      if (rows.length === 0) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
      return [line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
    }
    case "embedCard":
    case "blockCard":
      lossy.add(LOSSY_BLOCK[node.type]!);
      return typeof node.attrs?.url === "string" ? node.attrs.url : "";
    case "mediaSingle":
    case "mediaGroup":
    case "media":
    case "extension":
    case "bodiedExtension":
      lossy.add(LOSSY_BLOCK[node.type]!);
      return "";
    default:
      if (LOSSY_BLOCK[node.type] !== undefined) lossy.add(LOSSY_BLOCK[node.type]!);
      else if (node.content === undefined && node.text === undefined) lossy.add(`unsupported content (${node.type})`);
      return node.content === undefined ? mdInline([node], lossy) : mdBlocks(children, lossy).join("\n\n");
  }
}

/** A paragraph line that would otherwise read as a heading, list, quote, or rule. */
function escapeLineStart(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s*)([#>+]|-(?=\s)|\*(?=\s)|\d+(?=[.)]\s)|---)/, "$1\\$2"))
    .join("\n");
}

function escapeText(text: string): string {
  return text
    .replace(/[\\`*[\]~]/g, "\\$&")
    .replace(/(^|[^\w])_|_(?=[^\w]|$)/g, (m) => m.replace("_", "\\_"));
}

function mdInline(nodes: AdfNode[], lossy: Set<string>): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text": {
          const marks = node.marks ?? [];
          const code = marks.some((m) => m.type === "code");
          let text = code ? codeSpan(node.text ?? "") : escapeText(node.text ?? "");
          for (const mark of marks) {
            if (mark.type === "strong") text = `**${text}**`;
            else if (mark.type === "em") text = `*${text}*`;
            else if (mark.type === "strike") text = `~~${text}~~`;
            else if (mark.type !== "code" && mark.type !== "link") lossy.add("text styling such as underline or color");
          }
          const link = marks.find((m): m is Extract<AdfMark, { type: "link" }> => m.type === "link");
          if (link !== undefined) {
            text = !code && node.text === link.attrs.href ? link.attrs.href : `[${text}](${link.attrs.href})`;
          }
          return text;
        }
        case "hardBreak":
          return "\n";
        case "mention":
          lossy.add("@mentions (kept as plain names)");
          return typeof node.attrs?.text === "string" ? node.attrs.text : "@someone";
        case "emoji":
          return typeof node.attrs?.text === "string" ? node.attrs.text : String(node.attrs?.shortName ?? "");
        case "inlineCard":
          return typeof node.attrs?.url === "string" ? node.attrs.url : "";
        case "date": {
          lossy.add("dates (kept as text)");
          const ts = Number(node.attrs?.timestamp);
          return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : "";
        }
        case "status":
          lossy.add("status lozenges (kept as text)");
          return String(node.attrs?.text ?? "");
        default:
          lossy.add(`unsupported content (${node.type})`);
          return mdInline(node.content ?? [], lossy);
      }
    })
    .join("");
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  return /^`|`$/.test(text) ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}
