# Google Doc sync for the RFCs plugin

Reviewers comment in a Google Doc; you work in markdown. This folder holds a
small Apps Script you deploy once as a web app. It runs inside Google as you,
so it works even when a Workspace admin blocks third-party OAuth apps, and it
serves every Doc you can open: the plugin passes the Doc id with each call.

What the plugin does with it:

- **Pull from Doc** fetches the comment threads (author, text, replies,
  resolved) and the Doc body as paragraphs. Comments are matched to the
  markdown by their quoted text and shown as cards under their sections.
  Comments imported earlier from a .docx are recognised and keep their
  statuses and drafts.
- **Send reply** / **Send & resolve** on a comment card queue the drafted
  reply.
- **Push to Doc** posts the queued replies and edits the Doc body paragraph by
  paragraph to match the markdown: replace, insert after, delete, each found
  by text, so comments anchored elsewhere survive. Headings, lists, bold,
  italic, inline code and links carry over. Tables, code blocks and diagrams
  are never edited automatically; the panel lists them for a manual update.
  Results come back immediately.

## Setup, once

1. Go to <https://script.google.com>, **New project**. Replace `Code.gs` with
   this folder's `Code.gs`.
2. Left bar, **Services (+)** → **Drive API** (version v3, identifier
   `Drive`) → Add.
3. **Project Settings** (gear) → **Script properties** → add `TOKEN` with a
   long random value, for example the output of `openssl rand -hex 24`.
4. **Deploy → New deployment**, type **Web app**: *Execute as* **Me**, *Who
   has access* **Anyone**. Deploy, authorize when asked (it needs access to
   your Docs and Drive), and copy the **Web app URL** (ends in `/exec`).
5. In BB, plugin settings for RFCs: paste the URL into **Google Doc bridge
   URL** and the token into **Google Doc bridge token**.
6. In each RFC's header, add `Google Doc: <doc url>` (or `gdoc:` in YAML
   frontmatter).

"Anyone" is needed because the plugin cannot sign in with your Google session.
The token is what protects the endpoint; the URL alone does nothing without
it. If the deploy dialog does not offer "Anyone", your admin has restricted
web apps too and the .docx import remains the path.

Changing the script later: edit `Code.gs`, then **Deploy → Manage
deployments → edit (pencil) → Version: New version → Deploy**. The URL stays
the same.

## Day to day

Items → Comments shows the sync panel. Pull first (it also records the Doc's
paragraphs, which the push diff is based on), draft replies, queue them, then
Push. After a review round in the Doc, pull before you push so the edits are
planned against what reviewers see.

## Limits

- Edits reviewers make directly in the Doc body are not pulled into the
  markdown; a push would overwrite them with the markdown's version.
- Formatting pushed: headings, lists, bold, italic, inline code, links.
  Tables and diagrams stay manual.
- Apps Script web apps answer each request in a few seconds; a push with many
  paragraph edits can take 10–20 s.
