// DOM contract with the BB app. Every selector here was read from the bb 0.45
// app bundle; if BB renames one, this is the only file to touch.

/** The Tiptap/ProseMirror editable inside a BB composer. */
export const EDITOR_SELECTOR =
  "[data-promptbox-editor-content] .ProseMirror[contenteditable='true']";
/** The thread timeline's scroll container (one per pane). */
export const VIEWPORT_SELECTOR = "[data-page-scroll-viewport]";
/** Top-level timeline rows (messages, tool bundles, dividers). */
export const ROW_SELECTOR =
  "[data-timeline-row-list='top-level'] [data-timeline-row-id]";
/** Sidebar thread rows. BB's own shortcuts use the same selector. */
export const SIDEBAR_ROW_SELECTOR = "[data-sidebar-thread-shortcut-target]";
/** Sidebar navigation rows above the threads (New thread, Plugins, Kanban…). */
export const SIDEBAR_NAV_SELECTOR = "[data-sidebar-navigation-item] > button";
/** Submit button of the composer under the caret. */
export const SUBMIT_SELECTOR = "[data-promptbox-submit-action]";

export const CURSOR_ATTR = "data-vim-cursor";

export function activeEditor(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  return active.closest<HTMLElement>(EDITOR_SELECTOR);
}

/** Opt-out marker: anything inside `[data-vim-ignore]` is left to its owner. */
export const IGNORE_SELECTOR = "[data-vim-ignore]";

/**
 * Generic editable target other than BB's composer: a textarea, or any
 * contenteditable region (a plugin's own editor). Single-line inputs are
 * deliberately excluded: search boxes expect Escape to clear/close.
 */
export type EditableTarget =
  | { kind: "textarea"; element: HTMLTextAreaElement }
  | { kind: "contenteditable"; element: HTMLElement };

export function activeGenericEditable(): EditableTarget | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (active.closest(IGNORE_SELECTOR)) return null;
  if (active.closest(EDITOR_SELECTOR)) return null;
  if (active instanceof HTMLTextAreaElement) {
    return active.readOnly ? null : { kind: "textarea", element: active };
  }
  if (active.isContentEditable) {
    let root: HTMLElement = active;
    while (root.parentElement?.isContentEditable) root = root.parentElement;
    return { kind: "contenteditable", element: root };
  }
  return null;
}

/** Element under the last pointerdown; scroll keys prefer its scroll area. */
let lastPointerTarget: HTMLElement | null = null;
export function notePointerTarget(target: EventTarget | null): void {
  lastPointerTarget = target instanceof HTMLElement ? target : null;
}

function isScrollable(element: HTMLElement): boolean {
  if (element.scrollHeight <= element.clientHeight + 1) return false;
  const overflowY = getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll";
}

function scrollableAncestor(node: HTMLElement | null): HTMLElement | null {
  let el: HTMLElement | null = node;
  while (el && el !== document.body) {
    if (isScrollable(el)) return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * The scroll region j/k should move. Priority:
 *   1. `[data-vim-scroll]` inside the focused/last-clicked area (opt-in)
 *   2. the scrollable ancestor of the focused element
 *   3. the scrollable ancestor of the last pointerdown target
 *   4. BB's thread viewport (focused pane, else largest)
 *   5. the largest visible scrollable element outside the sidebar
 */
export function findScrollTarget(): HTMLElement | null {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const anchors = [active, lastPointerTarget].filter(
    (n): n is HTMLElement => n !== null && n.isConnected,
  );
  for (const anchor of anchors) {
    const optIn = anchor.closest<HTMLElement>("[data-vim-scroll]");
    if (optIn && isVisible(optIn)) return optIn;
  }
  for (const anchor of anchors) {
    if (anchor === document.body) continue;
    const scrollable = scrollableAncestor(anchor);
    if (scrollable && isVisible(scrollable)) return scrollable;
  }
  const viewport = currentViewport();
  if (viewport) return viewport;
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
    if (el.closest("[data-sidebar], aside, nav")) continue;
    if (!isScrollable(el) || !isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

export function anyEditor(): HTMLElement | null {
  const editors = Array.from(
    document.querySelectorAll<HTMLElement>(EDITOR_SELECTOR),
  ).filter(isVisible);
  if (editors.length === 0) return null;
  // Prefer the composer inside the focused/most recently used viewport, else
  // the last one in DOM order (the main thread composer renders after the
  // sidebar and any new-thread composer).
  const viewport = currentViewport();
  if (viewport) {
    const pane = paneRoot(viewport);
    const inPane = editors.find((editor) => pane.contains(editor));
    if (inPane) return inPane;
  }
  return editors[editors.length - 1] ?? null;
}

/** True when the element the user is typing into is not a BB composer. */
export function isForeignEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(EDITOR_SELECTOR)) return false;
  if (target.closest(IGNORE_SELECTOR)) return true;
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target.isContentEditable) return true;
  // xterm.js keeps focus in a hidden textarea; the webview browser never
  // bubbles keys to us. Monaco/CodeMirror would be contenteditable or textarea.
  return false;
}

/** A modal, menu, palette or popover is open: leave keys to the host. */
export function overlayOpen(): boolean {
  if (
    document.querySelector(
      [
        "[role='dialog'][data-state='open']",
        "[role='alertdialog'][data-state='open']",
        "[role='menu'][data-state='open']",
        "[role='listbox']",
        "[cmdk-root]",
      ].join(","),
    ) !== null
  ) {
    return true;
  }
  // Popovers and mention menus block us; tooltips (hover hints) do not.
  for (const wrapper of Array.from(
    document.querySelectorAll("[data-radix-popper-content-wrapper]"),
  )) {
    if (!wrapper.querySelector("[role='tooltip']")) return true;
  }
  return false;
}

export function isVisible(element: Element): boolean {
  if (typeof (element as HTMLElement).checkVisibility === "function") {
    return (element as HTMLElement).checkVisibility({
      visibilityProperty: true,
    } as CheckVisibilityOptions);
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function paneRoot(viewport: HTMLElement): HTMLElement {
  // Walk up to the element that also contains a composer, if any; fall back
  // to the viewport's parent.
  let node: HTMLElement | null = viewport;
  while (node && node !== document.body) {
    if (node.querySelector(EDITOR_SELECTOR)) return node;
    node = node.parentElement;
  }
  return viewport.parentElement ?? viewport;
}

/** The timeline viewport to scroll: the focused pane's, else the largest. */
export function currentViewport(): HTMLElement | null {
  const viewports = Array.from(
    document.querySelectorAll<HTMLElement>(VIEWPORT_SELECTOR),
  ).filter(isVisible);
  if (viewports.length === 0) return null;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const containing = viewports.find((viewport) => {
      const pane = paneRoot(viewport);
      return pane.contains(active);
    });
    if (containing) return containing;
  }
  let best = viewports[0]!;
  let bestArea = 0;
  for (const viewport of viewports) {
    const rect = viewport.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = viewport;
      bestArea = area;
    }
  }
  return best;
}

export function timelineRows(viewport: HTMLElement): HTMLElement[] {
  const rows = Array.from(
    viewport.querySelectorAll<HTMLElement>(ROW_SELECTOR),
  ).filter(
    // Keep only top-level rows: skip rows nested inside another row (tool
    // bundles) and rows the virtualizer has collapsed to zero height.
    (row) =>
      row.parentElement?.closest("[data-timeline-row-id]") === null &&
      row.getBoundingClientRect().height > 0,
  );
  if (rows.length > 0) return rows;
  // Fallback when the list is not tagged top-level (older/newer bb).
  return Array.from(
    viewport.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
  ).filter((row) => row.parentElement?.closest("[data-timeline-row-id]") === null);
}

/** Escape and Ctrl-C are interchangeable everywhere in this plugin. */
export function isEscape(event: KeyboardEvent): boolean {
  if (event.metaKey || event.altKey) return false;
  if (event.key === "Escape" && !event.ctrlKey) return true;
  return event.ctrlKey && (event.key === "c" || event.key === "C");
}

/** Visible sidebar thread rows, in DOM order, mirroring BB's own filter. */
export function sidebarRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(SIDEBAR_ROW_SELECTOR),
  ).filter(
    (row) =>
      !row.closest("[data-sidebar-overflow='true']") && isVisible(row),
  );
}

