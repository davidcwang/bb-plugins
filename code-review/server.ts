// bb-plugin-code-review — backend entry.
//
// A review workbench that sits beside a thread:
//  - Changes: the thread's workspace diff or its pull request, with inline
//    comments you draft and send to the agent as one message.
//  - Findings: a hidden review worker thread reads the diff and reports
//    structured findings through the `code_review_report_findings` tool; you
//    accept, skip, edit, and prioritize them before they reach the agent.
//  - Walkthroughs: the agent groups a change into logical change sets with
//    `code_review_publish_walkthrough`; the chat renders them via the
//    `::code-review-walkthrough{id="…"}` directive.
//
// State is per thread in bb.storage.kv. GitHub is read with a token from
// settings or, failing that, the gh CLI's login.
import { execFile } from "node:child_process";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PRIORITIES, type Priority } from "./shared";

export const KANBAN_PLUGIN_ID = "kanban";
const CHANGED = "code-review-changed";
const REVIEW_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_FINDINGS = 60;
const MAX_WALKTHROUGH_GROUPS = 30;

// ---- schemas -------------------------------------------------------------

const sideSchema = z.enum(["new", "old"]);
const commentSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  side: sideSchema,
  body: z.string(),
  /** Where the line came from, so a sent comment can say which diff it meant. */
  source: z.enum(["workspace", "pr"]),
  status: z.enum(["draft", "sent"]),
  createdAt: z.string(),
});
export type Comment = z.infer<typeof commentSchema>;

const prioritySchema = z.enum(PRIORITIES);
export type { Priority };
const severitySchema = z.enum(["high", "medium", "low"]);

const findingInputSchema = z.object({
  file: z.string().max(500),
  line: z.number().int().positive().nullable().default(null),
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

const hunkRefSchema = z.object({
  path: z.string().max(500),
  startLine: z.number().int().positive().nullable().default(null),
  endLine: z.number().int().positive().nullable().default(null),
  /** Optional unified patch for this hunk; the chat renders it as a diff. */
  patch: z.string().max(20_000).nullable().default(null),
});
const walkthroughGroupSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(4000),
  hunks: z.array(hunkRefSchema).max(40),
});
const walkthroughSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  groups: z.array(walkthroughGroupSchema).max(MAX_WALKTHROUGH_GROUPS),
});
export type Walkthrough = z.infer<typeof walkthroughSchema>;

const prRefSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string().nullable(),
  state: z.string().nullable(),
});
export type PrRef = z.infer<typeof prRefSchema>;

const prFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().nullable(),
});
export type PrFile = z.infer<typeof prFileSchema>;

