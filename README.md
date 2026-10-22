# bb-plugins

Personal BB plugins, one directory per plugin. `.bb/plugins.json` indexes them.

    ./install.sh                                    # install all
    ./install.sh <name>                             # install one
    bb plugin install path:$PWD --plugin <name>   # same thing by hand
    cd <name> && bb plugin dev                      # iterate

Third-party plugins are vendored copies at a reviewed commit; see SOURCES.md.
Nothing upgrades on its own.

| Plugin | Purpose |
| --- | --- |
| kanban | Board for tasks, threads, and GitHub items; start or link a thread per card and drive it through phases |
| code-review | Review workbench beside a thread: diff + inline comments, triaged review rounds, narrated walkthroughs |
| usage-meter | Context %, 5-hour and weekly limit % in the thread composer |
| vim | Vim-style keys: modal composer editing, j/k thread scrolling, sidebar thread cursor |
| beautiful-chat | Restyles BB's chat in BeautifulUI's design language (vendored, pinned) |
| aura | Custom image backgrounds and dithered patterns for threads (vendored, pinned) |
| rfcs | RFC workbench beside a thread: live markdown preview with mermaid + D2 diagrams, editor, triaged review rounds, a discussion thread per finding |
| sidebar-rail | Collapsing the left sidebar (⌘\\) leaves an icon-only rail instead of hiding it |

## Conventions for new plugins

- The `vim` plugin applies to every plugin's DOM automatically (textareas,
  contenteditables, scroll regions). Don't bind unmodified letters on
  `document`, don't stop `keydown` propagation in capture; use
  `app.commands.register` for shortcuts. Overrides: `data-vim-scroll`,
  `data-vim-ignore`. Details in `vim/skills/vim-keys/SKILL.md`.
