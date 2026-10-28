An RFC writing workbench that opens beside any thread.

## What you get

- An **RFC** tab in the thread panel with these views:
  - **Split** (default): a monospace editor with autosave beside the rendered
    document, scroll-synced; ```` ```mermaid ```` and ```` ```d2 ```` fences
    draw as diagrams. D2 gives Lucidchart-style architecture diagrams;
    mermaid covers sequence, flow, state, and ER diagrams.
  - **Document**: the rendered RFC alone; each section's **edit** action
    opens its raw markdown in place.
  - **Changes**: revision history with a line diff, defaulting to what the
    last edit changed; restore any revision.
  - **Review** runs a review round in a hidden worker thread. Findings land
    here first; accept, skip, edit, prioritize, and **discuss** each one in
    its own thread before the accepted set goes to the agent.
- An **RFCs** page in the sidebar: every RFC across your projects with
  status and search. Click one to land in its thread with the editor and
  preview pinned beside the chat.
- A markdown file opener that renders diagram fences in any `.md` preview.
- Agent tools (`rfc_set_document`, `rfc_report_findings`, `rfc_check_diagram`)
  and a `bb rfcs` command.

## Setup

No accounts or keys. D2 runs locally (WASM); mermaid renders in the app.
Set the RFC directory (default `rfcs`) and a default author in settings.