export const rpcContract = defineRpcContract({
  context_get: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      environmentId: z.string().nullable(),
      isGit: z.boolean(),
      mergeBaseBranch: z.string().nullable(),
      workspacePath: z.string().nullable(),
      definitionsAvailable: z.boolean(),
      pr: prRefSchema.nullable(),
      kanban: z.object({ cardId: z.string(), phase: z.string().nullable() }).nullable(),
    }),
  },
  pr_files: {
    input: z.object({ repo: z.string(), number: z.number().int() }),
    output: z.object({
      headSha: z.string(),
      baseSha: z.string(),
      title: z.string(),
      state: z.string(),
      files: z.array(prFileSchema),
    }),
  },
  pr_file: {
    input: z.object({ repo: z.string(), ref: z.string(), path: z.string() }),
    output: z.object({ content: z.string().nullable() }),
  },
  pr_parse: {
    input: z.object({ text: z.string().max(500) }),
    output: prRefSchema.nullable(),
  },
  definition_find: {
    input: z.object({ threadId: z.string(), symbol: z.string().min(1).max(200) }),
    output: z.object({
      environmentId: z.string().nullable(),
      results: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
      note: z.string().nullable(),
    }),
  },
  comments_list: {
    input: z.object({ threadId: z.string() }),
    output: z.array(commentSchema),
  },
  comments_add: {
    input: z.object({
      threadId: z.string(),
      path: z.string(),
      line: z.number().int().positive(),
      side: sideSchema,
      body: z.string().min(1).max(4000),
      source: z.enum(["workspace", "pr"]),
    }),
    output: commentSchema,
  },
  comments_update: {
    input: z.object({ threadId: z.string(), id: z.string(), body: z.string().min(1).max(4000) }),
    output: commentSchema,
  },
  comments_remove: {
    input: z.object({ threadId: z.string(), id: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  comments_send: {
    input: z.object({ threadId: z.string(), note: z.string().max(4000).default("") }),
    output: z.object({ sent: z.number() }),
  },
  review_run: {
    input: z.object({
      threadId: z.string(),
      source: z.enum(["auto", "workspace", "pr"]).default("auto"),
      instructions: z.string().max(4000).default(""),
    }),
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
    input: z.object({
      threadId: z.string(),
      status: z.enum(["accepted", "skipped"]),
      ids: z.array(z.string()).optional(),
    }),
    output: z.object({ changed: z.number() }),
  },
  findings_send: {
    input: z.object({ threadId: z.string(), note: z.string().max(4000).default("") }),
    output: z.object({ sent: z.number() }),
  },
  walkthrough_request: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  walkthrough_get: {
    input: z.object({ id: z.string() }),
    output: walkthroughSchema.nullable(),
  },
});

// ---- helpers -------------------------------------------------------------

const now = () => new Date().toISOString();
const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function run(cmd: string, args: string[], cwd?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, signal, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // git grep exits 1 on no matches: that is an empty result, not a failure.
          if (cmd === "git" && args[0] === "grep" && (error as { code?: number }).code === 1) {
            resolve("");
            return;
          }
          reject(new Error(stderr.trim() !== "" ? stderr.trim() : error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Parse "owner/repo#12", a GitHub PR URL, or "owner/repo 12". */
export function parsePrRef(text: string): PrRef | null {
  const trimmed = text.trim();
  const url = trimmed.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (url) {
    return {
      repo: url[1]!,
      number: Number(url[2]),
      url: `https://github.com/${url[1]}/pull/${url[2]}`,
      title: null,
      state: null,
    };
  }
  const short = trimmed.match(/^([\w.-]+\/[\w.-]+)[#\s](\d+)$/);
  if (short) {
    return {
      repo: short[1]!,
      number: Number(short[2]),
      url: `https://github.com/${short[1]}/pull/${short[2]}`,
      title: null,
      state: null,
    };
  }
  return null;
}

const priorityForSeverity = (severity: Finding["severity"]): Priority =>
  severity === "high" ? "p0" : severity === "medium" ? "p1" : "p2";

export function formatFindingsMessage(findings: Finding[], note: string): string {
  const order = (f: Finding) => PRIORITIES.indexOf(f.priority);
  const sorted = [...findings].sort((a, b) => order(a) - order(b));
  const lines = [
    `Code review: please address these ${sorted.length} accepted finding(s) in priority order (p0 first). For each one, explain what you changed or why you disagree.`,
  ];
  if (note.trim() !== "") lines.push("", note.trim());
  for (const f of sorted) {
    const where = f.line === null ? f.file : `${f.file}:${f.line}`;
    lines.push("", `### [${f.priority}] ${f.title}`, `File: ${where}`, "", f.edited ?? f.body);
    if (f.suggestion !== null && f.edited === null) lines.push("", "Suggestion:", f.suggestion);
  }
  return lines.join("\n");
}

export function formatCommentsMessage(comments: Comment[], note: string): string {
  const lines = [
    `Code review comments (${comments.length}). Please make these changes, or tell me why not, one by one.`,
  ];
  if (note.trim() !== "") lines.push("", note.trim());
  const byFile = new Map<string, Comment[]>();
  for (const c of comments) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  for (const [path, list] of byFile) {
    lines.push("", `### ${path}`);
    for (const c of list.sort((a, b) => a.line - b.line)) {
      const side = c.side === "old" ? " (removed line)" : "";
      const source = c.source === "pr" ? " [PR diff]" : "";
      lines.push("", `- Line ${c.line}${side}${source}: ${c.body}`);
    }
  }
  return lines.join("\n");
}

// ---- plugin --------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    githubToken: {
      type: "string",
      label: "GitHub token",
      description:
        "Token with read access to pull requests and repository contents. Leave empty to use the gh CLI's login instead.",
      secret: true,
    },
    reviewInstructions: {
      type: "string",
      label: "Standing review instructions",
      description: "Appended to every review round, e.g. house style or things to always check.",
      experimental_multiline: true,
      default: "",
    },
  });

  // ---- storage ----
  const key = {
    comments: (threadId: string) => `comments:${threadId}`,
    review: (threadId: string) => `review:${threadId}`,
    walkthrough: (id: string) => `walkthrough:${id}`,
  };
  const readComments = async (threadId: string): Promise<Comment[]> => {
    const raw = (await bb.storage.kv.get<unknown>(key.comments(threadId))) ?? [];
    const parsed = z.array(commentSchema).safeParse(raw);
    return parsed.success ? parsed.data : [];
  };
  const readReview = async (threadId: string): Promise<ReviewState> => {
    const raw = await bb.storage.kv.get<unknown>(key.review(threadId));
    const parsed = reviewStateSchema.safeParse(raw);
    return parsed.success ? parsed.data : emptyReview();
  };
  // One queue per thread so tool reports and UI edits never clobber each other.
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
  function mutateComments<T>(threadId: string, fn: (comments: Comment[]) => T | Promise<T>): Promise<T> {
    const qk = key.comments(threadId);
    const prev = queues.get(qk) ?? Promise.resolve();
    const next = prev.then(async () => {
      const comments = await readComments(threadId);
      const result = await fn(comments);
      await bb.storage.kv.set(qk, comments);
      bb.realtime.publish(CHANGED, { threadId, kind: "comments" });
      return result;
    });
    queues.set(qk, next.catch(() => undefined));
    return next;
  }

  // ---- GitHub ----
  async function githubToken(): Promise<string> {
    const { githubToken: configured } = await settings.get();
    if (typeof configured === "string" && configured !== "") return configured;
    try {
      const token = (await run("gh", ["auth", "token"])).trim();
      if (token !== "") return token;
    } catch {
      // fall through
    }
    throw new Error("No GitHub token: set one in plugin settings or run `gh auth login`.");
  }
  async function github<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const token = await githubToken();
    const response = await fetch(`https://api.github.com${path}`, {
      signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "bb-plugin-code-review",
      },
    });
    if (!response.ok) throw new Error(`GitHub ${path} failed: HTTP ${response.status}`);
    return schema.parse(await response.json());
  }
  const prResponse = z.object({
    title: z.string(),
    state: z.string(),
    html_url: z.string(),
    merged: z.boolean().optional(),
    head: z.object({ sha: z.string() }),
    base: z.object({ sha: z.string() }),
  });
  const prFilesResponse = z.array(
    z.object({
      filename: z.string(),
      previous_filename: z.string().optional(),
      status: z.string(),
      additions: z.number(),
      deletions: z.number(),
      patch: z.string().optional(),
    }),
  );
  const contentsResponse = z.object({
    encoding: z.string().optional(),
    content: z.string().optional(),
  });

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
    let pr: PrRef | null = null;
    if (environment !== null) {
      try {
        const result = await bb.sdk.environments.pullRequest({ environmentId: environment.id });
        if (result.outcome === "available") {
          const parsed = parsePrRef(result.pullRequest.url);
          if (parsed !== null) {
            pr = { ...parsed, title: result.pullRequest.title, state: result.pullRequest.state };
          }
        }
      } catch {
        pr = null;
      }
    }
    if (pr === null) {
      // A review thread opened on a PR card: the kanban plugin stores the PR
      // reference in its namespace when it starts the thread.
      try {
        const meta = await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: KANBAN_PLUGIN_ID });
        if (typeof meta.prUrl === "string") pr = parsePrRef(meta.prUrl);
      } catch {
        // no kanban metadata
      }
    }
    let kanban: { cardId: string; phase: string | null } | null = null;
    try {
      const meta = await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: KANBAN_PLUGIN_ID });
      if (typeof meta.cardId === "string") {
        kanban = { cardId: meta.cardId, phase: typeof meta.phase === "string" ? meta.phase : null };
      }
    } catch {
      kanban = null;
    }
    const primaryHostId = (await bb.sdk.system.config()).primaryHostId;
    const localWorkspace =
      environment !== null &&
      environment.path !== null &&
      environment.isGitRepo &&
      environment.hostId === primaryHostId;
    return { thread, environment, pr, kanban, localWorkspace };
  }

  // ---- review worker ----
  async function startReview(
    threadId: string,
    source: "auto" | "workspace" | "pr",
    instructions: string,
  ): Promise<{ started: boolean; reviewThreadId: string | null }> {
    // Claim the round under the queue first so overlapping calls (the panel
    // button and the kanban phase handoff) cannot both spawn a worker.
    const claim = await mutateReview(threadId, (state) => {
      if (state.status === "running") {
        return { claimed: false as const, reviewThreadId: state.reviewThreadId, round: state.round };
      }
      state.round += 1;
      state.status = "running";
      state.reviewThreadId = null;
      state.startedAt = now();
      state.finishedAt = null;
      state.error = null;
      // Findings from earlier rounds that were sent stay for the record; the
      // rest are cleared so the new round starts clean.
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

    let worker: Awaited<ReturnType<typeof bb.sdk.threads.spawn>>;
    try {
      const { thread, environment, pr } = await threadContext(threadId);
      const hasGit = environment !== null && environment.isGitRepo;
      if (source === "pr" && pr === null) throw new Error("This thread has no pull request to review.");
      if (source === "workspace" && !hasGit) throw new Error("This thread has no git workspace to review.");
      const usePr = pr !== null && (source === "pr" || (source === "auto" && !hasGit));
      if (!usePr && !hasGit) {
        throw new Error("This thread has no git workspace and no pull request to review.");
      }
      const { reviewInstructions } = await settings.get();
      const scope =
        usePr && pr !== null
          ? `Review pull request ${pr.repo}#${pr.number} (${pr.url}). Fetch its diff with \`gh pr diff ${pr.number} --repo ${pr.repo}\` and read surrounding code as needed.`
          : `Review the changes in this workspace. Run \`git status\` and \`git diff ${environment?.mergeBaseBranch ?? "HEAD"}\` (and \`git diff\` for uncommitted work) to see everything that changed relative to the base branch. Read surrounding code as needed.`;
      const prompt = [
        "You are a code reviewer. Do not modify any files.",
        scope,
        "Look for correctness bugs, missing error handling, security issues, race conditions, API misuse, and tests that no longer cover the change. Skip style nits unless they hide a bug.",
        "Report every finding with the code_review_report_findings tool: one call, all findings, each with file, line, severity (high, medium, low), a short title, a body that explains the problem concretely, and a suggestion when you have one. Report at most 25 findings; prefer fewer, higher-confidence ones.",
        "If you find nothing, call the tool with an empty list. After the tool call, reply with one line summarizing the round and stop.",
        instructions.trim() === "" ? null : `Additional instructions from the user:\n${instructions.trim()}`,
        reviewInstructions.trim() === "" ? null : `Standing instructions:\n${reviewInstructions.trim()}`,
      ]
        .filter((part): part is string => part !== null)
        .join("\n\n");

      const spawnBase = {
        projectId: thread.projectId,
        title: `Review round ${round}: ${thread.title ?? threadId}`,
        visibility: "hidden" as const,
        parentThreadId: threadId,
        pluginMetadata: { reviewFor: threadId, round },
      };
      // Environments to try, most faithful first. Some projects refuse to
      // share an environment (the personal project only allows its own
      // workspaces); the worker only reads, so a different environment pointed
      // at the workspace path is an acceptable fallback.
      type EnvChoice = Parameters<typeof bb.sdk.threads.spawn>[0]["environment"];
      const pathHint =
        environment?.path == null
          ? ""
          : `\n\nThe workspace to review is the directory ${JSON.stringify(environment.path)} on this machine. Run every git and file command inside that directory (cd there or use git -C).`;
      const candidates: Array<{ environment: EnvChoice; prompt: string }> = [];
      if (environment !== null) {
        candidates.push({ environment: { type: "reuse", environmentId: environment.id }, prompt });
      }
      candidates.push({ environment: { type: "project-default" }, prompt: `${prompt}${pathHint}` });
      candidates.push({
        environment: { type: "host", workspace: { type: "personal" } },
        prompt: `${prompt}${pathHint}`,
      });
      // The personal project only accepts reuse of one of its own personal
      // workspaces, so offer the project's ready environments too.
      try {
        const siblings = await bb.sdk.environments.list({ projectId: thread.projectId });
        for (const sibling of siblings) {
          if (sibling.id === environment?.id || sibling.status !== "ready") continue;
          if (sibling.lifecycle.phase !== "active") continue;
          candidates.push({
            environment: { type: "reuse", environmentId: sibling.id },
            prompt: `${prompt}${pathHint}`,
          });
        }
      } catch (cause) {
        bb.log.warn(`could not list environments: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      let spawned: Awaited<ReturnType<typeof bb.sdk.threads.spawn>> | null = null;
      let lastError: unknown = null;
      for (const candidate of candidates) {
        try {
          spawned = await bb.sdk.threads.spawn({ ...spawnBase, ...candidate });
          break;
        } catch (cause) {
          lastError = cause;
          bb.log.warn(
            `spawn with ${JSON.stringify(candidate.environment)} refused: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
      if (spawned === null) throw lastError instanceof Error ? lastError : new Error(String(lastError));
      worker = spawned;
    } catch (cause) {
      await fail(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
    await mutateReview(threadId, (state) => {
      if (state.round === round) state.reviewThreadId = worker.id;
    });

    void (async () => {
      // Poll until the worker is idle or has failed; `wait` only matches one
      // status, and a failed worker must not hang the round.
      const deadline = Date.now() + REVIEW_TIMEOUT_MS;
      let error: string | null = null;
      try {
        for (;;) {
          const current = await bb.sdk.threads.get({ threadId: worker.id });
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
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        try {
          await bb.sdk.threads.archive({ threadId: worker.id });
          await bb.sdk.threads.stop({ threadId: worker.id });
        } catch (cause) {
          bb.log.warn(`review worker cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      await mutateReview(threadId, (state) => {
        if (state.reviewThreadId !== worker.id) return;
        state.status = error === null ? "ready" : "failed";
        state.error = error;
        state.finishedAt = now();
      });
    })();
    return { started: true, reviewThreadId: worker.id };
  }

  // ---- RPC ----
  bb.rpc.register(rpcContract, {
    context_get: async ({ threadId }) => {
      const { environment, pr, kanban, localWorkspace } = await threadContext(threadId);
      return {
        environmentId: environment?.id ?? null,
        isGit: environment?.isGitRepo ?? false,
        mergeBaseBranch: environment?.mergeBaseBranch ?? environment?.baseBranch ?? null,
        workspacePath: environment?.path ?? null,
        definitionsAvailable: localWorkspace,
        pr,
        kanban,
      };
    },
    pr_files: async ({ repo, number }) => {
      const pr = await github(`/repos/${repo}/pulls/${number}`, prResponse);
      const files: PrFile[] = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await github(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, prFilesResponse);
        for (const f of batch) {
          files.push({
            path: f.filename,
            previousPath: f.previous_filename ?? null,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch ?? null,
          });
        }
        if (batch.length < 100) break;
      }
      return {
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        title: pr.title,
        state: pr.merged === true ? "merged" : pr.state,
        files,
      };
    },
    pr_file: async ({ repo, ref, path }) => {
      try {
        const result = await github(
          `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
          contentsResponse,
        );
        if (result.encoding !== "base64" || result.content === undefined) return { content: null };
        return { content: Buffer.from(result.content, "base64").toString("utf8") };
      } catch {
        return { content: null };
      }
    },
    pr_parse: ({ text }) => parsePrRef(text),
    definition_find: async ({ threadId, symbol }) => {
      const { environment, localWorkspace } = await threadContext(threadId);
      if (!localWorkspace || environment === null || environment.path === null) {
        return {
          environmentId: environment?.id ?? null,
          results: [],
          note: "Definition search needs a git workspace on this machine.",
        };
      }
      if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) {
        return { environmentId: environment.id, results: [], note: "Select a single identifier." };
      }
      // Definition-shaped lines first (declarations), then any other reference.
      const sym = symbol.replaceAll("$", "\\$");
      const decl = `(func|def|class|type|interface|struct|enum|const|let|var|fn|pub fn|function|export (default )?(function|const|class|type|interface|async function))\\s+(\\([^)]*\\)\\s*)?${sym}\\b|\\b${sym}\\s*(:=|=|:)\\s*(func|async|\\(|function|class|=>|struct|interface)`;
      const out = await run("git", ["grep", "-n", "-I", "-E", "--", decl], environment.path);
      let results = out
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => {
          const m = l.match(/^(.*?):(\d+):(.*)$/);
          return m ? { path: m[1]!, line: Number(m[2]), text: m[3]!.trim().slice(0, 200) } : null;
        })
        .filter((r): r is { path: string; line: number; text: string } => r !== null)
        .slice(0, 25);
      let note: string | null = null;
      if (results.length === 0) {
        const any = await run("git", ["grep", "-n", "-I", "-w", "--", symbol], environment.path);
        results = any
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => {
            const m = l.match(/^(.*?):(\d+):(.*)$/);
            return m ? { path: m[1]!, line: Number(m[2]), text: m[3]!.trim().slice(0, 200) } : null;
          })
          .filter((r): r is { path: string; line: number; text: string } => r !== null)
          .slice(0, 25);
        note = results.length === 0 ? "No matches in the workspace." : "No definition found; showing references.";
      }
      return { environmentId: environment.id, results, note };
    },
    comments_list: ({ threadId }) => readComments(threadId),
    comments_add: ({ threadId, ...input }) =>
      mutateComments(threadId, (comments) => {
        const comment: Comment = { id: newId("c"), ...input, status: "draft", createdAt: now() };
        comments.push(comment);
        return comment;
      }),
    comments_update: ({ threadId, id, body }) =>
      mutateComments(threadId, (comments) => {
        const comment = comments.find((c) => c.id === id);
        if (comment === undefined) throw new Error("Comment not found.");
        comment.body = body;
        return comment;
      }),
    comments_remove: ({ threadId, id }) =>
      mutateComments(threadId, (comments) => {
        const index = comments.findIndex((c) => c.id === id);
        if (index !== -1) comments.splice(index, 1);
        return { ok: true as const };
      }),
    comments_send: ({ threadId, note }) =>
      mutateComments(threadId, async (comments) => {
        const drafts = comments.filter((c) => c.status === "draft");
        if (drafts.length === 0) return { sent: 0 };
        await bb.sdk.threads.send({
          threadId,
          mode: "auto",
          input: [{ type: "text", text: formatCommentsMessage(drafts, note), mentions: [] }],
        });
        for (const c of drafts) c.status = "sent";
        return { sent: drafts.length };
      }),
    review_run: ({ threadId, source, instructions }) => startReview(threadId, source, instructions),
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
      const accepted = (await readReview(threadId)).findings.filter((f) => f.status === "accepted");
      if (accepted.length === 0) return { sent: 0 };
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text: formatFindingsMessage(accepted, note), mentions: [] }],
      });
      const ids = new Set(accepted.map((f) => f.id));
      await mutateReview(threadId, (state) => {
        for (const f of state.findings) if (ids.has(f.id)) f.status = "sent";
      });
      return { sent: accepted.length };
    },
    walkthrough_request: async ({ threadId }) => {
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: "Walk me through the changes you made so far. Group the diff into logical change sets (by feature or behavior, not by file), give each a title and a short summary of what it does and why, and list the hunks that belong to it with their unified patch text. Publish it with the code_review_publish_walkthrough tool and put the directive it returns in your reply.",
            mentions: [],
          },
        ],
      });
      return { ok: true as const };
    },
    walkthrough_get: async ({ id }) => {
      if (!/^w_[a-z0-9]+$/.test(id)) return null;
      const raw = await bb.storage.kv.get<unknown>(key.walkthrough(id));
      const parsed = walkthroughSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
  });

  // ---- agent tools ----
  const toolError = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    isError: true,
  });

  /** The thread a worker reports into: its `reviewFor` metadata, else itself. */
  async function reportTarget(threadId: string): Promise<{ target: string; round: number | null }> {
    const meta = await bb.sdk.threads.getPluginMetadata({ threadId });
    if (typeof meta.reviewFor === "string") {
      return { target: meta.reviewFor, round: typeof meta.round === "number" ? meta.round : null };
    }
    return { target: threadId, round: null };
  }

  bb.agents.registerTool({
    name: "code_review_report_findings",
    description:
      "Report code review findings to the Code review panel, where the user accepts, skips, and prioritizes them before they are acted on. Call once with every finding; an empty list means the review found nothing.",
    presentation: {
      label: { pending: "Reporting review findings", completed: "Reported review findings" },
    },
    parameters: z.object({
      findings: z.array(findingInputSchema).max(MAX_FINDINGS),
    }),
    async execute({ findings }, { threadId }) {
      try {
        const { target, round } = await reportTarget(threadId);
        const count = await mutateReview(target, (state) => {
          const thisRound = round ?? (state.status === "running" ? state.round : state.round + 1);
          if (round === null && state.status !== "running") {
            // A thread reviewing itself: open a round so the panel shows it.
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
            });
          }
          return state.findings.filter((f) => f.round === thisRound).length;
        });
        return `Reported ${findings.length} finding(s); ${count} now await the user's triage in the Code review panel.`;
      } catch (cause) {
        return toolError(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "code_review_publish_walkthrough",
    description:
      "Publish a narrated walkthrough of a change: logical groups of hunks with a title and summary each. Returns a directive to paste into your reply so the chat renders the walkthrough.",
    presentation: {
      label: { pending: "Publishing walkthrough", completed: "Published walkthrough" },
    },
    parameters: z.object({
      title: z.string().min(1).max(200),
      groups: z.array(walkthroughGroupSchema).min(1).max(MAX_WALKTHROUGH_GROUPS),
    }),
    async execute({ title, groups }, { threadId }) {
      try {
        const walkthrough: Walkthrough = { id: newId("w"), threadId, title, createdAt: now(), groups };
        await bb.storage.kv.set(key.walkthrough(walkthrough.id), walkthrough);
        return `Published. Put this line on its own paragraph in your reply so it renders:\n\n::code-review-walkthrough{id="${walkthrough.id}"}`;
      } catch (cause) {
        return toolError(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

  bb.agents.configure((context) => {
    const { reviewFor } = context.pluginMetadata;
    if (typeof reviewFor === "string") {
      return {
        tools: ["code_review_report_findings"],
        skills: [],
        instructions:
          "You are a read-only review worker. Report findings only with code_review_report_findings; never edit files, commit, or move Kanban cards.",
      };
    }
    return {
      tools: ["code_review_report_findings", "code_review_publish_walkthrough"],
      skills: ["code-review"],
    };
  });

  // ---- CLI ----
  const cliError = (cause: unknown) =>
    new PluginCliError(cause instanceof Error ? cause.message : String(cause));
  const needThread = (threadId: string | undefined): string => {
    if (threadId === undefined) {
      throw new PluginCliError("no thread in context", { hint: "Pass --thread <id>." });
    }
    return threadId;
  };
  const findingLine = (f: Finding) =>
    `${f.status.padEnd(8)} ${f.priority} ${f.id.padEnd(16)} ${f.file}${f.line === null ? "" : `:${f.line}`}  ${f.title}`;

  bb.cli.register(
    defineCli({
      name: "code-review",
      summary: "Run review rounds and manage findings and comments for a thread",
      commands: {
        run: cliCommand({
          summary: "Start a review round on a thread's changes (hidden worker thread)",
          options: {
            thread: { type: "string", description: "Thread id; defaults to this thread" },
            source: {
              type: "enum",
              values: ["auto", "workspace", "pr"],
              default: "auto",
              description: "What to review",
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            try {
              const result = await startReview(
                needThread(input.options.thread ?? ctx.threadId),
                input.options.source,
                "",
              );
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
          summary: "List findings for a thread (max 60)",
          options: {
            thread: { type: "string", description: "Thread id; defaults to this thread" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
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
          options: {
            thread: { type: "string", description: "Thread id; defaults to this thread" },
            priority: { type: "enum", values: [...PRIORITIES], description: "p0 (highest) to p3" },
          },
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
          options: { thread: { type: "string", description: "Thread id; defaults to this thread" } },
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
        comments: cliCommand({
          summary: "List draft and sent inline comments for a thread",
          options: {
            thread: { type: "string", description: "Thread id; defaults to this thread" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const comments = await readComments(needThread(input.options.thread ?? ctx.threadId));
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(comments)
                : comments.length === 0
                  ? "No comments."
                  : comments.map((c) => `${c.status.padEnd(6)} ${c.path}:${c.line}  ${c.body}`).join("\n"),
            };
          },
        }),
      },
    }),
  );

  bb.log.info("loaded");
}
