---
name: kanban
description: Keep the user's Kanban board current with `bb kanban` or the `kanban_move` and `kanban_task` tools. Use when you start work, need the user's review, open a PR, finish a task, or when the user asks to create, link, or move a card or to advance a task's phase.
---

# Kanban board

Cards are tasks the user created, threads, and GitHub items (PRs the user
authored, PRs requesting their review, issues or PRs that mention them,
assigned issues). Columns: `backlog`, `in_progress`, `in_review` (the user's
work awaiting someone else), `to_review` (things the user must review), `done`.

A task card can own a thread. Threads started from a card carry the card id
and phase in plugin metadata, and your instructions name that card. Phases:
`research`, `plan`, `implement`, `review`.

## Commands

| Command | Effect |
| --- | --- |
| `bb kanban list [--column <c>] [--json]` | Show cards with their ids. |
| `bb kanban add <title> [--description <text>] [--column <c>]` | Create a task card. |
| `bb kanban move <card> <column>` | Move a card. `<card>` is a card id, a thread id, or a unique id or title prefix. |
| `bb kanban link <card> [--thread <id>] [--unlink]` | Attach this thread (or another) to a task card. |
| `bb kanban phase <card> <phase> [--no-send]` | Set the phase; by default the phase prompt is sent to the linked thread. |
| `bb kanban remove <card>` | Delete a card. |
| `bb kanban sync` | Pull GitHub items now. |

Tools: `kanban_move` (omit `card` to move this thread's card) and
`kanban_task` (create a card; `link: true` attaches this thread).

## Procedure

1. When you start real work, move your card to `in_progress`.
2. When you open a PR or need the user to look at something, move it to `in_review`.
3. When the task is finished and nothing is waiting on anyone, move it to `done`.
4. Move only your own card unless the user asks otherwise.
5. If the user describes a new piece of work in passing, offer `kanban_task`
   rather than creating a card silently.

## Rules

- Never guess a card id; run `bb kanban list` first.
- A moved card is pinned: GitHub sync will not move it back.
- Do not change phase yourself unless the user asks; the user drives phases.
