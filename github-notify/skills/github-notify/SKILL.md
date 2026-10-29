---
name: github-notify
description: GitHub Notify plugin — desktop notifications and toasts for comments, reviews, assignments, and mentions on your GitHub pull requests. Use when the user asks why a GitHub notification did or did not arrive, how to change which events alert, or to send a test notification.
---

# GitHub Notify

Polls GitHub's notifications API (the feed behind github.com/notifications)
with your own token, so it covers every repo you can read and needs no org
approval or Slack app. It is already scoped to you: PRs you authored, were
assigned, were asked to review, commented on, or were mentioned in.

Each new or updated notification shows an in-app toast with an **Open**
button and, unless disabled, a system notification that opens the PR (or
the exact comment) on click. Alerts only appear while a BB window is open;
the poller keeps running and records what it saw, but signals are not
replayed to windows opened later. `bb github-notify recent` lists them.

## Commands

    bb github-notify status     # last poll, last error, enabled reasons
    bb github-notify recent     # last 50 notifications sent
    bb github-notify test       # sample notification to every open window

## Settings (`bb plugin config github-notify`)

- `githubToken` — optional secret. Empty uses `gh auth token`. Must be a
  classic token or gh's OAuth token with `notifications` or `repo` scope;
  fine-grained tokens cannot read notifications.
- `reasons` — comma-separated GitHub reasons. Default
  `author,assign,comment,mention,review_requested`. `author` covers any
  activity on PRs you opened; `assign` fires when you are assigned.
- `includeIssues` — also alert on issues (default PRs only).
- `desktop` — system notification in addition to the toast (default on).
- `enabled` — pause polling.

## Behaviour

- Poll interval follows GitHub's `X-Poll-Interval` (60 s minimum). Requests
  send `If-Modified-Since`, so an unchanged feed is a 304 that does not
  count against the rate limit.
- The first poll records the current unread backlog without alerting.
- Only unread notifications are in the feed: marking one read on GitHub
  stops nothing, and new activity on it alerts again.
- GitHub only notifies about things you participate in or watch; your own
  actions never notify. If something is missing here, check
  github.com/notifications first.
