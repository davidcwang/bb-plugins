# github-prs

A GitHub PR review workbench for your own open pull requests, as a BB
sidebar page ("Pull Requests").

- **List** — your open PRs (configurable GitHub search query, default
  `is:open is:pr author:@me archived:false`): review decision, checks,
  unresolved-thread counts, +/− stats.
- **PR view** — Overview (description, checks, reviews, conversation),
  Files (per-file diffs), Comments (review threads with the diff hunk
  under discussion).
- **Triage** — mark each thread pending / address / won't fix / done
  (plugin-local state, never posted to GitHub).
- **Replies** — "Draft reply" spawns a hidden worker thread that reads the
  PR and the local checkout and publishes a draft; you edit it in place and
  Post (or Post & resolve). Reactions (👍 🎉 …) toggle on any comment.
- **Proposed fixes** — "Propose fix" spawns a read-only worker that
  produces a unified patch (validated with `git apply --check` before it is
  accepted); the panel previews it per file and "Apply locally" runs
  `git apply --3way` in your checkout so you can inspect the change with
  your normal git tooling.

GitHub access uses the `gh` CLI's login (read via GraphQL/REST, writes via
REST + `resolveReviewThread`). Local checkouts are matched by origin URL
under the configured repos directory (default `~/repos`).

CLI: `bb github-prs list`, `bb github-prs comments <owner/repo#number>`.

Settings: `searchQuery`, `reposDir`, `replyVoice` (standing guidance for
drafted replies).
