// bb-plugin-rfcs — backend entry.
//
// An RFC writing workbench beside a thread:
//  - Document: the RFC markdown file this thread is working on. The panel
//    shows a live-rendered preview (with mermaid and D2 diagrams) and an
//    editor; the agent edits the same file with its own tools.
//  - Review: a hidden worker thread reads the RFC and reports structured
//    findings through `rfc_report_findings`. You accept, skip, edit, and
//    prioritize them; "Send accepted" delivers them to the agent.
//  - Discussions: each finding can open its own hidden child thread so the
//    conversation about that point stays with the point.
//
// State is per thread in bb.storage.kv. Files go through bb.sdk.files so the
// RFC can live on whichever host the thread's environment runs on.
import { createHash } from "node:crypto";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHANGED, PRIORITIES, SEVERITIES, outline, parseFrontmatter, type Priority, type Severity } from "./shared";
import {
  CARD_MODES,
  CARD_MODE_LABEL,
  CLAIM_STATUSES,
  NOTE_STATUSES,
  anchorSchema,
  cardSchema,
  claimSchema,
  codeRefSchema,
  diagramSchema,
  emptySidecar,
  noteSchema,
  sidecarPathFor,
  sidecarSchema,
  termSchema,
  walkthroughSchema,
  walkthroughStepSchema,
  type Card,
  type CardMode,
  type Claim,
  type Note,
  type Sidecar,
} from "./sidecar";

const REVIEW_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_FINDINGS = 60;
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const D2_CACHE_SIZE = 64;

// ---- schemas -------------------------------------------------------------

const docRefSchema = z.object({
  /** Absolute path on the environment's host. */
  path: z.string(),
  hostId: z.string().nullable(),
  setAt: z.string(),
});
export type DocRef = z.infer<typeof docRefSchema>;

const prioritySchema = z.enum(PRIORITIES);
const severitySchema = z.enum(SEVERITIES);
export type { Priority, Severity };

const findingInputSchema = z.object({
  /** Heading text the finding is about, e.g. "## Alternatives". */
  section: z.string().max(200).nullable().default(null),
  line: z.number().int().positive().nullable().default(null),
  /** Short verbatim quote from the RFC that the finding is about. */
  quote: z.string().max(500).nullable().default(null),
  severity: severitySchema.default("medium"),
  title: z.string().min(1).max(200),
  body: z.string().max(4000),
  suggestion: z.string().max(4000).nullable().default(null),
});
const findingSchema = findingInputSchema.extend({
  id: z.string(),
  round: z.number().int(),
  status: z.enum(["pending", "accepted", "skipped", "sent"]),
  priority: prioritySchema,
  /** Your edited version of `body`; null means send the original. */
  edited: z.string().max(4000).nullable(),
  /** Hidden child thread where this finding is discussed, once opened. */
  discussThreadId: z.string().nullable().default(null),
});
export type Finding = z.infer<typeof findingSchema>;

