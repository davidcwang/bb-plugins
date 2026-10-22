// bb-plugin-sidebar-rail — frontend entry.
//
// Collapsing the sidebar (⌘\, BB's own sidebar.toggle) leaves an icon rail
// instead of hiding it. app.css does the layout; this content script turns it
// on, gives the label-less rail icons hover titles, and tags each thread row
// with the monogram and hue its rail badge shows.
import "./app.css";
import { definePluginApp } from "@get-bb/plugin-sdk/app";

const RAIL_ATTR = "data-sidebar-rail";
const THREAD_ANCHOR = "[data-sidebar-thread-shortcut-target]";
const INITIALS_ATTR = "data-rail-initials";
const HUE_ATTR = "data-rail-hue";
const FOR_ATTR = "data-rail-for";
const CURRENT_ATTR = "data-rail-current";
const STOP_WORDS = new Set(
  "a all also an and any are be can could do does for from get have how i if in is it just let make me my not of on or our please should so some that the there these this those to us want we what when why will with would you".split(" "),
);
const RESIZE_HANDLE = '[data-testid="app-sidebar-resize-handle"]';
const TRIGGER = '[data-sidebar="trigger"]';
/** Dragging the sidebar edge left of this collapses it to the rail… */
const COLLAPSE_AT_X = 120;
/** …and dragging the rail's edge right of this expands it again. */
const EXPAND_AT_X = 160;
const RAIL_BUTTON = '[data-state="collapsed"] [data-sidebar-navigation-item] > button, [data-state="collapsed"] [data-testid="sidebar-navigation-more-trigger"]';

/** Two letters from the first distinct words of a title that aren't filler. */
function initials(title: string): string {
  const words = title.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const picked: string[] = [];
  for (const word of words) {
    if (STOP_WORDS.has(word) || picked.includes(word)) continue;
    picked.push(word);
    if (picked.length === 2) break;
  }
  if (picked.length === 0 && words[0]) picked.push(words[0]);
  return picked.map((word) => word[0]!.toUpperCase()).join("") || "?";
}

/** A stable hue per thread id, so a thread keeps its colour across renames. */
function hue(threadId: string): number {
  let hash = 0;
  for (let i = 0; i < threadId.length; i++) hash = (hash * 31 + threadId.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

function tagThreadRows(tagged: Set<HTMLElement>): void {
  const current = /\/threads\/([a-z0-9_]+)/i.exec(window.location.pathname)?.[1] ?? null;
  for (const anchor of document.querySelectorAll<HTMLElement>(THREAD_ANCHOR)) {
    const inset = anchor.parentElement;
    const threadId = anchor.getAttribute("data-sidebar-thread-id");
    if (inset === null || threadId === null) continue;
    // BB paints the selected row without a marker class, so derive it from the route.
    inset.toggleAttribute(CURRENT_ATTR, threadId === current);
    const title = inset.querySelector(".bb-thread-title")?.textContent?.trim() ?? "";
    const key = `${threadId}\n${title}`;
    if (inset.getAttribute(FOR_ATTR) === key) continue;
    inset.setAttribute(FOR_ATTR, key);
    inset.setAttribute(INITIALS_ATTR, initials(title));
    inset.setAttribute(HUE_ATTR, String(hue(threadId)));
    if (title !== "") inset.setAttribute("title", title);
    tagged.add(inset);
  }
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "rail",
    mount({ signal }) {
      const root = document.documentElement;
      root.setAttribute(RAIL_ATTR, "");

      // Navigation rows have no aria-label; their text is hidden in the rail,
      // so set a title from it on first hover.
      const titled = new Set<HTMLElement>();
      const onPointerOver = (event: PointerEvent) => {
        const button = (event.target as Element | null)?.closest<HTMLElement>(RAIL_BUTTON);
        if (button === null || button === undefined || button.hasAttribute("title")) return;
        const label = button.getAttribute("aria-label") ?? button.textContent?.trim();
        if (!label) return;
        button.setAttribute("title", label);
        titled.add(button);
      };
      document.addEventListener("pointerover", onPointerOver, { signal });

      // BB clamps the resize drag at a minimum width. Track the same drag and
      // snap to the rail once the pointer passes COLLAPSE_AT_X; from the rail,
      // drag its edge out past EXPAND_AT_X to expand. Collapsed, BB's handle
      // does nothing, so that drag is ours alone.
      let dragging = false;
      const isCollapsed = () =>
        document.querySelector('[data-side="left"][data-state="collapsed"]') !== null;
      const toggle = () => document.querySelector<HTMLButtonElement>(TRIGGER)?.click();
      const onMouseDown = (event: MouseEvent) => {
        if (event.button !== 0 || !(event.target as Element | null)?.closest(RESIZE_HANDLE)) return;
        dragging = true;
        if (isCollapsed()) {
          event.preventDefault();
          event.stopPropagation();
        }
      };
      const onMouseMove = (event: MouseEvent) => {
        if (!dragging) return;
        const collapsed = isCollapsed();
        if (!collapsed && event.clientX < COLLAPSE_AT_X) toggle();
        else if (collapsed && event.clientX > EXPAND_AT_X) toggle();
      };
      const onMouseUp = () => {
        dragging = false;
      };
      document.addEventListener("mousedown", onMouseDown, { capture: true, signal });
      document.addEventListener("mousemove", onMouseMove, { signal });
      document.addEventListener("mouseup", onMouseUp, { signal });

      // The thread list is windowed and re-rendered on every change, so
      // re-tag after each mutation batch; rows already tagged are skipped.
      const tagged = new Set<HTMLElement>();
      let frame = 0;
      const schedule = () => {
        if (frame !== 0) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          for (const inset of tagged) if (!inset.isConnected) tagged.delete(inset);
          tagThreadRows(tagged);
        });
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      schedule();

      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        for (const inset of tagged) {
          for (const attr of [FOR_ATTR, INITIALS_ATTR, HUE_ATTR, CURRENT_ATTR, "title"]) inset.removeAttribute(attr);
        }
        document.removeEventListener("pointerover", onPointerOver);
        document.removeEventListener("mousedown", onMouseDown, { capture: true });
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        for (const button of titled) button.removeAttribute("title");
        root.removeAttribute(RAIL_ATTR);
      };
    },
  });
});
