// Nav mode (nothing editable focused): scroll the thread, jump between
// messages, focus the composer, and drive a cursor over the sidebar threads
// and, above the first thread, the navigation rows (New thread, Kanban, …).
import {
  anyEditor,
  clearCursor,
  currentSidebarRow,
  currentViewport,
  findScrollTarget,
  isSidebarNavRow,
  setCursor,
  sidebarCursorRows,
  sidebarRowKey,
  sidebarRows,
  timelineRows,
  CURSOR_ATTR,
  isEscape,
} from "./dom";
import { getState, setState } from "./store";

const LINE_PX = 80;

let sidebarKey: string | null = null;
let observer: MutationObserver | null = null;

/**
 * BB re-renders the thread list after navigation and may replace the row
 * element, dropping our attribute. Re-apply it synchronously in the same
 * frame the DOM changes so the outline never blinks.
 */
function watchSidebar(): void {
  if (observer) return;
  observer = new MutationObserver(() => {
    if (getState().mode !== "sidebar" || !sidebarKey) return;
    const rows = sidebarCursorRows();
    const row = rows.find((r) => sidebarRowKey(r) === sidebarKey);
    if (row && !row.hasAttribute(CURSOR_ATTR)) {
      clearCursor();
      row.setAttribute(CURSOR_ATTR, "");
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-current", "data-active", "class"],
  });
}

function unwatchSidebar(): void {
  observer?.disconnect();
  observer = null;
}

/**
 * Open the thread under the cursor without leaving sidebar mode. The cursor
 * paint is synchronous; the navigation waits until keys stop for a moment.
 * Each navigation renders the whole thread view and blocks the main thread,
 * so navigating on every keypress would queue the next keypress behind it.
 */
const FOLLOW_IDLE_MS = 90;
let followTimer: number | null = null;

function previewCursorRow(): void {
  if (followTimer !== null) window.clearTimeout(followTimer);
  followTimer = window.setTimeout(() => {
    followTimer = null;
    if (getState().mode !== "sidebar") return;
    const rows = sidebarCursorRows();
    const row = rows[cursorRow(rows)];
    if (!row || row.getAttribute("aria-current") === "page") return;
    // Navigation rows open pages or panels; only Enter activates them.
    if (isSidebarNavRow(row)) return;
    row.click();
  }, FOLLOW_IDLE_MS);
}

function scrollBy(px: number): void {
  findScrollTarget()?.scrollBy({ top: px, behavior: "auto" });
}

function scrollTo(edge: "top" | "bottom"): void {
  const viewport = findScrollTarget();
  if (!viewport) return;
  viewport.scrollTo({
    top: edge === "top" ? 0 : viewport.scrollHeight,
    behavior: "auto",
  });
}

function jumpRow(direction: 1 | -1, count: number): void {
  const viewport = currentViewport();
  if (!viewport) return;
  const rows = timelineRows(viewport);
  if (rows.length === 0) return;
  const top = viewport.getBoundingClientRect().top;
  const tops = rows.map((row) => row.getBoundingClientRect().top - top);
  let target: HTMLElement | undefined;
  if (direction === 1) {
    const ahead = rows.filter((_, i) => tops[i]! > 4);
    target = ahead[Math.min(count, ahead.length) - 1];
  } else {
    const behind = rows.filter((_, i) => tops[i]! < -4);
    target = behind[Math.max(behind.length - count, 0)];
  }
  target?.scrollIntoView({ block: "start", behavior: "auto" });
}

function focusComposer(where: "end" | "start" | "newline"): void {
  const editor = anyEditor();
  if (!editor) return;
  editor.focus({ preventScroll: false });
  const sel = window.getSelection();
  if (sel) {
    sel.selectAllChildren(editor);
    sel.collapseToEnd();
    if (where === "start") sel.modify("move", "backward", "documentboundary");
  }
  setState({ mode: "insert", pending: "" });
}

// ---------------------------------------------------------------- sidebar

export function enterSidebar(): void {
  const threads = sidebarRows();
  const current =
    currentSidebarRow(threads) ?? threads[0] ?? sidebarCursorRows()[0];
  if (!current) return;
  sidebarKey = sidebarRowKey(current);
  setCursor(current);
  watchSidebar();
  setState({ mode: "sidebar", pending: "" });
}

export function leaveSidebar(): void {
  if (followTimer !== null) window.clearTimeout(followTimer);
  followTimer = null;
  unwatchSidebar();
  clearCursor();
  sidebarKey = null;
  if (getState().mode === "sidebar") setState({ mode: "nav", pending: "" });
}

function cursorRow(rows: HTMLElement[]): number {
  const byAttr = rows.findIndex((row) => row.hasAttribute(CURSOR_ATTR));
  if (byAttr >= 0) return byAttr;
  if (sidebarKey) {
    const byId = rows.findIndex((row) => sidebarRowKey(row) === sidebarKey);
    if (byId >= 0) return byId;
  }
  return 0;
}

function moveSidebar(delta: number): void {
  const rows = sidebarCursorRows();
  if (rows.length === 0) return;
  const index = Math.min(
    rows.length - 1,
    Math.max(0, cursorRow(rows) + delta),
  );
  const row = rows[index]!;
  sidebarKey = sidebarRowKey(row);
  setCursor(row);
  previewCursorRow();
}

/** gg / G: first / last thread (k past the first thread reaches navigation). */
function sidebarEdge(edge: "first" | "last"): void {
  const threads = sidebarRows();
  const rows = threads.length > 0 ? threads : sidebarCursorRows();
  const row = edge === "first" ? rows[0] : rows[rows.length - 1];
  if (!row) return;
  sidebarKey = sidebarRowKey(row);
  setCursor(row);
  previewCursorRow();
}

function openSidebarRow(): void {
  if (followTimer !== null) window.clearTimeout(followTimer);
  followTimer = null;
  const rows = sidebarCursorRows();
  const row = rows[cursorRow(rows)];
  if (!row) return;
  // BB routes an unmodified primary click in place.
  row.click();
  leaveSidebar();
}

// ---------------------------------------------------------------- dispatch

/**
 * Handle one keydown with no editable element focused. Returns true when
 * consumed.
 */
export function handleNavKey(event: KeyboardEvent): boolean {
  const state = getState();
  const key = event.key;
  const escape = isEscape(event);
  const ctrl = event.ctrlKey && !event.metaKey && !event.altKey;
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey;

  if (!ctrl && !plain) return false;
  if (key === "Shift" || key === "Control" || key === "Meta" || key === "Alt") {
    return false;
  }

  let pending = state.pending;
  const done = (): boolean => {
    setState({ pending: "" });
    return true;
  };

  // Ctrl-w window prefix (vim window navigation: sidebar <-> thread).
  if (ctrl && key === "w") {
    setState({ pending: "^W" });
    return true;
  }
  if (pending === "^W") {
    if (plain && (key === "h" || key === "ArrowLeft")) enterSidebar();
    else if (plain && (key === "l" || key === "ArrowRight")) leaveSidebar();
    return done();
  }

  if (escape) {
    if (state.helpOpen) {
      setState({ helpOpen: false, pending: "" });
      return true;
    }
    if (pending) return done();
    if (state.mode === "sidebar") {
      leaveSidebar();
      return true;
    }
    return false;
  }

  if (ctrl) {
    const viewport = findScrollTarget();
    const half = (viewport?.clientHeight ?? 600) / 2;
    switch (key) {
      case "d":
        scrollBy(half);
        return done();
      case "u":
        scrollBy(-half);
        return done();
      case "f":
        scrollBy(half * 2);
        return done();
      case "b":
        scrollBy(-half * 2);
        return done();
      case "e":
        scrollBy(LINE_PX);
        return done();
      case "y":
        scrollBy(-LINE_PX);
        return done();
      default:
        return false;
    }
  }

  if (key === "?") {
    setState({ helpOpen: !state.helpOpen, pending: "" });
    return true;
  }

  if (/^[1-9]$/.test(key) || (key === "0" && /\d$/.test(pending))) {
    setState({ pending: pending + key });
    return true;
  }
  const countMatch = /^(\d+)/.exec(pending);
  const count = countMatch ? Number.parseInt(countMatch[1]!, 10) : 1;
  const prefix = pending.slice(countMatch?.[0].length ?? 0);

  if (prefix === "g") {
    if (key === "g") {
      if (state.mode === "sidebar") sidebarEdge("first");
      else scrollTo("top");
    }
    return done();
  }
  if (key === "g") {
    setState({ pending: `${countMatch?.[0] ?? ""}g` });
    return true;
  }

  if (state.mode === "sidebar") {
    switch (key) {
      case "j":
      case "ArrowDown":
        moveSidebar(count);
        return done();
      case "k":
      case "ArrowUp":
        moveSidebar(-count);
        return done();
      case "G":
        sidebarEdge("last");
        return done();
      case "Enter":
      case "l":
      case "o":
      case " ":
        openSidebarRow();
        return done();
      case "h":
      case "L":
        leaveSidebar();
        return done();
      default:
        return done();
    }
  }

  switch (key) {
    case "j":
      scrollBy(LINE_PX * count);
      return done();
    case "k":
      scrollBy(-LINE_PX * count);
      return done();
    case "J":
      jumpRow(1, count);
      return done();
    case "K":
      jumpRow(-1, count);
      return done();
    case "G":
      scrollTo("bottom");
      return done();
    case "i":
    case "a":
    case "A":
      focusComposer("end");
      return done();
    case "I":
      focusComposer("start");
      return done();
    case "o":
      focusComposer("newline");
      return done();
    case "H":
      enterSidebar();
      return done();
    case "L":
      leaveSidebar();
      return done();
    default:
      return pending ? done() : false;
  }
}
