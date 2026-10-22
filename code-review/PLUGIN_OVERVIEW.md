A code review workbench that opens beside any thread.

## What you get

- A **Code review** tab in the thread panel with three views:
  - **Changes** shows the thread's workspace diff (uncommitted, or everything
    since the base branch) or its pull request, file by file. Click a line to
    leave a comment, then send all drafts to the agent as one message.
    Double-click an identifier to jump to its definition in the workspace.
  - **Findings** runs a review round in a hidden worker thread. Findings land
    here first; you accept, skip, edit, and prioritize them (p0 to p3) before
    the accepted ones are sent to the agent.
  - **Walkthrough** asks the agent to narrate the change as logical change
    sets, rendered inline in the chat with their diffs.
- A `bb code-review` command for agents and scripts.

## Setup

GitHub access uses the `gh` CLI login, or a token set with
`bb plugin config code-review`. Workspace diffs need no setup.

## Works with Kanban

Moving a Kanban card into its review phase starts a review round here.
