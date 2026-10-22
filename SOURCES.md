# Upstream sources

Every third-party plugin here is a plain copy of upstream at a reviewed commit.
Nothing updates on its own. To upgrade one: clone upstream, review the diff
against the pinned commit, copy the new tree over the directory, update this
table, commit.

| Plugin | Upstream | Pinned commit | Version | Reviewed |
| --- | --- | --- | --- | --- |
| beautiful-chat | https://github.com/diip3sh/bb-plugin-beautiful-chat | f0c0220082f7ba625fb3ae650385b9be91576f8e (tag v0.1.2) | 0.1.2 | 2026-10-22, CSS restyle only; no network, exec, fs, or storage access |
| aura | https://github.com/MateoCerquetella/bb-plugins (plugins/aura) | d205cb7534b8d5a210b78c32dd2487d5722f391b (tag aura/v0.2.3) | 0.2.3 | dist built locally 2026-10-22 with `bb plugin build` |
| kanban | (own plugin, authored in this repo) | — | 0.1.0 | — |
| vim | (own plugin, authored in this repo) | — | 0.1.0 | — |
| usage-meter | (own plugin, authored in this repo) | — | 0.1.0 | — |
| code-review | (own plugin, authored in this repo) | — | 0.1.0 | — |
| rfcs | (own plugin, authored in this repo) | — | 0.1.0 | — |
