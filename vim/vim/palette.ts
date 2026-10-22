// Vim-style keys inside BB's palettes (Cmd+K quick palette, Cmd+Shift+P
// command palette). A palette opens in PALETTE (normal) mode: plain j/k move,
// Enter runs, gg/G jump, `i` or `/` switches to typing. Esc while typing goes
// back to PALETTE mode; Esc in PALETTE mode closes the palette (BB's default).
// Ctrl-j/k/n/p/d/u/y/c work in both modes.
import { isEscape, sendKey } from "./dom";
import { getState, setState } from "./store";

const INPUT_FRAME = "[data-palette-input-frame]";

let currentInput: HTMLElement | null = null;

/** The focused palette search input, if a palette is open and focused. */
export function activePaletteInput(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (!(active instanceof HTMLInputElement || active.isContentEditable)) {
    return null;
  }
  if (active.closest(INPUT_FRAME)) return active;
  // Fallback: an input inside a dialog that lists options (older/newer bb).
  const dialog = active.closest<HTMLElement>("[role='dialog']");
  if (dialog?.querySelector("[role='option'], [cmdk-item]")) return active;
  return null;
}

/** Call whenever a palette input is focused: a new palette starts in PALETTE mode. */
export function syncPaletteMode(input: HTMLElement): void {
  const { mode } = getState();
  if (input !== currentInput || (mode !== "palette" && mode !== "palette-insert")) {
    currentInput = input;
    setState({ mode: "palette", pending: "" });
  }
}

/** Call when focus leaves the palette (it closed). */
export function resetPalette(): void {
  currentInput = null;
  const { mode } = getState();
  if (mode === "palette" || mode === "palette-insert") {
    setState({ mode: "nav", pending: "" });
  }
}

function optionCount(input: HTMLElement): number {
  const dialog = input.closest("[role='dialog']") ?? document;
  return dialog.querySelectorAll("[role='option'], [cmdk-item]").length;
}

function arrow(input: HTMLElement, key: "ArrowDown" | "ArrowUp", times: number) {
  for (let i = 0; i < times; i += 1) sendKey(input, key);
  return true;
}

/** Returns true when the key was consumed. */
export function handlePaletteKey(
  event: KeyboardEvent,
  input: HTMLElement,
): boolean {
  syncPaletteMode(input);
  const state = getState();
  const typing = state.mode === "palette-insert";
  const key = event.key;

  // Ctrl bindings work in both modes.
  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    switch (key) {
      case "c":
      case "C":
        sendKey(input, "Escape");
        return true;
      case "j":
      case "n":
        return arrow(input, "ArrowDown", 1);
      case "k":
      case "p":
        return arrow(input, "ArrowUp", 1);
      case "d":
        return arrow(input, "ArrowDown", 5);
      case "u":
        return arrow(input, "ArrowUp", 5);
      case "m":
      case "y":
        sendKey(input, "Enter");
        return true;
      default:
        return false;
    }
  }
  if (event.metaKey || event.altKey) return false;

  if (typing) {
    if (isEscape(event)) {
      setState({ mode: "palette", pending: "" });
      return true; // swallow: Esc goes back to PALETTE mode, not close
    }
    return false; // everything else types into the search field
  }

  // PALETTE (normal) mode.
  if (key === "Shift") return false;
  if (isEscape(event)) {
    setState({ pending: "" });
    return false; // let BB close the palette
  }
  if (key === "Enter" || key.startsWith("Arrow") || key === "Tab") return false;

  const pending = state.pending;
  if (/^[1-9]$/.test(key) || (key === "0" && /\d$/.test(pending))) {
    setState({ pending: pending + key });
    return true;
  }
  const countMatch = /^(\d+)/.exec(pending);
  const count = countMatch ? Number.parseInt(countMatch[1]!, 10) : 1;
  const prefix = pending.slice(countMatch?.[0].length ?? 0);
  const done = () => {
    setState({ pending: "" });
    return true;
  };

  if (prefix === "g") {
    if (key === "g") arrow(input, "ArrowUp", optionCount(input));
    return done();
  }
  switch (key) {
    case "g":
      setState({ pending: `${countMatch?.[0] ?? ""}g` });
      return true;
    case "j":
      return arrow(input, "ArrowDown", count) && done();
    case "k":
      return arrow(input, "ArrowUp", count) && done();
    case "G":
      arrow(input, "ArrowDown", optionCount(input));
      return done();
    case "l":
    case "o":
      sendKey(input, "Enter");
      return done();
    case "i":
    case "a":
    case "A":
    case "I":
    case "/":
      setState({ mode: "palette-insert", pending: "" });
      return true;
    case "Backspace":
      // Allow editing the existing query without entering insert mode.
      return false;
    default:
      return done(); // swallow other printable keys
  }
}
