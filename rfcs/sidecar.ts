// The RFC sidecar: notes, explainer cards, glossary, claims, and walkthroughs
// for one RFC, stored as `<rfc>.rfcs.json` beside the markdown so git carries
// it. Shared by server.ts and app.tsx; zod only, no Node imports.
import { z } from "zod";

export const SIDECAR_SUFFIX = ".rfcs.json";
export const sidecarPathFor = (docPath: string) => docPath.replace(/\.(md|markdown)$/i, "") + SIDECAR_SUFFIX;

export const anchorSchema = z.object({
  /** Heading text of the section (without #), or null for the whole document. */
  section: z.string().max(300).nullable().default(null),
  /** 1-based source line when known. */
  line: z.number().int().positive().nullable().default(null),
  /** Short verbatim quote the item is about. */
  quote: z.string().max(600).nullable().default(null),
});
export type Anchor = z.infer<typeof anchorSchema>;

export const NOTE_STATUSES = ["open", "decided", "blocked", "superseded"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const noteSchema = z.object({
  id: z.string(),
  anchor: anchorSchema,
  title: z.string().min(1).max(200),
  body: z.string().max(8000).default(""),
  status: z.enum(NOTE_STATUSES).default("open"),
  /** The outcome, once decided/superseded: what was decided and why. */
  resolution: z.string().max(8000).nullable().default(null),
  /** Hidden thread where this note is discussed, once opened. */
  threadId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.enum(["user", "agent"]).default("user"),
});
export type Note = z.infer<typeof noteSchema>;

export const CARD_MODES = ["concept", "code", "data", "flow", "question"] as const;
export type CardMode = (typeof CARD_MODES)[number];
export const CARD_MODE_LABEL: Record<CardMode, string> = {
  concept: "Explain the concept",
  code: "Show the code path",
  data: "Show the data model",
  flow: "Show the flow",
  question: "Ask a question",
};

export const codeRefSchema = z.object({
  /** Workspace-relative path. */
  path: z.string().max(500),
  startLine: z.number().int().positive().nullable().default(null),
  endLine: z.number().int().positive().nullable().default(null),
  /** Optional excerpt so the card reads without opening the file. */
  snippet: z.string().max(6000).nullable().default(null),
  note: z.string().max(400).nullable().default(null),
});
export type CodeRef = z.infer<typeof codeRefSchema>;

export const diagramSchema = z.object({
  lang: z.enum(["mermaid", "d2"]),
  source: z.string().max(20_000),
});

export const cardSchema = z.object({
  id: z.string(),
  anchor: anchorSchema,
  mode: z.enum(CARD_MODES),
  /** The user's selection or question that prompted the card. */
  prompt: z.string().max(2000),
  title: z.string().max(200),
  body: z.string().max(20_000),
  diagram: diagramSchema.nullable().default(null),
  files: z.array(codeRefSchema).max(20).default([]),
  status: z.enum(["pending", "ready", "failed"]).default("pending"),
  threadId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Card = z.infer<typeof cardSchema>;

export const termSchema = z.object({
  /** The term or ID as written in the document, e.g. "S12", "OIDC", "WIF". */
  term: z.string().min(1).max(80),
  /** One line; what it stands for and what it refers to here. */
  definition: z.string().min(1).max(1000),
  /** Alternate spellings matched case-insensitively. */
  aliases: z.array(z.string().max(80)).max(10).default([]),
  /** Where to read more: a section heading in this RFC or an external ref. */
  see: z.string().max(300).nullable().default(null),
});
export type Term = z.infer<typeof termSchema>;

export const CLAIM_STATUSES = ["verified", "assumed", "stale", "superseded"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const claimSchema = z.object({
  id: z.string(),
  /** Short key as cited in the text, e.g. "A2", "P20", "D6". */
  key: z.string().max(20).nullable().default(null),
  text: z.string().min(1).max(2000),
  /** Where it came from: doc, PDF, Slack, source file, spike step. */
  source: z.string().max(500).nullable().default(null),
  status: z.enum(CLAIM_STATUSES).default("assumed"),
  /** When it was last confirmed true (ISO date). */
  verifiedAt: z.string().nullable().default(null),
  /** Vendor/system version it was verified against, e.g. "chart 0.25.0". */
  against: z.string().max(120).nullable().default(null),
  anchor: anchorSchema.default({ section: null, line: null, quote: null }),
  note: z.string().max(2000).nullable().default(null),
  updatedAt: z.string(),
});
export type Claim = z.infer<typeof claimSchema>;

export const walkthroughStepSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(20_000),
  anchor: anchorSchema.default({ section: null, line: null, quote: null }),
  diagram: diagramSchema.nullable().default(null),
  files: z.array(codeRefSchema).max(20).default([]),
});
export type WalkthroughStep = z.infer<typeof walkthroughStepSchema>;

export const walkthroughSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  /** What this walkthrough is for: "first read", "security review", "what changed since 0.22". */
  audience: z.string().max(300).nullable().default(null),
  steps: z.array(walkthroughStepSchema).min(1).max(40),
  createdAt: z.string(),
});
export type Walkthrough = z.infer<typeof walkthroughSchema>;

export const sidecarSchema = z.object({
  version: z.literal(1),
  notes: z.array(noteSchema).default([]),
  cards: z.array(cardSchema).default([]),
  glossary: z.array(termSchema).default([]),
  claims: z.array(claimSchema).default([]),
  walkthroughs: z.array(walkthroughSchema).default([]),
});
export type Sidecar = z.infer<typeof sidecarSchema>;

export const emptySidecar = (): Sidecar => ({ version: 1, notes: [], cards: [], glossary: [], claims: [], walkthroughs: [] });

/** Which section heading (exact text) an anchor refers to, matched loosely. */
export function sectionMatches(anchorSection: string | null, heading: string): boolean {
  if (anchorSection === null) return false;
  // Ignore "## " and leading numbering ("4.", "4.1", "§4") so agents that
  // omit them still match.
  const norm = (s: string) =>
    s
      .replace(/^#+\s*/, "")
      .replace(/^§?\s*\d+(\.\d+)*\.?\s*/, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const a = norm(anchorSection);
  const h = norm(heading);
  if (a === "" || h === "") return false;
  return a === h || (a.length >= 4 && (h.startsWith(a) || a.startsWith(h)));
}

/** Glossary terms that appear in a piece of text (whole-word, case-insensitive for words; exact for IDs). */
export function termsIn(text: string, glossary: Term[]): Term[] {
  const hay = text;
  const lower = hay.toLowerCase();
  const out: Term[] = [];
  for (const t of glossary) {
    const names = [t.term, ...t.aliases];
    const hit = names.some((name) => {
      if (name.length === 0) return false;
      const idLike = /^[A-Z]{1,3}\d{1,3}$/.test(name);
      const re = new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Za-z0-9_])`, idLike ? "" : "i");
      return re.test(idLike ? hay : lower.length === hay.length ? hay : hay);
    });
    if (hit) out.push(t);
  }
  return out;
}
