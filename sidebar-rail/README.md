# Sidebar Rail

Collapse BB's left sidebar to an icon rail instead of hiding it.

- Toggle with BB's sidebar shortcut, ⌘\ (rebind in Settings → Keyboard,
  command `sidebar.toggle`), or the sidebar button in the header.
- Collapsed: a 48 px rail with the navigation icons, one coloured two-letter
  badge per thread (letters from the title, colour fixed per thread, ring on
  the open one), and the footer icons; hover anything for its name.
  Expanded: the same badge, same size, in front of each thread title, so you
  learn which colour is which thread.
- Dragging the sidebar edge almost to the window edge snaps it to the rail;
  dragging the rail's edge outward expands it again.
- Desktop widths only. Disable the plugin to get the fully hidden sidebar back.

`app.css` overrides BB's sidebar markup (data attributes such as
`data-sidebar`, `data-state`, `data-sidebar-navigation-item`); `app.tsx` is one
content script that sets `html[data-sidebar-rail]`, adds hover titles, and
tags thread rows with `data-rail-initials` / `data-rail-hue` /
`data-rail-current` for the badges.

    npx tsc -p tsconfig.json && bb plugin build && bb plugin reload sidebar-rail
