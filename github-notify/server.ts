// bb-plugin-github-notify — backend.
//
// One background service polls GitHub's notifications API (the same feed as
// github.com/notifications). Each new or updated notification is classified
// by what actually happened (see classify) and, if it concerns you
// personally, published on the realtime channel; app.tsx turns it into a desktop notification and a toast,
// and keeps the last MAX_RECENT on the GitHub Notify page.
//
// Polling honours GitHub's X-Poll-Interval and sends If-Modified-Since, so an
// unchanged feed costs a 304 that does not count against the rate limit. The
// first poll only records what is already unread, so installing the plugin
// does not replay the backlog.
import { execFile } from "node:child_process";
import {
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CLASSIFIED,
  FEED_CHANNEL,
  NOTIFY_CHANNEL,
  REASONS,
  feedSchema,
  type NotifyEvent,
} from "./shared";

export const rpcContract = defineRpcContract({
  feed_get: { input: z.null(), output: feedSchema },
  feed_mark_viewed: { input: z.null(), output: z.object({ ok: z.literal(true) }) },
  feed_clear: { input: z.null(), output: z.object({ ok: z.literal(true) }) },
});

const API = "https://api.github.com";
const STATE_KEY = "state";
const RECENT_KEY = "recent";
const VIEWED_KEY = "viewedAt";
const MAX_RECENT = 100;
/** Notifications classified per poll; more than this in one poll are skipped. */
const MAX_LOOKUPS = 25;
/** How far a comment, review, or timeline event may be from a notification's updated_at. */
const NEAR_MS = 2 * 60_000;
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

const userSchema = z.object({ login: z.string() }).nullable().optional();

const commentResponse = z.object({
  html_url: z.string(),
  body: z.string().nullable().optional(),
  user: userSchema,
  created_at: z.string(),
  updated_at: z.string().optional(),
});

const reviewsResponse = z.array(
  z.object({
    html_url: z.string(),
    body: z.string().nullable().optional(),
    user: userSchema,
    state: z.string(),
    submitted_at: z.string().nullable().optional(),
  }),
);

const issueEventsResponse = z.array(
  z.object({
    event: z.string(),
    created_at: z.string(),
    actor: userSchema,
    assignee: userSchema,
    requested_reviewer: userSchema,
  }),
);

