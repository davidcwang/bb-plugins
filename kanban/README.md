# bb-plugin-kanban

A kanban board in the bb sidebar for tasks, threads, and GitHub items.

## Columns

| Column | What lands there |
| --- | --- |
| To do (`backlog`) | Tasks you create |
| In progress | Threads that are running, draft PRs you authored |
| In review | PRs you authored that await review |
| To review | PRs that request your review by name, PRs that mention you |
| Done | Archived threads, merged or closed items, anything you drag there |

**Archived** is a status, not a column. Pick it from a card's menu to take the
card off the board. The **Archived** button lists archived cards, most
recently archived first, with **Restore** to put one back in the column it came
from. Sync, thread activity, and the one-week Done cleanup never touch archived
cards.

Drag cards between columns or use the picker on each card. A card you move is
pinned: sync and lifecycle events stop moving it.

## Cards

- **Tasks** are yours. Add one from the box at the top, the `bb kanban add`
  command, or the `kanban_task` agent tool. Open a task to edit its details,
  pick a project, and work with its thread.
- **Threads are not added on their own.** The board holds only cards you add
  and GitHub pull requests. A thread shows up through the card it is linked
  to: started from a card, or attached with **Link an existing thread**. When
  a linked thread goes active its card moves to In progress, and archiving
  moves it to Done. Idle is not mapped, because an idle agent may be waiting
  on you.
- **GitHub pull requests** sync every five minutes (or with **Sync**) using
  the `gh` CLI login or a token from settings. Only open PRs you opened, PRs
  that request your review by name, and PRs that @mention you in the
  description or a comment. Team review requests and issues are never
  included. Closed or merged PRs move to Done and leave after a week.
- **Settings** (the gear next to **Sync**) turns sync on or off and limits it
  to one or more GitHub organizations; empty means every organization.

## Threads per card

A task or GitHub card can own one thread.

- **Start a thread in phase** spawns a thread in the chosen project with a
  prompt for that phase and tags it with the card id in plugin metadata.
  Phases: research, plan, implement, review. Starting a thread from a GitHub
  card opens a review thread for that PR.
- **Link an existing thread** attaches a running thread to a task or GitHub
  card.
- **Phase** buttons send the next phase prompt to the linked thread. Choosing
  Review also starts a review round in the code-review plugin when it is
  installed.

Agents see which card they belong to and keep it current with `kanban_move`.

## CLI

```
bb kanban list [--column <c>] [--json]   # --column archived lists the archive, newest first
bb kanban add <title> [--description <text>] [--column <c>]
bb kanban move <card> <column>
bb kanban link <card> [--thread <id>] [--unlink]
bb kanban phase <card> <phase> [--no-send]
bb kanban restore <card>
bb kanban remove <card>
bb kanban sync
```

`<card>` is a card id, a thread id, or a unique prefix of either or of a title.

## Setup

```
npm install
bb plugin build
bb plugin install .
bb plugin config kanban            # githubToken, syncPullRequests, githubOrgs
```

## Layout

- `server.ts` — card store in `bb.storage.kv`, thread lifecycle handlers,
  GitHub sync, RPC, CLI, agent tools, agent configuration.
- `app.tsx` — the board page and the card dialog.
- `skills/kanban/SKILL.md` — how agents keep the board current.
