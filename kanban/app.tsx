// bb-plugin-kanban — frontend entry: the board page.
//
// Cards are tasks, threads, and synced GitHub items. Drag a card between
// columns (or use its column picker); open a card for its details, phase
// controls, and thread actions. The "kanban-changed" realtime signal keeps
// every open board current.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Card, Column, KanbanConfig, Phase, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const COLUMNS: Array<{ id: Column; title: string; hint: string }> = [
  { id: "backlog", title: "To do", hint: "Tasks you create" },
  { id: "in_progress", title: "In progress", hint: "Threads working now" },
  { id: "in_review", title: "In review", hint: "Your work awaiting others" },
  { id: "to_review", title: "To review", hint: "Review requests and mentions" },
  { id: "done", title: "Done", hint: "" },
];

const PHASES: Array<{ id: Phase; title: string }> = [
  { id: "research", title: "Research" },
  { id: "plan", title: "Plan" },
  { id: "implement", title: "Implement" },
  { id: "review", title: "Review" },
];

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

function useBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [syncConfigured, setSyncConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("cards_list").then((result) => {
      setCards(result.cards);
      setLastSync(result.lastSync);
      setSyncConfigured(result.syncConfigured);
      setError(result.syncError);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("kanban-changed", refetch);
  return { rpc, cards, lastSync, syncConfigured, error, report, refetch };
}

function cardIcon(card: Card): string {
  if (card.kind === "task") return "SquareCheck";
  if (card.kind === "pr") return card.pr?.type === "issue" ? "CircleDot" : "GitPullRequest";
  return "MessageSquare";
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
  const gh = card.pr;
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
          name={cardIcon(card)}
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 break-words">{card.title}</span>
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {card.phase === null ? null : (
          <span className="rounded bg-muted px-1.5 py-0.5 capitalize text-foreground">
            {card.phase}
          </span>
        )}
        {card.threadId !== undefined && card.threadStatus === "active" ? (
          <span className="text-foreground">● running</span>
        ) : null}
        {card.kind === "task" && card.threadId !== undefined && card.threadStatus !== "active" ? (
          <span>thread linked</span>
        ) : null}
        {gh === undefined ? null : (
          <>
            <span className="font-mono">
              {gh.repo}#{gh.number}
            </span>
            {gh.draft ? <span>draft</span> : null}
            {gh.closed ? <span>closed</span> : null}
            {gh.source === "review-requested" ? (
              <span className="text-foreground">review requested · {gh.author}</span>
            ) : gh.source === "mentioned" ? (
              <span className="text-foreground">mentioned you · {gh.author}</span>
            ) : gh.source === "assigned" ? (
              <span>assigned</span>
            ) : null}
          </>
        )}
        <select
          aria-label={`Move "${card.title}"`}
          value={card.column}
          onChange={(event) => onMove(event.target.value as Column)}
          onClick={(event) => event.stopPropagation()}
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

function CardDialog({
  card,
  rpc,
  onClose,
  onChanged,
  onError,
}: {
  card: Card;
  rpc: Rpc;
  onClose: () => void;
  onChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  const navigate = useBbNavigate();
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState(card.projectId ?? "");
  const [threads, setThreads] = useState<Array<{ id: string; title: string; status: string }>>([]);
  const [linkThreadId, setLinkThreadId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const isTask = card.kind === "task";
  const dirty =
    title !== card.title ||
    description !== card.description ||
    (projectId === "" ? undefined : projectId) !== card.projectId;

  const canOwnThread = card.kind !== "thread";
  useEffect(() => {
    if (!canOwnThread) return;
    rpc.call("projects_list").then((list) => {
      setProjects(list);
      if (projectId === "" && list.length > 0) setProjectId(list[0]!.id);
    }, onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canOwnThread, rpc]);
  useEffect(() => {
    if (!canOwnThread || card.threadId !== undefined) return;
    rpc
      .call("threads_recent", projectId === "" ? {} : { projectId })
      .then(setThreads, onError);
  }, [canOwnThread, card.threadId, projectId, rpc, onError]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setNote(null);
    try {
      await action();
      onChanged();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", () =>
      rpc.call("task_update", {
        id: card.id,
        title,
        description,
        projectId: projectId === "" ? null : projectId,
      }),
    );
  const startThread = (phase: Phase) =>
    run("start", async () => {
      const result = await rpc.call("card_start_thread", { id: card.id, projectId, phase });
      navigate.toThread(result.threadId);
      onClose();
    });
  const setPhase = (phase: Phase) =>
    run(`phase:${phase}`, async () => {
      const result = await rpc.call("card_set_phase", { id: card.id, phase, send: true });
      setNote(
        result.sent
          ? `Sent the ${phase} prompt to the thread.${result.note === null ? "" : ` ${result.note}`}`
          : (result.note ?? "Phase updated."),
      );
    });

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name={cardIcon(card)} className="size-4 text-muted-foreground" />
            {isTask ? "Task" : card.kind === "pr" ? "GitHub item" : "Thread"}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">{card.id}</DialogDescription>
        </DialogHeader>

        {isTask ? (
          <div className="flex flex-col gap-2">
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Title"
            />
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Details, acceptance criteria, links…"
              rows={5}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <div className="flex items-center gap-2 text-sm">
              <label htmlFor="kanban-project" className="text-muted-foreground">
                Project
              </label>
              <select
                id="kanban-project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                className="rounded border border-border bg-background px-2 py-1 text-sm"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                disabled={!dirty || busy !== null}
                onClick={save}
              >
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm">{card.title}</p>
        )}

        {card.pr === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">
              {card.pr.repo}#{card.pr.number}
            </span>{" "}
            by {card.pr.author} · {card.pr.source.replace("-", " ")}
            {card.pr.closed ? " · closed" : ""}
          </p>
        )}

        <section className="rounded-md border border-border p-3">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Thread
          </h3>
          {card.threadId !== undefined ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => navigate.toThread(card.threadId!)}>
                <Icon name="MessageSquare" className="size-4" />
                Open thread
              </Button>
              {card.threadStatus === undefined ? null : (
                <span className="text-xs text-muted-foreground">{card.threadStatus}</span>
              )}
              {canOwnThread ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={busy !== null}
                  onClick={() =>
                    run("unlink", () =>
                      rpc.call("card_link_thread", { id: card.id, threadId: null }),
                    )
                  }
                >
                  Unlink
                </Button>
              ) : null}
            </div>
          ) : canOwnThread ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {isTask ? (
                  <>
                    <span className="text-sm text-muted-foreground">Start a thread in phase</span>
                    {PHASES.map((phase) => (
                      <Button
                        key={phase.id}
                        size="sm"
                        variant="outline"
                        disabled={busy !== null || projectId === ""}
                        onClick={() => startThread(phase.id)}
                      >
                        {phase.title}
                      </Button>
                    ))}
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      disabled={busy !== null || projectId === ""}
                      onClick={() => startThread("review")}
                    >
                      <Icon name="Search" className="size-4" />
                      Start review thread
                    </Button>
                    <select
                      aria-label="Project for the review thread"
                      value={projectId}
                      onChange={(event) => setProjectId(event.target.value)}
                      className="rounded border border-border bg-background px-2 py-1 text-sm"
                    >
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <select
                  aria-label="Link an existing thread"
                  value={linkThreadId}
                  onChange={(event) => setLinkThreadId(event.target.value)}
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
                >
                  <option value="">Link an existing thread…</option>
                  {threads.map((thread) => (
                    <option key={thread.id} value={thread.id}>
                      {thread.title}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={linkThreadId === "" || busy !== null}
                  onClick={() =>
                    run("link", () =>
                      rpc.call("card_link_thread", { id: card.id, threadId: linkThreadId }),
                    )
                  }
                >
                  Link
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No thread.</p>
          )}
        </section>

        {card.threadId === undefined && !isTask ? null : (
          <section className="rounded-md border border-border p-3">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Phase
            </h3>
            <div className="flex flex-wrap gap-2">
              {PHASES.map((phase) => (
                <Button
                  key={phase.id}
                  size="sm"
                  variant={card.phase === phase.id ? "default" : "outline"}
                  disabled={busy !== null}
                  onClick={() => setPhase(phase.id)}
                >
                  {phase.title}
                </Button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Selecting a phase sends its prompt to the linked thread. Review also starts a
              review round in the Code review panel when that plugin is installed.
            </p>
            {note === null ? null : <p className="mt-2 text-xs text-foreground">{note}</p>}
          </section>
        )}

        <div className="flex items-center gap-2">
          {card.pr === undefined ? null : (
            <Button size="sm" variant="outline" onClick={() => navigate.openUrl(card.pr!.url)}>
              <Icon name="ExternalLink" className="size-4" />
              Open on GitHub
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive"
            disabled={busy !== null}
            onClick={() =>
              run("delete", async () => {
                await rpc.call("card_delete", { id: card.id });
                onClose();
              })
            }
          >
            <Icon name="Trash2" className="size-4" />
            Delete card
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const ORG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

function parseOrgInput(raw: string): { orgs: string[]; invalid: string[] } {
  const orgs: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    if (part === "") continue;
    if (!ORG_PATTERN.test(part)) invalid.push(part);
    else if (!orgs.includes(part)) orgs.push(part);
  }
  return { orgs, invalid };
}

const TOKEN_SOURCE: Record<KanbanConfig["tokenSource"], string> = {
  settings: "Using the GitHub token from the plugin's settings.",
  gh: "Using your gh CLI login.",
  none: "No GitHub login found. Run gh auth login, or add a token in the plugin's settings.",
};

function SettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<KanbanConfig | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [orgText, setOrgText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("config_get", null).then(
      (result) => {
        setConfig(result);
        setEnabled(result.syncPullRequests);
        setOrgText(result.orgs.join(", "));
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);

  const { orgs, invalid } = parseOrgInput(orgText);

  const save = async () => {
    if (invalid.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      await rpc.call("config_set", { syncPullRequests: enabled, orgs });
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="Settings" className="size-4 text-muted-foreground" />
            GitHub sync
          </DialogTitle>
          <DialogDescription>
            Choose where the board pulls pull requests from.
          </DialogDescription>
        </DialogHeader>

        {config === null && error === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={enabled}
                onCheckedChange={(checked) => setEnabled(checked === true)}
                aria-label="Sync from GitHub"
              />
              Sync pull requests from GitHub
            </label>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="kanban-orgs" className="text-sm font-medium">
                Organizations
              </label>
              <Input
                id="kanban-orgs"
                value={orgText}
                onChange={(event) => setOrgText(event.target.value)}
                placeholder="my-org, another-org"
                disabled={!enabled}
                aria-invalid={invalid.length > 0}
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated. Leave empty to include every organization and repository.
              </p>
              {invalid.length > 0 ? (
                <p role="alert" className="text-xs text-destructive">
                  Not a valid organization name: {invalid.join(", ")}
                </p>
              ) : null}
            </div>

            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">Included open pull requests</p>
              <ul className="list-disc space-y-0.5 pl-4">
                <li>Pull requests you opened</li>
                <li>Pull requests that request your review by name</li>
                <li>Pull requests that @mention you in the description or a comment</li>
              </ul>
              <p className="mt-1">
                Review requests sent to a team you belong to are left out, and so are issues.
              </p>
            </div>

            {config === null ? null : (
              <p className="text-xs text-muted-foreground">{TOKEN_SOURCE[config.tokenSource]}</p>
            )}
            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || invalid.length > 0 || config === null}>
                {saving ? "Saving…" : "Save and sync"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function BoardPage() {
  const { rpc, cards, lastSync, syncConfigured, error, report, refetch } = useBoard();
  const navigate = useBbNavigate();
  const [syncing, setSyncing] = useState(false);
  const [dragOver, setDragOver] = useState<Column | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [filter, setFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const openCard = useMemo(
    () => (openId === null ? null : (cards ?? []).find((c) => c.id === openId) ?? null),
    [cards, openId],
  );

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
  const addTask = async () => {
    const title = newTitle.trim();
    if (title === "") return;
    try {
      const card = await rpc.call("task_create", { title, description: "", column: "backlog" });
      setNewTitle("");
      refetch();
      setOpenId(card.id);
    } catch (cause) {
      report(cause);
    }
  };

  const needle = filter.trim().toLowerCase();
  const visible = (cards ?? []).filter(
    (card) =>
      needle === "" ||
      card.title.toLowerCase().includes(needle) ||
      card.id.toLowerCase().includes(needle) ||
      (card.pr?.repo.toLowerCase().includes(needle) ?? false),
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col px-4 pb-4 pt-3 md:px-5 md:pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void addTask();
          }}
        >
          <Input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="New task…"
            aria-label="New task title"
            className="max-w-md"
          />
          <Button type="submit" size="sm" disabled={newTitle.trim() === ""}>
            <Icon name="Plus" className="size-4" />
            Add
          </Button>
        </form>
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter"
          aria-label="Filter cards"
          className="w-40"
        />
        <p className="text-xs text-muted-foreground">
          {!syncConfigured
            ? "GitHub sync off."
            : lastSync === null
              ? "GitHub not synced yet."
              : `GitHub synced ${new Date(lastSync).toLocaleTimeString()}.`}
        </p>
        <Button variant="ghost" size="sm" disabled={syncing} onClick={sync}>
          <Icon name="RefreshCw" className={cn("size-4", syncing && "animate-spin")} />
          Sync
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSettingsOpen(true)}
          aria-label="GitHub sync settings"
        >
          <Icon name="Settings" className="size-4" />
        </Button>
      </div>
      {error === null ? null : (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto md:grid-cols-5">
        {COLUMNS.map((column) => {
          const items = visible.filter((card) => card.column === column.id);
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
              <h2
                title={column.hint}
                className="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                {column.title} · {items.length}
              </h2>
              <ul className="flex flex-1 flex-col gap-2 overflow-y-auto">
                {items.map((card) => (
                  <CardView
                    key={card.id}
                    card={card}
                    onMove={(next) => move(card.id, next)}
                    onOpen={() => {
                      if (card.kind === "thread" && card.threadId !== undefined) {
                        navigate.toThread(card.threadId);
                      } else {
                        setOpenId(card.id);
                      }
                    }}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {settingsOpen ? (
        <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={refetch} />
      ) : null}
      {openCard === null ? null : (
        <CardDialog
          card={openCard}
          rpc={rpc}
          onClose={() => setOpenId(null)}
          onChanged={refetch}
          onError={report}
        />
      )}
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
