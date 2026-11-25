// bb-plugin-github-prs — backend.
//
// A GitHub PR review workbench. All GitHub access goes through the `gh` CLI
// (its login), read via GraphQL/REST, written via REST mutations. Plugin-local
// review state (triage, reply drafts, proposed fixes) lives in bb.storage.kv
// keyed per PR. Reply drafts and fix patches are produced by hidden worker
// threads (same pattern as the rfcs plugin): the worker reads the local
// checkout and publishes its result with a plugin tool; the panel shows it.
import { execFile } from "node:child_process";
import { readdir, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defineRpcContract, defineCli, cliCommand, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CHANGED,
  REACTIONS,
  SEVERITIES,
  PRIORITIES,
  CONFIDENCES,
  emptyItem,
  emptyReview,
  emptyWalkthrough,
  workerModelSchema,
  type RunModel,
  type WorkerModel,
  prRefSchema,
  prKey,
  prSummarySchema,
  prDetailSchema,
  itemStateSchema,
  reviewStateSchema,
  walkthroughSchema,
  checkoutSchema,
  type Checkout,
  type ItemState,
  type PrDetail,
  type PrFile,
  type PrRef,
  type PrSummary,
  type ReactionGroup,
  type ReviewState,
  type ReviewThread,
  type Walkthrough,
} from "./shared";

export const rpcContract = defineRpcContract({
  prs_list: {
    input: z.object({ refresh: z.boolean().default(false) }),
    output: z.object({
      prs: z.array(prSummarySchema),
      fetchedAt: z.string(),
      syncing: z.boolean(),
      error: z.string().nullable(),
    }),
  },
  pr_get: { input: prRefSchema, output: z.object({ detail: prDetailSchema, syncing: z.boolean() }) },
  pr_refresh: { input: prRefSchema, output: z.object({ syncing: z.boolean() }) },
  triage_set: {
    input: z.object({ ref: prRefSchema, item: z.string(), triage: z.enum(["pending", "address", "wont-fix", "done"]) }),
    output: itemStateSchema,
  },
  draft_start: {
    input: z.object({ ref: prRefSchema, item: z.string(), guidance: z.string().max(4000).default("") }),
    output: itemStateSchema,
  },
  draft_save: {
    input: z.object({ ref: prRefSchema, item: z.string(), text: z.string().max(60_000) }),
    output: itemStateSchema,
  },
  reply_post: {
    input: z.object({
      ref: prRefSchema,
      item: z.string(),
      body: z.string().min(1).max(60_000),
      /** REST id of the review comment to reply to; null posts an issue comment. */
      replyTo: z.number().nullable(),
      resolve: z.string().nullable().default(null),
    }),
    output: z.object({ url: z.string() }),
  },
  react: {
    input: z.object({
      ref: prRefSchema,
      commentId: z.number(),
      kind: z.enum(["review", "issue"]),
      content: z.enum(REACTIONS),
      on: z.boolean(),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  thread_resolve: {
    input: z.object({ ref: prRefSchema, threadId: z.string(), resolved: z.boolean() }),
    output: z.object({ ok: z.literal(true) }),
  },
  fix_start: {
    input: z.object({ ref: prRefSchema, item: z.string(), guidance: z.string().max(4000).default("") }),
    output: itemStateSchema,
  },
  discuss_open: {
    input: z.object({ ref: prRefSchema, item: z.string() }),
    output: z.object({ threadId: z.string() }),
  },
  review_start: {
    input: z.object({ ref: prRefSchema, guidance: z.string().max(4000).default("") }),
    output: reviewStateSchema,
  },
  finding_set: {
    input: z.object({ ref: prRefSchema, findingId: z.string(), status: z.enum(["open", "dismissed"]) }),
    output: reviewStateSchema,
  },
  finding_post: {
    input: z.object({ ref: prRefSchema, findingId: z.string(), body: z.string().min(1).max(60_000) }),
    output: z.object({ url: z.string() }),
  },
  walkthrough_start: { input: prRefSchema, output: walkthroughSchema },
  file_at_head: {
    input: z.object({ ref: prRefSchema, path: z.string().min(1) }),
    output: z.object({ content: z.string().nullable(), error: z.string().nullable() }),
  },
  model_get: {
    input: z.null(),
    output: z.object({ selection: workerModelSchema.nullable(), fallback: workerModelSchema.nullable() }),
  },
  model_set: { input: z.object({ selection: workerModelSchema.nullable() }), output: z.object({ ok: z.literal(true) }) },
  fix_apply: {
    input: z.object({ ref: prRefSchema, item: z.string() }),
    output: z.object({ applied: z.boolean(), detail: z.string() }),
  },
  fix_discard: {
    input: z.object({ ref: prRefSchema, item: z.string() }),
    output: itemStateSchema,
  },
  checkout_get: { input: prRefSchema, output: checkoutSchema.nullable() },
});

const LIST_KEY = "prlist";
const LIST_TTL_MS = 60_000;
const stateKey = (ref: PrRef) => `state:${prKey(ref)}`;

interface PrState {
  items: Record<string, ItemState>;
  review?: ReviewState;
  walkthrough?: Walkthrough;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() !== "" ? stderr.trim() : error.message));
      else resolve(stdout);
    });
  });
}
const gh = (args: string[]) => run("gh", args);
const git = (cwd: string, args: string[]) => run("git", ["-C", cwd, ...args]);

// ---- GraphQL shapes ----

const gqlReactionGroups = z.array(
  z.object({
    content: z.string(),
    viewerHasReacted: z.boolean(),
    reactors: z.object({ totalCount: z.number() }),
  }),
);

const GQL_TO_REST: Record<string, (typeof REACTIONS)[number]> = {
  THUMBS_UP: "+1",
  THUMBS_DOWN: "-1",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

function reactions(groups: z.infer<typeof gqlReactionGroups>): ReactionGroup[] {
  return groups
    .map((g) => ({ content: GQL_TO_REST[g.content], count: g.reactors.totalCount, viewerReacted: g.viewerHasReacted }))
    .filter((g): g is ReactionGroup => g.content !== undefined && g.count > 0);
}

const author = z.object({ login: z.string() }).nullable();
const login = (a: z.infer<typeof author>) => a?.login ?? "ghost";

const searchNode = z.object({
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
  repository: z.object({ nameWithOwner: z.string() }),
  commits: z.object({
    nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })),
  }),
  reviewThreads: z.object({ nodes: z.array(z.object({ isResolved: z.boolean() })) }),
  comments: z.object({ totalCount: z.number() }),
});

const SEARCH_QUERY = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number title url isDraft updatedAt createdAt headRefName baseRefName
        additions deletions changedFiles reviewDecision
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        reviewThreads(first: 100) { nodes { isResolved } }
        comments { totalCount }
      }
    }
  }
}`;

const detailNode = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  createdAt: z.string(),
  author,
  headRefName: z.string(),
  baseRefName: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  reviewDecision: z.string().nullable(),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: z
            .object({
              state: z.string(),
              contexts: z.object({
                nodes: z.array(
                  z.union([
                    z.object({
                      __typename: z.literal("CheckRun"),
                      name: z.string(),
                      status: z.string(),
                      conclusion: z.string().nullable(),
                      detailsUrl: z.string().nullable(),
                    }),
                    z.object({
                      __typename: z.literal("StatusContext"),
                      context: z.string(),
                      state: z.string(),
                      targetUrl: z.string().nullable(),
                    }),
                    z.object({}).passthrough(),
                  ]),
                ),
              }),
            })
            .nullable(),
        }),
      }),
    ),
  }),
  reviews: z.object({
    nodes: z.array(
      z.object({
        author,
        state: z.string(),
        body: z.string(),
        submittedAt: z.string().nullable(),
        url: z.string(),
      }),
    ),
  }),
  comments: z.object({
    nodes: z.array(
      z.object({
        databaseId: z.number().nullable(),
        author,
        body: z.string(),
        createdAt: z.string(),
        url: z.string(),
        reactionGroups: gqlReactionGroups,
      }),
    ),
  }),
  reviewThreads: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        isResolved: z.boolean(),
        isOutdated: z.boolean(),
        path: z.string(),
        line: z.number().nullable(),
        comments: z.object({
          nodes: z.array(
            z.object({
              databaseId: z.number().nullable(),
              author,
              body: z.string(),
              createdAt: z.string(),
              url: z.string(),
              diffHunk: z.string(),
              reactionGroups: gqlReactionGroups,
            }),
          ),
        }),
      }),
    ),
  }),
});

const DETAIL_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title body url state isDraft updatedAt createdAt author { login }
      headRefName baseRefName additions deletions changedFiles reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } } }
      reviews(first: 50) { nodes { author { login } state body submittedAt url } }
      comments(first: 100) { nodes { databaseId author { login } body createdAt url
        reactionGroups { content viewerHasReacted reactors { totalCount } } } }
      reviewThreads(first: 100) { nodes { id isResolved isOutdated path line
        comments(first: 50) { nodes { databaseId author { login } body createdAt url diffHunk
          reactionGroups { content viewerHasReacted reactors { totalCount } } } } } }
    }
  }
}`;

