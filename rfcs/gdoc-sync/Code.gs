/**
 * RFCs plugin ↔ Google Docs bridge, running inside Google Apps Script as a
 * web app. One deployment serves every Doc you can open: the plugin passes
 * the Doc id with each call. It talks to the Docs and Drive REST APIs with
 * the script's own OAuth token, so no "advanced service" has to be enabled;
 * the scopes are declared in appsscript.json.
 *
 *   GET  ?token=…&what=ping                  → who the script runs as
 *   GET  ?token=…&doc=<id>&what=comments     → comment threads (Drive API v3)
 *   GET  ?token=…&doc=<id>&what=body         → paragraphs (committed text, with
 *                                              indexes) + pending suggestions
 *   POST ?token=…&doc=<id>&what=apply        → post replies / resolutions and
 *                                              apply paragraph edits AS SUGGESTIONS
 *   POST ?token=…&doc=<id>&what=suggest      → accept / reject suggestions by id
 *   POST ?token=…&what=create                → create a new Doc from blocks
 *
 * Edits land as suggested edits (Docs API writeControl.writeMode SUGGEST, GA
 * since 2026-09-30), so reviewers accept or reject each one in Google Docs.
 */

var PROPS = PropertiesService.getScriptProperties();
var DOCS = "https://docs.googleapis.com/v1/documents/";
var DRIVE = "https://www.googleapis.com/drive/v3/files/";

