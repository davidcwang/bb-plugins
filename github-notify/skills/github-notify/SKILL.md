---
name: github-notify
description: GitHub Notify plugin — desktop notifications and toasts for comments, reviews, assignments, and mentions on your GitHub pull requests. Use when the user asks why a GitHub notification did or did not arrive, how to change which events alert, or to send a test notification.
---

# GitHub Notify

Polls GitHub's notifications API (the feed behind github.com/notifications)
with your own token, so it covers every repo you can read and needs no org
approval or Slack app.

GitHub's notification reason alone is too coarse: team review requests use
the same `review_requested` reason as personal ones, and a thread keeps its
first reason for every later comment or push. So each update is checked
against what actually happened at that moment (the new comment, review, or
timeline event), and alerts only when:

- someone else comments on or reviews (approves, requests changes) your PR;
- you personally, not a team you are in, are requested as reviewer or
  assigned by someone else;
- the new comment, review, or a newly opened PR's description @mentions you.

Your own actions and, by default, bot accounts never alert.

Each new or updated notification shows an in-app toast with an **Open**
button and, unless disabled, a system notification that opens the PR (or
the exact comment) on click. Alerts only appear while a BB window is open;
the poller keeps running and records what it saw, but alerts are not
replayed to windows opened later.

The **GitHub Notify** sidebar page lists the last 100 notifications, newest
first; click one to open it. The sidebar entry shows how many arrived since
the page was last opened, and opening the page marks them read (in BB only;
nothing is marked read on GitHub). **Clear** empties the list.

## Commands

    bb github-notify status     # last poll, last error, enabled reasons
    bb github-notify check [--repo owner/name] [--limit N]
                                # dry run: would each recent notification alert?
    bb github-notify recent     # last 100 notifications sent
    bb github-notify test       # sample notification (also added to the page)

## Settings (`bb plugin config github-notify`)

- `githubToken` — optional secret. Empty uses `gh auth token`. Must be a
  classic token or gh's OAuth token with `notifications` or `repo` scope;
  fine-grained tokens cannot read notifications.
- `reasons` — comma-separated kinds to alert on. Default
  `author,assign,mention,review_requested` (as above). `comment` adds new
  comments on other threads you commented on. `team_mention`,
  `state_change`, `ci_activity`, `subscribed`, `manual` alert on any update
  GitHub files under them, unchecked.
- `ignoreBots` — skip comments and reviews from `*[bot]` accounts (default on).
- `openInBrowser` — open notifications in the system browser (default on).
  BB's in-app browser is usually not signed in to GitHub, so private repos
  show 404 there.
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