const restFiles = z.array(
  z.object({
    filename: z.string(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string().optional(),
  }),
);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    searchQuery: {
      type: "string",
      label: "PR search query",
      description: "GitHub search query for the PR list.",
      default: "is:open is:pr author:@me archived:false",
    },
    reposDir: {
      type: "string",
      label: "Repos directory",
      description: "Directory whose immediate subdirectories are your local checkouts (matched by origin URL).",
      default: `${process.env.HOME ?? "~"}/repos`,
    },
    replyVoice: {
      type: "string",
      label: "Reply drafting guidance",
      description: "Standing guidance for AI-drafted replies (tone, conventions).",
      default:
        "Direct and specific, one to four sentences, no preamble, no flattery. Technical terms spelled out. Past tense: describe what was done to address the comment (or why it was kept as-is), never promised future work.",
    },
    reviewQuery: {
      type: "string",
      label: "Review-requested search query",
      description:
        "GitHub search query for PRs that need your review (empty disables the section). user-review-requested matches only you personally, not teams you are in.",
      default: "is:open is:pr user-review-requested:@me archived:false",
    },
    reviewInstructions: {
      type: "string",
      label: "Review instructions",
      description: "Standing guidance for plugin-run review rounds (what to look for, team conventions).",
      default: "",
    },
  });

  // ---- local state ----
  async function readState(ref: PrRef): Promise<PrState> {
    return (await bb.storage.kv.get<PrState>(stateKey(ref))) ?? { items: {} };
  }
  async function mutateItem(ref: PrRef, item: string, fn: (it: ItemState) => void): Promise<ItemState> {
    const state = await readState(ref);
    const it = state.items[item] ?? emptyItem();
    fn(it);
    state.items[item] = it;
    await bb.storage.kv.set(stateKey(ref), state);
    bb.realtime.publish(CHANGED, { key: prKey(ref), kind: "state" });
    return it;
  }
  async function mutateReview<T>(ref: PrRef, fn: (review: ReviewState) => T): Promise<T> {
    const state = await readState(ref);
    const review = state.review ?? emptyReview();
    const result = fn(review);
    state.review = review;
    await bb.storage.kv.set(stateKey(ref), state);
    bb.realtime.publish(CHANGED, { key: prKey(ref), kind: "state" });
    return result;
  }
  async function mutateWalkthrough<T>(ref: PrRef, fn: (w: Walkthrough) => T): Promise<T> {
    const state = await readState(ref);
    const walkthrough = state.walkthrough ?? emptyWalkthrough();
    const result = fn(walkthrough);
    state.walkthrough = walkthrough;
    await bb.storage.kv.set(stateKey(ref), state);
    bb.realtime.publish(CHANGED, { key: prKey(ref), kind: "state" });
    return result;
  }

  // ---- checkout resolution ----
  let checkoutCache: { at: number; map: Map<string, string> } | null = null;
  async function checkoutMap(): Promise<Map<string, string>> {
    if (checkoutCache !== null && Date.now() - checkoutCache.at < 10 * 60_000) return checkoutCache.map;
    const { reposDir } = await settings.get();
    const map = new Map<string, string>();
    let entries: string[] = [];
    try {
      entries = (await readdir(reposDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (cause) {
      bb.log.warn(`cannot read reposDir ${reposDir}: ${describe(cause)}`);
    }
    await Promise.all(
      entries.map(async (name) => {
        const dir = join(reposDir, name);
        try {
          const origin = (await git(dir, ["remote", "get-url", "origin"])).trim();
          const m = origin.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
          if (m) map.set(`${m[1]}/${m[2]}`.toLowerCase(), dir);
        } catch {
          /* not a git repo or no origin */
        }
      }),
    );
    checkoutCache = { at: Date.now(), map };
    return map;
  }
  async function checkoutFor(ref: PrRef, headRefName: string | null): Promise<Checkout | null> {
    const dir = (await checkoutMap()).get(`${ref.owner}/${ref.repo}`.toLowerCase());
    if (dir === undefined) return null;
    let branch: string | null = null;
    let dirty = false;
    try {
      branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      dirty = (await git(dir, ["status", "--porcelain"])).trim() !== "";
    } catch {
      /* leave nulls */
    }
    return { path: dir, branch, dirty, onPrBranch: headRefName !== null && branch === headRefName };
  }

  // ---- GitHub reads ----
  async function graphql(query: string, vars: Record<string, string | number>): Promise<unknown> {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(vars)) {
      args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
    }
    return JSON.parse(await gh(args));
  }

  async function searchPrs(query: string, role: "author" | "reviewer"): Promise<PrSummary[]> {
    const data = await graphql(SEARCH_QUERY, { q: query });
    const nodes = z
      .object({ data: z.object({ search: z.object({ nodes: z.array(z.unknown()) }) }) })
      .parse(data).data.search.nodes;
    const prs: PrSummary[] = [];
    for (const raw of nodes) {
      const parsed = searchNode.safeParse(raw);
      if (!parsed.success) continue;
      const n = parsed.data;
      const [owner, repo] = n.repository.nameWithOwner.split("/");
      prs.push({
        owner,
        repo,
        number: n.number,
        role,
        title: n.title,
        url: n.url,
        isDraft: n.isDraft,
        updatedAt: n.updatedAt,
        createdAt: n.createdAt,
        headRefName: n.headRefName,
        baseRefName: n.baseRefName,
        additions: n.additions,
        deletions: n.deletions,
        changedFiles: n.changedFiles,
        reviewDecision: n.reviewDecision,
        checksState: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
        unresolvedThreads: n.reviewThreads.nodes.filter((t) => !t.isResolved).length,
        commentCount: n.comments.totalCount,
      });
    }
    prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return prs;
  }

  async function fetchList(): Promise<PrSummary[]> {
    const { searchQuery, reviewQuery } = await settings.get();
    const [mine, toReview] = await Promise.all([
      searchPrs(searchQuery, "author"),
      reviewQuery.trim() === "" ? Promise.resolve([]) : searchPrs(reviewQuery, "reviewer"),
    ]);
    const seen = new Set(mine.map((p) => prKey(p)));
    return [...mine, ...toReview.filter((p) => !seen.has(prKey(p)))];
  }

  // ---- stale-while-revalidate: cached data is returned instantly; GitHub
  // fetches run in the background and announce themselves over realtime.
  const syncing = new Set<string>(); // "list" or a PR key

  function startListSync(): void {
    if (syncing.has("list")) return;
    syncing.add("list");
    void (async () => {
      try {
        const prs = await fetchList();
        await bb.storage.kv.set(LIST_KEY, { prs, fetchedAt: new Date().toISOString() });
        syncing.delete("list");
        bb.realtime.publish(CHANGED, { kind: "list" });
        pruneDetails(prs);
        prefetchDetails(prs);
      } catch (cause) {
        syncing.delete("list");
        bb.realtime.publish(CHANGED, { kind: "list-error", message: describe(cause) });
      }
    })();
  }

  async function listPrs(refresh: boolean) {
    const cached = (await bb.storage.kv.get<{ prs: PrSummary[]; fetchedAt: string }>(LIST_KEY)) ?? null;
    if (cached === null) {
      const prs = await fetchList();
      const result = { prs, fetchedAt: new Date().toISOString() };
      await bb.storage.kv.set(LIST_KEY, result);
      prefetchDetails(prs);
      return { ...result, syncing: false, error: null };
    }
    if (refresh || Date.now() - Date.parse(cached.fetchedAt) >= LIST_TTL_MS) startListSync();
    return { ...cached, syncing: syncing.has("list"), error: null };
  }

  async function fetchDetail(ref: PrRef): Promise<PrDetail> {
    const [gql, filesRaw] = await Promise.all([
      graphql(DETAIL_QUERY, { owner: ref.owner, repo: ref.repo, number: ref.number }),
      gh(["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files`, "--paginate"]),
    ]);
    const pr = z
      .object({ data: z.object({ repository: z.object({ pullRequest: detailNode }) }) })
      .parse(gql).data.repository.pullRequest;
    // --paginate concatenates JSON arrays: "][", normalize before parsing.
    const files: PrFile[] = restFiles
      .parse(JSON.parse(filesRaw.replace(/\]\s*\[/g, ","))) // one array
      .map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
      }));
    const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup ?? null;
    const checks =
      rollup?.contexts.nodes.flatMap((c) => {
        if ("name" in c && typeof c.name === "string") {
          const cr = c as { name: string; status: string; conclusion: string | null; detailsUrl: string | null };
          return [{ name: cr.name, status: cr.conclusion ?? cr.status, url: cr.detailsUrl }];
        }
        if ("context" in c && typeof c.context === "string") {
          const sc = c as { context: string; state: string; targetUrl: string | null };
          return [{ name: sc.context, status: sc.state, url: sc.targetUrl }];
        }
        return [];
      }) ?? [];
    const threads: ReviewThread[] = pr.reviewThreads.nodes.map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      line: t.line,
      diffHunk: t.comments.nodes[0]?.diffHunk ?? "",
      comments: t.comments.nodes.map((c) => ({
        id: c.databaseId ?? 0,
        author: login(c.author),
        body: c.body,
        createdAt: c.createdAt,
        url: c.url,
        reactions: reactions(c.reactionGroups),
      })),
    }));
    const state = await readState(ref);
    const checkout = await checkoutFor(ref, pr.headRefName);
    const listed = (await bb.storage.kv.get<{ prs: PrSummary[] }>(LIST_KEY))?.prs.find(
      (p) => prKey(p) === prKey(ref),
    );
    return {
      summary: {
        owner: ref.owner,
        repo: ref.repo,
        number: pr.number,
        role: listed?.role ?? "author",
        title: pr.title,
        url: pr.url,
        isDraft: pr.isDraft,
        updatedAt: pr.updatedAt,
        createdAt: pr.createdAt,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        reviewDecision: pr.reviewDecision,
        checksState: rollup?.state ?? null,
        unresolvedThreads: threads.filter((t) => !t.isResolved).length,
        commentCount: pr.comments.nodes.length,
      },
      body: pr.body,
      author: login(pr.author),
      state: pr.state,
      checks,
      files,
      threads,
      issueComments: pr.comments.nodes.map((c) => ({
        id: c.databaseId ?? 0,
        author: login(c.author),
        body: c.body,
        createdAt: c.createdAt,
        url: c.url,
        reactions: reactions(c.reactionGroups),
      })),
      reviews: pr.reviews.nodes
        .filter((r) => !(r.state === "COMMENTED" && r.body === ""))
        .map((r) => ({ author: login(r.author), state: r.state, body: r.body, submittedAt: r.submittedAt, url: r.url })),
      items: state.items,
      review: state.review ?? emptyReview(),
      walkthrough: state.walkthrough ?? emptyWalkthrough(),
      checkout,
      fetchedAt: new Date().toISOString(),
    };
  }

  // Details are cached in memory and persisted in the plugin database
  // (patches are too big for kv's 256KB cap), so they survive reloads and a
  // previously opened PR renders instantly.
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS pr_details (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL)`,
  ]);
  const detailCache = new Map<string, PrDetail>();
  const DETAIL_TTL_MS = 60_000;

  function readCachedDetail(key: string): PrDetail | undefined {
    const hit = detailCache.get(key);
    if (hit !== undefined) return hit;
    try {
      const row = db.prepare("SELECT json FROM pr_details WHERE key = ?").get(key) as { json: string } | undefined;
      if (row === undefined) return undefined;
      const parsed = prDetailSchema.safeParse(JSON.parse(row.json));
      if (!parsed.success) return undefined;
      detailCache.set(key, parsed.data);
      return parsed.data;
    } catch (cause) {
      bb.log.warn(`detail cache read ${key}: ${describe(cause)}`);
      return undefined;
    }
  }

  function writeCachedDetail(key: string, detail: PrDetail): void {
    detailCache.set(key, detail);
    try {
      db.prepare("INSERT OR REPLACE INTO pr_details (key, json, fetched_at) VALUES (?, ?, ?)").run(
        key,
        JSON.stringify(detail),
        detail.fetchedAt,
      );
    } catch (cause) {
      bb.log.warn(`detail cache write ${key}: ${describe(cause)}`);
    }
  }

  function startDetailSync(ref: PrRef): void {
    const key = prKey(ref);
    if (syncing.has(key)) return;
    syncing.add(key);
    void (async () => {
      try {
        const detail = await fetchDetail(ref);
        writeCachedDetail(key, detail);
        syncing.delete(key);
        bb.realtime.publish(CHANGED, { key, kind: "detail" });
      } catch (cause) {
        syncing.delete(key);
        bb.realtime.publish(CHANGED, { key, kind: "error", message: describe(cause) });
      }
    })();
  }

  /** Runs started before models were recorded: resolve once from their worker threads. */
  async function backfillRunModels(ref: PrRef): Promise<void> {
    const state = await readState(ref);
    const r = state.review;
    const w = state.walkthrough;
    if (r !== undefined && (r.model ?? null) === null && r.threadId !== null) {
      const model = await resolveRunModel(r.threadId);
      if (model !== null) await mutateReview(ref, (x) => void (x.model = model));
    }
    if (w !== undefined && (w.model ?? null) === null && w.threadId !== null) {
      const model = await resolveRunModel(w.threadId);
      if (model !== null) await mutateWalkthrough(ref, (x) => void (x.model = model));
    }
  }

  /** Cached detail with current local item state merged in; fetches only when nothing is cached. */
  async function getDetail(ref: PrRef): Promise<PrDetail> {
    const key = prKey(ref);
    await backfillRunModels(ref);
    const cached = readCachedDetail(key);
    if (cached !== undefined) {
      const state = await readState(ref);
      return {
        ...cached,
        items: state.items,
        review: state.review ?? emptyReview(),
        walkthrough: state.walkthrough ?? emptyWalkthrough(),
      };
    }
    const detail = await fetchDetail(ref);
    writeCachedDetail(key, detail);
    return detail;
  }

  /** Drop cached details for PRs no longer in the list (merged/closed). */
  function pruneDetails(prs: PrSummary[]): void {
    const keep = new Set(prs.map((p) => prKey(p)));
    try {
      const rows = db.prepare("SELECT key FROM pr_details").all() as Array<{ key: string }>;
      for (const { key } of rows) {
        if (!keep.has(key)) {
          db.prepare("DELETE FROM pr_details WHERE key = ?").run(key);
          detailCache.delete(key);
        }
      }
    } catch (cause) {
      bb.log.warn(`detail cache prune: ${describe(cause)}`);
    }
  }

  /** Warm the detail cache for listed PRs so first click is instant. One at a time. */
  let prefetching = false;
  function prefetchDetails(prs: PrSummary[]): void {
    if (prefetching) return;
    prefetching = true;
    void (async () => {
      try {
        for (const pr of prs) {
          const ref = { owner: pr.owner, repo: pr.repo, number: pr.number };
          const cached = readCachedDetail(prKey(ref));
          // Fresh enough, or cached newer than the PR's last activity: skip.
          if (cached !== undefined && Date.parse(cached.fetchedAt) >= Date.parse(pr.updatedAt)) continue;
          try {
            writeCachedDetail(prKey(ref), await fetchDetail(ref));
            bb.realtime.publish(CHANGED, { key: prKey(ref), kind: "detail" });
          } catch (cause) {
            bb.log.warn(`prefetch ${prKey(ref)}: ${describe(cause)}`);
          }
        }
      } finally {
        prefetching = false;
      }
    })();
  }

  // ---- hidden worker threads (draft replies, proposed fixes) ----
  type EnvChoice = Parameters<typeof bb.sdk.threads.spawn>[0]["environment"];

  const WORKER_MODEL_KEY = "workerModel";
  async function readWorkerModel(): Promise<WorkerModel | null> {
    const raw = (await bb.storage.kv.get<unknown>(WORKER_MODEL_KEY)) ?? null;
    const parsed = workerModelSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /** The provider/model/reasoning a thread actually runs on, as BB resolved it. */
  async function resolveRunModel(threadId: string): Promise<RunModel | null> {
    try {
      const [thread, opts] = await Promise.all([
        bb.sdk.threads.get({ threadId }),
        bb.sdk.threads.defaultExecutionOptions({ threadId }),
      ]);
      if (opts === null) return null;
      return { providerId: thread.providerId, model: opts.model, reasoningLevel: opts.reasoningLevel };
    } catch (cause) {
      bb.log.warn(`resolve model for ${threadId}: ${describe(cause)}`);
      return null;
    }
  }

  /** What a worker would run on with no explicit selection: the first project's defaults. */
  async function fallbackWorkerModel(): Promise<WorkerModel | null> {
    const projects = (await bb.sdk.projects.list({ includePersonal: true }).catch(() => [])) as Array<{ id: string }>;
    for (const p of projects) {
      try {
        const d = await bb.sdk.projects.defaultExecutionOptions({ projectId: p.id });
        if (d !== null) return { providerId: d.providerId, model: d.model, reasoningLevel: d.reasoningLevel, serviceTier: d.serviceTier };
      } catch {
        /* try next */
      }
    }
    return null;
  }

  async function spawnWorker(title: string, prompt: string, metadata: Record<string, string>): Promise<string> {
    // Prefer a project whose checkout contains the repo; fall back to any
    // project / the personal workspace. The prompt always names the absolute
    // repo path, so where the worker runs only affects file access defaults.
    const projects = (await bb.sdk.projects.list({ includePersonal: true }).catch(() => [])) as Array<{
      id: string;
      name?: string;
    }>;
    const candidates: Array<{ projectId: string; environment: EnvChoice }> = [];
    for (const p of projects) {
      candidates.push({ projectId: p.id, environment: { type: "host", workspace: { type: "personal" } } as EnvChoice });
      candidates.push({ projectId: p.id, environment: { type: "project-default" } as EnvChoice });
    }
    let lastError: unknown = new Error("No BB projects available to run a worker thread in.");
    for (const candidate of candidates) {
      try {
        const selection = await readWorkerModel();
        const spawned = await bb.sdk.threads.spawn({
          projectId: candidate.projectId,
          environment: candidate.environment,
          title,
          prompt,
          visibility: "hidden",
          pluginMetadata: metadata,
          ...(selection === null
            ? {}
            : {
                providerId: selection.providerId,
                model: selection.model,
                reasoningLevel: selection.reasoningLevel as never,
                ...(selection.serviceTier === undefined ? {} : { serviceTier: selection.serviceTier }),
              }),
        });
        return spawned.id;
      } catch (cause) {
        lastError = cause;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  function threadContextText(detail: PrDetail, item: string): string {
    if (item.startsWith("f:")) {
      const id = item.slice(2);
      const f = detail.review.findings.find((x) => x.id === id);
      if (f === undefined) throw new Error("Review finding not found on this PR.");
      return [
        `Your own review finding (severity: ${f.severity}) at ${f.path}${f.line === null ? "" : `:${f.line}`}: ${f.title}`,
        f.body,
      ].join("\n\n");
    }
    if (item.startsWith("ic:")) {
      const id = Number(item.slice(3));
      const c = detail.issueComments.find((x) => x.id === id);
      if (c === undefined) throw new Error("Comment not found on this PR.");
      return `Top-level PR comment by ${c.author} (${c.createdAt}):\n${c.body}`;
    }
    const t = detail.threads.find((x) => x.id === item);
    if (t === undefined) throw new Error("Review thread not found on this PR.");
    const chain = t.comments.map((c) => `${c.author} (${c.createdAt}): ${c.body}`).join("\n\n");
    return [
      `Review comment thread on ${t.path}${t.line === null ? "" : ` line ${t.line}`}${t.isOutdated ? " (outdated)" : ""}.`,
      t.diffHunk === "" ? null : `Diff hunk under review:\n\`\`\`\n${t.diffHunk}\n\`\`\``,
      `Thread:\n${chain}`,
    ]
      .filter((x): x is string => x !== null)
      .join("\n\n");
  }

  function prContextText(detail: PrDetail): string {
    const s = detail.summary;
    const checkoutLine =
      detail.checkout === null
        ? "No local checkout was found for this repo; work from the diff context given here and `gh` reads only."
        : `The repo is checked out locally at ${JSON.stringify(detail.checkout.path)} (currently on branch ${detail.checkout.branch ?? "?"}; the PR branch is ${s.headRefName}). Read code there.`;
    return [
      `PR: ${prKey(s)} — ${s.title} (${s.headRefName} -> ${s.baseRefName})`,
      `PR description:\n${detail.body === "" ? "(none)" : detail.body.slice(0, 4000)}`,
      checkoutLine,
    ].join("\n\n");
  }

  async function startDraft(ref: PrRef, item: string, guidance: string): Promise<ItemState> {
    const detail = await getDetail(ref);
    const { replyVoice } = await settings.get();
    const key = prKey(ref);
    const prompt = [
      `You are drafting the PR author's reply to a review comment on GitHub PR ${key}.`,
      prContextText(detail),
      threadContextText(detail, item),
      guidance.trim() === "" ? null : `Guidance from the author: ${guidance.trim()}`,
      `Voice: ${replyVoice}`,
      `Decide whether the reviewer is right by reading the actual code. Write the reply in PAST TENSE, as the author posts it after addressing the comment: if the comment was right, state briefly what was right about it and what was done to address it ("Good catch — added the nil check before the dereference."); if it is a question, answer it precisely; if you disagree, say what the comment missed and that it was kept as-is, with evidence. Never promise future work ("will fix", "going to"). Then publish the reply with the ghpr_publish_draft tool (item ${JSON.stringify(item)}), reply here with one line, and stop. The author reads the draft in the PR panel, edits it, and posts it themself — never post to GitHub.`,
    ]
      .filter((x): x is string => x !== null)
      .join("\n\n");
    const threadId = await spawnWorker(`Draft reply: ${key}`, prompt, {
      ghprKind: "draft",
      ghprPr: key,
      ghprItem: item,
    });
    return mutateItem(ref, item, (it) => {
      it.draftStatus = "pending";
      it.draftThreadId = threadId;
    });
  }

  async function startFix(ref: PrRef, item: string, guidance: string): Promise<ItemState> {
    const detail = await getDetail(ref);
    if (detail.checkout === null) {
      throw new Error(`No local checkout for ${ref.owner}/${ref.repo} under the configured repos directory.`);
    }
    const key = prKey(ref);
    const branchWarning = detail.checkout.onPrBranch
      ? null
      : `NOTE: the checkout is on branch ${detail.checkout.branch ?? "?"}, not the PR branch ${detail.summary.headRefName}. Still generate the patch against the files as they are on disk; mention the branch mismatch in the summary.`;
    const prompt = [
      `You are proposing the code change that addresses one review comment on GitHub PR ${key}.`,
      prContextText(detail),
      threadContextText(detail, item),
      guidance.trim() === "" ? null : `Guidance from the author: ${guidance.trim()}`,
      branchWarning,
      `Work READ-ONLY: never edit, create, or delete files, and never run git write commands. Read the code at ${JSON.stringify(detail.checkout.path)}, decide the minimal change that addresses the comment, and produce one unified diff against the files as they are on disk (standard \`diff --git a/... b/...\` format, paths relative to the repo root). Verify it applies by writing it to a file under $TMPDIR and running \`git -C ${detail.checkout.path} apply --check <file>\` — that command does not modify anything. Then publish it with the ghpr_publish_fix tool (item ${JSON.stringify(item)}): a two-to-four-sentence summary of what the change does and why, plus the patch. Reply here with one line and stop. The author previews the patch in the PR panel and applies it from there.`,
    ]
      .filter((x): x is string => x !== null)
      .join("\n\n");
    const threadId = await spawnWorker(`Propose fix: ${key}`, prompt, {
      ghprKind: "fix",
      ghprPr: key,
      ghprItem: item,
    });
    return mutateItem(ref, item, (it) => {
      it.fix = { status: "pending", summary: "", patch: "", error: null, threadId, appliedAt: null };
    });
  }

  /** Open (or reuse) the persistent discussion thread for one comment. */
  async function openDiscussion(ref: PrRef, item: string): Promise<string> {
    const state = await readState(ref);
    const existing = state.items[item]?.discussThreadId ?? null;
    if (existing !== null) {
      try {
        await bb.sdk.threads.get({ threadId: existing });
        return existing;
      } catch {
        /* deleted — spawn a fresh one */
      }
    }
    const detail = await getDetail(ref);
    const key = prKey(ref);
    const isFinding = item.startsWith("f:");
    const prompt = [
      isFinding
        ? `You are the reviewer's standing discussion partner for ONE finding of their review of GitHub PR ${key} (they are reviewing someone else's PR). This conversation is shown in a pane next to the finding and persists; the reviewer will come back to it.`
        : `You are the PR author's standing discussion partner for ONE review comment on GitHub PR ${key}. This conversation is shown in a pane next to the comment and persists; the author will come back to it.`,
      prContextText(detail),
      threadContextText(detail, item),
      isFinding
        ? `Open by walking through the finding: the relevant code (read it in the checkout — note the checkout may be on a different branch than the PR; prefer \`gh pr diff ${detail.summary.number} --repo ${ref.owner}/${ref.repo}\` for the changed lines), how confident you are the finding is real, what the counter-arguments are, and how severe it actually is. Keep the opening under ~300 words, specific, with file:line references.`
        : `Open by explaining the comment: what the reviewer is asking for, the relevant code (read it in the checkout), whether the comment is right, and the realistic options with their trade-offs. Keep the opening under ~300 words, specific, with file:line references.`,
      isFinding
        ? `Then discuss: answer follow-up questions and take the reviewer's own ideas seriously. When the reviewer asks for the comment to be drafted, publish it with ghpr_publish_draft (item ${JSON.stringify(item)}) — a concise review comment in the reviewer's voice (direct, specific, question when unsure, "[nit]" prefix for nits). It lands in the finding's comment box in the PR panel, where the reviewer edits and posts it; never post to GitHub yourself, and never edit files.`
        : `Then discuss: answer follow-up questions and take the author's own ideas seriously. When the author asks for a reply draft, publish it with ghpr_publish_draft (item ${JSON.stringify(item)}) — written in PAST TENSE as posted after the comment was addressed (what was right or wrong about it and what was done), never promising future work. It lands in the comment's reply box in the PR panel, where the author edits and posts it; never post to GitHub yourself. When the author asks for a proposed code change — or asks you to revise the fix already shown on the card — publish a unified diff with ghpr_publish_fix (item ${JSON.stringify(item)}), verified with \`git apply --check\` first; publishing replaces the card's current proposed fix. Only edit files in the checkout directly when the author explicitly asks you to in this conversation.`,
    ].join("\n\n");
    const threadId = await spawnWorker(`Discuss: ${key} ${isFinding ? "finding" : item.startsWith("ic:") ? "comment" : "thread"}`, prompt, {
      ghprKind: "discuss",
      ghprPr: key,
      ghprItem: item,
    });
    await mutateItem(ref, item, (it) => {
      it.discussThreadId = threadId;
    });
    return threadId;
  }

  function parseKey(key: string): PrRef {
    const m = key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
    if (m === null) throw new Error(`Bad PR key ${key}`);
    return { owner: m[1], repo: m[2], number: Number(m[3]) };
  }

  // ---- reviewer side: run a review round, post findings as PR comments ----

  async function startReview(ref: PrRef, guidance: string): Promise<ReviewState> {
    const detail = await getDetail(ref);
    const { reviewInstructions } = await settings.get();
    const key = prKey(ref);
    const claimed = await mutateReview(ref, (r) => {
      if (r.status === "running") return false;
      r.round += 1;
      r.status = "running";
      r.threadId = null;
      r.startedAt = new Date().toISOString();
      r.finishedAt = null;
      r.error = null;
      // Keep what you already posted or dismissed; a new round replaces open findings.
      r.findings = r.findings.filter((f) => f.status !== "open");
      return true;
    });
    if (!claimed) return (await readState(ref)).review ?? emptyReview();
    const prompt = [
      `You are reviewing GitHub PR ${key} on behalf of the reviewer (they were asked to review it; they make the final call on every finding).`,
      prContextText(detail),
      `Run the review with the code-review skill: invoke the Skill tool with skill "code-review" and args "high https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number} --max-findings 20"${detail.checkout === null ? "" : `, working from the checkout directory ${JSON.stringify(detail.checkout.path)}`}, and follow it to completion (it fetches the PR diff itself and verifies findings). Only if that skill is unavailable in this session, review manually: get the diff with \`gh pr diff ${ref.number} --repo ${ref.owner}/${ref.repo}\`, hunt for real bugs the change introduces, and verify every suspicion against the actual code.`,
      `Map every finding the skill reports to the panel — do not add findings the skill did not report, and do not drop any it kept. For each:
- severity (the kind): the skill's "important" → "bug"; "pre_existing" → "question" (say it is pre-existing in the comment); "nit" → "nit" (prefix its comment with "[nit]").
- confidence: the skill's verify verdict CONFIRMED → "confirmed"; PLAUSIBLE (or no verify pass) → "plausible".
- priority — impact IF the finding is real: "critical" = data loss or corruption, security hole, crash or outage on a common path, a broken deploy or migration; "high" = wrong results or behavior on a realistic path, resource leaks, broken API contract; "medium" = edge-case misbehavior, missing handling on an unlikely path, a pre-existing issue this change makes worse; "low" = nits and minor issues with little user-visible effect.
- failureScenario: the skill's concrete inputs/state → wrong output or crash, verbatim or tightened.
- refs: 1–5 code locations the reviewer must look at to understand the finding, each { path, startLine, endLine, note }, with line numbers in the file AS OF THE PR HEAD (check with \`gh api repos/${ref.owner}/${ref.repo}/contents/<path>?ref=${detail.summary.headRefName} -H "Accept: application/vnd.github.raw"\` when unsure). First the exact lines where the issue is; then the related context — e.g. for a column-width bug, the migration defining the column AND the code that writes it; for a race, both sides. Keep each range tight (1–15 lines). "note" is a one-or-two-sentence inline annotation saying what to see at that spot, written like a code-review comment on those lines.`,
      guidance.trim() === "" ? null : `Guidance from the reviewer for this round: ${guidance.trim()}`,
      reviewInstructions.trim() === "" ? null : `Standing review instructions: ${reviewInstructions.trim()}`,
      `Publish with ONE ghpr_report_findings call — the PR panel, NOT ReportFindings or prose (an empty list is a valid, good result). For each finding also give: path and the head-side line from the diff; a short title; an explanation for the reviewer (why it's a problem, with evidence); and "comment" — the review comment ready to post, in the reviewer's voice: direct, specific, concise, phrased as a question when confidence is "plausible". After the tool call reply here with one line and stop; the reviewer triages everything in the PR panel.`,
    ]
      .filter((x): x is string => x !== null)
      .join("\n\n");
    try {
      const threadId = await spawnWorker(`Review: ${key}`, prompt, { ghprKind: "review", ghprPr: key });
      const model = await resolveRunModel(threadId);
      await mutateReview(ref, (r) => {
        r.threadId = threadId;
        r.model = model;
      });
    } catch (cause) {
      await mutateReview(ref, (r) => {
        r.status = "failed";
        r.error = describe(cause);
        r.finishedAt = new Date().toISOString();
      });
      throw cause;
    }
    return (await readState(ref)).review ?? emptyReview();
  }

  // ---- walkthrough: a ground-up guided tour of the PR ----

  async function startWalkthrough(ref: PrRef): Promise<Walkthrough> {
    const detail = await getDetail(ref);
    const key = prKey(ref);
    const claimed = await mutateWalkthrough(ref, (w) => {
      if (w.status === "running") return false;
      w.status = "running";
      w.threadId = null;
      w.startedAt = new Date().toISOString();
      w.finishedAt = null;
      w.error = null;
      return true;
    });
    if (!claimed) return (await readState(ref)).walkthrough ?? emptyWalkthrough();
    const prompt = [
      `Build a ground-up walkthrough of GitHub PR ${key} for its reviewer: an ordered tour that builds the context needed to understand the change, starting from the existing code it builds on and ending at the new behavior.`,
      prContextText(detail),
      `Get the authoritative diff with \`gh pr diff ${ref.number} --repo ${ref.owner}/${ref.repo}\`; read the surrounding pre-existing code in the checkout (note it may be on a different branch — prefer \`git -C <checkout> show origin/${detail.summary.baseRefName}:<path>\` or the files as they are for pre-existing context).`,
      `Structure: 5–12 steps, each one concept — e.g. "the data model this builds on", "where requests enter", "the new store", "how the pieces connect", "edge cases and tests". Each step has: a title; a markdown body (plain language, 3–8 sentences, say WHY the piece exists); and 1–3 code sections. A section is { path, kind, code, startLine }: kind "context" = PRE-EXISTING code shown for understanding — pass the plain source text exactly as in the file with its real starting line number; kind "added" = code THIS PR changes — pass the relevant unified diff hunk(s) for that file (with the @@ header) so additions and removals are highlighted. Never mislabel: if the code is not part of this PR's diff it is "context".`,
      `Publish once with ghpr_publish_walkthrough (title + steps), then reply here with one line and stop. The reviewer steps through it in the PR panel.`,
    ].join("\n\n");
    try {
      const threadId = await spawnWorker(`Walkthrough: ${key}`, prompt, { ghprKind: "walkthrough", ghprPr: key });
      const model = await resolveRunModel(threadId);
      await mutateWalkthrough(ref, (w) => {
        w.threadId = threadId;
        w.model = model;
      });
    } catch (cause) {
      await mutateWalkthrough(ref, (w) => {
        w.status = "failed";
        w.error = describe(cause);
        w.finishedAt = new Date().toISOString();
      });
      throw cause;
    }
    return (await readState(ref)).walkthrough ?? emptyWalkthrough();
  }

  // ---- file contents at the PR head (finding context viewer) ----
  const headShaCache = new Map<string, { sha: string; at: number }>();
  const fileCache = new Map<string, string>(); // `${sha}:${path}` -> content
  async function headSha(ref: PrRef): Promise<string> {
    const key = prKey(ref);
    const hit = headShaCache.get(key);
    if (hit !== undefined && Date.now() - hit.at < 60_000) return hit.sha;
    const sha = (await gh(["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, "--jq", ".head.sha"])).trim();
    headShaCache.set(key, { sha, at: Date.now() });
    return sha;
  }
  async function fileAtHead(ref: PrRef, path: string): Promise<{ content: string | null; error: string | null }> {
    if (path.split("/").some((seg) => seg === ".." || seg === "")) return { content: null, error: "Invalid path." };
    try {
      const sha = await headSha(ref);
      const cacheKey = `${sha}:${path}`;
      const hit = fileCache.get(cacheKey);
      if (hit !== undefined) return { content: hit, error: null };
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const content = await gh([
        "api",
        `repos/${ref.owner}/${ref.repo}/contents/${encoded}?ref=${sha}`,
        "-H",
        "Accept: application/vnd.github.raw",
      ]);
      if (fileCache.size > 200) fileCache.delete(fileCache.keys().next().value!);
      fileCache.set(cacheKey, content);
      return { content, error: null };
    } catch (cause) {
      return { content: null, error: describe(cause) };
    }
  }

  async function postFinding(ref: PrRef, findingId: string, body: string): Promise<string> {
    const state = await readState(ref);
    const finding = state.review?.findings.find((f) => f.id === findingId);
    if (finding === undefined) throw new Error("Finding not found.");
    const repo = `repos/${ref.owner}/${ref.repo}`;
    let url: string | null = null;
    if (finding.line !== null) {
      try {
        const head = z
          .object({ head: z.object({ sha: z.string() }) })
          .parse(JSON.parse(await gh(["api", `${repo}/pulls/${ref.number}`])));
        const out = JSON.parse(
          await gh([
            "api",
            `${repo}/pulls/${ref.number}/comments`,
            "--method",
            "POST",
            "-f",
            `body=${body}`,
            "-f",
            `commit_id=${head.head.sha}`,
            "-f",
            `path=${finding.path}`,
            "-F",
            `line=${finding.line}`,
            "-f",
            "side=RIGHT",
          ]),
        );
        url = z.object({ html_url: z.string() }).parse(out).html_url;
      } catch (cause) {
        bb.log.warn(`inline comment on ${finding.path}:${finding.line} failed (${describe(cause)}); posting as PR comment`);
      }
    }
    if (url === null) {
      url = await postReply(ref, `**\`${finding.path}${finding.line === null ? "" : `:${finding.line}`}\`** — ${body}`, null);
    }
    await mutateReview(ref, (r) => {
      const f = r.findings.find((x) => x.id === findingId);
      if (f !== undefined) {
        f.status = "posted";
        f.postedAt = new Date().toISOString();
      }
    });
    startDetailSync(ref);
    return url;
  }

  // ---- worker tools ----
  const toolError = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

  bb.agents.registerTool({
    name: "ghpr_publish_draft",
    description: "Publish the drafted reply to the PR review comment this thread is working on (item id from your prompt). The author edits and posts it from the PR panel.",
    presentation: { label: { pending: "Publishing draft reply", completed: "Published draft reply" } },
    parameters: z.object({ item: z.string(), draft: z.string().min(1).max(20_000) }),
    async execute({ item, draft }, { threadId }) {
      try {
        const meta = await bb.sdk.threads.getPluginMetadata({ threadId });
        if (typeof meta.ghprPr !== "string") return toolError("This thread is not attached to a PR comment.");
        const ref = parseKey(meta.ghprPr);
        await mutateItem(ref, typeof meta.ghprItem === "string" ? meta.ghprItem : item, (it) => {
          it.draft = draft;
          it.draftStatus = "ready";
        });
        return "Draft published to the PR panel.";
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "ghpr_publish_fix",
    description: "Publish the proposed patch for the PR review comment this thread is working on (item id from your prompt). The author previews and applies it from the PR panel.",
    presentation: { label: { pending: "Publishing proposed fix", completed: "Published proposed fix" } },
    parameters: z.object({
      item: z.string(),
      summary: z.string().min(1).max(4000),
      patch: z.string().min(1).max(400_000),
    }),
    async execute({ item, summary, patch }, { threadId }) {
      try {
        const meta = await bb.sdk.threads.getPluginMetadata({ threadId });
        if (typeof meta.ghprPr !== "string") return toolError("This thread is not attached to a PR comment.");
        const ref = parseKey(meta.ghprPr);
        const itemId = typeof meta.ghprItem === "string" ? meta.ghprItem : item;
        // Validate against the checkout before accepting, so Apply never surprises.
        const checkout = await checkoutFor(ref, null);
        if (checkout !== null) {
          const file = join(tmpdir(), `ghpr-${randomUUID()}.patch`);
          await writeFile(file, patch.endsWith("\n") ? patch : `${patch}\n`, "utf8");
          try {
            await git(checkout.path, ["apply", "--check", "--whitespace=nowarn", file]);
          } catch (cause) {
            return toolError(`The patch does not apply cleanly to ${checkout.path}: ${describe(cause)}. Regenerate it against the files as they are on disk.`);
          } finally {
            await unlink(file).catch(() => undefined);
          }
        }
        await mutateItem(ref, itemId, (it) => {
          it.fix = { status: "ready", summary, patch, error: null, threadId, appliedAt: null };
        });
        return "Proposed fix published to the PR panel.";
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "ghpr_report_findings",
    description:
      "Report the findings of the PR review this thread is running, in one call. The reviewer triages, edits, and posts them from the PR panel.",
    presentation: { label: { pending: "Reporting review findings", completed: "Reported review findings" } },
    parameters: z.object({
      findings: z
        .array(
          z.object({
            path: z.string().min(1),
            line: z.number().int().positive().nullable().default(null),
            severity: z.enum(SEVERITIES),
            priority: z.enum(PRIORITIES),
            confidence: z.enum(CONFIDENCES),
            failureScenario: z.string().max(4000).nullable().default(null),
            refs: z
              .array(
                z.object({
                  path: z.string().min(1),
                  startLine: z.number().int().positive(),
                  endLine: z.number().int().positive(),
                  note: z.string().min(1).max(2000),
                }),
              )
              .max(6)
              .default([]),
            title: z.string().min(1).max(200),
            explanation: z.string().min(1).max(8000),
            comment: z.string().min(1).max(8000),
          }),
        )
        .max(20),
    }),
    async execute({ findings }, { threadId }) {
      try {
        const meta = await bb.sdk.threads.getPluginMetadata({ threadId });
        if (typeof meta.ghprPr !== "string") return toolError("This thread is not attached to a PR review.");
        const ref = parseKey(meta.ghprPr);
        const added = findings.map((f) => ({
          id: randomUUID().slice(0, 8),
          path: f.path,
          line: f.line,
          severity: f.severity,
          priority: f.priority,
          confidence: f.confidence,
          scenario: f.failureScenario,
          refs: f.refs.map((r) => ({ ...r, endLine: Math.max(r.endLine, r.startLine) })),
          title: f.title,
          body: f.explanation,
          status: "open" as const,
          postedAt: null,
        }));
        await mutateReview(ref, (r) => {
          r.findings = [...r.findings, ...added];
          r.status = "done";
          r.finishedAt = new Date().toISOString();
          r.error = null;
        });
        // The ready-to-post comment lands as the finding's editable draft.
        for (const [i, f] of added.entries()) {
          await mutateItem(ref, `f:${f.id}`, (it) => {
            it.draft = findings[i].comment;
            it.draftStatus = "ready";
          });
        }
        return `Reported ${added.length} finding(s) to the PR panel.`;
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "ghpr_publish_walkthrough",
    description:
      "Publish the ground-up walkthrough of the PR this thread is working on. The reviewer steps through it in the PR panel.",
    presentation: { label: { pending: "Publishing walkthrough", completed: "Published walkthrough" } },
    parameters: z.object({
      title: z.string().min(1).max(200),
      steps: z
        .array(
          z.object({
            title: z.string().min(1).max(200),
            body: z.string().min(1).max(8000),
            sections: z
              .array(
                z.object({
                  path: z.string().min(1),
                  kind: z.enum(["added", "context"]),
                  code: z.string().min(1).max(20_000),
                  startLine: z.number().int().positive().nullable().default(null),
                }),
              )
              .max(4)
              .default([]),
          }),
        )
        .min(1)
        .max(15),
    }),
    async execute({ title, steps }, { threadId }) {
      try {
        const meta = await bb.sdk.threads.getPluginMetadata({ threadId });
        if (typeof meta.ghprPr !== "string") return toolError("This thread is not attached to a PR.");
        const ref = parseKey(meta.ghprPr);
        await mutateWalkthrough(ref, (w) => {
          w.title = title;
          w.steps = steps;
          w.status = "done";
          w.finishedAt = new Date().toISOString();
          w.error = null;
        });
        return `Published a ${steps.length}-step walkthrough to the PR panel.`;
      } catch (cause) {
        return toolError(describe(cause));
      }
    },
  });

  bb.agents.configure((context) => {
    const kind = context.pluginMetadata?.ghprKind;
    if (kind === "draft") {
      return {
        tools: ["ghpr_publish_draft"],
        skills: [],
        instructions:
          "You are a read-only worker drafting one PR reply. Publish it with ghpr_publish_draft; never edit files or post to GitHub.",
      };
    }
    if (kind === "fix") {
      return {
        tools: ["ghpr_publish_fix"],
        skills: [],
        instructions:
          "You are a read-only worker proposing one patch. Publish it with ghpr_publish_fix; never edit files, never run git write commands, never post to GitHub. `git apply --check` is allowed (it modifies nothing).",
      };
    }
    if (kind === "review") {
      return {
        tools: ["ghpr_report_findings"],
        skills: [],
        instructions:
          "You are a read-only PR review worker. Report findings only with one ghpr_report_findings call; never edit files, never run git write commands, never post to GitHub. The reviewer triages everything in the PR panel.",
      };
    }
    if (kind === "walkthrough") {
      return {
        tools: ["ghpr_publish_walkthrough"],
        skills: [],
        instructions:
          "You are a read-only worker building a ground-up walkthrough of one PR. Publish it with one ghpr_publish_walkthrough call; never edit files, never run git write commands, never post to GitHub.",
      };
    }
    if (kind === "discuss") {
      return {
        tools: ["ghpr_publish_draft", "ghpr_publish_fix"],
        skills: [],
        instructions:
          "You are a persistent discussion about one PR review comment, shown in a pane beside the comment. Explain and discuss; stay on this comment. Publish reply drafts with ghpr_publish_draft and proposed patches with ghpr_publish_fix (item id from your first prompt) — the author edits and posts from the PR panel; never post to GitHub yourself. Edit files in the checkout only when the author explicitly asks you to here.",
      };
    }
    return { tools: [], skills: [] };
  });

  /** A worker finished without publishing: salvage its final output or mark failed. */
  async function settleWorker(threadId: string) {
    const meta = await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null);
    if (meta === null || typeof meta.ghprPr !== "string") return;
    const kind = meta.ghprKind;
    const ref = parseKey(meta.ghprPr);
    if (kind === "review") {
      const review = (await readState(ref)).review;
      if (review?.status === "running" && review.threadId === threadId) {
        await mutateReview(ref, (r) => {
          r.status = "failed";
          r.error = "The review worker finished without reporting findings. Run it again.";
          r.finishedAt = new Date().toISOString();
        });
      }
      return;
    }
    if (kind === "walkthrough") {
      const walkthrough = (await readState(ref)).walkthrough;
      if (walkthrough?.status === "running" && walkthrough.threadId === threadId) {
        await mutateWalkthrough(ref, (w) => {
          w.status = "failed";
          w.error = "The walkthrough worker finished without publishing. Run it again.";
          w.finishedAt = new Date().toISOString();
        });
      }
      return;
    }
    if (typeof meta.ghprItem !== "string") return;
    const item = meta.ghprItem;
    const state = await readState(ref);
    const it = state.items[item];
    if (it === undefined) return;
    if (kind === "draft" && it.draftStatus === "pending" && it.draftThreadId === threadId) {
      const text = ((await bb.sdk.threads.output({ threadId }).catch(() => ({ output: null }))).output ?? "").trim();
      await mutateItem(ref, item, (x) => {
        if (text === "") {
          x.draftStatus = "failed";
        } else {
          x.draft = text;
          x.draftStatus = "ready";
        }
      });
    } else if (kind === "fix" && it.fix?.status === "pending" && it.fix.threadId === threadId) {
      await mutateItem(ref, item, (x) => {
        if (x.fix !== null) {
          x.fix.status = "failed";
          x.fix.error = "The worker finished without publishing a patch. Try again, or add guidance.";
        }
      });
    }
  }
  bb.events.on("thread.idle", ({ thread }) => void settleWorker(thread.id).catch(() => undefined));
  bb.events.on("thread.failed", ({ thread }) => void settleWorker(thread.id).catch(() => undefined));

  // ---- GitHub writes ----
  async function postReply(ref: PrRef, body: string, replyTo: number | null): Promise<string> {
    const repo = `repos/${ref.owner}/${ref.repo}`;
    const endpoint =
      replyTo === null
        ? `${repo}/issues/${ref.number}/comments`
        : `${repo}/pulls/${ref.number}/comments/${replyTo}/replies`;
    const out = JSON.parse(await gh(["api", endpoint, "--method", "POST", "-f", `body=${body}`]));
    return z.object({ html_url: z.string() }).parse(out).html_url;
  }

  async function resolveThread(threadId: string, resolved: boolean): Promise<void> {
    const mutation = resolved
      ? `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`
      : `mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }`;
    await graphql(mutation, { id: threadId });
  }

  let viewer: string | null = null;
  async function viewerLogin(): Promise<string> {
    if (viewer === null) viewer = z.object({ login: z.string() }).parse(JSON.parse(await gh(["api", "user"]))).login;
    return viewer;
  }

  async function setReaction(ref: PrRef, commentId: number, kind: "review" | "issue", content: string, on: boolean) {
    const base = `repos/${ref.owner}/${ref.repo}/${kind === "review" ? "pulls" : "issues"}/comments/${commentId}/reactions`;
    if (on) {
      await gh(["api", base, "--method", "POST", "-f", `content=${content}`]);
      return;
    }
    const me = await viewerLogin();
    const list = z
      .array(z.object({ id: z.number(), content: z.string(), user: z.object({ login: z.string() }).nullable() }))
      .parse(JSON.parse(await gh(["api", `${base}?per_page=100`])));
    const mine = list.find((r) => r.content === content && r.user?.login === me);
    if (mine !== undefined) await gh(["api", `${base}/${mine.id}`, "--method", "DELETE"]);
  }

  async function applyFix(ref: PrRef, item: string): Promise<{ applied: boolean; detail: string }> {
    const state = await readState(ref);
    const fix = state.items[item]?.fix;
    if (fix === undefined || fix === null || fix.status !== "ready") {
      throw new Error("No ready patch on this comment.");
    }
    const checkout = await checkoutFor(ref, null);
    if (checkout === null) throw new Error(`No local checkout for ${ref.owner}/${ref.repo}.`);
    const file = join(tmpdir(), `ghpr-${randomUUID()}.patch`);
    await writeFile(file, fix.patch.endsWith("\n") ? fix.patch : `${fix.patch}\n`, "utf8");
    try {
      await git(checkout.path, ["apply", "--3way", "--whitespace=nowarn", file]);
    } catch (cause) {
      return { applied: false, detail: describe(cause) };
    } finally {
      await unlink(file).catch(() => undefined);
    }
    const status = (await git(checkout.path, ["status", "--short"]).catch(() => "")).trim();
    await mutateItem(ref, item, (it) => {
      if (it.fix !== null) {
        it.fix.status = "applied";
        it.fix.appliedAt = new Date().toISOString();
      }
    });
    return { applied: true, detail: `Applied to ${checkout.path} (branch ${checkout.branch ?? "?"}).\n${status}` };
  }

  // ---- RPC ----
  bb.rpc.register(rpcContract, {
    prs_list: ({ refresh }) => listPrs(refresh),
    pr_get: async (ref) => {
      const detail = await getDetail(ref);
      if (Date.now() - Date.parse(detail.fetchedAt) >= DETAIL_TTL_MS) startDetailSync(ref);
      return { detail, syncing: syncing.has(prKey(ref)) };
    },
    pr_refresh: (ref) => {
      startDetailSync(ref);
      return { syncing: true };
    },
    triage_set: ({ ref, item, triage }) => mutateItem(ref, item, (it) => void (it.triage = triage)),
    draft_start: ({ ref, item, guidance }) => startDraft(ref, item, guidance),
    draft_save: ({ ref, item, text }) =>
      mutateItem(ref, item, (it) => {
        it.draft = text;
        if (it.draftStatus === "pending") it.draftStatus = "ready";
      }),
    reply_post: async ({ ref, item, body, replyTo, resolve }) => {
      const url = await postReply(ref, body, replyTo);
      if (resolve !== null) await resolveThread(resolve, true).catch((cause) => bb.log.warn(`resolve: ${describe(cause)}`));
      await mutateItem(ref, item, (it) => {
        it.postedAt = new Date().toISOString();
        it.draft = null;
        it.draftStatus = null;
      });
      startDetailSync(ref);
      return { url };
    },
    react: async ({ ref, commentId, kind, content, on }) => {
      await setReaction(ref, commentId, kind, content, on);
      startDetailSync(ref);
      return { ok: true as const };
    },
    thread_resolve: async ({ ref, threadId, resolved }) => {
      await resolveThread(threadId, resolved);
      startDetailSync(ref);
      return { ok: true as const };
    },
    fix_start: ({ ref, item, guidance }) => startFix(ref, item, guidance),
    discuss_open: async ({ ref, item }) => ({ threadId: await openDiscussion(ref, item) }),
    review_start: ({ ref, guidance }) => startReview(ref, guidance),
    finding_set: async ({ ref, findingId, status }) =>
      mutateReview(ref, (r) => {
        const f = r.findings.find((x) => x.id === findingId);
        if (f === undefined) throw new Error("Finding not found.");
        if (f.status !== "posted") f.status = status;
        return r;
      }),
    finding_post: async ({ ref, findingId, body }) => ({ url: await postFinding(ref, findingId, body) }),
    walkthrough_start: (ref) => startWalkthrough(ref),
    file_at_head: ({ ref, path }) => fileAtHead(ref, path),
    model_get: async () => ({ selection: await readWorkerModel(), fallback: await fallbackWorkerModel() }),
    model_set: async ({ selection }) => {
      if (selection === null) await bb.storage.kv.delete(WORKER_MODEL_KEY);
      else await bb.storage.kv.set(WORKER_MODEL_KEY, selection);
      bb.realtime.publish(CHANGED, { kind: "model" });
      return { ok: true as const };
    },
    fix_apply: ({ ref, item }) => applyFix(ref, item),
    fix_discard: ({ ref, item }) => mutateItem(ref, item, (it) => void (it.fix = null)),
    checkout_get: (ref) => checkoutFor(ref, null),
  });

  // ---- CLI ----
  bb.cli.register(
    defineCli({
      name: "github-prs",
      summary: "Your open GitHub PRs and their review-comment workbench",
      commands: {
        list: cliCommand({
          summary: "List your open PRs (same query as the panel)",
          options: {
            refresh: { type: "boolean", description: "Bypass the 60s cache" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            let prs: PrSummary[];
            let error: string | null = null;
            if (input.options.refresh === true) {
              prs = await fetchList();
              await bb.storage.kv.set(LIST_KEY, { prs, fetchedAt: new Date().toISOString() });
              bb.realtime.publish(CHANGED, { kind: "list" });
              pruneDetails(prs);
              prefetchDetails(prs);
            } else {
              ({ prs, error } = await listPrs(false));
            }
            if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(prs)}\n` };
            const lines = prs.map(
              (p) =>
                `${prKey(p).padEnd(44)} ${String(p.unresolvedThreads).padStart(2)} open threads  ${p.checksState ?? "-"}  ${p.title}`,
            );
            const suffix = error === null ? "" : `\n(warning: refresh failed: ${error})`;
            return { exitCode: 0, stdout: `${lines.join("\n") || "No open PRs."}${suffix}\n` };
          },
        }),
        review: cliCommand({
          summary: "Start a review round on a PR (findings land in the panel's Review tab)",
          positionals: [{ name: "pr", description: "owner/repo#number", required: true }],
          options: { guidance: { type: "string", description: "Extra guidance for this round" } },
          async run(input) {
            const ref = parseKey(input.positionals.pr);
            const review = await startReview(ref, input.options.guidance ?? "");
            return {
              exitCode: 0,
              stdout: `Review round ${review.round} ${review.status} (worker thread ${review.threadId ?? "?"}). Findings appear in the PR panel's Review tab.\n`,
            };
          },
        }),
        walkthrough: cliCommand({
          summary: "Build a ground-up walkthrough of a PR (appears in the panel's Walkthrough tab)",
          positionals: [{ name: "pr", description: "owner/repo#number", required: true }],
          async run(input) {
            const ref = parseKey(input.positionals.pr);
            const w = await startWalkthrough(ref);
            return { exitCode: 0, stdout: `Walkthrough ${w.status} (worker thread ${w.threadId ?? "?"}).\n` };
          },
        }),
        findings: cliCommand({
          summary: "List a PR's review findings and their status",
          positionals: [{ name: "pr", description: "owner/repo#number", required: true }],
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            const ref = parseKey(input.positionals.pr);
            await backfillRunModels(ref);
            const review = (await readState(ref)).review ?? emptyReview();
            if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(review)}\n` };
            const lines = review.findings.map(
              (f) => `[${f.status.padEnd(9)}] ${(f.priority ?? "medium").padEnd(8)} ${f.severity.padEnd(8)} ${f.confidence === "plausible" ? "?" : " "} ${f.path}${f.line === null ? "" : `:${f.line}`}  ${f.title}`,
            );
            return {
              exitCode: 0,
              stdout: `round ${review.round} ${review.status}${review.model === null ? "" : ` on ${review.model.model} (${review.model.reasoningLevel})`}${review.error === null ? "" : ` (${review.error})`}\n${lines.join("\n")}\n`,
            };
          },
        }),
        comments: cliCommand({
          summary: "List a PR's unresolved review threads with triage state",
          positionals: [{ name: "pr", description: "owner/repo#number", required: true }],
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            const ref = parseKey(input.positionals.pr);
            const detail = await fetchDetail(ref);
            const rows = detail.threads
              .filter((t) => !t.isResolved)
              .map((t) => ({
                item: t.id,
                where: `${t.path}${t.line === null ? "" : `:${t.line}`}`,
                author: t.comments[0]?.author ?? "?",
                excerpt: (t.comments[0]?.body ?? "").replace(/\s+/g, " ").slice(0, 100),
                triage: detail.items[t.id]?.triage ?? "pending",
              }));
            if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(rows)}\n` };
            return {
              exitCode: 0,
              stdout: `${rows.map((r) => `[${r.triage.padEnd(8)}] ${r.where}  ${r.author}: ${r.excerpt}`).join("\n") || "No unresolved threads."}\n`,
            };
          },
        }),
      },
    }),
  );
}
