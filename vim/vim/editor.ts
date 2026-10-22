// Vim normal/visual mode inside BB's Tiptap composer.
//
// Strategy: we never touch ProseMirror's API (it is not exposed to plugins).
// Motions move the DOM selection with Selection.modify(); edits go through
// document.execCommand, which ProseMirror's DOM observer reconciles into a
// transaction (the same path browser spellcheck uses); undo/redo and newlines
// are forwarded as synthetic Mod+Z / Shift+Enter keydowns so Tiptap's own
// keymap handles them.
import { isEscape, sendKey } from "./dom";
import { enterSidebar } from "./nav";
import { getState, setState } from "./store";

type Granularity =
  | "character"
  | "word"
  | "line"
  | "lineboundary"
  | "documentboundary";
type Direction = "forward" | "backward";

let register = "";
let registerLinewise = false;

function selection(): Selection | null {
  return window.getSelection();
}

function modify(
  alter: "move" | "extend",
  direction: Direction,
  granularity: Granularity,
  count = 1,
): void {
  const sel = selection();
  if (!sel) return;
  for (let i = 0; i < count; i += 1) {
    sel.modify(alter, direction, granularity);
  }
}

/** Collapse a non-empty selection to its focus so motions start clean. */
function collapseToFocus(): void {
  const sel = selection();
  if (!sel || sel.isCollapsed || !sel.focusNode) return;
  sel.collapse(sel.focusNode, sel.focusOffset);
}

function applyMotion(
  alter: "move" | "extend",
  key: string,
  count: number,
): boolean {
  switch (key) {
    case "h":
    case "Backspace":
      modify(alter, "backward", "character", count);
      return true;
    case "l":
    case " ":
      modify(alter, "forward", "character", count);
      return true;
    case "j":
      modify(alter, "forward", "line", count);
      return true;
    case "k":
      modify(alter, "backward", "line", count);
      return true;
    case "w":
      // Chromium's forward "word" lands at the end of the current word (vim
      // `e`). Overshoot one word and come back to approximate `w`.
      for (let i = 0; i < count; i += 1) {
        modify(alter, "forward", "word");
        modify(alter, "forward", "word");
        modify(alter, "backward", "word");
      }
      return true;
    case "e":
      modify(alter, "forward", "word", count);
      return true;
    case "b":
      modify(alter, "backward", "word", count);
      return true;
    case "0":
    case "^":
      modify(alter, "backward", "lineboundary");
      return true;
    case "$":
      modify(alter, "forward", "lineboundary");
      return true;
    case "G":
      modify(alter, "forward", "documentboundary");
      return true;
    case "gg":
      modify(alter, "backward", "documentboundary");
      return true;
    default:
      return false;
  }
}

function selectedText(): string {
  return selection()?.toString() ?? "";
}

function deleteSelection(): void {
  if (selection()?.isCollapsed) return;
  document.execCommand("delete");
}

function yankSelection(linewise = false): void {
  register = selectedText();
  registerLinewise = linewise;
  if (register) {
    navigator.clipboard?.writeText(register).catch(() => undefined);
  }
}

function selectLine(count: number): void {
  modify("move", "backward", "lineboundary");
  modify("extend", "forward", "lineboundary");
  for (let i = 1; i < count; i += 1) {
    modify("extend", "forward", "line");
    modify("extend", "forward", "lineboundary");
  }
}

function insertText(text: string): void {
  document.execCommand("insertText", false, text);
}

function newline(editor: HTMLElement): void {
  sendKey(editor, "Enter", { shift: true });
}

function enterInsert(): void {
  setState({ mode: "insert", pending: "" });
}

function enterNormal(): void {
  collapseToFocus();
  setState({ mode: "normal", pending: "" });
}

function paste(editor: HTMLElement, before: boolean, count: number): void {
  if (!register) return;
  const text = register.repeat(count);
  if (registerLinewise) {
    if (before) {
      modify("move", "backward", "lineboundary");
      insertText(text);
      newline(editor);
      modify("move", "backward", "line");
      modify("move", "backward", "lineboundary");
    } else {
      modify("move", "forward", "lineboundary");
      newline(editor);
      insertText(text);
    }
    return;
  }
  if (!before) modify("move", "forward", "character");
  insertText(text);
}

/**
 * Handle one keydown while the composer is focused and the mode is normal or
 * visual. Returns true when the key was consumed.
 */
