A kanban board in the sidebar where every thread is a card and agents move cards
as work progresses.

## What you get

- A **Kanban** page with Backlog, In progress, In review, and Done columns.
  Drag cards, or use the column picker on each card.
- Threads become cards automatically and move to In progress when they start
  running; archiving moves them to Done.
- Open PRs you authored and PRs that request your review sync from GitHub every
  five minutes (or with **Sync PRs**).

## Setup

Set a GitHub token (pull requests: read) with `bb plugin config kanban`.
Without one the board still tracks threads; PR sync stays off.

## For agents

The bundled skill and `kanban_move` tool let an agent move its own card.
