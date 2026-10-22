# bb-plugin-code-review

A review workbench that opens beside any bb thread.

## What it does

The **Code review** action in a thread's right panel opens a tab with two views.

**Changes** shows a diff, file by file:

- the thread's workspace, either uncommitted changes or everything since the
  base branch (read through bb's own environment diff API), or
- a pull request, either the one linked to the thread's environment or any
  `owner/repo#123` you paste (read through the GitHub REST API).

Hover a line and press `+` to leave a comment. Drafts collect per thread; **Send
to agent** turns them into one message grouped by file and line. Double-click an
identifier to search the workspace for its definition and open the file at that
line. **Rich view** swaps in bb's syntax-highlighted diff renderer. **Narrate**
asks the agent for a walkthrough (below).

**Findings** runs review rounds. **Run review** spawns a hidden worker thread
in the same environment (or, where the project refuses to share one, in the
project's default environment pointed at the workspace path). The worker reads
the diff and reports structured findings through the
`code_review_report_findings` tool. Each finding shows severity, file and line,
and the reviewer's explanation. You accept or skip it, edit the text, and set a
priority from p0 to p3. **Send accepted** delivers the accepted set to the agent
sorted by priority. Earlier rounds stay visible for the record.

**Walkthroughs** render in chat. The agent groups a change into logical change
sets with `code_review_publish_walkthrough` and emits the
`::code-review-walkthrough{id="…"}` directive, which this plugin renders as an
expandable list of titled groups with their summaries and diffs.

## Setup

```
npm install
bb plugin build
bb plugin install .
```

GitHub access uses the `gh` CLI's login. To use a token instead:

```
bb plugin config code-review set githubToken <token>
```

`reviewInstructions` holds standing instructions appended to every round.

## CLI

```
bb code-review run [--thread <id>] [--source auto|workspace|pr]
bb code-review findings [--thread <id>] [--json]
bb code-review accept <finding-id> [--priority p0..p3]
bb code-review skip <finding-id>
bb code-review comments [--thread <id>]
```

## Works with the kanban plugin

Setting a kanban card's phase to **Review** calls this plugin's `review_run`
RPC for the card's thread, so a round starts without opening the panel. Threads
started from a GitHub card carry the PR URL in kanban's thread metadata, and the
Changes view picks it up as a source.

## Layout

- `server.ts` — settings, kv storage per thread, GitHub client, review worker
  lifecycle, RPC, agent tools, CLI.
- `shared.ts` — constants used by both bundles. No Node imports.
- `app.tsx` — the panel (Changes, Findings), the patch parser and diff view, and
  the walkthrough directive.
- `skills/code-review/SKILL.md` — tells agents how findings, comments, and
  walkthroughs flow.
