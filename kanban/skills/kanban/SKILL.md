---
name: kanban
description: Keep this thread's card on the Kanban board current with `bb kanban move` or the `kanban_move` tool. Use when you start work, need the user's review, open a PR, or finish a task.
---

# Kanban board

Every thread is a card; open PRs you authored or were asked to review sync in
from GitHub. Columns: `backlog`, `in_progress`, `in_review`, `done`.

## Commands

| Command | Effect |
| --- | --- |
| `bb kanban list [--column <c>] [--json]` | Show cards with their ids. |
| `bb kanban move <card> <column>` | Move a card. `<card>` is a card id, a thread id, or a unique id prefix. |
| `bb kanban sync` | Pull PRs from GitHub now. |

The `kanban_move` tool does the same; omit `card` to move this thread's card.

## Procedure

1. When you start real work, move your card to `in_progress`.
2. When you open a PR or need the user to look at something, move it to `in_review`.
3. When the task is finished and nothing is waiting on anyone, move it to `done`.
4. Move only your own card unless the user asks otherwise.

## Rules

- Never guess a card id; run `bb kanban list` first.
- A moved card is pinned: PR sync will not move it back.
