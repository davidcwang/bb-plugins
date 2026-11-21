# Google Doc sync for the RFCs plugin

Reviewers comment in a Google Doc; you work in markdown. This folder holds a
small Apps Script you deploy once as a web app. It runs inside Google as you,
so it works even when a Workspace admin blocks third-party OAuth apps, and it
serves every Doc you can open: the plugin passes the Doc id with each call.
It calls the Docs and Drive REST APIs with the script's own token, so no
"advanced service" has to be switched on; the scopes live in
`appsscript.json`.

## The workflow

1. **Draft** the RFC in the plugin. Items → Comments → **Create Google Doc**
   builds the Doc from the markdown (headings, lists, tables, code, bold,
   italic, inline code, links; mermaid and D2 diagrams as PNG images) and
   writes a `Google Doc: <url>` line into the RFC header. Or link an existing
   Doc by adding that line yourself.
2. **Review**: engineers comment in the Doc. **Pull from Doc** brings every
   comment thread in as a card under its section, matched by the quoted text.
   The plugin's first pass assesses each comment and drafts a reply.
3. **Iterate** in the plugin: edit the RFC, ask follow-ups on a comment, fix
   the drafted replies, mark comments answered or needs-change.
4. **Push as suggestions**: every paragraph that differs between the markdown
   and the Doc goes up as a *suggested edit* (Docs API `writeMode: SUGGEST`),
   so reviewers accept or reject each one in Google Docs as usual. The first
   change in a section that has an open "needs change" comment gets an
   anchored comment naming that review comment. Queued replies post to their
   threads, with resolve when you chose "Send & resolve".
5. **Accept** from either side: in the Doc, or from the plugin's list of open
   suggestions (per item, or all). Pull again afterwards and the plan shows
   what still differs.

## Setup, once

1. Go to <https://script.google.com>, **New project**, name it. Replace the
   default `Code.gs` with this folder's `Code.gs`.
2. **Project Settings** (gear) → tick **Show "appsscript.json" manifest file
   in editor** → back in the editor open `appsscript.json` and replace it
   with this folder's `appsscript.json` (OAuth scopes + web app settings).
3. **Project Settings** → **Script properties** → add `TOKEN` with a long
   random value, for example the output of `openssl rand -hex 24`.
4. **Deploy → New deployment**, type **Web app**: *Execute as* **Me**, *Who
   has access* **Anyone**. Deploy, authorize when asked (Docs, Drive, and
   "connect to an external service", which is how it reaches Google's own
   REST APIs), and copy the **Web app URL** (ends in `/exec`).
5. In BB, plugin settings for RFCs: paste the URL into **Google Doc bridge
   URL** and the token into **Google Doc bridge token**.

"Anyone" is needed because the plugin cannot sign in with your Google session.
The token is what protects the endpoint; the URL alone does nothing without
it. If the deploy dialog does not offer "Anyone", your admin has restricted
web apps too and the .docx import remains the path.

Changing the script later: edit `Code.gs`, then **Deploy → Manage
deployments → edit (pencil) → Version: New version → Deploy**. The URL stays
the same.

## Limits

- Edits reviewers make directly in the Doc body are not pulled into the
  markdown. A push would suggest reverting them; reject those suggestions.
- Pushed formatting: headings, lists, bold, italic, inline code, links.
  Changed tables, code blocks and diagrams are listed for a manual update
  (they are created fine on "Create Google Doc").
- Suggestions and comments are created by the account that deployed the
  script, so they show your name.
- Apps Script answers each request in a few seconds; a push with many
  paragraph edits can take 10–20 s.
