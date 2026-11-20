---
name: jira
description: Jira plugin — browse and create Jira Cloud issues in the configured source projects, and sync issues assigned to the user onto the Kanban board. Use when the user asks about their Jira tickets, wants a ticket created, or asks why a Jira issue is or is not on the board.
---

# Jira

Connects one Jira Cloud site with the user's Atlassian email and API token,
plus a list of project keys (the "source"). Empty projects means every
project the account can see.

## UI

The **Jira** sidebar page has five tabs:

- **My issues** — assigned to you, open or finished in the last 7 days.
- **Project** — every issue in the source projects (with no projects set, issues
  updated in the last 90 days, since Jira refuses unbounded searches). Search
  by text or key.
- **Drafts** — tickets written in BB that are not in Jira yet. A Draft column
  on the left, oldest first; click one to edit it on the right: summary, project, type
  (sub-tasks included), description, assignee, reporter, labels, parent, and
  linked issues (blocks, is blocked by, and the site's other link types).
  Edits autosave locally. **Create in Jira** files it, adds the links, and
  removes the draft; a link that fails is reported and the issue is kept.
  Fields not on the project's create screen are disabled with a note.
  Descriptions are Markdown (here and on the Create tab): headings, nested
  lists, fenced code, pipe tables, links and bare URLs, bold, italic and
  inline code are converted to Jira's ADF on create. A single newline is a
  line break; `snake_case` stays literal.
- **Create** — project, issue type, summary, Markdown description, and
  "Assign to me" (on by default).
- **Source** — site, email, API token (write-only; leave empty to keep it),
  projects (add by key, a pasted board or issue URL, or look up by name), and the Kanban sync toggle.
  Save tests the connection.

On **My issues** and **Project**, click a row to open the issue in an editor
on the right (same fields as a draft). Nothing is saved until **Update in
Jira**, which sends only what changed and adds or removes links. Fields not on
the issue's edit screen are disabled. The update is refused if the issue
changed in Jira after it was opened (reload, then redo the edit). The
description is shown as Markdown; if it holds content Markdown can't carry
(images, panels, @mentions, colors) the editor says so, and that content is
only lost if you edit the description. Status and issue type are read-only.

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
- `jira_get_issue` — read-only; one issue's editable fields, its `updated`
  stamp, which fields its edit screen allows, and the description as Markdown.
- `jira_update_issue` — changes an existing issue in Jira. Only when the user
  asked. Read it with `jira_get_issue` first and pass its `updated` as
  `expectedUpdated`; the update is refused if the issue changed since. Pass
  only the fields to change: `summary`, `description` (full Markdown
  replacement), `assignee` / `reporter` (`"me"`, `"none"` for assignee, or a
  name or email), `labels` or `addLabels`/`removeLabels`, `parent` (key or
  `"none"`), `addLinks` / `removeLinks`. Replacing a description that holds
  images, panels or mentions needs `allowDroppingDescriptionContent: true`,
  which only the user can approve. Tell the user exactly what changed.
- `jira_drafts` — list drafts with their ids.
- `jira_update_draft` — edit a draft's summary, description, labels, parent,
  assignee or reporter; nothing goes to Jira.
- `jira_draft` — saves a draft on the Drafts tab; nothing goes to Jira. Prefer
  it when the user wants a ticket written but has not asked to file it.
- `jira_create_issue` — creates a real issue visible to the team. Only use it
  when the user asked for a ticket, and confirm summary and project first
  unless the user already gave both.

## Settings (`bb plugin config jira`)

`siteUrl`, `email`, `apiToken` (secret), `projects`, `syncToKanban`
(default on). The Source tab edits the same values.

Links open through BB, so they follow Settings → General → Links → "Open
links in the in-app browser". Turn it off to open them in the default browser,
where you are signed in to Jira.
