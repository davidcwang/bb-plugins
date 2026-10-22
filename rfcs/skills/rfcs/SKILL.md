---
name: rfcs
description: Use the RFCs plugin when the user is writing, revising, diagramming, or reviewing an RFC or design document in markdown. Covers opening the document in the RFC panel, mermaid and D2 diagram fences, review rounds, and accepted findings arriving from the panel.
---

# RFC workbench

The user has an **RFC** panel beside this thread. It shows a live-rendered
preview of one markdown file (re-read every 1.5 s, so your edits appear as you
make them), an editor the user may type in, and a Review tab.

## Opening the document

- When you create an RFC file or the user points you at one, call
  `rfc_set_document` with its path right away so the panel follows it. Paths
  are workspace-relative or absolute. New RFCs normally go in the configured
  RFC directory (default `rfcs/`); `bb rfcs show` prints the current one.
- `bb rfcs new "<title>"` creates a file from the house template (frontmatter,
  Summary, Motivation, Goals/non-goals, Proposal, Detailed design,
  Alternatives, Security, Rollout, Open questions) and opens it.
- Edit the file with your normal file tools. Keep edits surgical: the user may
  be editing the same file in the panel. Never rewrite the whole document to
  change one section.

## Diagrams

Two fenced-block languages render inline in the preview:

- ```` ```mermaid ```` for sequence diagrams, flowcharts, state machines,
  ER diagrams, gantt. Keep to standard syntax; the renderer is mermaid 12.
- ```` ```d2 ```` for architecture diagrams (containers, nested systems,
  cylinders, clouds, icons, labelled edges). D2 produces Lucidchart-grade
  output; prefer it for anything with boxes-in-boxes or more than ~8 nodes.
  Call `rfc_check_diagram` with the D2 source before putting it in the RFC;
  it compiles with the real D2 engine and returns the error if any.

D2 tips: `direction: right`; containers are `name: Label { child: ... }`;
shapes via `shape: cylinder | cloud | queue | hexagon | person | package`;
edges `a -> b: label`; styles `style.fill: "#..."`; reuse with `classes`.
Don't use `icon:` URLs that need network access.

## Review

The user runs review rounds from the Review tab. A hidden worker reads the
RFC and reports findings; the user accepts, skips, edits, prioritizes, and
can open a **discussion thread per finding** to ask about it without
cluttering this thread.

Accepted findings arrive here as one message headed "RFC review: please
address these … accepted finding(s)", p0 first. For each: edit the RFC, then
say what changed, or explain why you disagree. When a finding says it was
discussed in another thread, read that thread first with
`bb thread log <id> --format verbose --all`; conclusions reached there
override the original suggestion.

If the user asks *you* to review the RFC in this thread, call
`rfc_report_findings` once with every finding (section, line, quote,
severity, title, body, suggestion) instead of listing them in prose, so the
user can triage them in the panel.

## Notes, cards, glossary, claims, walkthroughs (the sidecar)

Beside each RFC the plugin keeps `<rfc>.rfcs.json` with the author's working
state. You maintain it with tools; the user sees it in the panel's **Items**
and **Walkthrough** views and as chrome on each section of the preview.

- **Notes** (`rfc_note_add`, `rfc_note_update`): design questions, decisions,
  things to keep in mind, blockers; each anchored to a section with a status
  (open, decided, blocked, superseded) and, once settled, a one-paragraph
  resolution saying what was decided and why. Whenever a conversation settles
  or raises something the author must track, record it as a note instead of
  leaving it in chat. Inside a note's discussion thread, `rfc_note_update`
  needs no id.
- **Explainer cards** (`rfc_publish_card`): a concept explanation, code path,
  data model, flow, or answer attached to a section, with an optional diagram
  and `files` (workspace path, line range, snippet, note). When the user asks
  you to explain something in the RFC, publish a card rather than a long chat
  reply so it stays with the section.
- **Glossary** (`rfc_define_term`): every acronym, vendor term, internal
  shorthand, and requirement/assumption/question ID (S12, O8, A2, Q13, P20,
  D6) gets a one-line definition. Define terms as you introduce them.
- **Claims register** (`rfc_claims_upsert`): facts the design depends on, with
  source, status (verified, assumed, stale, superseded), when and against
  which vendor version they were verified. When you learn a fact changed
  (new chart version, retracted finding), update the claim rather than only
  editing prose.
- **Walkthrough** (`rfc_publish_walkthrough`): ordered teaching steps with
  anchors, diagrams, and code refs. Requested from the Walkthrough view.

Messages from the panel ("Build or refresh the glossary…", "Audit the claims
register…", "Create a walkthrough…") describe exactly what to call.

## CLI

| Command | Effect |
| --- | --- |
| `bb rfcs open <path>` | Point the panel at a file. |
| `bb rfcs new "<title>"` | Create from template and open. |
| `bb rfcs show [--json]` | Current file and heading outline. |
| `bb rfcs list [--json]` | Every RFC across projects (the sidebar library). |
| `bb rfcs review` | Start a review round. |
| `bb rfcs findings [--json]` | List findings and triage status. |
| `bb rfcs accept <id> [--priority p0..p3]` / `skip <id>` | Triage only when the user asks. |
| `bb rfcs check-d2 <file.d2>` | Compile a D2 file. |

## Rules

- As a review worker: never edit files; only call `rfc_report_findings`.
- Never accept findings on the user's behalf unless asked.
- Keep frontmatter (`title`, `status`, `authors`, `created`, `updated`) intact
  and bump `updated` when you make substantive changes.