const reviewStateSchema = z.object({
  round: z.number().int(),
  status: z.enum(["idle", "running", "ready", "failed"]),
  reviewThreadId: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  findings: z.array(findingSchema),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;
const emptyReview = (): ReviewState => ({
  round: 0,
  status: "idle",
  reviewThreadId: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  findings: [],
});

const docReadSchema = z.object({
  path: z.string(),
  content: z.string(),
  sha256: z.string(),
  modifiedAtMs: z.number().nullable(),
});
export type DocRead = z.infer<typeof docReadSchema>;

const candidateSchema = z.object({ path: z.string(), relative: z.string() });
export type Candidate = z.infer<typeof candidateSchema>;

const libraryItemSchema = z.object({
  path: z.string(),
  hostId: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  relative: z.string(),
  title: z.string(),
  status: z.string().nullable(),
  authors: z.string().nullable(),
  updated: z.string().nullable(),
  modifiedAtMs: z.number().nullable(),
  sizeBytes: z.number(),
  found: z.enum(["rfc-dir", "search", "thread"]),
  threads: z.array(z.object({ id: z.string(), title: z.string().nullable(), status: z.string(), unread: z.boolean().default(false) })),
});
export type LibraryItem = z.infer<typeof libraryItemSchema>;

export const rpcContract = defineRpcContract({
  library_list: {
    input: z.object({ force: z.boolean().default(false) }).nullable(),
    output: z.object({ items: z.array(libraryItemSchema), notes: z.array(z.string()) }),
  },
  library_read: {
    input: z.object({ path: z.string().max(1000), hostId: z.string().nullable() }),
    output: docReadSchema.nullable(),
  },
  library_open: {
    // Open (or create) a thread for an RFC and make sure its RFC panel tab is pinned open.
    input: z.object({
      path: z.string().max(1000),
      hostId: z.string().nullable(),
      projectId: z.string().nullable(),
      threadId: z.string().nullable(),
      fresh: z.boolean().default(false),
    }),
    output: z.object({ threadId: z.string(), created: z.boolean() }),
  },
  threads_state: {
    // Read/attention state for a few threads, for unread badges while the chat pane is hidden.
    input: z.object({ threadIds: z.array(z.string()).max(50) }),
    output: z.array(z.object({ id: z.string(), status: z.string(), unread: z.boolean(), needsInput: z.boolean() })),
  },
  thread_mark_read: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  library_create: {
    // Create a new RFC from the template in the project's RFC directory and start a thread on it.
    input: z.object({ title: z.string().trim().min(1).max(200), projectId: z.string().nullable() }),
    output: z.object({ threadId: z.string(), path: z.string() }),
  },
  sidecar_get: {
    input: z.object({ threadId: z.string() }),
    output: sidecarSchema.nullable(),
  },
  note_add: {
    input: z.object({
      threadId: z.string(),
      anchor: anchorSchema,
      title: z.string().min(1).max(200),
      body: z.string().max(8000).default(""),
      status: z.enum(NOTE_STATUSES).default("open"),
      /** Open a discussion thread for it right away. */
      discuss: z.boolean().default(false),
    }),
    output: noteSchema,
  },
  note_update: {
    input: z.object({
      threadId: z.string(),
      id: z.string(),
      title: z.string().min(1).max(200).optional(),
      body: z.string().max(8000).optional(),
      status: z.enum(NOTE_STATUSES).optional(),
      resolution: z.string().max(8000).nullable().optional(),
    }),
    output: noteSchema,
  },
  note_remove: {
    input: z.object({ threadId: z.string(), id: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  note_discuss: {
    input: z.object({ threadId: z.string(), id: z.string() }),
    output: z.object({ discussThreadId: z.string() }),
  },
  card_open: {
    input: z.object({
      threadId: z.string(),
      anchor: anchorSchema,
      mode: z.enum(CARD_MODES),
      /** Selected text, or the user's question for mode "question". */
      prompt: z.string().min(1).max(2000),
    }),
    output: cardSchema,
  },
  card_remove: {
    input: z.object({ threadId: z.string(), id: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  term_set: {
    input: z.object({ threadId: z.string(), term: termSchema }),
    output: z.object({ count: z.number() }),
  },
  term_remove: {
    input: z.object({ threadId: z.string(), term: z.string() }),
    output: z.object({ count: z.number() }),
  },
  glossary_request: {
    // Ask the RFC thread to build/refresh the glossary from the document.
    input: z.object({ threadId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  claim_upsert: {
    input: z.object({ threadId: z.string(), claim: claimSchema.partial({ id: true, updatedAt: true }) }),
    output: claimSchema,
  },
  claim_remove: {
    input: z.object({ threadId: z.string(), id: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  claims_audit: {
    // Ask the RFC thread to extract/refresh claims from the document and re-verify the stale ones.
    input: z.object({ threadId: z.string(), focus: z.string().max(2000).default("") }),
    output: z.object({ ok: z.literal(true) }),
  },
  walkthrough_request: {
    input: z.object({ threadId: z.string(), audience: z.string().max(300).default("") }),
    output: z.object({ ok: z.literal(true) }),
  },
  walkthrough_remove: {
    input: z.object({ threadId: z.string(), id: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  context_get: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      environmentId: z.string().nullable(),
      hostId: z.string().nullable(),
      workspacePath: z.string().nullable(),
      rfcDir: z.string().nullable(),
      doc: docRefSchema.nullable(),
    }),
  },
  docs_list: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ candidates: z.array(candidateSchema), note: z.string().nullable() }),
  },
  doc_set: {
    input: z.object({ threadId: z.string(), path: z.string().min(1).max(1000) }),
    output: docRefSchema,
  },
  doc_create: {
    input: z.object({ threadId: z.string(), title: z.string().min(1).max(200) }),
    output: docRefSchema,
  },
  doc_read: {
    input: z.object({ threadId: z.string() }),
    output: docReadSchema.nullable(),
  },
  doc_write: {
    input: z.object({ threadId: z.string(), content: z.string().max(MAX_DOC_BYTES), expectedSha256: z.string().nullable() }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({ outcome: z.literal("conflict"), currentSha256: z.string().nullable() }),
    ]),
  },
  file_read: {
    // Used by the markdown file opener for files that are not the thread's RFC.
    input: z.object({
      source: z.enum(["workspace", "host"]),
      environmentId: z.string().nullable(),
      hostId: z.string().nullable(),
      path: z.string().max(1000),
    }),
    output: z.object({ content: z.string(), rootPath: z.string().nullable() }).nullable(),
  },
  file_excerpt: {
    // Lines of a workspace file for a code reference whose snippet the agent left out.
    input: z.object({ environmentId: z.string(), path: z.string().max(1000), startLine: z.number().int().positive().nullable(), endLine: z.number().int().positive().nullable() }),
    output: z.object({ text: z.string(), startLine: z.number(), endLine: z.number(), totalLines: z.number() }).nullable(),
  },
  diagram_render: {
    input: z.object({
      lang: z.literal("d2"),
      source: z.string().max(200_000),
      dark: z.boolean().default(false),
    }),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), svg: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  review_run: {
    input: z.object({ threadId: z.string(), instructions: z.string().max(4000).default("") }),
    output: z.object({ started: z.boolean(), reviewThreadId: z.string().nullable() }),
  },
  review_get: {
    input: z.object({ threadId: z.string() }),
    output: reviewStateSchema,
  },
  findings_update: {
    input: z.object({
      threadId: z.string(),
      id: z.string(),
      status: z.enum(["pending", "accepted", "skipped"]).optional(),
      priority: prioritySchema.optional(),
      edited: z.string().max(4000).nullable().optional(),
    }),
    output: findingSchema,
  },
  findings_bulk: {
    input: z.object({ threadId: z.string(), status: z.enum(["accepted", "skipped"]), ids: z.array(z.string()).optional() }),
    output: z.object({ changed: z.number() }),
  },
  findings_send: {
    input: z.object({ threadId: z.string(), note: z.string().max(4000).default("") }),
    output: z.object({ sent: z.number() }),
  },
  discuss_open: {
    input: z.object({ threadId: z.string(), id: z.string() }),
    output: z.object({ discussThreadId: z.string() }),
  },
});

// ---- helpers -------------------------------------------------------------

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${rel.replace(/^[\\/]+/, "")}`;
}
function normalize(p: string): string {
  const parts: string[] = [];
  for (const part of p.split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return (p.startsWith("/") ? "/" : "") + parts.join("/");
}
const within = (root: string, p: string) => normalize(p) === normalize(root) || normalize(p).startsWith(`${normalize(root)}/`);

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "rfc";
}

export function rfcTemplate(title: string, author: string | null): string {
  const date = new Date().toISOString().slice(0, 10);
  return `---
title: ${title}
status: draft
authors: ${author ?? ""}
created: ${date}
updated: ${date}
---

# ${title}

## Summary

One paragraph: what is being proposed and why it matters.

## Motivation

What problem exists today, who feels it, and what happens if nothing changes.

## Goals and non-goals

- Goal:
- Non-goal:

## Proposal

The design. Use diagrams where a picture carries more than prose:

\`\`\`d2
direction: right
client: Client
api: API {
  shape: rectangle
}
db: Database {
  shape: cylinder
}
client -> api: request
api -> db: query
\`\`\`

## Detailed design

### Data model

### Interfaces

### Failure modes

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |

## Security and privacy

## Rollout and migration

\`\`\`mermaid
sequenceDiagram
  participant Dev
  participant Staging
  participant Prod
  Dev->>Staging: deploy behind flag
  Staging->>Prod: promote after soak
\`\`\`

## Open questions

-
`;
}

export function formatFindingsMessage(findings: Finding[], docPath: string, note: string): string {
  const order = (f: Finding) => PRIORITIES.indexOf(f.priority);
  const sorted = [...findings].sort((a, b) => order(a) - order(b));
  const lines = [
    `RFC review: please address these ${sorted.length} accepted finding(s) on ${docPath}, in priority order (p0 first). Edit the RFC directly. For each finding say what you changed, or explain why you disagree.`,
  ];
  if (note.trim() !== "") lines.push("", note.trim());
  for (const f of sorted) {
    const where = [f.section, f.line === null ? null : `line ${f.line}`].filter(Boolean).join(", ");
    lines.push("", `### [${f.priority}] ${f.title}`);
    if (where !== "") lines.push(`Where: ${where}`);
    if (f.quote !== null) lines.push(`Quote: "${f.quote}"`);
    lines.push("", f.edited ?? f.body);
    if (f.suggestion !== null && f.edited === null) lines.push("", "Suggestion:", f.suggestion);
    if (f.discussThreadId !== null) {
      lines.push(
        "",
        `This finding was discussed in thread ${f.discussThreadId}. Read that conversation first with \`bb thread log ${f.discussThreadId} --format verbose --all\` and follow the conclusions reached there; they override the original suggestion where they differ.`,
      );
    }
  }
  return lines.join("\n");
}

/** D2 throws a JSON array of { range, errmsg }; turn it into readable lines. */
export function formatD2Error(cause: unknown): string {
  const raw = describe(cause).replace(/^Error:\s*/, "");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const lines = parsed
        .map((e: unknown) => (typeof e === "object" && e !== null && typeof (e as { errmsg?: unknown }).errmsg === "string" ? (e as { errmsg: string }).errmsg : null))
        .filter((l): l is string => l !== null)
        .map((l) => l.replace(/^index:/, "line "));
      if (lines.length > 0) return lines.join("\n");
    }
  } catch {
    // not JSON
  }
  return raw;
}

/** Strip scripts and event handlers from an SVG string before it is inlined. */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "$1=$2#$2");
}

// ---- plugin --------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    rfcDir: {
      type: "string",
      label: "RFC directory",
      description:
        "Where RFCs live. Relative paths resolve against the thread's workspace; an absolute path works for threads without a workspace.",
      default: "rfcs",
    },
    author: {
      type: "string",
      label: "Default author",
      description: "Written into the frontmatter of new RFCs.",
      default: "",
    },
    reviewInstructions: {
      type: "string",
      label: "Standing review instructions",
      description: "Appended to every review round, e.g. house style or sections every RFC must have.",
      experimental_multiline: true,
      default: "",
    },
    d2Layout: {
      type: "select",
      label: "D2 layout engine",
      description: "elk gives tidier architecture diagrams; dagre is faster.",
      options: ["elk", "dagre"],
      default: "elk",
    },
    d2Sketch: {
      type: "boolean",
      label: "D2 sketch (hand-drawn) style",
      default: false,
    },
  });

  // ---- storage ----
  const key = {
    doc: (threadId: string) => `doc:${threadId}`,
    review: (threadId: string) => `review:${threadId}`,
  };
  const readDoc = async (threadId: string): Promise<DocRef | null> => {
    const parsed = docRefSchema.safeParse(await bb.storage.kv.get<unknown>(key.doc(threadId)));
    return parsed.success ? parsed.data : null;
  };
  const writeDoc = async (threadId: string, doc: DocRef) => {
    await bb.storage.kv.set(key.doc(threadId), doc);
    invalidateLibrary();
    bb.realtime.publish(CHANGED, { threadId, kind: "doc" });
  };
  const readReview = async (threadId: string): Promise<ReviewState> => {
    const parsed = reviewStateSchema.safeParse(await bb.storage.kv.get<unknown>(key.review(threadId)));
    return parsed.success ? parsed.data : emptyReview();
  };
  const queues = new Map<string, Promise<unknown>>();
  function mutateReview<T>(threadId: string, fn: (state: ReviewState) => T | Promise<T>): Promise<T> {
    const prev = queues.get(threadId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const state = await readReview(threadId);
      const result = await fn(state);
      await bb.storage.kv.set(key.review(threadId), state);
      bb.realtime.publish(CHANGED, { threadId, kind: "review" });
      return result;
    });
    queues.set(threadId, next.catch(() => undefined));
    return next;
  }

  // ---- thread context ----
  async function threadContext(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    let environment: Awaited<ReturnType<typeof bb.sdk.environments.get>> | null = null;
    if (thread.environmentId !== null) {
      try {
        environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      } catch {
        environment = null;
      }
    }
    const { rfcDir: configured } = await settings.get();
    const workspacePath = environment?.path ?? null;
    const rfcDir =
      isAbsolute(configured) ? configured : workspacePath === null ? null : joinPath(workspacePath, configured);
    const hostId = environment?.hostId ?? null;
    const doc = await readDoc(threadId);
    return { thread, environment, workspacePath, rfcDir, hostId, doc };
  }

  /** Resolve a user- or agent-supplied path to an absolute path for this thread. */
  async function resolveDocPath(threadId: string, input: string): Promise<{ path: string; hostId: string | null }> {
    const { workspacePath, rfcDir, hostId } = await threadContext(threadId);
    const trimmed = input.trim();
    if (isAbsolute(trimmed)) return { path: normalize(trimmed), hostId };
    const base = workspacePath ?? rfcDir;
    if (base === null) {
      throw new Error("This thread has no workspace; pass an absolute path or set an absolute RFC directory in settings.");
    }
    // Relative paths resolve against the workspace first, then the RFC dir.
    const inWorkspace = normalize(joinPath(base, trimmed));
    if (rfcDir !== null && !trimmed.includes("/") && !trimmed.endsWith(".md")) {
      return { path: normalize(joinPath(rfcDir, `${trimmed}.md`)), hostId };
    }
    return { path: inWorkspace, hostId };
  }

  const fileArgs = (hostId: string | null) => (hostId === null ? {} : { hostId });

  async function readFileAt(path: string, hostId: string | null): Promise<DocRead | null> {
    try {
      const file = await bb.sdk.files.read({ path, ...fileArgs(hostId) });
      const content =
        file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
      return { path, content, sha256: file.sha256, modifiedAtMs: file.modifiedAtMs ?? null };
    } catch (cause) {
      if (/ENOENT|not found|no such file|does not exist|\b404\b/i.test(describe(cause))) return null;
      throw cause;
    }
  }

  async function setDoc(threadId: string, input: string): Promise<DocRef> {
    const { path, hostId } = await resolveDocPath(threadId, input);
    const doc: DocRef = { path, hostId, setAt: now() };
    await writeDoc(threadId, doc);
    return doc;
  }

  async function createDoc(threadId: string, title: string): Promise<DocRef> {
    const { rfcDir, hostId } = await threadContext(threadId);
    if (rfcDir === null) throw new Error("No RFC directory: this thread has no workspace and the setting is relative.");
    const { author } = await settings.get();
    let path = normalize(joinPath(rfcDir, `${slugify(title)}.md`));
    const existing = await readFileAt(path, hostId);
    if (existing !== null) path = normalize(joinPath(rfcDir, `${slugify(title)}-${Date.now().toString(36)}.md`));
    const result = await bb.sdk.files.write({
      path,
      content: rfcTemplate(title, author.trim() === "" ? null : author.trim()),
      createParents: true,
      expectedSha256: null,
      ...fileArgs(hostId),
    });
    if (result.outcome !== "written") throw new Error("Could not create the RFC file.");
    return setDoc(threadId, path);
  }

  // ---- D2 ----
  type D2Module = typeof import("@terrastruct/d2");
  let d2Instance: Promise<InstanceType<D2Module["D2"]>> | null = null;
  const d2 = () => {
    d2Instance ??= import("@terrastruct/d2").then((mod) => new mod.D2());
    return d2Instance;
  };
  const d2Cache = new Map<string, { ok: true; svg: string } | { ok: false; error: string }>();
  async function renderD2(source: string, dark: boolean) {
    const { d2Layout, d2Sketch } = await settings.get();
    const cacheKey = sha256(`${d2Layout}|${d2Sketch}|${dark}|${source}`);
    const hit = d2Cache.get(cacheKey);
    if (hit !== undefined) return hit;
    let result: { ok: true; svg: string } | { ok: false; error: string };
    try {
      const engine = await d2();
      const compiled = await engine.compile({
        fs: { index: source },
        inputPath: "index",
        options: {
          layout: d2Layout === "dagre" ? "dagre" : "elk",
          sketch: d2Sketch,
          // 0 = neutral default; 200 = dark mauve. The diagram's own `vars.d2-config` wins.
          themeID: dark ? 200 : 0,
          pad: 16,
          scale: 1,
          noXMLTag: true,
        },
      });
      const svg = await engine.render(compiled.diagram, compiled.renderOptions);
      result = { ok: true, svg: sanitizeSvg(svg) };
    } catch (cause) {
      result = { ok: false, error: formatD2Error(cause) };
    }
    if (d2Cache.size >= D2_CACHE_SIZE) d2Cache.delete(d2Cache.keys().next().value!);
    d2Cache.set(cacheKey, result);
    return result;
  }

  // ---- review worker ----
  type EnvChoice = Parameters<typeof bb.sdk.threads.spawn>[0]["environment"];
  async function spawnHidden(
    threadId: string,
    title: string,
    prompt: string,
    pluginMetadata: Record<string, string | number>,
  ): Promise<string> {
    const { thread, environment, workspacePath } = await threadContext(threadId);
    const pathHint =
      workspacePath === null
        ? ""
        : `\n\nThe workspace is the directory ${JSON.stringify(workspacePath)} on this machine; run every file command inside it.`;
    const base = {
      projectId: thread.projectId,
      title,
      visibility: "hidden" as const,
      parentThreadId: threadId,
      pluginMetadata,
    };
    const candidates: Array<{ environment: EnvChoice; prompt: string }> = [];
    if (environment !== null) candidates.push({ environment: { type: "reuse", environmentId: environment.id }, prompt });
    candidates.push({ environment: { type: "project-default" }, prompt: `${prompt}${pathHint}` });
    candidates.push({ environment: { type: "host", workspace: { type: "personal" } }, prompt: `${prompt}${pathHint}` });
    try {
      const siblings = await bb.sdk.environments.list({ projectId: thread.projectId });
      for (const sibling of siblings) {
        if (sibling.id === environment?.id || sibling.status !== "ready" || sibling.lifecycle.phase !== "active") continue;
        candidates.push({ environment: { type: "reuse", environmentId: sibling.id }, prompt: `${prompt}${pathHint}` });
      }
    } catch (cause) {
      bb.log.warn(`could not list environments: ${describe(cause)}`);
    }
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const spawned = await bb.sdk.threads.spawn({ ...base, ...candidate });
        return spawned.id;
      } catch (cause) {
        lastError = cause;
        bb.log.warn(`spawn with ${JSON.stringify(candidate.environment)} refused: ${describe(cause)}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function startReview(threadId: string, instructions: string) {
    const doc = await readDoc(threadId);
    if (doc === null) throw new Error("No RFC is open on this thread. Pick or create one first.");
    const claim = await mutateReview(threadId, (state) => {
      if (state.status === "running") return { claimed: false as const, reviewThreadId: state.reviewThreadId, round: state.round };
      state.round += 1;
      state.status = "running";
      state.reviewThreadId = null;
      state.startedAt = now();
      state.finishedAt = null;
      state.error = null;
      state.findings = state.findings.filter((f) => f.status === "sent");
      return { claimed: true as const, reviewThreadId: null, round: state.round };
    });
    if (!claim.claimed) return { started: false, reviewThreadId: claim.reviewThreadId };
    const round = claim.round;
    const fail = (message: string) =>
      mutateReview(threadId, (state) => {
        if (state.round !== round) return;
        state.status = "failed";
        state.error = message;
        state.finishedAt = now();
      });

    let workerId: string;
    try {
      const { reviewInstructions } = await settings.get();
      const prompt = [
        `You are reviewing an RFC (design document). Do not modify any files. Read the RFC at ${JSON.stringify(doc.path)} in full, and read any code or documents it references when that helps you judge it.`,
        "Review it the way a senior engineer on the design review would: Is the problem stated clearly and is the motivation real? Are goals and non-goals explicit? Does the proposal actually meet the goals? Are failure modes, security, privacy, migration, rollback, observability, and operational cost covered? Are the alternatives real alternatives with honest trade-offs? Are there hidden assumptions, unquantified claims, or missing data? Are diagrams consistent with the prose? Is anything ambiguous enough that two engineers would build different things?",
        "Report every finding with the rfc_report_findings tool: one call, all findings. Each has `section` (the heading it concerns), `line` when you can point at one, a short verbatim `quote` from the RFC when one anchors the point, `severity` (high: blocks approval; medium: should fix before approval; low: polish), a short `title`, a `body` that explains the concern concretely and why it matters, and a `suggestion` with specific text or a specific change when you have one. Report at most 25 findings; prefer fewer, sharper ones over nits. Skip pure style unless it hides a real ambiguity.",
        "If you find nothing, call the tool with an empty list. After the tool call, reply with one line summarizing the round and stop.",
        instructions.trim() === "" ? null : `Additional instructions from the user:\n${instructions.trim()}`,
        reviewInstructions.trim() === "" ? null : `Standing instructions:\n${reviewInstructions.trim()}`,
      ]
        .filter((p): p is string => p !== null)
        .join("\n\n");
      const { thread } = await threadContext(threadId);
      workerId = await spawnHidden(threadId, `RFC review round ${round}: ${thread.title ?? threadId}`, prompt, {
        reviewFor: threadId,
        round,
      });
    } catch (cause) {
      await fail(describe(cause));
      throw cause;
    }
    await mutateReview(threadId, (state) => {
      if (state.round === round) state.reviewThreadId = workerId;
    });

    void (async () => {
      const deadline = Date.now() + REVIEW_TIMEOUT_MS;
      let error: string | null = null;
      try {
        for (;;) {
          const current = await bb.sdk.threads.get({ threadId: workerId });
          if (current.status === "idle") break;
          if (current.status === "error") {
            error = "The review worker failed.";
            break;
          }
          if (Date.now() > deadline) {
            error = "The review worker did not finish in time.";
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      } catch (cause) {
        error = describe(cause);
      } finally {
        try {
          await bb.sdk.threads.archive({ threadId: workerId });
          await bb.sdk.threads.stop({ threadId: workerId });
        } catch (cause) {
          bb.log.warn(`review worker cleanup failed: ${describe(cause)}`);
        }
      }
      await mutateReview(threadId, (state) => {
        if (state.reviewThreadId !== workerId) return;
        state.status = error === null ? "ready" : "failed";
        state.error = error;
        state.finishedAt = now();
      });
    })();
    return { started: true, reviewThreadId: workerId };
  }

  async function openDiscussion(threadId: string, findingId: string): Promise<string> {
    const state = await readReview(threadId);
    const finding = state.findings.find((f) => f.id === findingId);
    if (finding === undefined) throw new Error("Finding not found.");
    if (finding.discussThreadId !== null) return finding.discussThreadId;
    const doc = await readDoc(threadId);
    if (doc === null) throw new Error("No RFC is open on this thread.");
    const where = [finding.section, finding.line === null ? null : `line ${finding.line}`].filter(Boolean).join(", ");
    const prompt = [
      `You are discussing one review finding on the RFC at ${JSON.stringify(doc.path)}. Read the RFC first so you have its full context, then answer the user's questions about this finding. Stay on this finding; if the user wants to change the RFC, tell them to accept the finding in the panel and send it to the main thread, unless they explicitly ask you to edit the file here.`,
      `### [${finding.severity}] ${finding.title}`,
      where === "" ? null : `Where: ${where}`,
      finding.quote === null ? null : `Quote: "${finding.quote}"`,
      finding.body,
      finding.suggestion === null ? null : `Suggestion:\n${finding.suggestion}`,
      "Start by restating the finding in one or two sentences and, if there is a genuine trade-off, name it. Then wait for the user.",
    ]
      .filter((p): p is string => p !== null)
      .join("\n\n");
    const discussId = await spawnHidden(threadId, `Discuss: ${finding.title}`, prompt, {
      discussFor: threadId,
      findingId,
    });
    await mutateReview(threadId, (s) => {
      const f = s.findings.find((x) => x.id === findingId);
      if (f !== undefined) f.discussThreadId = discussId;
    });
    return discussId;
  }

  // ---- library (all RFCs across projects) ----
  function titleOf(content: string, fallback: string): { title: string; meta: Record<string, string> } {
    const fm = parseFrontmatter(content);
    const meta = fm?.meta ?? {};
    const h1 = (fm?.body ?? content).match(/^#\s+(.+?)\s*$/m)?.[1];
    return { title: meta.title ?? h1 ?? fallback, meta };
  }

  // Stale-while-revalidate cache: the page remounts on every navigation, so
  // serve the last scan at once and refresh in the background.
  const LIBRARY_TTL_MS = 30_000;
  let libraryCache: { at: number; value: { items: LibraryItem[]; notes: string[] } } | null = null;
  let libraryInflight: Promise<{ items: LibraryItem[]; notes: string[] }> | null = null;
  function publishLibrary(value: { items: LibraryItem[]; notes: string[] }) {
    const changed = JSON.stringify(value) !== JSON.stringify(libraryCache?.value ?? null);
    libraryCache = { at: Date.now(), value };
    if (changed) bb.realtime.publish(CHANGED, { threadId: "", kind: "library" });
  }
  function refreshLibrary() {
    // Phase 1 (≈10 ms): RFC directories and thread documents. Phase 2 (seconds
    // on a big tree): the fuzzy *rfc*.md search, merged in when it lands.
    libraryInflight ??= scanLibrary(false)
      .then((fast) => {
        publishLibrary(fast);
        void scanLibrary(true)
          .then(publishLibrary)
          .catch((cause: unknown) => bb.log.warn(`library search phase failed: ${describe(cause)}`));
        return fast;
      })
      .finally(() => {
        libraryInflight = null;
      });
    return libraryInflight;
  }
  async function listLibrary(force = false): Promise<{ items: LibraryItem[]; notes: string[] }> {
    if (libraryCache === null || force) return refreshLibrary();
    if (Date.now() - libraryCache.at > LIBRARY_TTL_MS) void refreshLibrary();
    return libraryCache.value;
  }
  // Anything that changes which file a thread follows invalidates the cache.
  function invalidateLibrary() {
    libraryCache = null;
  }

  async function scanLibrary(includeSearch: boolean): Promise<{ items: LibraryItem[]; notes: string[] }> {
    const t0 = Date.now();
    const lap = (label: string) => bb.log.debug(`library scan: ${label} at ${Date.now() - t0}ms`);
    const notes: string[] = [];
    const { rfcDir } = await settings.get();
    const primaryHostId = (await bb.sdk.system.config()).primaryHostId;
    const seen = new Map<string, LibraryItem>();
    const keyOf = (hostId: string | null, path: string) => `${hostId ?? primaryHostId}|${normalize(path)}`;

    const add = async (
      path: string,
      hostId: string | null,
      project: { id: string; name: string } | null,
      root: string | null,
      found: LibraryItem["found"],
    ) => {
      const k = keyOf(hostId, path);
      const existing = seen.get(k);
      if (existing !== undefined) {
        if (existing.projectId === null && project !== null) {
          existing.projectId = project.id;
          existing.projectName = project.name;
        }
        return existing;
      }
      let file: Awaited<ReturnType<typeof bb.sdk.files.read>>;
      try {
        file = await bb.sdk.files.read({ path, ...fileArgs(hostId) });
      } catch {
        return null;
      }
      const content = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
      const basename = path.split("/").pop() ?? path;
      const { title, meta } = titleOf(content, basename.replace(/\.(md|markdown)$/i, ""));
      const item: LibraryItem = {
        path: normalize(path),
        hostId,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        relative: (() => {
          const rfcRoot = root === null ? (isAbsolute(rfcDir) ? rfcDir : null) : isAbsolute(rfcDir) ? rfcDir : joinPath(root, rfcDir);
          if (rfcRoot !== null && within(rfcRoot, path)) return normalize(path).slice(normalize(rfcRoot).length + 1);
          if (root !== null && within(root, path)) return normalize(path).slice(normalize(root).length + 1);
          return normalize(path);
        })(),
        title,
        status: meta.status ?? null,
        authors: meta.authors ?? meta.author ?? null,
        updated: meta.updated ?? meta.date ?? meta.created ?? null,
        modifiedAtMs: file.modifiedAtMs ?? null,
        sizeBytes: file.sizeBytes,
        found,
        threads: [],
      };
      seen.set(k, item);
      return item;
    };

    // 1. Every project's RFC directory, plus any *rfc*.md elsewhere in the project.
    let projects: Array<{ id: string; name: string; sources: Array<{ type: string; path: string; hostId: string }> }> = [];
    try {
      projects = (await bb.sdk.projects.list()).map((p) => ({
        id: p.id,
        name: p.name,
        sources: (p as { sources?: Array<{ type: string; path: string; hostId: string }> }).sources ?? [],
      }));
    } catch (cause) {
      notes.push(`Could not list projects: ${describe(cause)}`);
    }
    // Collect candidate paths first (directory listing and fuzzy search run
    // concurrently), then read the files in parallel. Order matters for
    // de-duplication: rfc-dir entries win over search hits.
    type Cand = { path: string; hostId: string | null; project: { id: string; name: string }; root: string; found: LibraryItem["found"] };
    const dirCands: Cand[] = [];
    const searchCands: Cand[] = [];
    await Promise.all(
      projects.flatMap((project) =>
        project.sources
          .filter((source) => source.type === "local_path")
          .flatMap((source) => {
            const hostId = source.hostId === primaryHostId ? null : source.hostId;
            const dir = isAbsolute(rfcDir) ? rfcDir : joinPath(source.path, rfcDir);
            return [
              bb.sdk.files
                .listPaths({ path: dir, includeFiles: true, includeDirectories: false, includeHidden: false, limit: 500, ...fileArgs(hostId) })
                .then((listed) => {
                  for (const entry of listed.paths) {
                    if (entry.kind !== "file" || !/\.(md|markdown)$/i.test(entry.path)) continue;
                    dirCands.push({ path: joinPath(dir, entry.path), hostId, project, root: source.path, found: "rfc-dir" });
                  }
                })
                .catch(() => undefined),
              !includeSearch
                ? Promise.resolve()
                : bb.sdk.files
                .list({ path: source.path, query: "rfc", limit: 300, ...fileArgs(hostId) })
                .then((found) => {
                  for (const entry of found.files) {
                    const base = entry.path.split("/").pop() ?? "";
                    if (!/rfc/i.test(base) || !/\.(md|markdown)$/i.test(base)) continue;
                    if (/node_modules|\/dist\/|\/\.git\//.test(entry.path)) continue;
                    searchCands.push({ path: joinPath(source.path, entry.path), hostId, project, root: source.path, found: "search" });
                  }
                })
                .catch((cause: unknown) => {
                  notes.push(`Search in ${project.name} failed: ${describe(cause)}`);
                }),
            ];
          }),
      ),
    );
    lap(`listed ${dirCands.length} dir + ${searchCands.length} search candidates`);
    const uniq = new Map<string, Cand>();
    for (const c of [...dirCands, ...searchCands]) {
      const k = keyOf(c.hostId, c.path);
      if (!uniq.has(k)) uniq.set(k, c);
    }
    await Promise.all([...uniq.values()].map((c) => add(c.path, c.hostId, c.project, c.root, c.found)));
    lap(`read ${uniq.size} files`);

    // 2. Every RFC some thread follows, with the thread attached.
    const docKeys = await bb.storage.kv.list("doc:");
    const threadDocs = await Promise.all(
      docKeys.map(async (k) => {
        const threadId = k.slice("doc:".length);
        const doc = docRefSchema.safeParse(await bb.storage.kv.get<unknown>(k));
        if (!doc.success) return null;
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          return { doc: doc.data, thread };
        } catch {
          return null; // thread deleted
        }
      }),
    );
    for (const entry of threadDocs) {
      if (entry === null) continue;
      const { doc, thread } = entry;
      const project = projects.find((p) => p.id === thread.projectId) ?? null;
      const root = project?.sources.find((s) => s.type === "local_path" && within(s.path, doc.path))?.path ?? null;
      const item = await add(doc.path, doc.hostId, project, root, "thread");
      if ((thread as { archivedAt?: number | null }).archivedAt != null) continue;
      if (item !== null) item.threads.push({ id: thread.id, title: thread.title ?? null, status: thread.status, unread: isUnread(thread as { lastReadAt?: number | null; latestAttentionAt?: number | null }) });
    }

    lap("attached threads");
    const items = [...seen.values()].sort((a, b) => (b.modifiedAtMs ?? 0) - (a.modifiedAtMs ?? 0));
    return { items, notes };
  }

  async function openLibraryItem({
    path,
    hostId,
    projectId,
    threadId,
    fresh,
  }: {
    path: string;
    hostId: string | null;
    projectId: string | null;
    threadId: string | null;
    fresh: boolean;
  }): Promise<{ threadId: string; created: boolean }> {
      const abs = normalize(path);
      let target = threadId;
      let created = false;
      if (!fresh && target === null) {
        // Reuse the newest live thread that already follows this file.
        const candidates: Array<{ id: string; updatedAt: number }> = [];
        for (const k of await bb.storage.kv.list("doc:")) {
          const doc = docRefSchema.safeParse(await bb.storage.kv.get<unknown>(k));
          if (!doc.success || normalize(doc.data.path) !== abs) continue;
          try {
            const t = await bb.sdk.threads.get({ threadId: k.slice("doc:".length) });
            if ((t as { archivedAt?: number | null }).archivedAt == null) candidates.push({ id: t.id, updatedAt: Date.parse(doc.data.setAt) });
          } catch {
            // deleted
          }
        }
        candidates.sort((a, b) => b.updatedAt - a.updatedAt);
        target = candidates[0]?.id ?? null;
      }
      if (target === null) {
        if (projectId === null) throw new Error("This RFC is not inside a BB project, so no thread can be started for it.");
        const file = await readFileAt(abs, hostId);
        const base = abs.split("/").pop() ?? "RFC";
        const { title } = file === null ? { title: base } : titleOf(file.content, base.replace(/\.(md|markdown)$/i, ""));
        const spawned = await bb.sdk.threads.spawn({
          projectId,
          title: `RFC: ${title}`,
          environment: { type: "project-default" },
          prompt: `We are working on the RFC at ${JSON.stringify(abs)}. Call rfc_set_document with that path, read the RFC, then give me a short summary of where it stands and its open questions, and wait for direction. Edit the file directly when I ask for changes; I can see it rendered beside this chat.`,
        });
        await writeDoc(spawned.id, { path: abs, hostId, setAt: now() });
        target = spawned.id;
        created = true;
      }
      await ensureRfcTab(target);
      return { threadId: target, created };
  }

  /** Pin this plugin's RFC panel tab (Split view) in a thread's side panel. */
  async function ensureRfcTab(threadId: string) {
    try {
      const current = await bb.sdk.threads.tabs.get({ threadId });
      const id = "plugin-panel:rfcs:rfc";
      if (current.tabs.some((t) => t.id === id)) return;
      await bb.sdk.threads.tabs.update({
        threadId,
        expectedRevision: current.revision,
        tabs: [...current.tabs, { id, kind: "plugin-panel", pluginId: "rfcs", actionId: "rfc", title: "RFC", paramsJson: JSON.stringify({ view: "split" }) }],
      });
    } catch (cause) {
      bb.log.warn(`could not pin RFC tab on ${threadId}: ${describe(cause)}`);
    }
  }

  // ---- sidecar (notes, cards, glossary, claims, walkthroughs) ----
  async function readSidecarAt(path: string, hostId: string | null): Promise<{ data: Sidecar; sha: string | null }> {
    const file = await readFileAt(path, hostId);
    if (file === null) return { data: emptySidecar(), sha: null };
    try {
      const parsed = sidecarSchema.safeParse(JSON.parse(file.content));
      return { data: parsed.success ? parsed.data : emptySidecar(), sha: file.sha256 };
    } catch {
      return { data: emptySidecar(), sha: file.sha256 };
    }
  }
  async function sidecarFor(threadId: string) {
    const doc = await readDoc(threadId);
    if (doc === null) throw new Error("No RFC is open on this thread.");
    return { doc, path: sidecarPathFor(doc.path) };
  }
  async function readSidecar(threadId: string): Promise<Sidecar | null> {
    const doc = await readDoc(threadId);
    if (doc === null) return null;
    return (await readSidecarAt(sidecarPathFor(doc.path), doc.hostId)).data;
  }
  const sidecarQueues = new Map<string, Promise<unknown>>();
  /** Read-modify-write under a per-file queue, with a compare-and-swap retry. */
  function mutateSidecar<T>(threadId: string, fn: (data: Sidecar) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const { doc, path } = await sidecarFor(threadId);
      for (let attempt = 0; attempt < 4; attempt++) {
        const { data, sha } = await readSidecarAt(path, doc.hostId);
        const result = await fn(data);
        const written = await bb.sdk.files.write({
          path,
          content: `${JSON.stringify(data, null, 2)}\n`,
          createParents: true,
          expectedSha256: sha,
          ...fileArgs(doc.hostId),
        });
        if (written.outcome === "written") {
          bb.realtime.publish(CHANGED, { threadId, kind: "sidecar" });
          return result;
        }
      }
      throw new Error("The RFC sidecar kept changing underneath us; try again.");
    };
    const prev = sidecarQueues.get(threadId) ?? Promise.resolve();
    const next = prev.then(run, run);
    sidecarQueues.set(threadId, next.catch(() => undefined));
    return next;
  }
  const anchorText = (a: { section: string | null; line: number | null; quote: string | null }) =>
    [a.section === null ? null : `section "${a.section}"`, a.line === null ? null : `line ${a.line}`, a.quote === null ? null : `quote: "${a.quote}"`]
      .filter((x): x is string => x !== null)
      .join(", ");

  async function openNoteThread(threadId: string, noteId: string): Promise<string> {
    const data = await readSidecar(threadId);
    const note = data?.notes.find((n) => n.id === noteId);
    if (note === undefined) throw new Error("Note not found.");
    if (note.threadId !== null) return note.threadId;
    const { doc } = await sidecarFor(threadId);
    const prompt = [
      `You are discussing one design note on the RFC at ${JSON.stringify(doc.path)}. Read the RFC first, then the note. Help the user think it through: surface trade-offs, missing facts, and what would settle it. Stay on this note.`,
      `Note: ${note.title}`,
      anchorText(note.anchor) === "" ? null : `Where: ${anchorText(note.anchor)}`,
      note.body.trim() === "" ? null : note.body,
      `When the user reaches a decision, call rfc_note_update with status "decided" (or "superseded"/"blocked") and a one-paragraph resolution that records what was decided and why. Do not edit the RFC here unless the user explicitly asks.`,
      "Start by restating the question in one or two sentences, then wait for the user.",
    ]
      .filter((p): p is string => p !== null)
      .join("\n\n");
    const id = await spawnHidden(threadId, `Note: ${note.title}`, prompt, { noteFor: threadId, noteId });
    await mutateSidecar(threadId, (d) => {
      const n = d.notes.find((x) => x.id === noteId);
      if (n !== undefined) n.threadId = id;
    });
    return id;
  }

  const cardInstructions: Record<CardMode, string> = {
    concept:
      "Explain the concept the selection relies on, for a strong engineer who is new to this system. Define terms, say why it exists, how it works, and the one or two gotchas that matter here. Prefer a short mermaid or D2 diagram when a picture carries more than prose.",
    code: "Find the code path behind the selection in the workspace (grep, read files). Report it as an ordered list of hops with file paths and line ranges in `files`, each with a short snippet and a one-line note on what that hop does. Point out where behaviour is decided (branches, config) and anything that contradicts the RFC text.",
    data: "Describe the data model behind the selection: tables/structs/protos, their key fields, ownership, and relationships. Render it as a D2 diagram using sql_table shapes (or a mermaid erDiagram) and list the defining files in `files`.",
    flow: "Describe the end-to-end flow behind the selection as a mermaid sequenceDiagram (participants = systems/services, messages = the actual calls/events), then a numbered narration with what can fail at each step and how it is detected.",
    question: "Answer the user's question about the selection precisely, citing sections of the RFC or files in the workspace. If the answer is uncertain, say what would settle it.",
  };

  async function openCard(threadId: string, input: { anchor: Card["anchor"]; mode: CardMode; prompt: string }): Promise<Card> {
    const { doc } = await sidecarFor(threadId);
    const nowIso = now();
    const card: Card = {
      id: newId("card"),
      anchor: input.anchor,
      mode: input.mode,
      prompt: input.prompt,
      title: input.mode === "question" ? input.prompt.slice(0, 120) : `${CARD_MODE_LABEL[input.mode]}: ${input.prompt.slice(0, 80)}`,
      body: "",
      diagram: null,
      files: [],
      status: "pending",
      threadId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await mutateSidecar(threadId, (d) => {
      d.cards.push(card);
    });
    const prompt = [
      `You are producing one explainer card for the RFC at ${JSON.stringify(doc.path)}. Read the RFC (at least the section involved) before answering.`,
      `Selection${anchorText(input.anchor) === "" ? "" : ` (${anchorText(input.anchor)})`}:\n"""${input.prompt}"""`,
      cardInstructions[input.mode],
      `Publish the result with rfc_publish_card using cardId ${JSON.stringify(card.id)}: a short title, a markdown body, an optional diagram ({lang, source}; check D2 with rfc_check_diagram first), and \`files\` for any code you cite (workspace-relative path, startLine, endLine, snippet, note). Keep the body under ~400 words; put detail in the diagram and file references. After publishing, reply with one line and stop. The user may continue the conversation here with follow-up questions; answer them in chat and republish the card only if asked.`,
    ].join("\n\n");
    const hidden = await spawnHidden(threadId, `Explain: ${card.title}`, prompt, { explainFor: threadId, cardId: card.id });
    return mutateSidecar(threadId, (d) => {
      const c = d.cards.find((x) => x.id === card.id);
      if (c !== undefined) c.threadId = hidden;
      return c ?? card;
    });
  }

  async function askRfcThread(threadId: string, text: string) {
    await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
  }

  /** bb's unread rule: attention arrived after the last read. */
  const isUnread = (t: { lastReadAt?: number | null; latestAttentionAt?: number | null }) =>
    t.latestAttentionAt != null && (t.lastReadAt == null || t.latestAttentionAt > t.lastReadAt);

  // ---- RPC ----
  bb.rpc.register(rpcContract, {
    threads_state: async ({ threadIds }) => {
      const out: Array<{ id: string; status: string; unread: boolean; needsInput: boolean }> = [];
      await Promise.all(
        threadIds.map(async (id) => {
          try {
            const t = await bb.sdk.threads.get({ threadId: id });
            const x = t as { lastReadAt?: number | null; latestAttentionAt?: number | null; hasPendingInteraction?: boolean };
            out.push({ id, status: String(t.status), unread: isUnread(x), needsInput: x.hasPendingInteraction === true });
          } catch {
            // deleted
          }
        }),
      );
      return out;
    },
    thread_mark_read: async ({ threadId }) => {
      try {
        await bb.sdk.threads.markRead({ threadId });
      } catch (cause) {
        bb.log.warn(`markRead ${threadId}: ${describe(cause)}`);
      }
      return { ok: true as const };
    },
    sidecar_get: ({ threadId }) => readSidecar(threadId),
    note_add: async ({ threadId, anchor, title, body, status, discuss }) => {
      const nowIso = now();
      const note: Note = { id: newId("note"), anchor, title, body, status, resolution: null, threadId: null, createdAt: nowIso, updatedAt: nowIso, createdBy: "user" };
      await mutateSidecar(threadId, (d) => {
        d.notes.push(note);
      });
      if (discuss) note.threadId = await openNoteThread(threadId, note.id);
      return note;
    },
    note_update: ({ threadId, id, ...patch }) =>
      mutateSidecar(threadId, (d) => {
        const n = d.notes.find((x) => x.id === id);
        if (n === undefined) throw new Error("Note not found.");
        if (patch.title !== undefined) n.title = patch.title;
        if (patch.body !== undefined) n.body = patch.body;
        if (patch.status !== undefined) n.status = patch.status;
        if (patch.resolution !== undefined) n.resolution = patch.resolution;
        n.updatedAt = now();
        return n;
      }),
    note_remove: ({ threadId, id }) =>
      mutateSidecar(threadId, (d) => {
        d.notes = d.notes.filter((x) => x.id !== id);
        return { ok: true as const };
      }),
    note_discuss: async ({ threadId, id }) => ({ discussThreadId: await openNoteThread(threadId, id) }),
    card_open: ({ threadId, ...input }) => openCard(threadId, input),
    card_remove: ({ threadId, id }) =>
      mutateSidecar(threadId, (d) => {
        d.cards = d.cards.filter((x) => x.id !== id);
        return { ok: true as const };
      }),
    term_set: ({ threadId, term }) =>
      mutateSidecar(threadId, (d) => {
        const i = d.glossary.findIndex((t) => t.term.toLowerCase() === term.term.toLowerCase());
        if (i === -1) d.glossary.push(term);
        else d.glossary[i] = term;
        d.glossary.sort((a, b) => a.term.localeCompare(b.term));
        return { count: d.glossary.length };
      }),
    term_remove: ({ threadId, term }) =>
      mutateSidecar(threadId, (d) => {
        d.glossary = d.glossary.filter((t) => t.term.toLowerCase() !== term.toLowerCase());
        return { count: d.glossary.length };
      }),
    glossary_request: async ({ threadId }) => {
      const { doc } = await sidecarFor(threadId);
      await askRfcThread(
        threadId,
        `Build or refresh the glossary for the RFC at ${JSON.stringify(doc.path)}. Read it end to end and collect every acronym, vendor term, internal shorthand, and requirement/assumption/question ID (patterns like S12, O8, A2, Q13, P20, D6, T1, V1) that a strong engineer new to this system would have to look up. For each, call rfc_define_term once with the term, a one-line definition that says what it stands for and what it refers to in this RFC, aliases if the text spells it differently, and \`see\` pointing at the section or reference that explains it. Skip terms already in the glossary unless their definition is wrong. Reply with one line when done.`,
      );
      return { ok: true as const };
    },
    claim_upsert: ({ threadId, claim }) =>
      mutateSidecar(threadId, (d) => {
        const nowIso = now();
        const existing = claim.id === undefined ? undefined : d.claims.find((c) => c.id === claim.id);
        if (existing !== undefined) {
          Object.assign(existing, { ...claim, updatedAt: nowIso });
          return existing;
        }
        const created: Claim = { ...claim, id: claim.id ?? newId("claim"), updatedAt: nowIso };
        d.claims.push(created);
        return created;
      }),
    claim_remove: ({ threadId, id }) =>
      mutateSidecar(threadId, (d) => {
        d.claims = d.claims.filter((x) => x.id !== id);
        return { ok: true as const };
      }),
    claims_audit: async ({ threadId, focus }) => {
      const { doc } = await sidecarFor(threadId);
      await askRfcThread(
        threadId,
        [
          `Audit the claims register for the RFC at ${JSON.stringify(doc.path)}.`,
          "1. Read the RFC and extract every factual claim the design depends on that could be wrong or go stale: vendor behaviour, API shapes, limits, versions, what exists in our code, what was observed in a spike. Skip opinions and goals.",
          "2. Compare against the existing register (rfc_claims_upsert replaces by id; new claims get no id). For each claim set: key (the ID used in the text if any, e.g. A2, P20), text, source (doc/PDF/Slack/file/spike step), status (verified only if you can point at evidence dated within the RFC's current vendor version; assumed if it rests on docs or memory; stale if the vendor version moved since it was verified; superseded if the RFC no longer relies on it), verifiedAt, against (e.g. chart 0.25.0), and the section anchor.",
          "3. Where the workspace holds evidence (spike logs, source, the vendor repo), check it and upgrade assumed to verified or flag contradictions in `note`.",
          focus.trim() === "" ? null : `Focus: ${focus.trim()}`,
          "Call rfc_claims_upsert in batches of up to 25. Finish with a three-line summary: counts per status and the top three claims that most need verifying.",
        ]
          .filter((p): p is string => p !== null)
          .join("\n"),
      );
      return { ok: true as const };
    },
    walkthrough_request: async ({ threadId, audience }) => {
      const { doc } = await sidecarFor(threadId);
      await askRfcThread(
        threadId,
        [
          `Create a walkthrough of the RFC at ${JSON.stringify(doc.path)}${audience.trim() === "" ? "" : ` for this audience: ${audience.trim()}`}.`,
          "Read the RFC. Then build 6 to 14 ordered steps that teach the design the way you would explain it at a whiteboard: start with the problem and the one-sentence answer, then the moving parts, then the main flow, then the hard decisions and why, then what is unverified or risky. Each step has a title, a body (under ~250 words, plain language, expand every acronym the first time), an anchor to the RFC section it draws on, an optional diagram ({lang, source}; D2 for architecture, mermaid for sequences; check D2 with rfc_check_diagram), and `files` for code it cites.",
          "Publish once with rfc_publish_walkthrough (title, audience, steps). Reply with one line and stop.",
        ].join("\n"),
      );
      return { ok: true as const };
    },
    walkthrough_remove: ({ threadId, id }) =>
      mutateSidecar(threadId, (d) => {
        d.walkthroughs = d.walkthroughs.filter((x) => x.id !== id);
        return { ok: true as const };
      }),
    library_list: (input) => listLibrary(input?.force ?? false),
    library_read: async ({ path, hostId }) => {
      if (!isAbsolute(path) || !/\.(md|markdown)$/i.test(path)) return null;
      return readFileAt(normalize(path), hostId);
    },
    library_open: (input) => openLibraryItem(input),
    library_create: async ({ title, projectId }) => {
      const projects = await bb.sdk.projects.list();
      const project = (projectId === null ? projects[0] : projects.find((p) => p.id === projectId)) ?? null;
      if (project === undefined || project === null) throw new Error("No BB project to create the RFC in.");
      const source = ((project as { sources?: Array<{ type: string; path: string; hostId: string; isDefault?: boolean }> }).sources ?? [])
        .filter((src) => src.type === "local_path")
        .sort((x, y) => Number(y.isDefault === true) - Number(x.isDefault === true))[0];
      if (source === undefined) throw new Error(`Project ${project.name} has no local checkout.`);
      const primaryHostId = (await bb.sdk.system.config()).primaryHostId;
      const hostId = source.hostId === primaryHostId ? null : source.hostId;
      const { rfcDir, author } = await settings.get();
      const dir = isAbsolute(rfcDir) ? rfcDir : joinPath(source.path, rfcDir);
      let path = normalize(joinPath(dir, `${slugify(title)}.md`));
      if ((await readFileAt(path, hostId)) !== null) path = normalize(joinPath(dir, `${slugify(title)}-${Date.now().toString(36)}.md`));
      const written = await bb.sdk.files.write({
        path,
        content: rfcTemplate(title, author.trim() === "" ? null : author.trim()),
        createParents: true,
        expectedSha256: null,
        ...fileArgs(hostId),
      });
      if (written.outcome !== "written") throw new Error("Could not create the RFC file.");
      invalidateLibrary();
      const { threadId } = await openLibraryItem({ path, hostId, projectId: project.id, threadId: null, fresh: true });
      return { threadId, path };
    },
    context_get: async ({ threadId }) => {
      const { environment, workspacePath, rfcDir, hostId, doc } = await threadContext(threadId);
      return { environmentId: environment?.id ?? null, hostId, workspacePath, rfcDir, doc };
    },
    docs_list: async ({ threadId }) => {
      const { rfcDir, hostId } = await threadContext(threadId);
      if (rfcDir === null) return { candidates: [], note: "No workspace; set an absolute RFC directory in settings." };
      try {
        const result = await bb.sdk.files.listPaths({
          path: rfcDir,
          includeFiles: true,
          includeDirectories: false,
          includeHidden: false,
          limit: 500,
          ...fileArgs(hostId),
        });
        const candidates = result.paths
          .filter((p) => p.kind === "file" && /\.(md|markdown)$/i.test(p.path))
          .map((p) => ({ path: normalize(joinPath(rfcDir, p.path)), relative: p.path }))
          .sort((a, b) => a.relative.localeCompare(b.relative));
        return { candidates, note: null };
      } catch (cause) {
        if (/ENOENT|not found|no such|does not exist|\b404\b/i.test(describe(cause))) {
          return { candidates: [], note: `${rfcDir} does not exist yet; "New RFC" will create it.` };
        }
        throw cause;
      }
    },
    doc_set: ({ threadId, path }) => setDoc(threadId, path),
    doc_create: ({ threadId, title }) => createDoc(threadId, title),
    doc_read: async ({ threadId }) => {
      const doc = await readDoc(threadId);
      if (doc === null) return null;
      return readFileAt(doc.path, doc.hostId);
    },
    doc_write: async ({ threadId, content, expectedSha256 }) => {
      const doc = await readDoc(threadId);
      if (doc === null) throw new Error("No RFC is open on this thread.");
      const result = await bb.sdk.files.write({
        path: doc.path,
        content,
        createParents: true,
        ...(expectedSha256 === null ? {} : { expectedSha256 }),
        ...fileArgs(doc.hostId),
      });
      if (result.outcome === "written") {
        bb.realtime.publish(CHANGED, { threadId, kind: "doc" });
        return { outcome: "written" as const, sha256: result.sha256 };
      }
      return { outcome: "conflict" as const, currentSha256: result.currentSha256 ?? null };
    },
    file_excerpt: async ({ environmentId, path, startLine, endLine }) => {
      try {
        const environment = await bb.sdk.environments.get({ environmentId });
        if (environment.path === null) return null;
        const abs = normalize(joinPath(environment.path, path));
        if (!within(environment.path, abs)) return null;
        const file = await readFileAt(abs, environment.hostId);
        if (file === null) return null;
        const lines = file.content.split("\n");
        const from = Math.max(1, startLine ?? 1);
        const to = Math.min(lines.length, endLine ?? Math.min(lines.length, from + 39));
        if (from > lines.length) return { text: "", startLine: from, endLine: from, totalLines: lines.length };
        return { text: lines.slice(from - 1, to).join("\n"), startLine: from, endLine: to, totalLines: lines.length };
      } catch {
        return null;
      }
    },
    file_read: async ({ source, environmentId, hostId, path }) => {
      try {
        if (source === "workspace") {
          if (environmentId === null) return null;
          const environment = await bb.sdk.environments.get({ environmentId });
          if (environment.path === null) return null;
          const abs = normalize(joinPath(environment.path, path));
          if (!within(environment.path, abs)) return null;
          const file = await readFileAt(abs, environment.hostId);
          return file === null ? null : { content: file.content, rootPath: environment.path };
        }
        if (!isAbsolute(path)) return null;
        const file = await readFileAt(normalize(path), hostId);
        return file === null ? null : { content: file.content, rootPath: null };
      } catch {
        return null;
      }
    },
    diagram_render: ({ source, dark }) => renderD2(source, dark),
    review_run: ({ threadId, instructions }) => startReview(threadId, instructions),
    review_get: ({ threadId }) => readReview(threadId),
    findings_update: ({ threadId, id, status, priority, edited }) =>
      mutateReview(threadId, (state) => {
        const finding = state.findings.find((f) => f.id === id);
        if (finding === undefined) throw new Error("Finding not found.");
        if (finding.status === "sent") throw new Error("This finding was already sent.");
        if (status !== undefined) finding.status = status;
        if (priority !== undefined) finding.priority = priority;
        if (edited !== undefined) finding.edited = edited;
        return finding;
      }),
    findings_bulk: ({ threadId, status, ids }) =>
      mutateReview(threadId, (state) => {
        let changed = 0;
        for (const f of state.findings) {
          if (f.status === "sent") continue;
          if (ids !== undefined && !ids.includes(f.id)) continue;
          if (f.status !== status) {
            f.status = status;
            changed++;
          }
        }
        return { changed };
      }),
    findings_send: async ({ threadId, note }) => {
      const doc = await readDoc(threadId);
      if (doc === null) throw new Error("No RFC is open on this thread.");
      const accepted = (await readReview(threadId)).findings.filter((f) => f.status === "accepted");
      if (accepted.length === 0) return { sent: 0 };
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text: formatFindingsMessage(accepted, doc.path, note), mentions: [] }],
      });
      const ids = new Set(accepted.map((f) => f.id));
      await mutateReview(threadId, (state) => {
        for (const f of state.findings) if (ids.has(f.id)) f.status = "sent";
      });
      return { sent: accepted.length };
    },
    discuss_open: async ({ threadId, id }) => ({ discussThreadId: await openDiscussion(threadId, id) }),
  });

  // ---- agent tools ----
  const toolError = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
  const priorityForSeverity = (severity: Severity): Priority =>
    severity === "high" ? "p0" : severity === "medium" ? "p1" : "p2";

  async function reportTarget(threadId: string): Promise<{ target: string; round: number | null }> {
    const meta = await bb.sdk.threads.getPluginMetadata({ threadId });
    if (typeof meta.reviewFor === "string") {
      return { target: meta.reviewFor, round: typeof meta.round === "number" ? meta.round : null };
    }
    return { target: threadId, round: null };
  }

  bb.agents.registerTool({
    name: "rfc_set_document",
    description:
      "Tell the RFC panel which markdown file this thread is writing. Call it when you create a new RFC file or when the user points you at an existing one, so the live preview and review follow that file. Paths are relative to the workspace, or absolute.",
    presentation: { label: { pending: "Opening RFC in panel", completed: "Opened RFC in panel" } },
    parameters: z.object({ path: z.string().min(1).max(1000) }),
    async execute({ path }, { threadId }) {
      try {
        const doc = await setDoc(threadId, path);
        const exists = (await readFileAt(doc.path, doc.hostId)) !== null;
        return `The RFC panel now follows ${doc.path}${exists ? "" : " (file does not exist yet; the preview fills in once you write it)"}.`;
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "rfc_report_findings",
    description:
      "Report RFC review findings to the RFC panel, where the user accepts, skips, discusses, and prioritizes them before they are acted on. Call once with every finding; an empty list means the review found nothing.",
    presentation: { label: { pending: "Reporting RFC findings", completed: "Reported RFC findings" } },
    parameters: z.object({ findings: z.array(findingInputSchema).max(MAX_FINDINGS) }),
    async execute({ findings }, { threadId }) {
      try {
        const { target, round } = await reportTarget(threadId);
        const count = await mutateReview(target, (state) => {
          const thisRound = round ?? (state.status === "running" ? state.round : state.round + 1);
          if (round === null && state.status !== "running") {
            state.round = thisRound;
            state.status = "ready";
            state.finishedAt = now();
            state.findings = state.findings.filter((f) => f.status === "sent");
          }
          for (const input of findings) {
            state.findings.push({
              ...input,
              id: newId("f"),
              round: thisRound,
              status: "pending",
              priority: priorityForSeverity(input.severity),
              edited: null,
              discussThreadId: null,
            });
          }
          return state.findings.filter((f) => f.round === thisRound).length;
        });
        return `Reported ${findings.length} finding(s); ${count} now await the user's triage in the RFC panel.`;
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "rfc_check_diagram",
    description:
      "Compile a D2 diagram and report syntax or layout errors before you put it in the RFC. Returns ok, or the compiler's error message. Mermaid cannot be checked here; keep mermaid blocks simple and standard.",
    presentation: { label: { pending: "Checking diagram", completed: "Checked diagram" } },
    parameters: z.object({ lang: z.literal("d2"), source: z.string().min(1).max(200_000) }),
    async execute({ source }) {
      const result = await renderD2(source, false);
      if (result.ok) {
        const shapes = (result.svg.match(/<g class="shape"/g) ?? []).length;
        return `ok: D2 compiled and rendered${shapes > 0 ? ` (${shapes} shapes)` : ""}.`;
      }
      return toolError(`D2 error: ${result.error}`);
    },
  });

  /** Which RFC thread a hidden helper thread belongs to; itself otherwise. */
  async function ownerThread(threadId: string): Promise<string> {
    const meta = await bb.sdk.threads.getPluginMetadata({ threadId });
    for (const k of ["explainFor", "noteFor", "discussFor", "reviewFor"] as const) {
      if (typeof meta[k] === "string") return meta[k] as string;
    }
    return threadId;
  }

  bb.agents.registerTool({
    name: "rfc_note_add",
    description:
      "Add a design note to the RFC panel's Items list, anchored to a section: an open question, a decision to record, a thing to keep in mind, or a blocker. Use it whenever the conversation settles or raises something the RFC author should track; the user triages notes beside the document.",
    presentation: { label: { pending: "Adding RFC note", completed: "Added RFC note" } },
    parameters: z.object({
      section: z.string().max(300).nullable().default(null),
      line: z.number().int().positive().nullable().default(null),
      quote: z.string().max(600).nullable().default(null),
      title: z.string().min(1).max(200),
      body: z.string().max(8000).default(""),
      status: z.enum(NOTE_STATUSES).default("open"),
      resolution: z.string().max(8000).nullable().default(null),
    }),
    async execute({ section, line, quote, title, body, status, resolution }, { threadId }) {
      try {
        const owner = await ownerThread(threadId);
        const nowIso = now();
        const note: Note = { id: newId("note"), anchor: { section, line, quote }, title, body, status, resolution, threadId: null, createdAt: nowIso, updatedAt: nowIso, createdBy: "agent" };
        await mutateSidecar(owner, (d) => {
          d.notes.push(note);
        });
        return `Added note ${note.id} (${status}) to the RFC's Items.`;
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "rfc_note_update",
    description: "Update a design note: change its status (open, decided, blocked, superseded), record the resolution, or edit its text. Call this when the user decides something in a note's discussion.",
    presentation: { label: { pending: "Updating RFC note", completed: "Updated RFC note" } },
    parameters: z.object({
      noteId: z.string().optional().describe("Omit inside a note discussion thread; the note is implied."),
      title: z.string().min(1).max(200).optional(),
      body: z.string().max(8000).optional(),
      status: z.enum(NOTE_STATUSES).optional(),
      resolution: z.string().max(8000).nullable().optional(),
    }),
    async execute({ noteId, ...patch }, { threadId }) {
      try {
        const meta = await bb.sdk.threads.getPluginMetadata({ threadId });
        const owner = await ownerThread(threadId);
        const id = noteId ?? (typeof meta.noteId === "string" ? meta.noteId : undefined);
        if (id === undefined) return toolError("noteId is required outside a note discussion thread.");
        const n = await mutateSidecar(owner, (d) => {
          const note = d.notes.find((x) => x.id === id);
          if (note === undefined) throw new Error("Note not found.");
          if (patch.title !== undefined) note.title = patch.title;
          if (patch.body !== undefined) note.body = patch.body;
          if (patch.status !== undefined) note.status = patch.status;
          if (patch.resolution !== undefined) note.resolution = patch.resolution;
          note.updatedAt = now();
          return note;
        });
        return `Note "${n.title}" is now ${n.status}.`;
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "rfc_publish_card",
    description:
      "Publish an explainer card attached to an RFC section: a concept explanation, code path, data model, flow, or answer. Inside an explain thread the cardId is given in the prompt; from the main RFC thread omit cardId to create a new card.",
    presentation: { label: { pending: "Publishing explainer card", completed: "Published explainer card" } },
    parameters: z.object({
      cardId: z.string().optional(),
      mode: z.enum(CARD_MODES).default("concept"),
      section: z.string().max(300).nullable().default(null),
      line: z.number().int().positive().nullable().default(null),
      quote: z.string().max(600).nullable().default(null),
      title: z.string().min(1).max(200),
      body: z.string().max(20_000),
      diagram: diagramSchema.nullable().default(null),
      files: z.array(codeRefSchema).max(20).default([]),
    }),
    async execute({ cardId, mode, section, line, quote, title, body, diagram, files }, { threadId }) {
      try {
        const meta = await bb.sdk.threads.getPluginMetadata({ threadId });
        const owner = await ownerThread(threadId);
        const id = cardId ?? (typeof meta.cardId === "string" ? meta.cardId : undefined);
        if (diagram !== null && diagram.lang === "d2") {
          const check = await renderD2(diagram.source, false);
          if (!check.ok) return toolError(`The D2 diagram does not compile: ${check.error}. Fix it and publish again.`);
        }
        const nowIso = now();
        const card = await mutateSidecar(owner, (d) => {
          const existing = id === undefined ? undefined : d.cards.find((c) => c.id === id);
          if (existing !== undefined) {
            Object.assign(existing, { title, body, diagram, files, status: "ready", updatedAt: nowIso });
            return existing;
          }
          const created: Card = {
            id: id ?? newId("card"),
            anchor: { section, line, quote },
            mode,
            prompt: quote ?? title,
            title,
            body,
            diagram,
            files,
            status: "ready",
            threadId: typeof meta.explainFor === "string" ? threadId : null,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          d.cards.push(created);
          return created;
        });
        return `Published card "${card.title}"; it is attached to ${card.anchor.section === null ? "the document" : `section "${card.anchor.section}"`} in the RFC panel.`;
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "rfc_define_term",
    description:
      "Add or update a glossary entry for the RFC: an acronym, vendor term, internal shorthand, or requirement/assumption ID (S12, A2, Q13, P20). The panel shows definitions beside each section that uses the term. Call it whenever you introduce such a term in the document.",
    presentation: { label: { pending: "Defining term", completed: "Defined term" } },
    parameters: termSchema,
    async execute(term, { threadId }) {
      try {
        const owner = await ownerThread(threadId);
        const count = await mutateSidecar(owner, (d) => {
          const i = d.glossary.findIndex((t) => t.term.toLowerCase() === term.term.toLowerCase());
          if (i === -1) d.glossary.push(term);
          else d.glossary[i] = term;
          d.glossary.sort((a, b) => a.term.localeCompare(b.term));
          return d.glossary.length;
        });
        return `Glossary now has ${count} term(s).`;
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "rfc_claims_upsert",
    description:
      "Add or update entries in the RFC's claims register: facts the design depends on, each with source, status (verified, assumed, stale, superseded), when and against which version it was verified. Pass an id to update an existing claim; omit it to add.",
    presentation: { label: { pending: "Updating claims register", completed: "Updated claims register" } },
    parameters: z.object({
      claims: z
        .array(
          z.object({
            id: z.string().optional(),
            key: z.string().max(20).nullable().default(null),
            text: z.string().min(1).max(2000),
            source: z.string().max(500).nullable().default(null),
            status: z.enum(CLAIM_STATUSES).default("assumed"),
            verifiedAt: z.string().nullable().default(null),
            against: z.string().max(120).nullable().default(null),
            section: z.string().max(300).nullable().default(null),
            line: z.number().int().positive().nullable().default(null),
            note: z.string().max(2000).nullable().default(null),
          }),
        )
        .min(1)
        .max(25),
    }),
    async execute({ claims }, { threadId }) {
      try {
        const owner = await ownerThread(threadId);
        const result = await mutateSidecar(owner, (d) => {
          let added = 0;
          let updated = 0;
          const nowIso = now();
          for (const c of claims) {
            const existing = c.id === undefined ? undefined : d.claims.find((x) => x.id === c.id);
            const anchor = { section: c.section, line: c.line, quote: null };
            if (existing !== undefined) {
              Object.assign(existing, { key: c.key, text: c.text, source: c.source, status: c.status, verifiedAt: c.verifiedAt, against: c.against, anchor, note: c.note, updatedAt: nowIso });
              updated++;
            } else {
              d.claims.push({ id: c.id ?? newId("claim"), key: c.key, text: c.text, source: c.source, status: c.status, verifiedAt: c.verifiedAt, against: c.against, anchor, note: c.note, updatedAt: nowIso });
              added++;
            }
          }
          return { added, updated, total: d.claims.length };
        });
        return `Claims register: ${result.added} added, ${result.updated} updated, ${result.total} total.`;
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "rfc_publish_walkthrough",
    description:
      "Publish an ordered walkthrough of the RFC for the panel's Walkthrough view: steps with a title, plain-language body, section anchor, optional diagram, and code references. Replaces a walkthrough with the same title.",
    presentation: { label: { pending: "Publishing walkthrough", completed: "Published walkthrough" } },
    parameters: z.object({
      title: z.string().min(1).max(200),
      audience: z.string().max(300).nullable().default(null),
      steps: z.array(walkthroughStepSchema).min(1).max(40),
    }),
    async execute({ title, audience, steps }, { threadId }) {
      try {
        const owner = await ownerThread(threadId);
        for (const [i, step] of steps.entries()) {
          if (step.diagram !== null && step.diagram.lang === "d2") {
            const check = await renderD2(step.diagram.source, false);
            if (!check.ok) return toolError(`Step ${i + 1} ("${step.title}") has a D2 diagram that does not compile: ${check.error}`);
          }
        }
        const w = { id: newId("wt"), title, audience, steps, createdAt: now() };
        await mutateSidecar(owner, (d) => {
          d.walkthroughs = d.walkthroughs.filter((x) => x.title.toLowerCase() !== title.toLowerCase());
          d.walkthroughs.push(w);
        });
        return `Published walkthrough "${title}" with ${steps.length} step(s); open the Walkthrough view in the RFC panel.`;
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });
  void walkthroughSchema;

  bb.agents.configure((context) => {
    const { reviewFor, discussFor, explainFor, noteFor } = context.pluginMetadata;
    if (typeof explainFor === "string") {
      return {
        tools: ["rfc_publish_card", "rfc_check_diagram"],
        skills: [],
        instructions:
          "You are producing and then discussing one explainer card for an RFC section. Publish with rfc_publish_card using the cardId from your prompt. Read the workspace freely; never edit files.",
      };
    }
    if (typeof noteFor === "string") {
      return {
        tools: ["rfc_note_update", "rfc_check_diagram"],
        skills: [],
        instructions:
          "You are a focused discussion about one design note on an RFC. Stay on it. When the user decides, record it with rfc_note_update (status + resolution). Do not edit the RFC unless the user explicitly asks here.",
      };
    }
    if (typeof reviewFor === "string") {
      return {
        tools: ["rfc_report_findings"],
        skills: [],
        instructions:
          "You are a read-only RFC review worker. Report findings only with rfc_report_findings; never edit files.",
      };
    }
    if (typeof discussFor === "string") {
      return {
        tools: ["rfc_check_diagram"],
        skills: [],
        instructions:
          "You are a focused discussion thread about one RFC review finding. Keep answers specific to that finding. Do not edit the RFC unless the user explicitly asks you to in this thread; changes normally flow through the main thread after the user accepts the finding.",
      };
    }
    return {
      tools: [
        "rfc_set_document",
        "rfc_report_findings",
        "rfc_check_diagram",
        "rfc_note_add",
        "rfc_note_update",
        "rfc_publish_card",
        "rfc_define_term",
        "rfc_claims_upsert",
        "rfc_publish_walkthrough",
      ],
      skills: ["rfcs"],
    };
  });

  // ---- lifecycle: archive/unarchive an RFC thread's hidden children with it ----
  async function childThreads(parentId: string): Promise<string[]> {
    const ids = new Set<string>();
    try {
      const list = await bb.sdk.threads.list({ parentThreadId: parentId, includeHidden: true });
      for (const t of list as Array<{ id: string }>) ids.add(t.id);
    } catch (cause) {
      bb.log.warn(`could not list children of ${parentId}: ${describe(cause)}`);
    }
    // Belt and braces: ids we recorded ourselves (review workers, discussions).
    const review = await readReview(parentId);
    if (review.reviewThreadId !== null) ids.add(review.reviewThreadId);
    for (const f of review.findings) if (f.discussThreadId !== null) ids.add(f.discussThreadId);
    ids.delete(parentId);
    return [...ids];
  }
  const publishThread = ({ thread }: { thread: { id: string } }) => {
    bb.realtime.publish(CHANGED, { threadId: thread.id, kind: "thread" });
    // Library rows carry unread flags; let them refresh too.
    invalidateLibrary();
  };
  bb.events.on("thread.idle", publishThread);
  bb.events.on("thread.active", publishThread);
  bb.events.on("thread.failed", publishThread);
  bb.events.on("interaction.pending", publishThread);

  bb.events.on("thread.archived", async ({ thread }) => {
    if ((await readDoc(thread.id)) === null) return; // not an RFC thread
    const children = await childThreads(thread.id);
    for (const id of children) {
      try {
        const t = await bb.sdk.threads.get({ threadId: id });
        if ((t as { archivedAt?: number | null }).archivedAt != null) continue;
        await bb.sdk.threads.archive({ threadId: id });
      } catch (cause) {
        bb.log.warn(`archive child ${id} failed: ${describe(cause)}`);
      }
    }
    invalidateLibrary();
    bb.realtime.publish(CHANGED, { threadId: "", kind: "library" });
    if (children.length > 0) bb.log.info(`archived ${children.length} RFC child thread(s) of ${thread.id}`);
  });
  bb.events.on("thread.unarchived", async ({ thread }) => {
    if ((await readDoc(thread.id)) === null) return;
    // Bring back discussion threads (not finished review workers) so the
    // finding cards can still show their conversations.
    const review = await readReview(thread.id);
    for (const f of review.findings) {
      if (f.discussThreadId === null) continue;
      try {
        await bb.sdk.threads.unarchive({ threadId: f.discussThreadId });
      } catch (cause) {
        bb.log.warn(`unarchive discussion ${f.discussThreadId} failed: ${describe(cause)}`);
      }
    }
    invalidateLibrary();
    bb.realtime.publish(CHANGED, { threadId: "", kind: "library" });
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    if ((await readDoc(thread.id)) === null) return;
    await bb.storage.kv.delete(key.doc(thread.id));
    await bb.storage.kv.delete(key.review(thread.id));
    invalidateLibrary();
    bb.realtime.publish(CHANGED, { threadId: "", kind: "library" });
  });

  // ---- CLI ----
  const cliError = (cause: unknown) => new PluginCliError(describe(cause));
  const needThread = (threadId: string | undefined): string => {
    if (threadId === undefined) throw new PluginCliError("no thread in context", { hint: "Pass --thread <id>." });
    return threadId;
  };
  const findingLine = (f: Finding) =>
    `${f.status.padEnd(8)} ${f.priority} ${f.id.padEnd(16)} ${f.section ?? ""}${f.line === null ? "" : `:${f.line}`}  ${f.title}`;
  const threadOpt = { thread: { type: "string" as const, description: "Thread id; defaults to this thread" } };

  bb.cli.register(
    defineCli({
      name: "rfcs",
      summary: "Open, create, and review RFC markdown documents for a thread",
      commands: {
        open: cliCommand({
          summary: "Make a markdown file the RFC the panel follows for this thread",
          positionals: [{ name: "path", description: "Path, relative to the workspace or absolute", required: true }],
          options: threadOpt,
          async run(input, ctx) {
            try {
              const doc = await setDoc(needThread(input.options.thread ?? ctx.threadId), input.positionals.path);
              return { exitCode: 0, stdout: doc.path };
            } catch (cause) {
              throw cliError(cause);
            }
          },
        }),
        new: cliCommand({
          summary: "Create an RFC from the template in the RFC directory and open it",
          positionals: [{ name: "title", description: "RFC title", required: true }],
          options: threadOpt,
          async run(input, ctx) {
            try {
              const doc = await createDoc(needThread(input.options.thread ?? ctx.threadId), input.positionals.title);
              return { exitCode: 0, stdout: doc.path };
            } catch (cause) {
              throw cliError(cause);
            }
          },
        }),
        show: cliCommand({
          summary: "Print the RFC this thread follows and its outline",
          options: { ...threadOpt, json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input, ctx) {
            const threadId = needThread(input.options.thread ?? ctx.threadId);
            const doc = await readDoc(threadId);
            if (doc === null) return { exitCode: 1, stdout: "", stderr: "No RFC open on this thread." };
            const file = await readFileAt(doc.path, doc.hostId);
            const heads = file === null ? [] : outline(file.content);
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ doc, exists: file !== null, outline: heads }) };
            return {
              exitCode: 0,
              stdout: [doc.path, ...heads.map((h) => `${"  ".repeat(h.level - 1)}${h.title}  (line ${h.line})`)].join("\n"),
            };
          },
        }),
        review: cliCommand({
          summary: "Start a review round on this thread's RFC (hidden worker thread)",
          options: { ...threadOpt, json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input, ctx) {
            try {
              const result = await startReview(needThread(input.options.thread ?? ctx.threadId), "");
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify(result)
                  : result.started
                    ? `Review round started (worker ${result.reviewThreadId}).`
                    : "A review round is already running.",
              };
            } catch (cause) {
              throw cliError(cause);
            }
          },
        }),
        findings: cliCommand({
          summary: "List findings for this thread's RFC",
          options: { ...threadOpt, json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input, ctx) {
            const state = await readReview(needThread(input.options.thread ?? ctx.threadId));
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(state)
                : [`round ${state.round} · ${state.status}`, ...state.findings.map(findingLine)].join("\n"),
            };
          },
        }),
        accept: cliCommand({
          summary: "Accept a finding, optionally with a priority",
          positionals: [{ name: "finding", description: "Finding id", required: true }],
          options: { ...threadOpt, priority: { type: "enum", values: [...PRIORITIES], description: "p0 (highest) to p3" } },
          async run(input, ctx) {
            try {
              const f = await mutateReview(needThread(input.options.thread ?? ctx.threadId), (state) => {
                const finding = state.findings.find((x) => x.id === input.positionals.finding);
                if (finding === undefined) throw new Error("Finding not found.");
                finding.status = "accepted";
                if (input.options.priority !== undefined) finding.priority = input.options.priority;
                return finding;
              });
              return { exitCode: 0, stdout: findingLine(f) };
            } catch (cause) {
              throw cliError(cause);
            }
          },
        }),
        skip: cliCommand({
          summary: "Skip a finding",
          positionals: [{ name: "finding", description: "Finding id", required: true }],
          options: threadOpt,
          async run(input, ctx) {
            try {
              const f = await mutateReview(needThread(input.options.thread ?? ctx.threadId), (state) => {
                const finding = state.findings.find((x) => x.id === input.positionals.finding);
                if (finding === undefined) throw new Error("Finding not found.");
                finding.status = "skipped";
                return finding;
              });
              return { exitCode: 0, stdout: findingLine(f) };
            } catch (cause) {
              throw cliError(cause);
            }
          },
        }),
        list: cliCommand({
          summary: "List every RFC the library knows about (all projects, plus files open in threads)",
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            const { items, notes } = await scanLibrary(true);
            publishLibrary({ items, notes });
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ items, notes }) };
            const lines = items.map(
              (i) => `${(i.status ?? "-").padEnd(9)} ${(i.projectName ?? "-").padEnd(12)} ${i.title.slice(0, 48).padEnd(48)} ${i.path}${i.threads.length > 0 ? `  [${i.threads.length} thread(s)]` : ""}`,
            );
            return { exitCode: 0, stdout: [...lines, ...notes.map((n) => `note: ${n}`)].join("\n") || "No RFCs found." };
          },
        }),
        "check-d2": cliCommand({
          summary: "Compile a D2 file and report errors",
          positionals: [{ name: "path", description: "Absolute path to a .d2 file", required: true }],
          async run(input) {
            try {
              const file = await readFileAt(normalize(input.positionals.path), null);
              if (file === null) throw new Error("File not found.");
              const result = await renderD2(file.content, false);
              if (result.ok) return { exitCode: 0, stdout: "ok" };
              return { exitCode: 1, stdout: "", stderr: result.error };
            } catch (cause) {
              throw cliError(cause);
            }
          },
        }),
      },
    }),
  );

  bb.log.info("loaded");
}
