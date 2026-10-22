# bb-plugin-rfcs

An RFC (design document) workbench that opens beside any bb thread.

## What it does

The **RFC** action in a thread's right panel opens a tab that follows one
markdown file for that thread.

**Preview** renders the file live. The plugin re-reads it every 1.5 s and on
every save, so the agent's edits show up as it makes them. Prose goes through
bb's own Markdown renderer; two fence languages render as diagrams:

- ```` ```mermaid ```` — rendered in the browser with mermaid 12
  (sequence, flowchart, state, class, ER, gantt, …), theme-aware.
- ```` ```d2 ```` — compiled on the plugin server with the D2 WASM engine
  (ELK or dagre layout, optional sketch style). This is the one to reach for
  for architecture diagrams: nested containers, cylinders, clouds, queues,
  labelled edges, grid layouts, classes. Output is SVG; copy it from the
  diagram toolbar to paste into Lucid, Figma, or a slide.

Frontmatter (`title`, `status`, `authors`, …) renders as a header strip.
Each diagram has a hover toolbar: show source, copy source, copy SVG. A
diagram that fails to compile shows the compiler error above its source
instead of breaking the page.

**Edit** is a monospace editor for the same file. ⌘S / Ctrl+S saves with a
compare-and-swap guard: if the agent or another editor changed the file since
you loaded it, the save is refused and you choose to reload or overwrite.
When you have no unsaved changes, external edits flow in automatically.

**Split** shows Edit and Preview side by side.

**Review** runs review rounds. **Run review** spawns a hidden worker thread
in the same environment; it reads the RFC (and anything it references) and
reports structured findings through the `rfc_report_findings` tool: section,
line, quote, severity, title, body, suggestion. Each finding card lets you:

- **Accept** / **Skip**, set a priority p0–p3, and **Edit** the text that
  will be sent;
- **Discuss**: opens a hidden child thread seeded with the RFC path and that
  one finding, rendered inline in the card with bb's `ThreadChat`. Ask
  follow-ups there; the main thread stays clean. When you later send the
  finding, the message tells the agent to read that discussion first and
  treat its conclusions as overriding the original suggestion.

**Send accepted** delivers the accepted set to the agent, p0 first, as one
message. Earlier rounds stay visible for the record.

An **RFCs** page in the left sidebar lists every RFC bb can see: markdown
under each project's RFC directory, any `*rfc*.md` elsewhere in a project,
and every file some thread has open in its RFC tab. Search by title, path,
or author; filter by frontmatter status. **Clicking an RFC opens its thread**
(the newest live one that follows the file, or a new one if none does) with
the RFC panel pinned beside the chat in Split view, so you can discuss, edit,
and watch the preview in one place. Each row also lists its live threads and
offers "Start/Another thread". The directory listing shows instantly; the
filename search merges in a moment later, and results are cached for 30 s.

**Items and Walkthrough** views, backed by a sidecar file `<rfc>.rfcs.json`
beside the RFC (so git carries it):

- **Notes** anchored to sections, each with a status (open, decided, blocked,
  superseded), an optional resolution, and its own hidden discussion thread.
  Add one from the selection toolbar, from a section's "+ note", from the
  Items list, or let the agent record decisions with `rfc_note_add`.
- **Explainer cards**: select text in the preview and pick Explain, Code,
  Data, Flow, or Ask. A hidden thread reads the RFC (and the workspace) and
  publishes a card under that section: markdown, an optional diagram, and
  code references rendered with bb's source viewer and file links. Cards stay
  collapsed until opened; each has a follow-up conversation.
- **Glossary**: terms and IDs (S12, A2, OIDC) with one-line definitions.
  Each section lists the terms it mentions; hover or click for the
  definition, or expand them all. "Build from document" asks the agent to
  define everything the RFC uses.
- **Claims register**: the facts the design depends on, with source, status
  (verified, assumed, stale, superseded), verification date and vendor
  version. "Audit claims" asks the agent to extract and re-verify them.
  Sections show a count of unverified claims.
- **Walkthrough**: ordered teaching steps (problem, answer, moving parts,
  main flow, hard decisions, unverified bits) with diagrams and code refs,
  navigable with ← → or j/k. "Generate walkthrough" takes an audience.

A **file opener** for `.md` / `.markdown` also ships: when a markdown file
opened in the panel contains a mermaid or D2 fence, this plugin renders it;
otherwise bb's built-in preview is used unchanged.

## Setup

```
npm install
bb plugin build
bb plugin install .
```

Settings (`bb plugin config rfcs`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `rfcDir` | `rfcs` | Where RFCs live; relative to the thread's workspace, or absolute. |
| `author` | `` | Written into new RFCs' frontmatter. |
| `reviewInstructions` | `` | Appended to every review round. |
| `d2Layout` | `elk` | `elk` or `dagre`. |
| `d2Sketch` | `false` | Hand-drawn D2 style. |

## Agent tools

| Tool | Who | Effect |
| --- | --- | --- |
| `rfc_set_document { path }` | main thread | Point the panel at a file. |
| `rfc_report_findings { findings }` | review worker, or main thread when asked to review | Findings land in the Review tab for triage. |
| `rfc_check_diagram { lang: "d2", source }` | main thread, discussion threads | Compile D2 and return errors before it goes in the doc. |

Review workers get only `rfc_report_findings` and are told not to edit.
Discussion threads get `rfc_check_diagram` and are told to stay on their
finding.

## CLI

```
bb rfcs open <path> [--thread <id>]
bb rfcs new "<title>" [--thread <id>]
bb rfcs show [--json]
bb rfcs list [--json]                 # the library: every RFC across projects
bb rfcs review
bb rfcs findings [--json]
bb rfcs accept <finding-id> [--priority p0..p3]
bb rfcs skip <finding-id>
bb rfcs check-d2 <file.d2>
```

## Layout

- `server.ts` — settings, per-thread kv state, file I/O through
  `bb.sdk.files`, D2 rendering with a small cache, review worker and
  discussion thread lifecycle, RPC, agent tools, CLI.
- `shared.ts` — fence splitter, frontmatter parser, outline; no Node imports.
- `app.tsx` — panel (Preview / Edit / Split / Review), diagram blocks, finding
  cards with inline `ThreadChat`, markdown file opener.
- `skills/rfcs/SKILL.md` — tells agents how the document, diagrams, and
  findings flow.

## Notes

- `dist/app.js` is ~5 MB because mermaid is bundled; it loads once per app
  session.
- D2 compiles in a worker thread on the plugin server; the first render pays
  ~0.5 s of WASM start-up, later ones are cached by source hash.
