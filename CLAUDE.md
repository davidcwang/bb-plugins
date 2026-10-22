# bb-plugins

My BB plugins, one directory per plugin; see README.md and SOURCES.md.

## Commit and push every change (standing authorization)

This repo is the exception to "don't run git write commands unless asked"
in `~/repos/CLAUDE.md`. Commits here are cheap to revert, so:

- After any change under `~/repos/bb-plugins` is built and working, commit it
  without asking, then push to the upstream remote.
- One commit per logical change, scoped to the plugin it touches
  (`vim: ...`, `usage-meter: ...`, `repo: ...` for index/README/SOURCES).
- Stage paths explicitly (`git add vim/ README.md`), never `git add -A`.
  Leave other threads' unrelated in-progress edits uncommitted unless they
  belong to the same change.
- Commits must be GPG-signed. Run `git commit` as a standalone command from
  this directory with the sandbox disabled (gpg needs gpg-agent's socket).
  Never pass `--no-gpg-sign`.
- Push with plain `git push`. Never force-push, rebase, or amend a pushed
  commit; fix mistakes with a new commit or `git revert`.
- If there is no upstream remote, or a push fails, commit locally anyway and
  tell the user; don't create remotes or GitHub repos without asking.
- Never commit `node_modules/`, `dist/` of own plugins, `.env*`, or secrets.
  Vendored plugins keep their `dist/` (see `.gitignore`).