const subjectResponse = z.object({
  html_url: z.string(),
  body: z.string().nullable().optional(),
  user: userSchema,
  created_at: z.string(),
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

function isBot(login: string): boolean {
  return login.endsWith("[bot]");
}

function reviewHeadline(actor: string, state: string): string {
  switch (state) {
    case "APPROVED":
      return `${actor} approved`;
    case "CHANGES_REQUESTED":
      return `${actor} requested changes`;
    default:
      return `${actor} reviewed`;
  }
}

/** The `rel="last"` URL of a GitHub Link header, if the list has more pages. */
function lastPage(link: string | null): string | null {
  const match = link?.match(/<([^>]+)>;\s*rel="last"/);
  return match ? match[1] : null;
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
      description: `Comma-separated kinds of activity to alert on: author (others comment on or review your PRs), assign and review_requested (you personally, not your teams), mention (@you in the new comment, review, or description), comment (new comments on other threads you commented on). Others alert on any update: ${REASONS.filter((r) => !CLASSIFIED.has(r)).join(", ")}.`,
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
      default: "author,assign,mention,review_requested",
    },
    ignoreBots: {
      type: "boolean",
      label: "Ignore bots",
      description: "Skip comments and reviews from bot accounts such as github-actions[bot].",
      default: true,
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
    openInBrowser: {
      type: "boolean",
      label: "Open in system browser",
      description:
        "Open notifications in your default browser, where you are signed in to GitHub. Off follows BB's browser preference.",
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

  let login: { token: string; login: string } | null = null;
  async function myLogin(token: string, signal: AbortSignal): Promise<string> {
    if (login?.token === token) return login.login;
    const me = z.object({ login: z.string() }).parse(await getJson(`${API}/user`, token, signal));
    login = { token, login: me.login };
    return me.login;
  }

  async function getJson(url: string, token: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(url, { signal, headers: headers(token) });
    if (!response.ok) throw new Error(`GET ${new URL(url).pathname}: HTTP ${response.status}`);
    return response.json();
  }

  /** The newest page of an oldest-first GitHub list. */
  async function newestPage(url: string, token: string, signal: AbortSignal): Promise<unknown> {
    const first = await fetch(`${url}?per_page=100`, { signal, headers: headers(token) });
    if (!first.ok) throw new Error(`GET ${new URL(url).pathname}: HTTP ${first.status}`);
    const last = lastPage(first.headers.get("link"));
    return last === null ? first.json() : getJson(last, token, signal);
  }

  /**
   * Works out what changed at the notification's updated_at and returns an
   * event only if it concerns you personally. GitHub keeps a thread's first
   * reason (review_requested, mention) for all later activity on it, and
   * uses review_requested for team requests too, so the reason alone says
   * too little.
   */
  async function classify(
    n: Notification,
    token: string,
    wanted: Set<string>,
    ignoreBots: boolean,
    signal: AbortSignal,
  ): Promise<NotifyEvent | null> {
    const kind = n.subject.type === "PullRequest" ? "pr" : "issue";
    const me = await myLogin(token, signal);
    const at = Date.parse(n.updated_at);
    const near = (iso: string | null | undefined) =>
      iso !== null && iso !== undefined && Math.abs(Date.parse(iso) - at) <= NEAR_MS;
    const mentionsMe = (body: string | null | undefined) =>
      new RegExp(`(^|[^\\w-])@${me}(?![\\w-])`, "i").test(body ?? "");
    const other = (who: string | null | undefined): who is string =>
      typeof who === "string" && who.toLowerCase() !== me.toLowerCase() && !(ignoreBots && isBot(who));
    const event = (actor: string | null, headline: string, url: string, body?: string | null): NotifyEvent => ({
      id: n.id,
      repo: n.repository.full_name,
      number: subjectNumber(n),
      kind,
      title: n.subject.title,
      reason: n.reason,
      actor,
      headline,
      excerpt: excerpt(body),
      url,
      updatedAt: n.updated_at,
      receivedAt: new Date().toISOString(),
    });

    // Reasons this plugin does not classify alert on any update, as GitHub sends them.
    if (!CLASSIFIED.has(n.reason)) {
      return wanted.has(n.reason) ? event(null, n.reason.replace("_", " "), htmlUrl(n)) : null;
    }
    if (n.subject.url === null) return null;

    // 1. A new comment (issue comment or PR review comment).
    const commentUrl = n.subject.latest_comment_url;
    if (commentUrl !== null && commentUrl !== n.subject.url) {
      const comment = commentResponse.parse(await getJson(commentUrl, token, signal));
      if (near(comment.created_at) || near(comment.updated_at)) {
        const who = comment.user?.login;
        if (!other(who)) return null;
        if (wanted.has("mention") && mentionsMe(comment.body)) {
          return event(who, `${who} mentioned you`, comment.html_url, comment.body);
        }
        if ((n.reason === "author" && wanted.has("author")) || (n.reason === "comment" && wanted.has("comment"))) {
          return event(who, `${who} commented`, comment.html_url, comment.body);
        }
        return null;
      }
    }

    // 2. A submitted review, including a bare approval with no comment.
    if (kind === "pr") {
      const reviews = reviewsResponse.parse(await newestPage(`${n.subject.url}/reviews`, token, signal));
      const review = [...reviews].reverse().find((r) => near(r.submitted_at));
      if (review !== undefined) {
        const who = review.user?.login;
        if (!other(who)) return null;
        if (wanted.has("mention") && mentionsMe(review.body)) {
          return event(who, `${who} mentioned you`, review.html_url, review.body);
        }
        if (n.reason === "author" && wanted.has("author")) {
          return event(who, reviewHeadline(who, review.state), review.html_url, review.body);
        }
        return null;
      }
    }

    // 3. You were personally requested or assigned (team requests have no
    //    requested_reviewer and never match).
    const issueUrl = n.subject.url.replace(/\/pulls\/(\d+)$/, "/issues/$1");
    const events = issueEventsResponse.parse(await newestPage(`${issueUrl}/events`, token, signal));
    for (const e of [...events].reverse()) {
      if (!near(e.created_at)) continue;
      const who = e.actor?.login ?? null;
      const isMe = (u: { login: string } | null | undefined) => u?.login.toLowerCase() === me.toLowerCase();
      if (e.event === "review_requested" && isMe(e.requested_reviewer) && wanted.has("review_requested")) {
        return event(who, who ? `${who} requested your review` : "Review requested", htmlUrl(n));
      }
      if (e.event === "assigned" && isMe(e.assignee) && wanted.has("assign") && who?.toLowerCase() !== me.toLowerCase()) {
        return event(who, who ? `${who} assigned you` : "Assigned to you", htmlUrl(n));
      }
    }

    // 4. A mention in the description of a newly opened PR or issue.
    if (n.reason === "mention" && wanted.has("mention")) {
      const subject = subjectResponse.parse(await getJson(n.subject.url, token, signal));
      const who = subject.user?.login;
      if (near(subject.created_at) && other(who) && mentionsMe(subject.body)) {
        return event(who, `${who} mentioned you`, subject.html_url, subject.body);
      }
    }
    return null;
  }

  /** One poll. Returns the delay GitHub asks for before the next one, in ms. */
  async function poll(signal: AbortSignal): Promise<number> {
    const { enabled, reasons, includeIssues, ignoreBots } = await settings.get();
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
    // Every changed thread is classified, whatever its reason: a mention or
    // a personal request can arrive on a thread GitHub files under another.
    const fresh = items.filter((n) => state.seen[n.id] !== n.updated_at && types.has(n.subject.type));
    const events: NotifyEvent[] = [];
    if (!baseline) {
      if (fresh.length > MAX_LOOKUPS) bb.log.warn(`${fresh.length} updates in one poll; skipping the oldest ${fresh.length - MAX_LOOKUPS}`);
      for (const n of fresh.slice(0, MAX_LOOKUPS)) {
        try {
          const found = await classify(n, token, wanted, ignoreBots, signal);
          if (found !== null) events.push(found);
          else bb.log.debug(`skipped ${n.repository.full_name} ${n.reason} ${n.updated_at}`);
        } catch (cause) {
          if (signal.aborted) throw cause;
          bb.log.warn(`could not classify ${n.repository.full_name} notification ${n.id}: ${String(cause)}`);
        }
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

  bb.rpc.register(rpcContract, {
    feed_get: async () => {
      const state = await readState();
      return {
        events: await readRecent(),
        viewedAt: (await bb.storage.kv.get<string>(VIEWED_KEY)) ?? null,
        lastPollAt: state.lastPollAt,
        lastError: state.lastError,
      };
    },
    feed_mark_viewed: async () => {
      await bb.storage.kv.set(VIEWED_KEY, new Date().toISOString());
      bb.realtime.publish(FEED_CHANNEL, { viewed: true });
      return { ok: true as const };
    },
    feed_clear: async () => {
      await bb.storage.kv.set(RECENT_KEY, []);
      bb.realtime.publish(FEED_CHANNEL, { cleared: true });
      return { ok: true as const };
    },
  });

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
        check: cliCommand({
          summary: "Dry run: classify your latest notifications (read or unread) without alerting",
          options: {
            limit: { type: "integer", min: 1, max: 50, default: 20, description: "How many notifications to check (max 50)" },
            repo: { type: "string", description: "Only this repository (owner/name)" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const { reasons, includeIssues, ignoreBots } = await settings.get();
            const token = await githubToken();
            if (token === null) return { exitCode: 1, stderr: "No GitHub token.\n" };
            const limit = input.options.limit;
            const signal = ctx.signal ?? new AbortController().signal;
            const wanted = new Set(reasons.split(",").map((r) => r.trim()));
            const types = new Set(includeIssues ? ["PullRequest", "Issue"] : ["PullRequest"]);
            const repo = input.options.repo;
            if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
              return { exitCode: 2, stderr: "--repo must look like owner/name\n" };
            }
            const base = repo === undefined ? API : `${API}/repos/${repo}`;
            const items = notificationsResponse
              .parse(await getJson(`${base}/notifications?all=true&per_page=${limit}`, token, signal))
              .filter((n) => types.has(n.subject.type));
            const rows: Array<{ ref: string; reason: string; updatedAt: string; result: string }> = [];
            for (const n of items) {
              const number = subjectNumber(n);
              const ref = number === null ? n.repository.full_name : `${n.repository.full_name}#${number}`;
              let result: string;
              try {
                const found = await classify(n, token, wanted, ignoreBots, signal);
                result = found === null ? "skip" : `ALERT  ${found.headline}`;
              } catch (cause) {
                result = `error  ${cause instanceof Error ? cause.message : String(cause)}`;
              }
              rows.push({ ref, reason: n.reason, updatedAt: n.updated_at, result });
            }
            if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(rows)}\n` };
            return {
              exitCode: 0,
              stdout: `${rows.map((r) => `${r.updatedAt}  ${r.reason.padEnd(16)}  ${r.ref.padEnd(40)}  ${r.result}`).join("\n")}\n`,
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
          summary: "Send a sample notification (also listed on the page; Clear removes it)",
          async run() {
            await emit([{
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
              receivedAt: new Date().toISOString(),
            }]);
            return { exitCode: 0, stdout: "Sent a sample notification.\n" };
          },
        }),
      },
    }),
  );
}
