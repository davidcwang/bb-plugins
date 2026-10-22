---
name: usage-meter
description: Usage Meter plugin — the "ctx % · 5h % ↻reset · wk % ↻reset" readout in the thread composer. Use when the user asks what those numbers mean, where they come from, or why one is missing.
---

# Usage meter

Read-only readout in each thread composer's action row, refreshed every 10 s
while the window is visible.

- **ctx** — the thread's context window use, from `bb thread context`
  (the same number; "estimated" when the provider has not reported exact
  usage yet).
- **5h** — the provider's current session (five-hour) limit.
- **wk** — the provider's general weekly limit.
- A model name (for example **Fable**) appears when a model-specific weekly
  limit is higher than the general weekly one.

Each limit is followed by a countdown to its reset, such as `↻4h12m` or
`↻2d3h`. A model window that resets at the same moment as the weekly limit
does not repeat it. Hover the readout for token counts, every window, and reset times. Colors: green
under 50 % used, amber from 50 %, red from 80 %.

Limit windows come from the thread provider plugin's `provider-usage.v1` RPCs,
the same data as BB's Provider usage plugin, cached for 60 s on the server.
The account email never leaves the server. A segment is missing when the
provider does not report it, or when the thread has not run a turn yet.