export function handleEditorKey(
  event: KeyboardEvent,
  editor: HTMLElement,
): boolean {
  const state = getState();
  const { mode } = state;
  const key = event.key;

  const escape = isEscape(event);
  // Modifier combos stay with the host (Mod+Enter, Mod+K, ...) except redo
  // and Ctrl-C (treated as Escape).
  if (!escape && (event.metaKey || event.altKey || (event.ctrlKey && key !== "r"))) {
    return false;
  }
  if (key === "Enter" || key === "Tab" || key.startsWith("Arrow")) {
    return false; // Enter submits via BB; arrows behave as in insert mode.
  }
  if (event.ctrlKey && key === "r") {
    sendKey(editor, "z", { meta: true, shift: true });
    setState({ pending: "" });
    return true;
  }
  if (key === "Shift" || key === "Control" || key === "Meta" || key === "Alt") {
    return false;
  }

  let pending = state.pending;

  if (escape) {
    if (pending) {
      setState({ pending: "" });
      return true;
    }
    if (mode === "visual") {
      enterNormal();
      return true;
    }
    // Escape from normal mode leaves the editor entirely (nav mode).
    editor.blur();
    setState({ mode: "nav", pending: "" });
    return true;
  }

  // Count prefix. A bare 0 is a motion unless a count is already in progress.
  if (/^[1-9]$/.test(key) || (key === "0" && /\d$/.test(pending))) {
    setState({ pending: pending + key });
    return true;
  }
  const countMatch = /^(\d+)/.exec(pending);
  const count = countMatch ? Number.parseInt(countMatch[1]!, 10) : 1;
  const prefix = pending.slice(countMatch?.[0].length ?? 0); // "", "g", "d", "c", "y"

  const done = (): boolean => {
    setState({ pending: "" });
    return true;
  };

  // Two-key prefixes.
  if (prefix === "g") {
    if (key === "g") {
      applyMotion(mode === "visual" ? "extend" : "move", "gg", count);
    }
    return done();
  }
  if (prefix === "d" || prefix === "c" || prefix === "y") {
    const op = prefix;
    if (key === op) {
      // dd / cc / yy: whole line(s)
      selectLine(count);
      if (op === "y") {
        yankSelection(true);
        collapseToFocus();
        return done();
      }
      yankSelection(true);
      deleteSelection();
      if (op === "d") {
        document.execCommand("delete"); // remove the now-empty line
      } else {
        enterInsert();
      }
      return done();
    }
    if (applyMotion("extend", key === "g" ? "gg" : key, count)) {
      if (key === "g") return true; // need a second g
      yankSelection(false);
      if (op === "y") {
        collapseToFocus();
        return done();
      }
      deleteSelection();
      if (op === "c") enterInsert();
      return done();
    }
    return done();
  }

  // Visual mode: motions extend, operators act on the selection.
  if (mode === "visual") {
    if (key === "g") {
      setState({ pending: `${countMatch?.[0] ?? ""}g` });
      return true;
    }
    if (applyMotion("extend", key, count)) return done();
    switch (key) {
      case "d":
      case "x":
        yankSelection();
        deleteSelection();
        enterNormal();
        return true;
      case "c":
      case "s":
        yankSelection();
        deleteSelection();
        enterInsert();
        return true;
      case "y":
        yankSelection();
        enterNormal();
        return true;
      case "v":
        enterNormal();
        return true;
      case "p":
        deleteSelection();
        insertText(register);
        enterNormal();
        return true;
      default:
        return done();
    }
  }

  // Normal mode.
  if (applyMotion("move", key, count)) return done();
  switch (key) {
    case "g":
    case "d":
    case "c":
    case "y":
      setState({ pending: `${countMatch?.[0] ?? ""}${key}` });
      return true;
    case "i":
      enterInsert();
      return true;
    case "a":
      modify("move", "forward", "character");
      enterInsert();
      return true;
    case "I":
      modify("move", "backward", "lineboundary");
      enterInsert();
      return true;
    case "A":
      modify("move", "forward", "lineboundary");
      enterInsert();
      return true;
    case "o":
      modify("move", "forward", "lineboundary");
      newline(editor);
      enterInsert();
      return true;
    case "O":
      modify("move", "backward", "lineboundary");
      newline(editor);
      modify("move", "backward", "line");
      enterInsert();
      return true;
    case "x":
      modify("extend", "forward", "character", count);
      yankSelection();
      deleteSelection();
      return done();
    case "X":
      modify("extend", "backward", "character", count);
      yankSelection();
      deleteSelection();
      return done();
    case "s":
      modify("extend", "forward", "character", count);
      yankSelection();
      deleteSelection();
      enterInsert();
      return true;
    case "S":
      selectLine(1);
      yankSelection(true);
      deleteSelection();
      enterInsert();
      return true;
    case "D":
      modify("extend", "forward", "lineboundary");
      yankSelection();
      deleteSelection();
      return done();
    case "C":
      modify("extend", "forward", "lineboundary");
      yankSelection();
      deleteSelection();
      enterInsert();
      return true;
    case "Y":
      selectLine(1);
      yankSelection(true);
      collapseToFocus();
      return done();
    case "p":
      paste(editor, false, count);
      return done();
    case "P":
      paste(editor, true, count);
      return done();
    case "u":
      for (let i = 0; i < count; i += 1) sendKey(editor, "z", { meta: true });
      return done();
    case "v":
      setState({ mode: "visual", pending: "" });
      return true;
    case "V":
      selectLine(count);
      setState({ mode: "visual", pending: "" });
      return true;
    case "H":
      // Leave the composer and put the cursor on the sidebar.
      editor.blur();
      setState({ mode: "nav", pending: "" });
      enterSidebar();
      return true;
    case "L":
      // Leave the composer back to the thread (nav mode).
      editor.blur();
      setState({ mode: "nav", pending: "" });
      return true;
    default:
      // Swallow every other printable key so it cannot type into the editor.
      return done();
  }
}
