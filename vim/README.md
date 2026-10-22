# bb-plugin-vim

Vim-style keyboard navigation for BB. Frontend-only: one content script owns
the keyboard, an overlay shows the mode, two palette commands toggle it.

    bb plugin install path:$PWD/.. --plugin vim   # from this repo
    cd vim && bb plugin dev                       # iterate

Press `?` with nothing focused for the in-app cheat sheet. Full key list and
limits: [skills/vim-keys/SKILL.md](skills/vim-keys/SKILL.md).

## Other plugins

Nothing to import. Textareas, contenteditables and scrollable regions in any
plugin get vim keys automatically; `data-vim-scroll` and `data-vim-ignore`
are optional overrides. See `skills/vim-keys/SKILL.md`, "Other plugins'
panels".

## Layout

- `vim/dom.ts` — every BB DOM selector the plugin depends on (composer,
  timeline viewport, sidebar rows). Fix here first after a BB update.
- `vim/editor.ts` — normal/visual mode inside the Tiptap composer, driven by
  `Selection.modify` and `execCommand`, with undo/redo and newlines forwarded
  as synthetic keydowns.
- `vim/nav.ts` — scrolling (any region), message jumps, sidebar cursor.
- `vim/textarea.ts` — normal/visual mode for plain textareas (other plugins).
- `vim/palette.ts` — PALETTE mode for Cmd+K / Cmd+Shift+P.
- `vim/engine.ts` — document listeners, mode transitions, injected CSS.
- `vim/store.ts` — tiny external store; `app.tsx` renders the overlay from it.
