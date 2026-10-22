// Spatial tooltips: in a row of 3+ tooltip buttons, one bubble glides between
// siblings instead of each button popping its own. Radix still owns timing,
// focus, Escape and the screen-reader text; we mirror its open state, hide the
// native bubble visually, and draw a single shared one.

const SCOPE = "#thread-detail-timeline-panel, [data-app-composer]";
const OPEN = '[data-state="delayed-open"], [data-state="instant-open"]';
const GAP = 4; // Radix sideOffset in BB
const EDGE = 8;
const SKIP_MS = 300; // Radix skipDelayDuration default: sibling opens instantly within it

type Rect = { left: number; top: number; bottom: number; width: number };

/** Where the bubble goes: centered on the trigger, flipped when it won't fit, clamped to the viewport. */
export function placeTip(trigger: Rect, w: number, h: number, vw: number, vh: number, side: string) {
  const below = trigger.bottom + GAP;
  const above = trigger.top - GAP - h;
  const top = side === "top" ? (above < EDGE ? below : above) : below + h > vh - EDGE && above >= EDGE ? above : below;
  const left = Math.min(Math.max(trigger.left + trigger.width / 2 - w / 2, EDGE), Math.max(EDGE, vw - EDGE - w));
  return { x: Math.round(left), y: Math.round(top), origin: top < trigger.top ? "bottom" : "top" };
}

/** Nearest single-row ancestor (≤2 levels up) holding 3+ button items, else null. */
function groupOf(trigger: Element): Element | null {
  const scope = trigger.closest(SCOPE);
  if (!scope) return null;
  const h = trigger.getBoundingClientRect().height;
  let el = trigger.parentElement;
  for (let i = 0; el && el !== scope && i < 2; i++, el = el.parentElement) {
    const items = Array.from(el.children).filter((c) => c.matches("button") || c.querySelector("button"));
    if (items.length >= 3 && el.getBoundingClientRect().height <= h * 2 + 8) return el;
  }
  return null;
}

export function mountSpatialTooltips(): () => void {
  const tip = document.createElement("div");
  tip.className = "bui-spatial-tip";
  tip.setAttribute("aria-hidden", "true");
  const measure = document.createElement("div");
  measure.className = "bui-spatial-tip bui-spatial-tip-measure";
  measure.setAttribute("aria-hidden", "true");
  document.body.append(tip, measure);

  let group: Element | null = null;
  let hiddenAt = 0;
  let open = false;

  const sync = () => {
    let trigger: Element | undefined;
    let nextGroup: Element | null = null;
    for (const t of Array.from(document.querySelectorAll(OPEN))) if ((nextGroup = groupOf(t))) { trigger = t; break; }
    if (!trigger || !nextGroup) {
      if (open) (open = false), (hiddenAt = performance.now()), tip.removeAttribute("data-open");
      return;
    }
    const native = document.getElementById(trigger.getAttribute("aria-describedby") ?? "");
    native?.closest("[data-radix-popper-content-wrapper]")?.setAttribute("data-bui-spatial-native", "");
    const text = native?.textContent?.trim() || trigger.getAttribute("aria-label") || "";
    const glide = nextGroup === group && (open || performance.now() - hiddenAt < SKIP_MS);

    measure.textContent = text;
    // offset* ignores the closed-state scale(0.96) that getBoundingClientRect would include
    const w = Math.min(measure.offsetWidth + 1, 320);
    const side = native?.parentElement?.getAttribute("data-side") ?? "bottom";
    const { x, y, origin } = placeTip(trigger.getBoundingClientRect(), w, measure.offsetHeight, innerWidth, innerHeight, side);

    if (!glide) tip.setAttribute("data-snap", "");
    tip.textContent = text;
    tip.style.setProperty("--x", `${x}px`);
    tip.style.setProperty("--y", `${y}px`);
    tip.style.setProperty("--w", `${w}px`);
    tip.style.transformOrigin = `center ${origin}`;
    if (!glide) void tip.offsetWidth, tip.removeAttribute("data-snap");
    tip.setAttribute("data-open", "");
    group = nextGroup;
    open = true;
  };

  const observer = new MutationObserver(sync);
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-state", "aria-describedby"] });

  return () => {
    observer.disconnect();
    tip.remove();
    measure.remove();
    document.querySelectorAll("[data-bui-spatial-native]").forEach((el) => el.removeAttribute("data-bui-spatial-native"));
  };
}
