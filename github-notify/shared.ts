// Wire types shared by server.ts and app.tsx. The GitHub token never leaves
// the server: only the fields a notification shows do.
import { z } from "zod";

export const NOTIFY_CHANNEL = "github-notify";
/** Published when the feed is viewed or cleared, so unread counts refetch. */
export const FEED_CHANNEL = "github-notify-feed";

/** GitHub notification reasons this plugin can alert on. */
export const REASONS = [
  "author",
  "assign",
  "comment",
  "mention",
  "team_mention",
  "review_requested",
  "state_change",
  "ci_activity",
  "subscribed",
  "manual",
] as const;
export type Reason = (typeof REASONS)[number];

export const eventSchema = z.object({
  /** GitHub notification thread id. */
  id: z.string(),
  repo: z.string(),
  number: z.number().nullable(),
  kind: z.enum(["pr", "issue"]),
  title: z.string(),
  reason: z.string(),
  /** Who caused it, when the latest comment or review could be read. */
  actor: z.string().nullable(),
  /** One-line summary, e.g. "alice commented". */
  headline: z.string(),
  /** Start of the comment body, if any. */
  excerpt: z.string().nullable(),
  url: z.string(),
  updatedAt: z.string(),
  /** When this plugin first saw this update. */
  receivedAt: z.string(),
});
export type NotifyEvent = z.infer<typeof eventSchema>;

export const feedSchema = z.object({
  events: z.array(eventSchema),
  /** Events received after this are unread; null until the page is opened. */
  viewedAt: z.string().nullable(),
  lastPollAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type Feed = z.infer<typeof feedSchema>;
