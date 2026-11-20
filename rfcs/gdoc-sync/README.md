# Google Doc sync for the RFCs plugin

Reviewers comment in a Google Doc; you work in markdown. This folder holds the
Apps Script that connects the two without any third-party OAuth app, which
matters when a Workspace admin blocks those.

How it works:

- The script runs inside Google as you, on a 5-minute trigger. It exports the
  Doc's comment threads to `comments.json` and its body paragraphs to
  `body.json`, in a Drive folder.
- Google Drive for Desktop mirrors that folder to your machine. The plugin reads
  the two files there (Items → Comments → **Pull from Doc**) and writes
  `outbox.json` when you **Push to Doc**.
- On its next run the script applies the outbox: posts queued replies (and
  resolves threads when asked), and edits the Doc body paragraph by paragraph
  to match the markdown, then writes `results.json` which the next pull reads.

Edits are applied by finding each paragraph by its text, so comments anchored
elsewhere survive. A paragraph you rewrote keeps its comments in the Doc as
orphaned comments, which is what Google does for any edit of commented text.
Tables, code blocks and diagrams are never edited automatically; the sync panel
lists them for a manual update.

## Setup, once per Doc

1. In the Doc: **Extensions → Apps Script**. Replace the default `Code.gs` with
   this folder's `Code.gs`.
2. In the script editor's left bar, **Services (+)** → add **Drive API**
   (version v3, identifier `Drive`).
3. In **My Drive**, create a folder `rfc-sync`, and inside it a folder named
   after the Doc id (the long id in the Doc's URL). Open that folder and copy
   its id from the URL.
4. **Project Settings → Script properties**: add `SYNC_FOLDER_ID` = that
   folder id. (`DOC_ID` is optional for a script bound to the Doc.)
5. Select the `setup` function and **Run**. Authorize when asked; the script
   needs Drive and Docs access to your own files. This installs the trigger
   and does the first export.
6. In the RFC markdown, add a line in the header: `Google Doc: <doc url>`
   (or `gdoc: <url>` in YAML frontmatter).
7. Install Google Drive for Desktop if you don't have it. The plugin finds
   `My Drive/rfc-sync` on its own; otherwise set the folder path in the
   plugin's settings.

Then Items → Comments shows the sync panel with Pull and Push.

## Day to day

- **Pull from Doc** imports new comments and replies, confirms replies the
  script posted, and refreshes the Doc body snapshot the push diff is based on.
- Per comment: **Send reply** or **Send & resolve** queues the drafted reply.
- **Push to Doc** writes the outbox: every queued reply plus the paragraph
  edits that bring the Doc in line with the markdown. The button shows the
  counts. The script applies it within about five minutes; pull again to see
  the result.

## Limits

- Drive for Desktop sync latency plus the 5-minute trigger: expect a few
  minutes end to end.
- Formatting pushed to the Doc: headings, lists, bold, italic, inline code,
  links. Tables and diagrams stay manual.
- Edits reviewers make directly in the Doc are not pulled into the markdown;
  the push would overwrite them with the markdown's version. Pull first and
  look at the comments before pushing after a review round.
