// Vim normal/visual mode for plain <textarea> elements (any plugin's editor,
// e.g. the RFCs panel). Motions work on the value string and the selection
// range; edits go through document.execCommand so the textarea's native undo
// stack and React's onChange both see them.
import { isEscape } from "./dom";
import { enterSidebar } from "./nav";
import { getState, setState } from "./store";

let register = "";
let registerLinewise = false;
let desiredCol: number | null = null; // sticky column for j/k
let visualAnchor = 0;

const WORD = /\w/;
const SPACE = /\s/;

function cls(ch: string): 0 | 1 | 2 {
  if (SPACE.test(ch)) return 0;
  return WORD.test(ch) ? 1 : 2;
}

function lineStart(v: string, pos: number): number {
  return v.lastIndexOf("\n", pos - 1) + 1;
}
function lineEnd(v: string, pos: number): number {
  const i = v.indexOf("\n", pos);
  return i === -1 ? v.length : i;
}
function firstNonBlank(v: string, pos: number): number {
  const s = lineStart(v, pos);
  const e = lineEnd(v, pos);
  let i = s;
  while (i < e && /[ \t]/.test(v[i]!)) i += 1;
  return i;
}
function lineMove(v: string, pos: number, delta: number): number {
  const col = desiredCol ?? pos - lineStart(v, pos);
  desiredCol = col;
  let s = lineStart(v, pos);
  if (delta > 0) {
    for (let i = 0; i < delta; i += 1) {
      const e = lineEnd(v, s);
      if (e >= v.length) break;
      s = e + 1;
    }
  } else {
    for (let i = 0; i < -delta; i += 1) {
      if (s === 0) break;
      s = lineStart(v, s - 1);
    }
  }
  return Math.min(s + col, lineEnd(v, s));
}
function wordForward(v: string, pos: number): number {
  let i = pos;
  if (i >= v.length) return i;
  const c = cls(v[i]!);
  if (c !== 0) while (i < v.length && cls(v[i]!) === c) i += 1;
  while (i < v.length && cls(v[i]!) === 0) i += 1;
  return i;
}
function wordEnd(v: string, pos: number): number {
  let i = pos + 1;
  while (i < v.length && cls(v[i]!) === 0) i += 1;
  if (i >= v.length) return v.length;
  const c = cls(v[i]!);
  while (i + 1 < v.length && cls(v[i + 1]!) === c) i += 1;
  return i;
}
function wordBack(v: string, pos: number): number {
  let i = pos - 1;
  while (i > 0 && cls(v[i]!) === 0) i -= 1;
  if (i <= 0) return 0;
  const c = cls(v[i]!);
  while (i > 0 && cls(v[i - 1]!) === c) i -= 1;
  return i;
}

/** Resolve a motion from `pos`; null when `key` is not a motion. */
function motion(v: string, pos: number, key: string, count: number): number | null {
  let p = pos;
  const vertical = key === "j" || key === "k";
  if (!vertical) desiredCol = null;
  switch (key) {
    case "h":
    case "Backspace":
      return Math.max(lineStart(v, pos), pos - count);
    case "l":
    case " ":
      return Math.min(lineEnd(v, pos), pos + count);
    case "j":
      return lineMove(v, pos, count);
    case "k":
      return lineMove(v, pos, -count);
    case "w":
      for (let i = 0; i < count; i += 1) p = wordForward(v, p);
      return p;
    case "e":
      for (let i = 0; i < count; i += 1) p = wordEnd(v, p);
      return p;
    case "b":
      for (let i = 0; i < count; i += 1) p = wordBack(v, p);
      return p;
    case "0":
      return lineStart(v, pos);
    case "^":
      return firstNonBlank(v, pos);
    case "$":
      return lineEnd(v, pos);
    case "gg":
      return 0;
    case "G":
      return firstNonBlank(v, v.length);
    default:
      return null;
  }
}

