/**
 * RFCs plugin ↔ Google Docs bridge, running inside Google Apps Script as a
 * web app. One deployment serves every Doc you own: the plugin passes the Doc
 * id with each call.
 *
 * Why this exists: Workspace admins often block third-party OAuth apps, but a
 * script you deploy yourself runs as you with first-party services.
 *
 *   GET  ?token=…&doc=<id>&what=comments   → comment threads (Drive API v3)
 *   GET  ?token=…&doc=<id>&what=body       → the Doc body as paragraphs
 *   POST ?token=…&doc=<id>  body: outbox   → posts replies / resolutions and
 *                                            applies paragraph edits; returns results
 *
 * Setup (once), see README.md:
 *   1. script.google.com → New project; paste this file.
 *   2. Services (+) → Drive API (v3), identifier Drive.
 *   3. Project Settings → Script properties: TOKEN = a long random string.
 *   4. Deploy → New deployment → Web app: execute as Me, access "Anyone".
 *      Copy the /exec URL into the plugin settings together with the token.
 */

var PROPS = PropertiesService.getScriptProperties();

function json_(obj, code) {
  var out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}

function auth_(e) {
  var token = PROPS.getProperty("TOKEN");
  if (!token) throw new Error("Set the TOKEN script property.");
  var given = (e && e.parameter && e.parameter.token) || "";
  if (given !== token) throw new Error("bad token");
}

