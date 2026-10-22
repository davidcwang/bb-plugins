// bb-plugin-kanban — backend entry.
//
// One card per thread, plus cards synced from GitHub PRs (yours, and ones that
// request your review). Cards live in bb.storage.kv; every write publishes a
// realtime signal so open boards refetch. Agents move cards with
// `bb kanban move` or the `kanban_move` tool; thread lifecycle events move
// them automatically where the meaning is unambiguous.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

export const COLUMNS = ["backlog", "in_progress", "in_review", "done"] as const;
const columnSchema = z.enum(COLUMNS);
export type Column = z.infer<typeof columnSchema>;

const prSchema = z.object({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  author: z.string(),
  draft: z.boolean(),
  source: z.enum(["authored", "review-requested"]),
});
export type PrInfo = z.infer<typeof prSchema>;

const cardSchema = z.object({
  id: z.string(),
  kind: z.enum(["thread", "pr"]),
  title: z.string(),
  column: columnSchema,
  /** Set once a person or agent moved the card; sync then stops moving it. */
  pinned: z.boolean(),
  updatedAt: z.string(),
  threadId: z.string().optional(),
  projectId: z.string().optional(),
  threadStatus: z.string().optional(),
  pr: prSchema.optional(),
});
export type Card = z.infer<typeof cardSchema>;

export const rpcContract = defineRpcContract({
  cards_list: {
    input: z.null(),
    output: z.object({
      cards: z.array(cardSchema),
      lastSync: z.string().nullable(),
      syncError: z.string().nullable(),
    }),
  },
  cards_move: {
    input: z.object({ id: z.string(), column: columnSchema }),
    output: cardSchema,
  },
  sync_now: {
    input: z.null(),
    output: z.object({ prs: z.number() }),
  },
});

const CHANGED = "kanban-changed";
const CARDS_KEY = "cards";
const SYNC_KEY = "sync";
const MAX_CLI_ROWS = 200;

interface SyncState {
  at: string | null;
  error: string | null;
}

