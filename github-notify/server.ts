// bb-plugin-github-notify — backend.
//
// One background service polls GitHub's notifications API (the same feed as
// github.com/notifications, already scoped to you: PRs you authored, were
// assigned, were asked to review, commented on, or were mentioned in). Each
// new or updated notification whose reason is enabled is published on the
// realtime channel; app.tsx turns it into a desktop notification and a toast.
//
// Polling honours GitHub's X-Poll-Interval and sends If-Modified-Since, so an
// unchanged feed costs a 304 that does not count against the rate limit. The
// first poll only records what is already unread, so installing the plugin
// does not replay the backlog.
import { execFile } from "node:child_process";
import {
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { NOTIFY_CHANNEL, REASONS, type NotifyEvent } from "./shared";

const API = "https://api.github.com";
const STATE_KEY = "state";
const RECENT_KEY = "recent";
const MAX_RECENT = 50;
/** Comment lookups per poll; the rest notify without the commenter's name. */
const MAX_LOOKUPS = 10;
const EXCERPT_CHARS = 200;
const RETRY_MS = 5 * 60_000;

interface PollState {
  /** Last-Modified of the last 200 response; null until the first poll. */
  lastModified: string | null;
  /** Notification id -> updated_at already handled. */
  seen: Record<string, string>;
  lastPollAt: string | null;
  lastError: string | null;
}

const notificationsResponse = z.array(
  z.object({
    id: z.string(),
    reason: z.string(),
    updated_at: z.string(),
    subject: z.object({
      title: z.string(),
      type: z.string(),
      url: z.string().nullable(),
      latest_comment_url: z.string().nullable(),
    }),
    repository: z.object({ full_name: z.string(), html_url: z.string() }),
  }),
);
type Notification = z.infer<typeof notificationsResponse>[number];

const commentResponse = z.object({
  html_url: z.string(),
  body: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable(),
});

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() !== "" ? stderr.trim() : error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** `https://api.github.com/repos/o/r/pulls/12` -> `https://github.com/o/r/pull/12`. */
function htmlUrl(n: Notification): string {
  const match = n.subject.url?.match(/\/repos\/([^/]+\/[^/]+)\/(pulls|issues)\/(\d+)$/);
  if (match === null || match === undefined) return n.repository.html_url;
  const path = match[2] === "pulls" ? "pull" : "issues";
  return `https://github.com/${match[1]}/${path}/${match[3]}`;
}

function subjectNumber(n: Notification): number | null {
  const match = n.subject.url?.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function excerpt(body: string | null | undefined): string | null {
  const text = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text;
}

function headline(reason: string, actor: string | null, commented: boolean, kind: "pr" | "issue"): string {
  const what = kind === "pr" ? "PR" : "issue";
  switch (reason) {
    case "assign":
      return "Assigned to you";
    case "review_requested":
      return "Review requested";
    case "mention":
    case "team_mention":
      return actor ? `${actor} mentioned you` : "You were mentioned";
    case "state_change":
      return "State changed";
    case "ci_activity":
      return "CI activity";
  }
  if (commented && actor) return `${actor} commented`;
  return reason === "author" ? `Activity on your ${what}` : "New activity";
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    githubToken: {
      type: "string",
      label: "GitHub token",
      description:
        "Classic token with the notifications or repo scope (fine-grained tokens cannot read notifications). Leave empty to use the gh CLI's login instead.",
      secret: true,
    },
    enabled: {
      type: "boolean",
      label: "Notify",
      description: "Poll GitHub notifications and alert on new activity.",
      default: true,
    },
    reasons: {
      type: "string",
      label: "Reasons",
      description: `Comma-separated GitHub notification reasons to alert on. Known: ${REASONS.join(", ")}.`,
      experimental_schema: z
        .string()
        .refine(
          (value) =>
            value
              .split(",")
              .map((r) => r.trim())
              .filter((r) => r !== "")
              .every((r) => (REASONS as readonly string[]).includes(r)),
          `Reasons must be a comma-separated list of: ${REASONS.join(", ")}`,
        ),
      default: "author,assign,comment,mention,review_requested",
    },
    includeIssues: {
      type: "boolean",
      label: "Include issues",
      description: "Also alert on issues, not only pull requests.",
      default: false,
    },
    desktop: {
      type: "boolean",
      label: "Desktop notifications",
      description: "Show a system notification as well as the in-app toast.",
      default: true,
    },
  });

  async function githubToken(): Promise<string | null> {
    const { githubToken: configured } = await settings.get();
    if (typeof configured === "string" && configured !== "") return configured;
    try {
      const token = (await runGh(["auth", "token"])).trim();
      return token === "" ? null : token;
    } catch {
      return null;
    }
  }

  async function readState(): Promise<PollState> {
    return (
      (await bb.storage.kv.get<PollState>(STATE_KEY)) ?? {
        lastModified: null,
        seen: {},
        lastPollAt: null,
        lastError: null,
      }
    );
  }

  async function readRecent(): Promise<NotifyEvent[]> {
    return (await bb.storage.kv.get<NotifyEvent[]>(RECENT_KEY)) ?? [];
  }

  async function emit(events: NotifyEvent[]): Promise<void> {
    if (events.length === 0) return;
    const recent = [...events, ...(await readRecent())].slice(0, MAX_RECENT);
    await bb.storage.kv.set(RECENT_KEY, recent);
    for (const event of events) bb.realtime.publish(NOTIFY_CHANNEL, event);
  }

  function headers(token: string): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "bb-plugin-github-notify",
    };
  }

  async function toEvent(n: Notification, token: string, lookup: boolean, signal: AbortSignal): Promise<NotifyEvent> {
    const kind = n.subject.type === "PullRequest" ? "pr" : "issue";
    let actor: string | null = null;
    let body: string | null = null;
    let url = htmlUrl(n);
    // latest_comment_url points at the subject itself when the latest event
    // is not a comment (a push, an assignment); only comments name an actor.
    const commentUrl = n.subject.latest_comment_url;
    const commented = commentUrl !== null && commentUrl !== n.subject.url;
    if (lookup && commented) {
      try {
        const response = await fetch(commentUrl, { signal, headers: headers(token) });
        if (response.ok) {
          const comment = commentResponse.parse(await response.json());
          actor = comment.user?.login ?? null;
          body = comment.body ?? null;
          url = comment.html_url;
        }
      } catch (cause) {
        if (signal.aborted) throw cause;
        bb.log.debug(`comment lookup failed for ${n.id}: ${String(cause)}`);
      }
    }
    return {
      id: n.id,
      repo: n.repository.full_name,
      number: subjectNumber(n),
      kind,
      title: n.subject.title,
      reason: n.reason,
      actor,
      headline: headline(n.reason, actor, commented && actor !== null, kind),
      excerpt: excerpt(body),
      url,
      updatedAt: n.updated_at,
    };
  }

  /** One poll. Returns the delay GitHub asks for before the next one, in ms. */
  async function poll(signal: AbortSignal): Promise<number> {
    const { enabled, reasons, includeIssues } = await settings.get();
    const state = await readState();
    if (!enabled) return 60_000;
    const token = await githubToken();
    if (token === null) {
      state.lastError = "No GitHub token: set one in plugin settings or run `gh auth login`.";
      await bb.storage.kv.set(STATE_KEY, state);
      return RETRY_MS;
    }
    const request: Record<string, string> = headers(token);
    if (state.lastModified !== null) request["if-modified-since"] = state.lastModified;
    const response = await fetch(`${API}/notifications?per_page=50`, { signal, headers: request });
    const interval = Math.max(60, Number(response.headers.get("x-poll-interval") ?? 60) || 60) * 1000;
    state.lastPollAt = new Date().toISOString();
    if (response.status === 304) {
      state.lastError = null;
      await bb.storage.kv.set(STATE_KEY, state);
      return interval;
    }
    if (!response.ok) {
      state.lastError =
        response.status === 401 || response.status === 403
          ? `GitHub refused the token (HTTP ${response.status}); it needs the notifications or repo scope.`
          : `GitHub notifications failed: HTTP ${response.status}`;
      await bb.storage.kv.set(STATE_KEY, state);
      return Math.max(interval, RETRY_MS);
    }
    const items = notificationsResponse.parse(await response.json());
    const baseline = state.lastModified === null;
    const wanted = new Set(reasons.split(",").map((r) => r.trim()));
    const types = new Set(includeIssues ? ["PullRequest", "Issue"] : ["PullRequest"]);
    const fresh = items.filter(
      (n) => state.seen[n.id] !== n.updated_at && wanted.has(n.reason) && types.has(n.subject.type),
    );
    const events: NotifyEvent[] = [];
    if (!baseline) {
      for (const [index, n] of fresh.entries()) {
        events.push(await toEvent(n, token, index < MAX_LOOKUPS, signal));
      }
    }
    // Keep only ids still in the feed: a read notification leaves the feed
    // and comes back with a new updated_at, which alerts anyway.
    state.seen = Object.fromEntries(items.map((n) => [n.id, n.updated_at]));
    state.lastModified = response.headers.get("last-modified") ?? new Date().toUTCString();
    state.lastError = null;
    await bb.storage.kv.set(STATE_KEY, state);
    await emit(events);
    if (baseline) bb.log.info(`baseline recorded: ${items.length} unread notifications`);
    else if (events.length > 0) bb.log.info(`notified ${events.length}`);
    return interval;
  }

  bb.background.service("poller", {
    async start(signal) {
      while (!signal.aborted) {
        let delay: number;
        try {
          delay = await poll(signal);
        } catch (cause) {
          if (signal.aborted) return;
          const state = await readState();
          state.lastError = cause instanceof Error ? cause.message : String(cause);
          await bb.storage.kv.set(STATE_KEY, state);
          bb.log.warn(`poll failed: ${state.lastError}`);
          delay = RETRY_MS;
        }
        await sleep(delay, signal);
      }
    },
  });

  function line(event: NotifyEvent): string {
    const ref = event.number === null ? event.repo : `${event.repo}#${event.number}`;
    return `${event.updatedAt}  ${ref}  ${event.headline}: ${event.title}  ${event.url}`;
  }

  bb.cli.register(
    defineCli({
      name: "github-notify",
      summary: "Desktop notifications for activity on your GitHub pull requests",
      commands: {
        status: cliCommand({
          summary: "Show the last poll time, error, and enabled reasons",
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            const state = await readState();
            const { enabled, reasons, includeIssues, desktop } = await settings.get();
            const status = {
              enabled,
              reasons: reasons.split(",").map((r) => r.trim()),
              includeIssues,
              desktop,
              lastPollAt: state.lastPollAt,
              lastError: state.lastError,
              tracked: Object.keys(state.seen).length,
            };
            if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(status)}\n` };
            return {
              exitCode: 0,
              stdout: [
                `enabled:   ${enabled}`,
                `reasons:   ${status.reasons.join(", ")}${includeIssues ? " (PRs and issues)" : " (PRs only)"}`,
                `desktop:   ${desktop}`,
                `last poll: ${state.lastPollAt ?? "never"}`,
                `error:     ${state.lastError ?? "none"}`,
                `tracked:   ${status.tracked} unread notifications`,
                "",
              ].join("\n"),
            };
          },
        }),
        recent: cliCommand({
          summary: `List the last notifications sent (up to ${MAX_RECENT})`,
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            const recent = await readRecent();
            if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(recent)}\n` };
            if (recent.length === 0) return { exitCode: 0, stdout: "No notifications yet.\n" };
            return { exitCode: 0, stdout: `${recent.map(line).join("\n")}\n` };
          },
        }),
        test: cliCommand({
          summary: "Send a sample notification to every open BB window",
          async run() {
            bb.realtime.publish(NOTIFY_CHANNEL, {
              id: `test-${Date.now()}`,
              repo: "octocat/hello-world",
              number: 1,
              kind: "pr",
              title: "Sample pull request",
              reason: "comment",
              actor: "octocat",
              headline: "octocat commented",
              excerpt: "This is a test notification from bb github-notify test.",
              url: "https://github.com/notifications",
              updatedAt: new Date().toISOString(),
            } satisfies NotifyEvent);
            return { exitCode: 0, stdout: "Sent a sample notification.\n" };
          },
        }),
      },
    }),
  );
}
