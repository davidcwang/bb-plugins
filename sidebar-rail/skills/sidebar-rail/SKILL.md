---
name: sidebar-rail
description: Sidebar Rail plugin — collapsing BB's left sidebar (⌘\) leaves an icon-only rail instead of hiding it. Use when the user asks how to collapse the sidebar to icons, change the shortcut, or why the collapsed sidebar still shows icons.
---

# Sidebar Rail

While this plugin is enabled, collapsing the app sidebar leaves a 48 px rail
with the navigation icons (New thread, Plugins, Skills, plugin panels, More)
and the footer icons. Threads stay visible as coloured two-letter badges
(initials from the first non-filler words of the title, colour fixed per
thread id, ring on the open thread); hover shows the full title, click opens
it, and the vim plugin's sidebar cursor moves over them. The expanded
sidebar shows the same badge, same size, in front of each thread title. Expanding the
sidebar restores the normal layout.

- Shortcut: BB's own `sidebar.toggle` command, ⌘\ by default (rebound to ⌘E on this install). The header
  toggle button works too. Rebind with
  `bb settings keyboard set sidebar.toggle <shortcut>` or in
  Settings → Keyboard.
- To hide the sidebar completely again, disable the plugin:
  `bb plugin disable sidebar-rail`.
- Drag: pulling the sidebar's resize edge left past x≈120 px collapses it to
  the rail (BB's own drag stops at a minimum width); pulling the rail's edge
  right past x≈160 px expands it.
- Desktop widths only (≥ 768 px); the compact/mobile drawer is unchanged.
- The rail is a CSS override of BB's app-shell DOM (`app.css`). If a BB update
  changes the sidebar markup, the rail can break; check selectors there first.
