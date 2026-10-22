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
| kanban | Board where each card is a thread; agents move cards; GitHub PRs sync in |
| beautiful-chat | Restyles BB's chat in BeautifulUI's design language (vendored, pinned) |
| aura | Custom image backgrounds and dithered patterns for threads (vendored, pinned) |