function setCaret(ta: HTMLTextAreaElement, pos: number): void {
  ta.setSelectionRange(pos, pos);
}
function select(ta: HTMLTextAreaElement, a: number, b: number): void {
  ta.setSelectionRange(Math.min(a, b), Math.max(a, b), a <= b ? "forward" : "backward");
}
function replaceRange(ta: HTMLTextAreaElement, a: number, b: number, text: string): void {
  ta.setSelectionRange(Math.min(a, b), Math.max(a, b));
  if (text) document.execCommand("insertText", false, text);
  else document.execCommand("delete");
}
function yank(text: string, linewise: boolean): void {
  register = text;
  registerLinewise = linewise;
  if (text) navigator.clipboard?.writeText(text).catch(() => undefined);
}
/** [start, end) covering `count` whole lines including the trailing newline. */
function lineRange(v: string, pos: number, count: number): [number, number] {
  const s = lineStart(v, pos);
  let e = lineEnd(v, pos);
  for (let i = 1; i < count && e < v.length; i += 1) e = lineEnd(v, e + 1);
  if (e < v.length) return [s, e + 1];
  return [Math.max(0, s - 1), e]; // last line: eat the preceding newline
}

const insert = () => setState({ mode: "insert", pending: "" });
const normal = () => setState({ mode: "normal", pending: "" });

