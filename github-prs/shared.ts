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
  fix: fixSchema.nullable(),
  postedAt: z.string().nullable(),
});
export type ItemState = z.infer<typeof itemStateSchema>;

export const emptyItem = (): ItemState => ({
  triage: "pending",
  draft: null,
  draftStatus: null,
  draftThreadId: null,
  fix: null,
  postedAt: null,
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
  checkout: checkoutSchema.nullable(),
  fetchedAt: z.string(),
});
export type PrDetail = z.infer<typeof prDetailSchema>;