function doGet(e) {
  try {
    auth_(e);
    var docId = e.parameter.doc;
    if (!docId) throw new Error("doc parameter required");
    var what = e.parameter.what || "comments";
    if (what === "comments") return json_({ docId: docId, exportedAt: new Date().toISOString(), comments: getComments(docId) });
    if (what === "body") return json_({ docId: docId, exportedAt: new Date().toISOString(), paragraphs: getBody(docId) });
    if (what === "ping") return json_({ ok: true, user: Session.getActiveUser().getEmail() || null });
    throw new Error("unknown what=" + what);
  } catch (err) {
    return json_({ error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  try {
    auth_(e);
    var docId = e.parameter.doc;
    if (!docId) throw new Error("doc parameter required");
    var data = JSON.parse((e.postData && e.postData.contents) || "{}");
    return json_(applyOutbox(docId, data));
  } catch (err) {
    return json_({ error: String(err && err.message ? err.message : err) });
  }
}

// ---- read ----------------------------------------------------------------

function getComments(fileId) {
  var out = [];
  var pageToken = null;
  do {
    var res = Drive.Comments.list(fileId, {
      fields: "nextPageToken,comments(id,author/displayName,author/emailAddress,createdTime,modifiedTime,content,quotedFileContent/value,resolved,deleted,replies(id,author/displayName,content,createdTime,action,deleted))",
      pageSize: 100,
      pageToken: pageToken,
      includeDeleted: false,
    });
    (res.comments || []).forEach(function (c) {
      if (c.deleted) return;
      out.push({
        id: c.id,
        author: (c.author && c.author.displayName) || "Unknown",
        email: (c.author && c.author.emailAddress) || null,
        createdTime: c.createdTime || null,
        modifiedTime: c.modifiedTime || null,
        content: c.content || "",
        quoted: (c.quotedFileContent && c.quotedFileContent.value) || "",
        resolved: !!c.resolved,
        replies: (c.replies || [])
          .filter(function (r) { return !r.deleted; })
          .map(function (r) {
            return { id: r.id, author: (r.author && r.author.displayName) || "Unknown", content: r.content || "", createdTime: r.createdTime || null, action: r.action || null };
          }),
      });
    });
    pageToken = res.nextPageToken || null;
  } while (pageToken);
  return out;
}

function headingLevel_(h) {
  var H = DocumentApp.ParagraphHeading;
  if (h === H.HEADING1 || h === H.TITLE) return 1;
  if (h === H.HEADING2) return 2;
  if (h === H.HEADING3) return 3;
  if (h === H.HEADING4) return 4;
  if (h === H.HEADING5) return 5;
  if (h === H.HEADING6) return 6;
  return 0;
}

function getBody(docId) {
  var body = DocumentApp.openById(docId).getBody();
  var paras = [];
  var n = body.getNumChildren();
  for (var i = 0; i < n; i++) {
    var el = body.getChild(i);
    var type = el.getType();
    if (type === DocumentApp.ElementType.PARAGRAPH) {
      var p = el.asParagraph();
      var lvl = headingLevel_(p.getHeading());
      paras.push({ index: i, kind: lvl > 0 ? "heading" : "paragraph", level: lvl, text: p.getText() });
    } else if (type === DocumentApp.ElementType.LIST_ITEM) {
      var li = el.asListItem();
      paras.push({ index: i, kind: "list", level: li.getNestingLevel(), text: li.getText() });
    } else if (type === DocumentApp.ElementType.TABLE) {
      paras.push({ index: i, kind: "table", level: 0, text: el.asTable().getText() });
    } else {
      paras.push({ index: i, kind: "other", level: 0, text: "" });
    }
  }
  return paras;
}

// ---- write (apply the plugin's outbox) -----------------------------------

function norm_(t) {
  return String(t || "").toLowerCase().replace(/[\s ]+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
}

/** Find the body element (paragraph or list item) whose text matches. */
function findPara_(body, text) {
  var want = norm_(text);
  if (!want) return null;
  var n = body.getNumChildren();
  for (var i = 0; i < n; i++) {
    var el = body.getChild(i);
    var type = el.getType();
    if (type !== DocumentApp.ElementType.PARAGRAPH && type !== DocumentApp.ElementType.LIST_ITEM) continue;
    if (norm_(el.getText()) === want) return el;
  }
  return null;
}

var HEADINGS = [null, "HEADING1", "HEADING2", "HEADING3", "HEADING4", "HEADING5", "HEADING6"];

/** Write runs into a paragraph/list item: text, then bold/italic/code/link ranges. */
function setRuns_(el, block) {
  var runs = block.runs || [];
  var text = runs.map(function (r) { return r.text; }).join("") || block.text || "";
  el.setText(text);
  var t = el.editAsText();
  var pos = 0;
  runs.forEach(function (r) {
    var len = r.text.length;
    if (len > 0) {
      var a = pos, b = pos + len - 1;
      t.setBold(a, b, !!r.bold);
      t.setItalic(a, b, !!r.italic);
      if (r.code) { t.setFontFamily(a, b, "Roboto Mono"); t.setBackgroundColor(a, b, "#f1f3f4"); }
      if (r.link) t.setLinkUrl(a, b, r.link);
    }
    pos += len;
  });
  if (block.kind === "heading") {
    var h = HEADINGS[Math.min(6, Math.max(1, block.level || 2))];
    el.setHeading(DocumentApp.ParagraphHeading[h]);
  } else if (el.getType() === DocumentApp.ElementType.PARAGRAPH) {
    el.setHeading(DocumentApp.ParagraphHeading.NORMAL);
  }
}

function insertBlockAfter_(body, anchorEl, block) {
  var index = anchorEl === null ? 0 : body.getChildIndex(anchorEl) + 1;
  var el;
  if (block.kind === "list") {
    el = body.insertListItem(index, "");
    el.setGlyphType(block.ordered ? DocumentApp.GlyphType.NUMBER : DocumentApp.GlyphType.BULLET);
    el.setNestingLevel(block.level || 0);
  } else {
    el = body.insertParagraph(index, "");
  }
  setRuns_(el, block);
  return el;
}

function applyOutbox(fileId, data) {
  var results = { id: data.id || null, appliedAt: new Date().toISOString(), replies: [], ops: [] };

  (data.replies || []).forEach(function (r) {
    try {
      var payload = { content: r.text };
      if (r.resolve) payload.action = "resolve";
      var created = Drive.Replies.create(payload, fileId, r.commentId, { fields: "id" });
      results.replies.push({ commentId: r.commentId, ok: true, replyId: created.id });
    } catch (e) {
      results.replies.push({ commentId: r.commentId, ok: false, error: String(e) });
    }
  });

  if ((data.ops || []).length > 0) {
    var doc = DocumentApp.openById(fileId);
    var body = doc.getBody();
    (data.ops || []).forEach(function (op, i) {
      try {
        if (op.op === "replace") {
          var el = findPara_(body, op.find);
          if (el === null) throw new Error("paragraph not found: " + String(op.find).slice(0, 80));
          setRuns_(el, op.block);
        } else if (op.op === "delete") {
          var del = findPara_(body, op.find);
          if (del === null) throw new Error("paragraph not found: " + String(op.find).slice(0, 80));
          if (body.getNumChildren() === 1) del.asParagraph().setText("");
          else del.removeFromParent();
        } else if (op.op === "insertAfter") {
          var anchor = op.anchor === null ? null : findPara_(body, op.anchor);
          if (op.anchor !== null && anchor === null) throw new Error("anchor not found: " + String(op.anchor).slice(0, 80));
          insertBlockAfter_(body, anchor, op.block);
        } else {
          throw new Error("unknown op " + op.op);
        }
        results.ops.push({ i: i, ok: true });
      } catch (e) {
        results.ops.push({ i: i, ok: false, error: String(e) });
      }
    });
    doc.saveAndClose();
  }
  return results;
}
