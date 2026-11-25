// bb-plugin-github-prs — types and schemas shared by server.ts and app.tsx.
import { z } from "zod";

/** Realtime channel: payload { key } (a PR state key) or {} for the list. */
export const CHANGED = "ghpr-changed";

/** GitHub reaction content values accepted by the REST reactions API. */
export const REACTIONS = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"] as const;
export type Reaction = (typeof REACTIONS)[number];
export const REACTION_EMOJI: Record<Reaction, string> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😄",
  confused: "😕",
  heart: "❤️",
  hooray: "🎉",
  rocket: "🚀",
  eyes: "👀",
};

export const prRefSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
});
export type PrRef = z.infer<typeof prRefSchema>;
export const prKey = (ref: PrRef) => `${ref.owner}/${ref.repo}#${ref.number}`;

export const prSummarySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  /** author = your PR; reviewer = your review was requested. */
  role: z.enum(["author", "reviewer"]).default("author"),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  createdAt: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  reviewDecision: z.string().nullable(),
  checksState: z.string().nullable(),
  unresolvedThreads: z.number(),
  commentCount: z.number(),
});
export type PrSummary = z.infer<typeof prSummarySchema>;

export const reactionGroupSchema = z.object({
  content: z.enum(REACTIONS),
  count: z.number(),
  viewerReacted: z.boolean(),
});
export type ReactionGroup = z.infer<typeof reactionGroupSchema>;

export const reviewCommentSchema = z.object({
  /** REST (database) id — used for replies and reactions. */
  id: z.number(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
  reactions: z.array(reactionGroupSchema),
});
export type ReviewComment = z.infer<typeof reviewCommentSchema>;

export const reviewThreadSchema = z.object({
  /** GraphQL node id — used for resolveReviewThread and as the item key. */
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().nullable(),
  diffHunk: z.string(),
  comments: z.array(reviewCommentSchema),
});
export type ReviewThread = z.infer<typeof reviewThreadSchema>;

export const issueCommentSchema = z.object({
  id: z.number(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
  reactions: z.array(reactionGroupSchema),
});
export type IssueComment = z.infer<typeof issueCommentSchema>;

export const reviewSchema = z.object({
  author: z.string(),
  state: z.string(),
  body: z.string(),
  submittedAt: z.string().nullable(),
  url: z.string(),
});
export type Review = z.infer<typeof reviewSchema>;

export const prFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  /** Unified patch for this one file; null for binary or very large files. */
  patch: z.string().nullable(),
});
export type PrFile = z.infer<typeof prFileSchema>;

export const checkSchema = z.object({
  name: z.string(),
  status: z.string(),
  url: z.string().nullable(),
});
export type Check = z.infer<typeof checkSchema>;

// ---- plugin-local state per comment thread / item ----

export const TRIAGES = ["pending", "address", "wont-fix", "done"] as const;
export type Triage = (typeof TRIAGES)[number];

export const fixSchema = z.object({
  status: z.enum(["pending", "ready", "failed", "applied"]),
  summary: z.string(),
  patch: z.string(),
  error: z.string().nullable(),
  threadId: z.string().nullable(),
  appliedAt: z.string().nullable(),
});
export type Fix = z.infer<typeof fixSchema>;

export const itemStateSchema = z.object({
  triage: z.enum(TRIAGES),
  draft: z.string().nullable(),
  draftStatus: z.enum(["pending", "ready", "failed"]).nullable(),
  draftThreadId: z.string().nullable(),
  /** Persistent per-comment discussion thread (right pane), reused across opens. */
  discussThreadId: z.string().nullable().default(null),
  fix: fixSchema.nullable(),
  postedAt: z.string().nullable(),
});
export type ItemState = z.infer<typeof itemStateSchema>;

export const emptyItem = (): ItemState => ({
  triage: "pending",
  draft: null,
  draftStatus: null,
  draftThreadId: null,
  discussThreadId: null,
  fix: null,
  postedAt: null,
});

// ---- worker model: which provider/model/reasoning a worker ran on ----

export const runModelSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.string(),
});
export type RunModel = z.infer<typeof runModelSchema>;

/** The model selection workers spawn with; null = BB's default for new threads. */
export const workerModelSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.string(),
  serviceTier: z.string().optional(),
});
export type WorkerModel = z.infer<typeof workerModelSchema>;

// ---- reviewer side: findings from a plugin-run review round ----

export const SEVERITIES = ["bug", "question", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const findingSchema = z.object({
  id: z.string(),
  path: z.string(),
  /** Line on the PR head side; null = whole-PR / not line-anchored. */
  line: z.number().nullable(),
  severity: z.enum(SEVERITIES),
  title: z.string(),
  /** Explanation of the finding, for you (markdown). */
  body: z.string(),
  status: z.enum(["open", "posted", "dismissed"]),
  postedAt: z.string().nullable(),
});
export type Finding = z.infer<typeof findingSchema>;

export const reviewStateSchema = z.object({
  status: z.enum(["idle", "running", "done", "failed"]),
  round: z.number(),
  threadId: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  findings: z.array(findingSchema),
  /** Model the latest round ran on (null for rounds started before this was recorded). */
  model: runModelSchema.nullable().default(null),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const emptyReview = (): ReviewState => ({
  status: "idle",
  round: 0,
  threadId: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  findings: [],
  model: null,
});

// ---- walkthrough: ground-up guided tour of the PR ----

export const walkSectionSchema = z.object({
  path: z.string(),
  /** added = part of this PR's change (rendered as a colored diff); context = pre-existing code (rendered plain). */
  kind: z.enum(["added", "context"]),
  /** added: a unified diff hunk; context: plain source text. */
  code: z.string(),
  /** First line number of a context section in its file. */
  startLine: z.number().nullable(),
});
export type WalkSection = z.infer<typeof walkSectionSchema>;

export const walkStepSchema = z.object({
  title: z.string(),
  /** Markdown explanation of this step. */
  body: z.string(),
  sections: z.array(walkSectionSchema),
});
export type WalkStep = z.infer<typeof walkStepSchema>;

export const walkthroughSchema = z.object({
  status: z.enum(["idle", "running", "done", "failed"]),
  threadId: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  title: z.string().nullable(),
  steps: z.array(walkStepSchema),
  model: runModelSchema.nullable().default(null),
});
export type Walkthrough = z.infer<typeof walkthroughSchema>;

export const emptyWalkthrough = (): Walkthrough => ({
  status: "idle",
  threadId: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  title: null,
  steps: [],
  model: null,
});

export const checkoutSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  dirty: z.boolean(),
  onPrBranch: z.boolean(),
});
export type Checkout = z.infer<typeof checkoutSchema>;

export const prDetailSchema = z.object({
  summary: prSummarySchema,
  body: z.string(),
  author: z.string(),
  state: z.string(),
  checks: z.array(checkSchema),
  files: z.array(prFileSchema),
  threads: z.array(reviewThreadSchema),
  issueComments: z.array(issueCommentSchema),
  reviews: z.array(reviewSchema),
  items: z.record(z.string(), itemStateSchema),
  review: reviewStateSchema,
  walkthrough: walkthroughSchema,
  checkout: checkoutSchema.nullable(),
  fetchedAt: z.string(),
});
export type PrDetail = z.infer<typeof prDetailSchema>;