const searchResponse = z.object({
  items: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      html_url: z.string(),
      draft: z.boolean().optional(),
      repository_url: z.string(),
      user: z.object({ login: z.string() }).nullable(),
    }),
  ),
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    githubToken: {
      type: "string",
      label: "GitHub token",
      description:
        "Token with read access to pull requests (repo scope, or fine-grained Pull requests: read). Leave empty to disable PR sync.",
      secret: true,
    },
    syncPullRequests: {
      type: "boolean",
      label: "Sync my pull requests",
      description: "Open PRs you authored or were asked to review.",
      default: true,
    },
  });

  // All read-modify-write on the card list goes through this queue so
  // concurrent events and RPCs cannot lose each other's writes.
  let queue: Promise<unknown> = Promise.resolve();
  function mutate<T>(fn: (cards: Card[]) => T | Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      const cards = (await bb.storage.kv.get<Card[]>(CARDS_KEY)) ?? [];
      const result = await fn(cards);
      await bb.storage.kv.set(CARDS_KEY, cards);
      bb.realtime.publish(CHANGED, { count: cards.length });
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  }
  const readCards = async () =>
    (await bb.storage.kv.get<Card[]>(CARDS_KEY)) ?? [];
  const readSync = async (): Promise<SyncState> =>
    (await bb.storage.kv.get<SyncState>(SYNC_KEY)) ?? {
      at: null,
      error: null,
    };

  // ---- threads ---------------------------------------------------------

  type ThreadLike = {
    id: string;
    title: string | null;
    projectId: string;
    status: string;
    visibility: string;
    archivedAt: number | null;
  };

  function upsertThread(
    cards: Card[],
    thread: ThreadLike,
    autoColumn: Column | null,
  ): void {
    if (thread.visibility === "hidden") return;
    const id = `thread:${thread.id}`;
    const title = thread.title ?? "Untitled thread";
    const existing = cards.find((card) => card.id === id);
    if (existing === undefined) {
      cards.push({
        id,
        kind: "thread",
        title,
        column:
          thread.archivedAt !== null
            ? "done"
            : (autoColumn ??
              (thread.status === "active" ? "in_progress" : "backlog")),
        pinned: false,
        updatedAt: new Date().toISOString(),
        threadId: thread.id,
        projectId: thread.projectId,
        threadStatus: thread.status,
      });
      return;
    }
    existing.title = title;
    existing.threadStatus = thread.status;
    existing.updatedAt = new Date().toISOString();
    if (thread.archivedAt !== null) existing.column = "done";
    else if (autoColumn !== null && !existing.pinned) existing.column = autoColumn;
  }

  // A thread going active is the only unambiguous signal: work started.
  // Idle is NOT mapped — an idle agent may be finished or waiting on you, so
  // the agent (or you) decides via `bb kanban move`.
  bb.events.on("thread.created", ({ thread }) =>
    mutate((cards) => upsertThread(cards, thread, null)).then(() => undefined),
  );
  bb.events.on("thread.active", ({ thread }) =>
    mutate((cards) => {
      const card = cards.find((c) => c.id === `thread:${thread.id}`);
      // Reopen finished work, but never override a deliberate placement
      // beyond "backlog"/"done" the user or agent chose.
      const auto =
        card === undefined || card.column === "backlog" || card.column === "done"
          ? "in_progress"
          : null;
      upsertThread(cards, thread, auto);
      if (card !== undefined && auto !== null) card.pinned = false;
    }),
  );
  for (const event of ["thread.idle", "thread.failed", "thread.unarchived"] as const) {
    bb.events.on(event, ({ thread }) =>
      mutate((cards) => upsertThread(cards, thread, null)),
    );
  }
  bb.events.on("thread.archived", ({ thread }) =>
    mutate((cards) => upsertThread(cards, thread, "done")),
  );
  bb.events.on("thread.deleted", ({ thread }) =>
    mutate((cards) => {
      const index = cards.findIndex((c) => c.id === `thread:${thread.id}`);
      if (index !== -1) cards.splice(index, 1);
    }),
  );

  // Backfill existing threads on first load so the board is not empty.
  async function backfillThreads(): Promise<void> {
    if ((await readCards()).some((c) => c.kind === "thread")) return;
    const threads = await bb.sdk.threads.list({ limit: 100 });
    await mutate((cards) => {
      for (const thread of threads) upsertThread(cards, thread, null);
    });
  }

  // ---- GitHub PR sync --------------------------------------------------

  async function searchPrs(
    token: string,
    qualifier: string,
    signal?: AbortSignal,
  ): Promise<Array<PrInfo & { title: string }>> {
    const url = new URL("https://api.github.com/search/issues");
    url.searchParams.set("q", `is:pr is:open archived:false ${qualifier}`);
    url.searchParams.set("per_page", "100");
    const response = await fetch(url, {
      signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "bb-plugin-kanban",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub search failed: HTTP ${response.status}`);
    }
    const parsed = searchResponse.parse(await response.json());
    const source = qualifier.startsWith("author") ? "authored" : "review-requested";
    return parsed.items.map((item) => ({
      repo: item.repository_url.replace("https://api.github.com/repos/", ""),
      number: item.number,
      url: item.html_url,
      author: item.user?.login ?? "unknown",
      draft: item.draft ?? false,
      source,
      title: item.title,
    }));
  }

  async function syncPullRequests(signal?: AbortSignal): Promise<number> {
    const { githubToken, syncPullRequests: enabled } = await settings.get();
    if (!enabled || githubToken === undefined || githubToken === "") return 0;
    let found: Array<PrInfo & { title: string }>;
    try {
      const authored = await searchPrs(githubToken, "author:@me", signal);
      const requested = await searchPrs(
        githubToken,
        "review-requested:@me",
        signal,
      );
      // A PR you authored wins if both match (cannot review your own, but be safe).
      const seen = new Set<string>();
      found = [...authored, ...requested].filter((pr) => {
        const key = `${pr.repo}#${pr.number}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await bb.storage.kv.set(SYNC_KEY, { at: (await readSync()).at, error: message });
      bb.realtime.publish(CHANGED, { error: true });
      throw cause;
    }
    await mutate((cards) => {
      const live = new Set<string>();
      for (const pr of found) {
        const id = `pr:${pr.repo}#${pr.number}`;
        live.add(id);
        const { title, ...info } = pr;
        const defaultColumn: Column =
          info.source === "review-requested"
            ? "backlog"
            : info.draft
              ? "in_progress"
              : "in_review";
        const existing = cards.find((c) => c.id === id);
        if (existing === undefined) {
          cards.push({
            id,
            kind: "pr",
            title,
            column: defaultColumn,
            pinned: false,
            updatedAt: new Date().toISOString(),
            pr: info,
          });
        } else {
          existing.title = title;
          existing.pr = info;
          if (!existing.pinned) existing.column = defaultColumn;
        }
      }
      // Merged, closed, or no-longer-requested PRs leave the board.
      for (let i = cards.length - 1; i >= 0; i--) {
        const card = cards[i]!;
        if (card.kind === "pr" && !live.has(card.id)) cards.splice(i, 1);
      }
    });
    await bb.storage.kv.set(SYNC_KEY, {
      at: new Date().toISOString(),
      error: null,
    });
    bb.realtime.publish(CHANGED, { synced: true });
    return found.length;
  }

  bb.background.schedule("sync-prs", "*/5 * * * *", async () => {
    await syncPullRequests();
  });

  // ---- moving cards ----------------------------------------------------

  /** Resolve a card by full id, thread id, or unambiguous id prefix. */
  function findCard(cards: Card[], ref: string): Card | undefined {
    const exact = cards.find(
      (c) => c.id === ref || c.threadId === ref || c.id === `thread:${ref}`,
    );
    if (exact !== undefined) return exact;
    const matches = cards.filter((c) => c.id.startsWith(ref));
    return matches.length === 1 ? matches[0] : undefined;
  }
  function moveCard(ref: string, column: Column): Promise<Card> {
    return mutate((cards) => {
      const card = findCard(cards, ref);
      if (card === undefined) {
        throw new Error(`No card "${ref}". Run "bb kanban list" to see ids.`);
      }
      card.column = column;
      card.pinned = true;
      card.updatedAt = new Date().toISOString();
      return card;
    });
  }

  bb.rpc.register(rpcContract, {
    cards_list: async () => {
      const sync = await readSync();
      return {
        cards: await readCards(),
        lastSync: sync.at,
        syncError: sync.error,
      };
    },
    cards_move: ({ id, column }) => moveCard(id, column),
    sync_now: async () => ({ prs: await syncPullRequests() }),
  });

  // ---- CLI + agent tool ------------------------------------------------

  const line = (card: Card) =>
    `${card.column.padEnd(11)} ${card.id}  ${card.title}`;

  bb.cli.register(
    defineCli({
      name: "kanban",
      summary: "Move cards on the Kanban board and sync pull requests",
      commands: {
        list: cliCommand({
          summary: "List cards, optionally for one column",
          options: {
            column: {
              type: "enum",
              values: [...COLUMNS],
              description: "Only cards in this column",
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const cards = (await readCards())
              .filter(
                (c) =>
                  input.options.column === undefined ||
                  c.column === input.options.column,
              )
              .slice(0, MAX_CLI_ROWS);
            return input.options.json
              ? { exitCode: 0, stdout: JSON.stringify(cards) }
              : { exitCode: 0, stdout: cards.length === 0 ? "No cards." : cards.map(line).join("\n") };
          },
        }),
        move: cliCommand({
          summary: "Move a card to a column",
          positionals: [
            {
              name: "card",
              description: "Card id, thread id, or unique id prefix",
              required: true,
            },
            {
              name: "column",
              description: `One of: ${COLUMNS.join(", ")}`,
              required: true,
            },
          ],
          options: {
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const column = columnSchema.safeParse(input.positionals.column);
            if (!column.success) {
              throw new PluginCliError(
                `unknown column "${input.positionals.column}"; use one of: ${COLUMNS.join(", ")}`,
              );
            }
            try {
              const card = await moveCard(input.positionals.card, column.data);
              return {
                exitCode: 0,
                stdout: input.options.json ? JSON.stringify(card) : line(card),
              };
            } catch (cause) {
              throw new PluginCliError(
                cause instanceof Error ? cause.message : String(cause),
              );
            }
          },
        }),
        sync: cliCommand({
          summary: "Sync your open PRs and review requests from GitHub now",
          options: {
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            try {
              const prs = await syncPullRequests();
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ prs })
                  : `Synced ${prs} pull request(s).`,
              };
            } catch (cause) {
              throw new PluginCliError(
                cause instanceof Error ? cause.message : String(cause),
              );
            }
          },
        }),
      },
    }),
  );

  bb.agents.registerTool({
    name: "kanban_move",
    description:
      "Move a card on the Kanban board. Omit `card` to move this thread's own card. Columns: backlog, in_progress, in_review, done.",
    instructions:
      "Keep this thread's Kanban card current: in_progress while working, in_review when you need the user's review or a PR is up, done when finished.",
    parameters: z.object({
      card: z.string().optional(),
      column: columnSchema,
    }),
    async execute({ card, column }, { threadId }) {
      const ref = card ?? threadId;
      if (ref === undefined) return { content: [{ type: "text", text: "No card specified." }], isError: true };
      try {
        const moved = await moveCard(ref, column);
        return line(moved);
      } catch (cause) {
        return {
          content: [
            { type: "text", text: cause instanceof Error ? cause.message : String(cause) },
          ],
          isError: true,
        };
      }
    },
  });

  void backfillThreads().catch((cause) =>
    bb.log.warn(`backfill failed: ${cause instanceof Error ? cause.message : String(cause)}`),
  );
  bb.log.info("loaded");
}
