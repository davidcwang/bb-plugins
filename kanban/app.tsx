// bb-plugin-kanban — frontend entry: the board page.
//
// Cards are threads and synced GitHub PRs. Drag a card between columns (or use
// its column picker); agents move cards through `bb kanban move`, and the
// "kanban-changed" realtime signal keeps every open board current.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Card, Column, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const COLUMNS: Array<{ id: Column; title: string }> = [
  { id: "backlog", title: "Backlog" },
  { id: "in_progress", title: "In progress" },
  { id: "in_review", title: "In review" },
  { id: "done", title: "Done" },
];

function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("cards_list").then((result) => {
      setCards(result.cards);
      setLastSync(result.lastSync);
      setError(result.syncError);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("kanban-changed", refetch);
  return { rpc, cards, lastSync, error, report, refetch };
}

function CardView({
  card,
  onMove,
  onOpen,
}: {
  card: Card;
  onMove: (column: Column) => void;
  onOpen: () => void;
}) {
  const pr = card.pr;
  return (
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", card.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      className="cursor-grab rounded-lg border border-border bg-card p-3 text-sm shadow-sm active:cursor-grabbing"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-start gap-2 text-left"
      >
        <Icon
          name={card.kind === "pr" ? "GitPullRequest" : "MessageSquare"}
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 break-words">{card.title}</span>
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {pr === undefined ? (
          card.threadStatus === "active" ? (
            <span className="text-foreground">● running</span>
          ) : null
        ) : (
          <>
            <span className="font-mono">
              {pr.repo}#{pr.number}
            </span>
            {pr.draft ? <span>draft</span> : null}
            {pr.source === "review-requested" ? (
              <span className="text-foreground">review requested · {pr.author}</span>
            ) : null}
          </>
        )}
        <select
          aria-label={`Move "${card.title}"`}
          value={card.column}
          onChange={(event) => onMove(event.target.value as Column)}
          className="ml-auto rounded border border-border bg-background px-1 py-0.5 text-xs"
        >
          {COLUMNS.map((column) => (
            <option key={column.id} value={column.id}>
              {column.title}
            </option>
          ))}
        </select>
      </div>
    </li>
  );
}

function BoardPage() {
  const { rpc, cards, lastSync, error, report, refetch } = useBoard();
  const navigate = useBbNavigate();
  const [syncing, setSyncing] = useState(false);
  const [dragOver, setDragOver] = useState<Column | null>(null);

  const move = (id: string, column: Column) => {
    rpc.call("cards_move", { id, column }).then(refetch, report);
  };
  const sync = async () => {
    setSyncing(true);
    try {
      await rpc.call("sync_now");
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col px-4 pb-4 pt-3 md:px-5 md:pt-4">
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          {lastSync === null
            ? "PRs not synced yet."
            : `PRs synced ${new Date(lastSync).toLocaleTimeString()}.`}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={syncing}
          onClick={sync}
        >
          <Icon name="RefreshCw" className="size-4" />
          Sync PRs
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto md:grid-cols-4">
        {COLUMNS.map((column) => {
          const items = (cards ?? []).filter((card) => card.column === column.id);
          return (
            <section
              key={column.id}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(column.id);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(null);
                const id = event.dataTransfer.getData("text/plain");
                if (id !== "") move(id, column.id);
              }}
              className={cn(
                "flex min-h-40 min-w-0 flex-col rounded-lg border border-border bg-muted/30 p-2",
                dragOver === column.id && "border-primary bg-muted/60",
              )}
            >
              <h2 className="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {column.title} · {items.length}
              </h2>
              <ul className="flex flex-1 flex-col gap-2 overflow-y-auto">
                {items.map((card) => (
                  <CardView
                    key={card.id}
                    card={card}
                    onMove={(next) => move(card.id, next)}
                    onOpen={() => {
                      if (card.threadId !== undefined) navigate.toThread(card.threadId);
                      else if (card.pr !== undefined) navigate.openUrl(card.pr.url);
                    }}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Kanban",
    icon: "Kanban",
    path: "board",
    component: BoardPage,
  });
});
