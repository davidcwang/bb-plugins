---
name: vim-keys
description: Vim-style keybindings for the BB app (plugin "vim"). Use when the user asks which vim keys work in BB, how to turn vim mode on or off, or why a key is not responding.
---

# Vim keys in BB

The `vim` plugin is frontend-only. It has no CLI command and stores nothing on
the server; the only persisted value is an on/off flag in the browser's
localStorage. Toggle it from the quick palette (Mod+Shift+P) with
"Vim: toggle vim keybindings". Press `?` with nothing focused for the cheat
sheet, or run "Vim: show key cheat sheet".

## Modes

The badge in the bottom-right corner shows the mode.

- **NAV** — nothing editable has focus. `j`/`k` scroll the thread, `J`/`K`
  jump by message, `Ctrl-d`/`Ctrl-u` half page, `gg`/`G` top/bottom,
  `i`/`a`/`A`/`I`/`o` focus the composer, `H` (or `Ctrl-w h`) enters the
  sidebar.
- **SIDEBAR** — a cursor outline sits on a thread row. `j`/`k`, `gg`/`G`
  move it and the main view follows immediately, so you can browse
  conversations without pressing Enter. `k` past the first thread moves onto
  the navigation rows above (New thread, Plugins, Skills, Kanban, RFCs, …);
  those don't open on hover, `Enter` activates one. `gg`/`G` go to the
  first/last thread. `Enter`/`l`/`o` commits and returns focus to the
  thread; `Esc`/`h`/`L` leaves without changing the cursor.
- **INSERT** — composer focused; keys type normally. `Esc` (or `Ctrl-c`, which
  equals `Esc` everywhere) goes to NORMAL.
- **NORMAL** — composer focused, vim motions and operators (`h j k l w b e
  0 ^ $ gg G`, `x X s S D C dd cc d{motion} c{motion} yy p P u Ctrl-r`,
  counts). `Enter` still sends the message. `Esc` leaves the composer; `H`
  leaves it straight to the sidebar cursor and `L` back to the thread.
- **PALETTE** (Cmd+K, Cmd+Shift+P) — palettes open in this mode: `j`/`k`
  move, `gg`/`G` jump, `Enter`/`l`/`o` run, `i`/`a`/`/` switch to typing.
  While typing, `Esc` returns to PALETTE mode; in PALETTE mode `Esc` closes.
  `Ctrl-j`/`Ctrl-k`, `Ctrl-n`/`Ctrl-p`, `Ctrl-d`/`Ctrl-u`, `Ctrl-y`, `Ctrl-c`
  work in both modes.
- **VISUAL** — `v`/`V` from NORMAL; motions extend, `d x c y p` act on it.

## Other plugins' panels

No opt-in is needed. The vim plugin works on the DOM every plugin renders:

- Any `<textarea>` and any `contenteditable` region gets INSERT/NORMAL/VISUAL
  exactly like the composer (`Esc` → NORMAL, `i` → INSERT, `Esc` again leaves).
  Edits go through `document.execCommand`, so React `onChange` and the native
  undo stack both see them. Single-line `<input>` fields are left alone.
- `j`/`k`, `Ctrl-d`/`Ctrl-u`, `gg`/`G` scroll the nearest scrollable
  ancestor of the focused element, else of the last click, else BB's thread
  viewport, else the largest scrollable region on screen.

Optional markers for plugin authors, when the defaults pick wrong:

- `data-vim-scroll` on a container: prefer it as the scroll target when focus
  or the last click is inside it.
- `data-vim-ignore` on a region: the vim plugin leaves every key inside it to
  the region's own handlers (custom keyboard widgets, code editors with their
  own vim mode).

Rules that keep a plugin compatible: do not bind unmodified letters as
hotkeys on `document` or `window`; do not call `stopPropagation` on
`keydown` in the capture phase; use BB's `app.commands.register` for
shortcuts so they are rebindable.

## Constraints

- Keys are ignored while a dialog, menu, palette, or mention popup is open,
  and inside inputs that are not a BB composer (search fields, terminal).
- Composer editing works on the DOM selection, not ProseMirror's model, so
  `w` approximates word starts and edits inside mention chips may be refused.
- Only the current BB version's DOM attributes are targeted; if a key stops
  working after a BB update, check `vim/dom.ts` selectors first.
