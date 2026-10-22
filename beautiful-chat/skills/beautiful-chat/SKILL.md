---
name: beautiful-chat
description: Beautiful Chat plugin — CSS restyle of BB's native chat (composer, messages, work rows, background commands) in BeautifulUI's design language, using the active theme's colors.
---

# Beautiful Chat

It changes how BB's native chat looks, not how it behaves. Every feature below
has a setting (Settings → Plugins → Beautiful Chat, or
`bb plugin config beautiful-chat`): `loader` (drive | dots | orbit | coins | bb),
`toolChips` (surface | outline | plain), and on/off switches `shimmer`,
`workRows`, `streamingCaret`, `approvalCard`, `promptBar`, `userBubbles`,
`codeChips`, `selectionPill`, `messageActions`, `unreadMarker`, `mergedBanners`, `minimizeWhileRunning`, `treeLines`. Disable or remove it to revert
everything: `bb plugin disable beautiful-chat` / `bb plugin remove beautiful-chat`.

- Composer (`form[data-promptbox]`): 14px radius, hairline border that firms up on
  focus, soft shadow; 28px filled send/stop button; chip-style icon buttons.
- User messages: filled 12px pills without a border.
- Assistant replies: inline code as hairline chips, code blocks as hairline cards.
- Work rows ("Worked for…", "Explored…", commands, reasoning, answers): compact
  12.5px pills sized to their label with a hover fill; expanded details hang off a
  thin guide line.
- Background commands card: 10px hairline card.
- Loading & thinking: pending labels ("Thinking…", "Running", "Waiting for
  permission") use BeautifulUI's 1.4s shimmer, and their icon becomes a 3×3
  pixel-grid loader (static under reduced motion).
- Streaming text: a caret trails the reply while a run is live and the reply is
  the latest row.
- Tool chips: individual tool calls sit on hairline surfaces; details open with a
  300ms ease-out.
- Approval card: permission and question banners are raised 10px cards that
  fade up; decisions are 27px pills; question options use hairline radios.
- Prompt bar: 28px controls with 8px radius and press scale.
- Selection actions: the "Add to chat / Reply in side chat" popover is a pill.
- Tree lines: rows inside an expanded work group are indented under its header
  and joined by a trunk with rounded elbows into each row's icon.
- Minimize while generating: while a run is live and the prompt box is empty
  ("Stop run" on the send button), the box uses BB's one-line compact layout.
  Typing a follow-up ("Steer current run") grows it back.
- Composer banners: background commands, git, and parent/child thread banners
  share one card with hairline dividers instead of stacking as separate cards.
- Unread marker: the first unread work row prints NEW after its own label
  (success colour, row's text size, 8px gap) instead of BB's separator and rule
  above it. Message rows keep BB's separator.
- Spatial tooltips (`spatial-tooltip.ts`): in a row of 3+ tooltip buttons (message
  actions, composer icon rows) one shared bubble glides and resizes between
  siblings. BB's Radix tooltips still decide when to open and supply the
  screen-reader text; their bubble is only hidden visually.
- No entrance animations (rows mount while scrolling); press feedback respects
  `prefers-reduced-motion`.

Design reference: BeautifulUI (https://www.beautifului.dev, MIT). No BeautifulUI
code is bundled; only its visual language is applied, with BB theme colors.
BB's chat markup is not a public API, so a BB update can change what these
selectors match.
