---
name: code-review
description: Use the Code review plugin's tools when the user asks for a review round, a walkthrough or narration of changes, or when accepted findings or inline comments arrive from the Code review panel.
---

# Code review workbench

The user reviews your changes in the **Code review** panel beside this
thread. Three things flow between you and that panel.

## Walkthroughs

When asked to walk through, narrate, or summarize your changes, group the
diff into logical change sets (by behavior or feature, not by file). Call
`code_review_publish_walkthrough` with a `title` and `groups`; each group has
a `title`, a `summary`, and `hunks` (`path`, optional `startLine`/`endLine`,
and the hunk's unified `patch` text from `git diff`). Put the directive the
tool returns on its own line in your reply so the chat renders it.

## Findings

Accepted findings arrive as one message headed "Code review: please address
these … accepted finding(s)", sorted p0 first. Work through them in order.
For each, say what you changed, or explain why you disagree. Do not re-report
them.

If the user asks you to review code yourself (not a worker), call
`code_review_report_findings` once with every finding instead of listing them
in prose, so the user can triage them in the panel.

## Inline comments

Comments arrive as one message headed "Code review comments", grouped by file
with line numbers. Make each change or reply to it one by one.

## CLI

| Command | Effect |
| --- | --- |
| `bb code-review run [--source auto\|workspace\|pr]` | Start a review round for this thread. |
| `bb code-review findings [--json]` | List findings and their triage status. |
| `bb code-review accept <id> [--priority p0..p3]` / `skip <id>` | Triage on the user's behalf only when asked. |
| `bb code-review comments` | List inline comments. |

## Rules

- Never edit files when you are a review worker; only report findings.
- Never send findings to yourself; the user decides what is accepted.
