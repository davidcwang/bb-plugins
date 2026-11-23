---
name: github-prs
description: The GitHub PRs plugin tracks the user's open pull requests and their review comments. Use when the user asks about their open PRs, review comments to address, or mentions the PR panel.
---

# GitHub PRs plugin

The user reviews their own open PRs in the "Pull Requests" sidebar page:
diff, files, review-comment threads with triage state (pending / address /
won't fix / done), AI-drafted replies they edit and post, reactions, and
proposed fixes they can apply to the local checkout.

CLI:

- `bb github-prs list [--refresh] [--json]` — their open PRs (GitHub search
  query from plugin settings), with unresolved-thread counts and check state.
- `bb github-prs comments <owner/repo#number> [--json]` — a PR's unresolved
  review threads with the user's triage state.

GitHub access uses the `gh` CLI's login. Reply drafting and fix proposals run
in hidden worker threads; results appear in the panel, not in chat. Do not
post PR replies yourself unless the user explicitly asks — the panel flow
exists so the user edits and posts drafts.
