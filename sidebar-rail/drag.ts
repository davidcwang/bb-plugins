// Continuous drag between the full sidebar and the rail.
//
// BB's own resize drag is relative (start width + pointer delta), clamped to
// MIN_WIDTH..MAX_WIDTH, and persisted to localStorage on mouseup. This module
// takes over only the range BB refuses: below MIN_WIDTH the sidebar follows the
// pointer down to the rail, and on release it eases to whichever end is closer.
// From the rail, the edge follows the pointer out and, once it reaches
// MIN_WIDTH, the drag is handed to BB so the width it saves is the one shown.
//
// The displayed width is overridden with html[data-sidebar-rail-drag] and the
// --sidebar-rail-drag custom property (see app.css); BB's state is changed
// only through its own toggle button and resize handle.

const RESIZE_HANDLE = '[data-testid="app-sidebar-resize-handle"]';
const TRIGGER = '[data-sidebar="trigger"]';
const WIDTH_KEY = "bb.sidebar.width";

/** BB's clamp for the sidebar width (nae / rae / iae in the app bundle). */
const MIN_WIDTH = 240;
const MAX_WIDTH = 460;
const DEFAULT_WIDTH = 320;
/** Must match --sidebar-rail-width in app.css. */
const RAIL_WIDTH = 48;
/** Released below this, the sidebar settles on the rail; above, on MIN_WIDTH. */
const SETTLE_SPLIT = (RAIL_WIDTH + MIN_WIDTH) / 2;
/** Pointer travel past the rail edge before a rail drag expands the sidebar. */
const EXPAND_SLOP = 8;
const SETTLE_MS = 180;

const DRAG_ATTR = "data-sidebar-rail-drag";
const SETTLE_ATTR = "data-sidebar-rail-settle";
const DRAG_VAR = "--sidebar-rail-drag";

const root = () => document.documentElement;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const isCollapsed = () =>
  document.querySelector('[data-side="left"][data-state="collapsed"]') !== null;
const toggle = () => document.querySelector<HTMLButtonElement>(TRIGGER)?.click();

function savedWidth(): number {
  const saved = Number(window.localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(saved) && saved > 0 ? clamp(saved, MIN_WIDTH, MAX_WIDTH) : DEFAULT_WIDTH;
}

function showWidth(width: number): void {
  root().setAttribute(DRAG_ATTR, "");
  root().style.setProperty(DRAG_VAR, `${width}px`);
}

function clearWidth(): void {
  root().removeAttribute(DRAG_ATTR);
  root().removeAttribute(SETTLE_ATTR);
  root().style.removeProperty(DRAG_VAR);
}

/** Start a BB resize drag; it measures from clientX, so pick startX to align. */
function startHostDrag(clientX: number): void {
  document.querySelector(RESIZE_HANDLE)?.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX }),
  );
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Collapsing through BB's drag leaves it saving MIN_WIDTH. Replay a drag on the
 * (now hidden) handle so the width it reopens at is the one from before. The
 * move and release go out back to back so a real pointer move can't land in
 * between and become the saved width.
 */
async function restoreHostWidth(width: number): Promise<void> {
  startHostDrag(0);
  // BB attaches its window listeners in an effect after the mousedown render.
  await nextFrame();
  await nextFrame();
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: width - savedWidth() }));
  window.dispatchEvent(new MouseEvent("mouseup", {}));
}

export function mountDrag(signal: AbortSignal): () => void {
  /**
   * shrink: a BB drag from the expanded sidebar (we only act below MIN_WIDTH).
   * grow:   our drag out of the rail, until it is handed to BB.
   * host:   a handed-off drag; we mirror BB's width so nothing flickers.
   */
  let mode: "idle" | "shrink" | "grow" | "host" = "idle";
  let widthAtStart = DEFAULT_WIDTH;
  let shown: number | null = null;
  let settleTimer = 0;

  const settle = (target: number, then: () => void) => {
    root().setAttribute(SETTLE_ATTR, "");
    // Commit the current width before the transition target changes.
    void root().offsetWidth;
    showWidth(target);
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      then();
      clearWidth();
      shown = null;
    }, SETTLE_MS);
  };

  const onMouseDown = (event: MouseEvent) => {
    if (!event.isTrusted || event.button !== 0) return;
    if (!(event.target as Element | null)?.closest(RESIZE_HANDLE)) return;
    window.clearTimeout(settleTimer);
    clearWidth();
    widthAtStart = savedWidth();
    if (isCollapsed()) {
      // BB's handle would resize the hidden sidebar; this drag is ours.
      event.preventDefault();
      event.stopPropagation();
      mode = "grow";
      showWidth(RAIL_WIDTH);
      shown = RAIL_WIDTH;
    } else {
      mode = "shrink";
    }
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const x = event.clientX;
    if (mode === "shrink") {
      if (x < MIN_WIDTH) {
        shown = clamp(x, RAIL_WIDTH, MIN_WIDTH);
        showWidth(shown);
      } else if (shown !== null) {
        clearWidth();
        shown = null;
      }
    } else if (mode === "grow") {
      if (isCollapsed() && x > RAIL_WIDTH + EXPAND_SLOP) toggle();
      if (x >= MIN_WIDTH && !isCollapsed()) {
        // BB sets width = startWidth + (x - startX); startX = startWidth makes it x.
        mode = "host";
        startHostDrag(widthAtStart);
      }
      if (mode === "host") {
        shown = clamp(x, MIN_WIDTH, MAX_WIDTH);
      } else {
        shown = clamp(x, RAIL_WIDTH, MIN_WIDTH);
      }
      showWidth(shown);
    } else if (mode === "host") {
      shown = clamp(x, MIN_WIDTH, MAX_WIDTH);
      showWidth(shown);
    }
  };

  const onMouseUp = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const ended = mode;
    mode = "idle";
    if (ended === "host" || (ended === "shrink" && shown === null)) {
      clearWidth();
      shown = null;
      return;
    }
    if (shown === null) return;
    const toRail = shown < SETTLE_SPLIT;
    if (ended === "shrink") {
      const restoreTo = widthAtStart;
      if (toRail) {
        settle(RAIL_WIDTH, () => {
          toggle();
          void restoreHostWidth(restoreTo);
        });
      } else {
        settle(MIN_WIDTH, () => {});
      }
    } else if (ended === "grow") {
      if (toRail) {
        settle(RAIL_WIDTH, () => {
          if (!isCollapsed()) toggle();
        });
      } else {
        // BB reopens at its saved width; ease there instead of jumping.
        settle(widthAtStart, () => {
          if (isCollapsed()) toggle();
        });
      }
    }
  };

  document.addEventListener("mousedown", onMouseDown, { capture: true, signal });
  window.addEventListener("mousemove", onMouseMove, { signal });
  window.addEventListener("mouseup", onMouseUp, { signal });

  return () => {
    window.clearTimeout(settleTimer);
    document.removeEventListener("mousedown", onMouseDown, { capture: true });
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    clearWidth();
  };
}
