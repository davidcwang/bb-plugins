---
name: jira
description: Jira plugin — browse and create Jira Cloud issues in the configured source projects, and sync issues assigned to the user onto the Kanban board. Use when the user asks about their Jira tickets, wants a ticket created, or asks why a Jira issue is or is not on the board.
---

# Jira

Connects one Jira Cloud site with the user's Atlassian email and API token,
plus a list of project keys (the "source"). Empty projects means every
project the account can see.

## UI

The **Jira** sidebar page has four tabs:

- **My issues** — assigned to you, open or finished in the last 7 days.
- **Project** — every issue in the source projects (with no projects set, issues
  updated in the last 90 days, since Jira refuses unbounded searches). Search
  by text or key.
- **Create** — project, issue type, summary, plain-text description, and
  "Assign to me" (on by default).
- **Source** — site, email, API token (write-only; leave empty to keep it),
  projects (add by key or look up by name), and the Kanban sync toggle.
  Save tests the connection.

Click a row to see its description; **Open in Jira** opens the issue.

## Kanban

With **Sync to Kanban** on, every five minutes (and after saving the source
or creating an assigned issue) the plugin sends the issues assigned to you to
the kanban plugin's `jira_sync` RPC. Each becomes a `jira:<KEY>` card:
To Do → To do, In Progress → In progress, Done → Done, until someone moves
the card by hand. Issues no longer assigned move to Done and drop off after a
week. Starting a thread from the card works like a task card; the issue key
and URL are in the card description the thread receives. Moving a card does
not transition the Jira issue.

## Commands

    bb jira status                      # site, projects, last sync
    bb jira list [--all] [--project KEY] [--search TEXT] [--json]
    bb jira show KEY-123 [--json]
    bb jira create "Summary" [--project KEY] [--type Task] [--description TEXT] [--unassigned]
    bb jira sync                        # push assigned issues to Kanban now

`create` needs `--project` unless exactly one source project is set.

## Agent tools

- `jira_search` — read-only; scope `mine` or `project`, optional text.
- `jira_create_issue` — creates a real issue visible to the team. Only use it
  when the user asked for a ticket, and confirm summary and project first
  unless the user already gave both.

## Settings (`bb plugin config jira`)

`siteUrl`, `email`, `apiToken` (secret), `projects`, `syncToKanban`
(default on), `openInBrowser` (default on; BB's in-app browser is usually not
signed in to Jira). The Source tab edits the same values.
