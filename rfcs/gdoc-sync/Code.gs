/**
 * RFCs plugin ↔ Google Doc sync, running inside Google Apps Script.
 *
 * Why this exists: Workspace admins often block third-party OAuth apps, but a
 * script bound to your own account runs as you with first-party services. It
 * moves data through a Drive folder that Google Drive for Desktop mirrors to
 * your laptop, where the BB plugin reads and writes it.
 *
 * Files in the sync folder (one folder per Doc):
 *   comments.json  ← written here: every comment thread on the Doc
 *   body.json      ← written here: the Doc body as paragraphs
 *   outbox.json    → written by the plugin: replies, resolutions, paragraph edits
 *   results.json   ← written here after an outbox is applied
 *
 * Setup (once per Doc), see README.md:
 *   1. Extensions → Apps Script from the Doc, paste this file.
 *   2. Services (+) → add "Drive API" (v3), identifier Drive.
 *   3. Project Settings → Script properties: SYNC_FOLDER_ID = id of the Drive folder
 *      (inside "My Drive/rfc-sync/"), DOC_ID = the Doc id (optional for a bound script).
 *   4. Run `setup` once (authorize), which installs a 5-minute trigger for `sync`.
 */

var PROPS = PropertiesService.getScriptProperties();

function docId_() {
  var id = PROPS.getProperty("DOC_ID");
  if (id) return id;
  return DocumentApp.getActiveDocument().getId();
}
function folder_() {
  var id = PROPS.getProperty("SYNC_FOLDER_ID");
  if (!id) throw new Error("Set the SYNC_FOLDER_ID script property to the sync folder's Drive id.");
  return DriveApp.getFolderById(id);
}
function writeJson_(name, obj) {
  var folder = folder_();
  var it = folder.getFilesByName(name);
  var text = JSON.stringify(obj, null, 2);
  if (it.hasNext()) {
    var f = it.next();
    f.setContent(text);
    while (it.hasNext()) it.next().setTrashed(true);
    return f;
  }
  return folder.createFile(name, text, "application/json");
}
function readJson_(name) {
  var it = folder_().getFilesByName(name);
  if (!it.hasNext()) return null;
  var f = it.next();
  return { file: f, data: JSON.parse(f.getBlob().getDataAsString("UTF-8")) };
}

/** Install the periodic trigger and do a first pull. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "sync") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("sync").timeBased().everyMinutes(5).create();
  sync();
}

/** Apply anything the plugin queued, then export comments and body. */
function sync() {
  var applied = applyOutbox_();
  pullComments();
  pullBody();
  return applied;
}

// ---- pull ----------------------------------------------------------------

function pullComments() {
  var fileId = docId_();
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
  writeJson_("comments.json", { docId: fileId, exportedAt: new Date().toISOString(), comments: out });
  return out.length;
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

function pullBody() {
  var body = DocumentApp.openById(docId_()).getBody();
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
  writeJson_("body.json", { docId: docId_(), exportedAt: new Date().toISOString(), paragraphs: paras });
  return paras.length;
}

// ---- push (apply the plugin's outbox) ------------------------------------

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
    if (norm_(el.asText ? el.getText() : "") === want) return el;
  }
  return null;
}

var HEADINGS = [null, "HEADING1", "HEADING2", "HEADING3", "HEADING4", "HEADING5", "HEADING6"];

/** Write runs into a paragraph/list item: text, then bold/italic/code/link ranges. */
function setRuns_(el, block) {
  var text = (block.runs || []).map(function (r) { return r.text; }).join("");
  el.setText(text || block.text || "");
  var t = el.editAsText();
  var pos = 0;
  (block.runs || []).forEach(function (r) {
    var len = r.text.length;
    if (len > 0) {
      var a = pos, b = pos + len - 1;
      if (r.bold) t.setBold(a, b, true);
      if (r.italic) t.setItalic(a, b, true);
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

function applyOutbox_() {
  var box = readJson_("outbox.json");
  if (box === null) return null;
  var data = box.data;
  var fileId = docId_();
  var results = { id: data.id || null, appliedAt: new Date().toISOString(), replies: [], ops: [] };

  // 1. Replies and resolutions.
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

  // 2. Paragraph edits.
  if ((data.ops || []).length > 0) {
    var doc = DocumentApp.openById(fileId);
    var body = doc.getBody();
    (data.ops || []).forEach(function (op, i) {
      try {
        if (op.op === "replace") {
          var el = findPara_(body, op.find);
          if (el === null) throw new Error("paragraph not found: " + op.find.slice(0, 80));
          setRuns_(el, op.block);
          results.ops.push({ i: i, ok: true });
        } else if (op.op === "delete") {
          var del = findPara_(body, op.find);
          if (del === null) throw new Error("paragraph not found: " + op.find.slice(0, 80));
          if (body.getNumChildren() === 1) del.asParagraph().setText("");
          else del.removeFromParent();
          results.ops.push({ i: i, ok: true });
        } else if (op.op === "insertAfter") {
          var anchor = op.anchor === null ? null : findPara_(body, op.anchor);
          if (op.anchor !== null && anchor === null) throw new Error("anchor not found: " + op.anchor.slice(0, 80));
          insertBlockAfter_(body, anchor, op.block);
          results.ops.push({ i: i, ok: true });
        }
      } catch (e) {
        results.ops.push({ i: i, ok: false, error: String(e) });
      }
    });
    doc.saveAndClose();
  }

  writeJson_("results.json", results);
  box.file.setName("outbox.done-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
  return results;
}