export function sidebarRowThreadId(row: HTMLElement): string | null {
  return row.getAttribute("data-sidebar-thread-id");
}

/** Visible navigation rows, in DOM order. */
export function sidebarNavRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(SIDEBAR_NAV_SELECTOR),
  ).filter(isVisible);
}

/** Every row the sidebar cursor visits: navigation rows, then threads. */
export function sidebarCursorRows(): HTMLElement[] {
  return [...sidebarNavRows(), ...sidebarRows()];
}

/** Stable identity for a cursor row across re-renders. */
export function sidebarRowKey(row: HTMLElement): string | null {
  const navId = row
    .closest("[data-sidebar-navigation-item]")
    ?.getAttribute("data-sidebar-navigation-item");
  if (navId) return `nav:${navId}`;
  return sidebarRowThreadId(row);
}

export function isSidebarNavRow(row: HTMLElement): boolean {
  return row.matches(SIDEBAR_NAV_SELECTOR);
}

/** The sidebar row for the thread currently on screen, if any. */
export function currentSidebarRow(rows: HTMLElement[]): HTMLElement | null {
  const path = window.location.pathname;
  const match = /\/threads?\/([a-z0-9_]+)/i.exec(path);
  const threadId = match?.[1] ?? null;
  for (const row of rows) {
    if (row.getAttribute("aria-current") === "page") return row;
    if (row.getAttribute("data-active") === "true") return row;
    if (threadId && sidebarRowThreadId(row) === threadId) return row;
  }
  return null;
}

export function clearCursor(): void {
  for (const row of Array.from(document.querySelectorAll(`[${CURSOR_ATTR}]`))) {
    row.removeAttribute(CURSOR_ATTR);
  }
}

export function setCursor(row: HTMLElement): void {
  clearCursor();
  row.setAttribute(CURSOR_ATTR, "");
  row.scrollIntoView({ block: "nearest" });
}

/** Dispatch a trusted-looking key to the editor so Tiptap's keymap runs. */
export function sendKey(
  target: HTMLElement,
  key: string,
  options: { meta?: boolean; shift?: boolean; ctrl?: boolean } = {},
): void {
  const keyCode = KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0);
  const init: KeyboardEventInit & { keyCode: number; which: number } = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    keyCode,
    which: keyCode,
    metaKey: options.meta ?? false,
    shiftKey: options.shift ?? false,
    ctrlKey: options.ctrl ?? false,
    bubbles: true,
    cancelable: true,
  };
  synthetic = true;
  try {
    const down = new KeyboardEvent("keydown", init);
    target.dispatchEvent(down);
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  } finally {
    synthetic = false;
  }
}

const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Escape: 27,
  ArrowUp: 38,
  ArrowDown: 40,
  Backspace: 8,
  Delete: 46,
  z: 90,
  Z: 90,
};

let synthetic = false;
export function isSyntheticDispatch(): boolean {
  return synthetic;
}