export function handleTextareaKey(event: KeyboardEvent, ta: HTMLTextAreaElement): boolean {
  const state = getState();
  const key = event.key;
  const escape = isEscape(event);
  if (!escape && (event.metaKey || event.altKey || (event.ctrlKey && key !== "r"))) return false;
  if (key === "Tab" || key.startsWith("Arrow") || key === "Enter") return false;
  if (key === "Shift" || key === "Control" || key === "Meta" || key === "Alt") return false;
  if (event.ctrlKey && key === "r") {
    document.execCommand("redo");
    return true;
  }

  const v = ta.value;
  const pending = state.pending;
  const done = () => {
    setState({ pending: "" });
    return true;
  };

  if (escape) {
    if (pending) return done();
    if (state.mode === "visual") {
      setCaret(ta, ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd);
      normal();
      return true;
    }
    ta.blur();
    setState({ mode: "nav", pending: "" });
    return true;
  }
  if (/^[1-9]$/.test(key) || (key === "0" && /\d$/.test(pending))) {
    setState({ pending: pending + key });
    return true;
  }
  const countMatch = /^(\d+)/.exec(pending);
  const count = countMatch ? Number.parseInt(countMatch[1]!, 10) : 1;
  const prefix = pending.slice(countMatch?.[0].length ?? 0);
  const countStr = countMatch?.[0] ?? "";

  // ---- visual mode
  if (state.mode === "visual") {
    const head = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
    const lo = Math.min(visualAnchor, head);
    const hi = Math.max(visualAnchor, head);
    if (prefix === "g") {
      if (key === "g") select(ta, visualAnchor, 0);
      return done();
    }
    if (key === "g") {
      setState({ pending: `${countStr}g` });
      return true;
    }
    const m = motion(v, head, key, count);
    if (m !== null) {
      select(ta, visualAnchor, m);
      return done();
    }
    switch (key) {
      case "d":
      case "x":
        yank(v.slice(lo, hi), false);
        replaceRange(ta, lo, hi, "");
        normal();
        return true;
      case "c":
      case "s":
        yank(v.slice(lo, hi), false);
        replaceRange(ta, lo, hi, "");
        insert();
        return true;
      case "y":
        yank(v.slice(lo, hi), false);
        setCaret(ta, lo);
        normal();
        return true;
      case "p":
        replaceRange(ta, lo, hi, register);
        normal();
        return true;
      case "v":
        setCaret(ta, head);
        normal();
        return true;
      default:
        return done();
    }
  }

  // ---- normal mode
  const pos = ta.selectionStart;

  if (prefix === "g") {
    if (key === "g") setCaret(ta, 0);
    return done();
  }
  if (prefix === "d" || prefix === "c" || prefix === "y") {
    const op = prefix;
    let range: [number, number] | null = null;
    let linewise = false;
    if (key === op) {
      range = lineRange(v, pos, count);
      linewise = true;
    } else if (key === "g") {
      setState({ pending: `${countStr}${op}g` });
      return true;
    } else {
      const m = motion(v, pos, key, count);
      if (m !== null) range = m < pos ? [m, pos] : [pos, key === "e" ? m + 1 : m];
    }
    if (!range) return done();
    const [a, b] = range;
    yank(linewise ? v.slice(a, b).replace(/^\n/, "").replace(/\n$/, "") : v.slice(a, b), linewise);
    if (op === "y") {
      setCaret(ta, a);
      return done();
    }
    if (op === "c" && linewise) {
      // cc keeps the line, clears its content
      replaceRange(ta, lineStart(v, pos), lineEnd(v, pos), "");
      insert();
      return true;
    }
    replaceRange(ta, a, b, "");
    if (op === "c") insert();
    return done();
  }
  if (prefix.endsWith("g") && prefix.length === 2) {
    // d g g / c g g / y g g
    const op = prefix[0]!;
    if (key === "g") {
      const [a, b] = [0, pos];
      yank(v.slice(a, b), false);
      if (op !== "y") {
        replaceRange(ta, a, b, "");
        if (op === "c") insert();
      } else setCaret(ta, 0);
    }
    return done();
  }

  const m = motion(v, pos, key, count);
  if (m !== null) {
    setCaret(ta, m);
    return done();
  }
  switch (key) {
    case "g":
    case "d":
    case "c":
    case "y":
      setState({ pending: `${countStr}${key}` });
      return true;
    case "i":
      insert();
      return true;
    case "a":
      setCaret(ta, Math.min(lineEnd(v, pos), pos + 1));
      insert();
      return true;
    case "I":
      setCaret(ta, firstNonBlank(v, pos));
      insert();
      return true;
    case "A":
      setCaret(ta, lineEnd(v, pos));
      insert();
      return true;
    case "o": {
      const e = lineEnd(v, pos);
      replaceRange(ta, e, e, "\n");
      insert();
      return true;
    }
    case "O": {
      const s = lineStart(v, pos);
      replaceRange(ta, s, s, "\n");
      setCaret(ta, s);
      insert();
      return true;
    }
    case "x": {
      const e = Math.min(lineEnd(v, pos), pos + count);
      yank(v.slice(pos, e), false);
      replaceRange(ta, pos, e, "");
      return done();
    }
    case "X": {
      const s = Math.max(lineStart(v, pos), pos - count);
      yank(v.slice(s, pos), false);
      replaceRange(ta, s, pos, "");
      return done();
    }
    case "s": {
      const e = Math.min(lineEnd(v, pos), pos + count);
      yank(v.slice(pos, e), false);
      replaceRange(ta, pos, e, "");
      insert();
      return true;
    }
    case "S":
      yank(v.slice(lineStart(v, pos), lineEnd(v, pos)), true);
      replaceRange(ta, lineStart(v, pos), lineEnd(v, pos), "");
      insert();
      return true;
    case "D":
      yank(v.slice(pos, lineEnd(v, pos)), false);
      replaceRange(ta, pos, lineEnd(v, pos), "");
      return done();
    case "C":
      yank(v.slice(pos, lineEnd(v, pos)), false);
      replaceRange(ta, pos, lineEnd(v, pos), "");
      insert();
      return true;
    case "Y":
      yank(v.slice(lineStart(v, pos), lineEnd(v, pos)), true);
      return done();
    case "p":
    case "P": {
      if (!register) return done();
      const text = register.repeat(count);
      if (registerLinewise) {
        if (key === "p") {
          const e = lineEnd(v, pos);
          replaceRange(ta, e, e, `\n${text}`);
          setCaret(ta, e + 1);
        } else {
          const s = lineStart(v, pos);
          replaceRange(ta, s, s, `${text}\n`);
          setCaret(ta, s);
        }
      } else {
        const at = key === "p" ? Math.min(lineEnd(v, pos), pos + 1) : pos;
        replaceRange(ta, at, at, text);
      }
      return done();
    }
    case "u":
      for (let i = 0; i < count; i += 1) document.execCommand("undo");
      return done();
    case "v":
      visualAnchor = pos;
      select(ta, pos, Math.min(v.length, pos + 1));
      setState({ mode: "visual", pending: "" });
      return true;
    case "V": {
      const [a, b] = lineRange(v, pos, count);
      visualAnchor = a;
      select(ta, a, b);
      setState({ mode: "visual", pending: "" });
      return true;
    }
    case "H":
      ta.blur();
      setState({ mode: "nav", pending: "" });
      enterSidebar();
      return true;
    case "L":
      ta.blur();
      setState({ mode: "nav", pending: "" });
      return true;
    default:
      return done(); // swallow so nothing types in normal mode
  }
}