function json_(obj) {
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

/** Call a Google REST API as the script owner. Throws with Google's message on error. */
function api_(method, url, body) {
  var res = UrlFetchApp.fetch(url, {
    method: method,
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    payload: body === undefined ? undefined : JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  var parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch (err) { parsed = { raw: text }; }
  if (code >= 300) {
    var msg = (parsed.error && parsed.error.message) || text.slice(0, 300);
    throw new Error("HTTP " + code + " from " + method + " " + url.split("?")[0].replace(/^https:\/\/[^/]+/, "") + ": " + msg);
  }
  return parsed;
}

function doGet(e) {
  try {
    auth_(e);
    var what = e.parameter.what || "comments";
    if (what === "ping") return json_({ ok: true, user: Session.getEffectiveUser().getEmail() || null });
    var docId = e.parameter.doc;
    if (!docId) throw new Error("doc parameter required");
    if (what === "comments") return json_({ docId: docId, exportedAt: new Date().toISOString(), comments: getComments(docId) });
    if (what === "body") return json_(getBody(docId));
    throw new Error("unknown what=" + what);
  } catch (err) {
    return json_({ error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  try {
    auth_(e);
    var what = e.parameter.what || "apply";
    var data = JSON.parse((e.postData && e.postData.contents) || "{}");
    if (what === "create") return json_(createDoc(data));
    var docId = e.parameter.doc;
    if (!docId) throw new Error("doc parameter required");
    if (what === "apply") return json_(applyOutbox(docId, data));
    if (what === "suggest") return json_(resolveSuggestions(docId, data));
    throw new Error("unknown what=" + what);
  } catch (err) {
    return json_({ error: String(err && err.message ? err.message : err) });
  }
}

// ---- comments (Drive API) ------------------------------------------------

function getComments(fileId) {
  var out = [];
  var pageToken = null;
  do {
    var url = DRIVE + fileId + "/comments?pageSize=100&includeDeleted=false&fields=" + encodeURIComponent("nextPageToken,comments(id,author/displayName,author/emailAddress,createdTime,modifiedTime,content,quotedFileContent/value,resolved,deleted,replies(id,author/displayName,content,createdTime,action,deleted))");
    if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
    var res = api_("get", url);
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

// ---- body (Docs API) -----------------------------------------------------

function fetchDoc_(docId) {
  return api_("get", DOCS + docId + "?suggestionsViewMode=SUGGESTIONS_INLINE");
}

function headingLevel_(named) {
  var m = /^HEADING_(\d)$/.exec(named || "");
  if (m) return Number(m[1]);
  if (named === "TITLE") return 1;
  return 0;
}

/**
 * Walk the body. For each paragraph: the committed text (suggested insertions
 * left out, suggested deletions kept, since reviewers have not accepted them),
 * its index range, and the pending suggestions it carries.
 */
function scan_(doc) {
  var paras = [];
  var pending = {};
  var content = (doc.body && doc.body.content) || [];
  var listNesting = function (p) {
    return p.bullet ? (p.bullet.nestingLevel || 0) : -1;
  };
  content.forEach(function (el, i) {
    if (el.paragraph) {
      var p = el.paragraph;
      var committed = "";
      var live = "";
      (p.elements || []).forEach(function (pe) {
        if (!pe.textRun) return;
        var t = pe.textRun.content || "";
        live += t;
        var ins = pe.textRun.suggestedInsertionIds || [];
        var del = pe.textRun.suggestedDeletionIds || [];
        if (ins.length === 0) committed += t;
        ins.forEach(function (id) { (pending[id] = pending[id] || { id: id, kind: "insert", text: "", paragraph: i }).text += t; });
        del.forEach(function (id) { (pending[id] = pending[id] || { id: id, kind: "delete", text: "", paragraph: i }).text += t; });
      });
      var named = p.paragraphStyle && p.paragraphStyle.namedStyleType;
      var lvl = headingLevel_(named);
      var nest = listNesting(p);
      paras.push({
        index: i,
        kind: lvl > 0 ? "heading" : nest >= 0 ? "list" : "paragraph",
        level: lvl > 0 ? lvl : Math.max(0, nest),
        text: committed.replace(/\n$/, ""),
        liveText: live.replace(/\n$/, ""),
        startIndex: el.startIndex,
        endIndex: el.endIndex,
      });
    } else if (el.table) {
      var cells = [];
      (el.table.tableRows || []).forEach(function (row) {
        (row.tableCells || []).forEach(function (cell) {
          (cell.content || []).forEach(function (ce) {
            if (!ce.paragraph) return;
            (ce.paragraph.elements || []).forEach(function (pe) { if (pe.textRun) cells.push(pe.textRun.content || ""); });
          });
        });
      });
      paras.push({ index: i, kind: "table", level: 0, text: cells.join(" ").replace(/\s+/g, " ").trim(), liveText: "", startIndex: el.startIndex, endIndex: el.endIndex });
    } else {
      paras.push({ index: i, kind: "other", level: 0, text: "", liveText: "", startIndex: el.startIndex, endIndex: el.endIndex });
    }
  });
  var suggestions = Object.keys(pending).map(function (k) {
    var s = pending[k];
    var para = paras[s.paragraph];
    return { id: s.id, kind: s.kind, text: s.text.replace(/\n$/, ""), paragraph: para ? para.text : "", paragraphIndex: s.paragraph };
  });
  return { paras: paras, suggestions: suggestions };
}

function getBody(docId) {
  var doc = fetchDoc_(docId);
  var scanned = scan_(doc);
  return {
    docId: docId,
    exportedAt: new Date().toISOString(),
    title: doc.title || "",
    revisionId: doc.revisionId || null,
    paragraphs: scanned.paras.map(function (p) { return { index: p.index, kind: p.kind, level: p.level, text: p.text }; }),
    suggestions: scanned.suggestions,
  };
}

// ---- write (apply the plugin's outbox) -----------------------------------

function norm_(t) {
  return String(t || "").toLowerCase().replace(/[\s ]+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
}

function findPara_(paras, text) {
  var want = norm_(text);
  if (!want) return null;
  for (var i = 0; i < paras.length; i++) {
    var p = paras[i];
    if (p.kind === "table" || p.kind === "other") continue;
    if (norm_(p.text) === want) return p;
  }
  return null;
}

var NAMED = [null, "HEADING_1", "HEADING_2", "HEADING_3", "HEADING_4", "HEADING_5", "HEADING_6"];

/** Requests that write `block` as new text at `at` (which must be a paragraph start). Returns [requests, insertedLength]. */
function writeBlockAt_(at, block, withNewline) {
  var runs = block.runs && block.runs.length ? block.runs : [{ text: block.text || "" }];
  var text = runs.map(function (r) { return r.text; }).join("");
  if (text === "") text = " ";
  var reqs = [{ insertText: { location: { index: at }, text: withNewline ? text + "\n" : text } }];
  var pos = at;
  runs.forEach(function (r) {
    var len = r.text.length;
    if (len > 0) {
      var style = { bold: !!r.bold, italic: !!r.italic };
      var fields = "bold,italic";
      if (r.code) {
        style.weightedFontFamily = { fontFamily: "Roboto Mono" };
        style.backgroundColor = { color: { rgbColor: { red: 0.945, green: 0.953, blue: 0.957 } } };
        fields += ",weightedFontFamily,backgroundColor";
      }
      if (r.link) {
        style.link = { url: r.link };
        fields += ",link";
      }
      reqs.push({ updateTextStyle: { range: { startIndex: pos, endIndex: pos + len }, textStyle: style, fields: fields } });
    }
    pos += len;
  });
  var paraRange = { startIndex: at, endIndex: at + text.length };
  if (block.kind === "heading") {
    reqs.push({ updateParagraphStyle: { range: paraRange, paragraphStyle: { namedStyleType: NAMED[Math.min(6, Math.max(1, block.level || 2))] }, fields: "namedStyleType" } });
  } else if (block.kind === "list") {
    // Docs derives the bullet's nesting level from the paragraph indent (36 pt per level).
    var indent = 36 * ((block.level || 0) + 1);
    reqs.push({ updateParagraphStyle: { range: paraRange, paragraphStyle: { namedStyleType: "NORMAL_TEXT", indentStart: { magnitude: indent, unit: "PT" }, indentFirstLine: { magnitude: indent - 18, unit: "PT" } }, fields: "namedStyleType,indentStart,indentFirstLine" } });
    reqs.push({ createParagraphBullets: { range: paraRange, bulletPreset: block.ordered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE" } });
  } else {
    reqs.push({ updateParagraphStyle: { range: paraRange, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } });
  }
  return [reqs, text.length + (withNewline ? 1 : 0)];
}

/**
 * Apply the outbox. Replies go through the Drive API. Paragraph ops are
 * resolved against a fresh read of the Doc, ordered bottom-up so earlier
 * indexes stay valid, and sent in one batchUpdate as suggestions.
 */
function applyOutbox(fileId, data) {
  var results = { id: data.id || null, appliedAt: new Date().toISOString(), replies: [], ops: [], suggestionIds: [] };

  (data.replies || []).forEach(function (r) {
    try {
      var payload = { content: r.text };
      if (r.resolve) payload.action = "resolve";
      var created = api_("post", DRIVE + fileId + "/comments/" + encodeURIComponent(r.commentId) + "/replies?fields=id", payload);
      results.replies.push({ commentId: r.commentId, ok: true, replyId: created.id });
    } catch (e) {
      results.replies.push({ commentId: r.commentId, ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  var ops = data.ops || [];
  if (ops.length === 0) return results;

  var scanned = scan_(fetchDoc_(fileId)).paras;
  var bodyEnd = scanned.length ? scanned[scanned.length - 1].endIndex : 1;
  // Resolve each op to a position first; ops that cannot be placed fail individually.
  var placed = [];
  ops.forEach(function (op, i) {
    try {
      if (op.op === "replace" || op.op === "delete") {
        var p = findPara_(scanned, op.find);
        if (p === null) throw new Error("paragraph not found: " + String(op.find).slice(0, 80));
        placed.push({ i: i, op: op, at: p.startIndex, end: p.endIndex, para: p });
      } else if (op.op === "insertAfter") {
        var at;
        if (op.anchor === null || op.anchor === undefined) at = scanned.length && scanned[0].kind !== "other" ? scanned[0].startIndex : 1;
        else {
          var a = findPara_(scanned, op.anchor);
          if (a === null) throw new Error("anchor not found: " + String(op.anchor).slice(0, 80));
          at = a.endIndex;
        }
        placed.push({ i: i, op: op, at: at, end: at, para: null });
      } else throw new Error("unknown op " + op.op);
    } catch (e) {
      results.ops.push({ i: i, ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
  // Bottom-up: later positions first. Ties: inserts after deletes/replaces at the same index.
  placed.sort(function (x, y) { return y.at - x.at || (x.op.op === "insertAfter" ? -1 : 1) - (y.op.op === "insertAfter" ? -1 : 1); });

  var requests = [];
  var entries = []; // bottom-up: {start, len, note, delta}
  placed.forEach(function (pl) {
    var op = pl.op;
    if (op.op === "delete") {
      // Keep the final newline of the body: the last paragraph's trailing \n cannot be removed.
      var endIdx = pl.end >= bodyEnd ? pl.end - 1 : pl.end;
      var startIdx = pl.end >= bodyEnd && pl.at > 1 ? pl.at - 1 : pl.at;
      if (endIdx > startIdx) requests.push({ deleteContentRange: { range: { startIndex: startIdx, endIndex: endIdx } } });
      entries.push({ start: startIdx, len: 0, note: null, delta: -(Math.max(0, endIdx - startIdx)) });
    } else if (op.op === "replace") {
      var textEnd = pl.end - 1; // keep the paragraph's own newline
      var w = writeBlockAt_(pl.at, op.block, false);
      if (textEnd > pl.at) requests.push({ deleteContentRange: { range: { startIndex: pl.at, endIndex: textEnd } } });
      requests = requests.concat(w[0]);
      entries.push({ start: pl.at, len: w[1], note: op.note || null, delta: w[1] - Math.max(0, textEnd - pl.at) });
    } else {
      var at = pl.at;
      var tail = at >= bodyEnd; // appending at the very end: insert before the final newline instead
      if (tail) at = bodyEnd - 1;
      var w2 = writeBlockAt_(at, op.block, true);
      if (tail) {
        // "\ntext" before the final newline keeps the document's terminating paragraph intact.
        w2[0][0].insertText.text = "\n" + w2[0][0].insertText.text.replace(/\n$/, "");
        w2[0].slice(1).forEach(function (r) {
          var k = r.updateTextStyle ? "updateTextStyle" : r.updateParagraphStyle ? "updateParagraphStyle" : "createParagraphBullets";
          r[k].range.startIndex += 1;
          r[k].range.endIndex += 1;
        });
      }
      requests = requests.concat(w2[0]);
      entries.push({ start: tail ? at + 1 : at, len: w2[1] - 1, note: op.note || null, delta: w2[1] });
    }
  });
  // In suggest mode a deletion keeps the text in place, so only insertions move later indexes.
  entries.forEach(function (en) { if (en.delta < 0) en.delta = 0; });

  if (requests.length === 0) {
    placed.forEach(function (pl) { results.ops.push({ i: pl.i, ok: true }); });
    return results;
  }
  try {
    var res = api_("post", DOCS + fileId + ":batchUpdate", { requests: requests, writeControl: { writeMode: "SUGGEST" } });
    (res.suggestionResponses || []).forEach(function (s) {
      (s.createdSuggestionIds || []).forEach(function (id) { results.suggestionIds.push(id); });
    });
    placed.forEach(function (pl) { results.ops.push({ i: pl.i, ok: true }); });
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    placed.forEach(function (pl) { results.ops.push({ i: pl.i, ok: false, error: msg }); });
    return results;
  }
  // Anchored comments naming the review comment a change answers. The batch ran
  // bottom-up, so each change sits below everything processed after it; shift
  // its start by the text those later (higher) insertions added.
  var notes = [];
  for (var k = 0; k < entries.length; k++) {
    if (!entries[k].note) continue;
    var shift = 0;
    for (var j = k + 1; j < entries.length; j++) shift += entries[j].delta;
    notes.push({ start: entries[k].start + shift, len: entries[k].len, note: entries[k].note });
  }
  if (notes.length) {
    try {
      var creq = notes.map(function (n) {
        return { insertComment: { content: n.note, range: { startIndex: n.start, endIndex: n.start + Math.max(1, n.len) } } };
      });
      api_("post", DOCS + fileId + ":batchUpdate", { requests: creq });
      results.notes = creq.length;
    } catch (e2) {
      results.notesError = String(e2 && e2.message ? e2.message : e2);
    }
  }
  results.ops.sort(function (a, b) { return a.i - b.i; });
  return results;
}

/** Accept / reject pending suggestions. data: { accept: [ids], reject: [ids] } */
function resolveSuggestions(fileId, data) {
  var requests = [];
  (data.accept || []).forEach(function (id) { requests.push({ acceptSuggestion: { suggestionId: id } }); });
  (data.reject || []).forEach(function (id) { requests.push({ rejectSuggestion: { suggestionId: id } }); });
  if (requests.length === 0) return { accepted: 0, rejected: 0 };
  var res = api_("post", DOCS + fileId + ":batchUpdate", { requests: requests });
  var accepted = 0, rejected = 0;
  (res.suggestionResponses || []).forEach(function (s) {
    accepted += (s.acceptedSuggestionIds || []).length;
    rejected += (s.rejectedSuggestionIds || []).length;
  });
  return { accepted: accepted || (data.accept || []).length, rejected: rejected || (data.reject || []).length };
}

// ---- create a Doc from blocks (DocumentApp: tables and images by blob) ----

var GLYPHS = [DocumentApp.GlyphType.BULLET, DocumentApp.GlyphType.HOLLOW_BULLET, DocumentApp.GlyphType.SQUARE_BULLET];

function applyRuns_(el, runs) {
  var text = runs.map(function (r) { return r.text; }).join("");
  el.setText(text);
  if (text === "") return;
  var t = el.editAsText();
  var pos = 0;
  runs.forEach(function (r) {
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
}

/**
 * data: { title, blocks: [{kind, level, ordered, text, runs, rows?, code?, lang?, imageKey?}], images: {key: base64png} }
 */
function createDoc(data) {
  var title = data.title || "Untitled RFC";
  var doc = DocumentApp.create(title);
  var body = doc.getBody();
  body.getChild(0).asParagraph().setText(title).setHeading(DocumentApp.ParagraphHeading.TITLE);
  var images = data.images || {};
  var pendingList = null; // consecutive list items share one list id via DocumentApp automatically
  (data.blocks || []).forEach(function (b) {
    if (b.kind === "heading") {
      var h = body.appendParagraph("");
      applyRuns_(h, b.runs || [{ text: b.text || "" }]);
      var H = DocumentApp.ParagraphHeading;
      h.setHeading([H.NORMAL, H.HEADING1, H.HEADING2, H.HEADING3, H.HEADING4, H.HEADING5, H.HEADING6][Math.min(6, Math.max(1, b.level || 2))]);
    } else if (b.kind === "list") {
      var li = body.appendListItem("");
      applyRuns_(li, b.runs || [{ text: b.text || "" }]);
      li.setGlyphType(b.ordered ? DocumentApp.GlyphType.NUMBER : GLYPHS[Math.min(2, b.level || 0)]);
      li.setNestingLevel(b.level || 0);
    } else if (b.kind === "table" && b.rows) {
      var cells = b.rows.map(function (row) { return row.map(function (c) { return c.text || ""; }); });
      if (cells.length) {
        var width = Math.max.apply(null, cells.map(function (r) { return r.length; }));
        cells = cells.map(function (r) { while (r.length < width) r.push(""); return r; });
        var table = body.appendTable(cells);
        b.rows.forEach(function (row, ri) {
          row.forEach(function (cell, ci) {
            var cellEl = table.getCell(ri, ci);
            var p = cellEl.getChild(0).asParagraph();
            applyRuns_(p, cell.runs || [{ text: cell.text || "" }]);
            if (ri === 0) p.editAsText().setBold(true);
          });
        });
      }
    } else if (b.kind === "code") {
      var cp = body.appendParagraph(b.code || b.text || "");
      cp.setFontFamily("Roboto Mono").setFontSize(9);
      cp.setBackgroundColor("#f1f3f4");
    } else if (b.kind === "diagram") {
      var png = b.imageKey && images[b.imageKey];
      if (png) {
        var blob = Utilities.newBlob(Utilities.base64Decode(png), "image/png", b.imageKey + ".png");
        var ip = body.appendParagraph("");
        var img = ip.appendInlineImage(blob);
        var maxW = 600;
        if (img.getWidth() > maxW) { var ratio = maxW / img.getWidth(); img.setWidth(maxW).setHeight(Math.round(img.getHeight() * ratio)); }
        ip.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      } else {
        var dp = body.appendParagraph(b.code || b.text || "");
        dp.setFontFamily("Roboto Mono").setFontSize(9).setBackgroundColor("#f1f3f4");
      }
    } else {
      var p2 = body.appendParagraph("");
      applyRuns_(p2, b.runs || [{ text: b.text || "" }]);
      p2.setHeading(DocumentApp.ParagraphHeading.NORMAL);
    }
  });
  doc.saveAndClose();
  return { docId: doc.getId(), url: doc.getUrl(), title: title };
}
