// Content-script entry: owns the document listeners and routes each key to
// the editor engine (composer focused) or the nav engine (nothing focused).
import {
  activeEditor,
  activeGenericEditable,
  clearCursor,
  notePointerTarget,
  isEscape,
  isForeignEditable,
  isSyntheticDispatch,
  overlayOpen,
  EDITOR_SELECTOR,
} from "./dom";
import { handleEditorKey } from "./editor";
import { handleTextareaKey } from "./textarea";
import { handleNavKey, leaveSidebar } from "./nav";
import {
  activePaletteInput,
  handlePaletteKey,
  resetPalette,
  syncPaletteMode,
} from "./palette";
import { getState, setState, subscribe } from "./store";

const STYLE_ID = "bb-plugin-vim-style";

const CSS = `
/* Sidebar cursor. While the keyboard owns the sidebar, exactly one row is
   painted as selected: the cursor row, using BB's own selected-row gradient
   and background, synchronously on keypress. BB's own selected paint is
   hidden in this mode so the block never appears twice or resizes while the
   route catches up. */
/* BB puts the selected paint on the row container (the element carrying
   bb-sidebar-hover-actions-row), which spans the title and the trailing
   icon; the anchor we tag is a child of it, so paint the container. */
html[data-vim-mode="sidebar"] .bb-sidebar-hover-actions-row:has(> [data-vim-cursor]),
html[data-vim-mode="sidebar"] .bb-sidebar-hover-actions-row:has([data-vim-cursor]) {
  background-color: var(--state-active);
  background-image:
    linear-gradient(var(--state-active), var(--state-active)),
    linear-gradient(var(--sidebar), var(--sidebar));
}
html[data-vim-mode="sidebar"] .bb-sidebar-selected-row:not(:has([data-vim-cursor])) {
  background-color: transparent;
  background-image: none;
}
html[data-vim-mode="normal"] ${EDITOR_SELECTOR},
html[data-vim-mode="visual"] ${EDITOR_SELECTOR},
html[data-vim-mode="normal"] textarea:focus,
html[data-vim-mode="visual"] textarea:focus,
html[data-vim-mode="normal"] [contenteditable="true"]:focus,
html[data-vim-mode="visual"] [contenteditable="true"]:focus {
  caret-color: #e0a526;
}
html[data-vim-mode="normal"] ${EDITOR_SELECTOR}::selection,
html[data-vim-mode="normal"] ${EDITOR_SELECTOR} *::selection {
  background: color-mix(in srgb, #e0a526 35%, transparent);
}
`;

export interface MountContext {
  pluginId: string;
  signal: AbortSignal;
}

let mountedPluginId = "vim";

export function mount({ pluginId, signal }: MountContext): () => void {
  mountedPluginId = pluginId;
  const storageKey = `${pluginId}:enabled`;
  const enabled = window.localStorage.getItem(storageKey) !== "false";
  setState({ enabled, mode: enabled ? "nav" : "off", pending: "" });

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);

  const syncHtmlAttr = () => {
    const { mode, enabled: on } = getState();
    if (on) document.documentElement.setAttribute("data-vim-mode", mode);
    else document.documentElement.removeAttribute("data-vim-mode");
  };
  const unsubscribe = subscribe(syncHtmlAttr);
  syncHtmlAttr();

  // Entering a composer always starts in insert mode; leaving it returns to
  // nav mode. The modes persist only while focus stays inside the editor.
  const onFocusIn = (event: FocusEvent) => {
    if (!getState().enabled) return;
    const palette = activePaletteInput();
    if (palette) {
      syncPaletteMode(palette);
      return;
    }
    if (getState().mode.startsWith("palette")) resetPalette();
    const target = event.target;
    const isEditable =
      target instanceof HTMLElement &&
      (target.closest(EDITOR_SELECTOR) !== null || activeGenericEditable() !== null);
    if (target instanceof HTMLElement && isEditable) {
      const { mode } = getState();
      if (mode === "sidebar" && target.closest(EDITOR_SELECTOR)) {
        // A thread opened by the sidebar cursor focuses its composer; keep
        // the keyboard in the sidebar until the user opens with Enter.
        target.blur();
        return;
      }
      if (mode === "nav") {
        clearCursor();
        setState({ mode: "insert", pending: "" });
      }
    }
  };
  const onFocusOut = (event: FocusEvent) => {
    if (!getState().enabled) return;
    if (getState().mode.startsWith("palette")) {
      window.setTimeout(() => {
        if (!signal.aborted && !activePaletteInput()) resetPalette();
      }, 0);
      return;
    }
    const target = event.target;
    const wasEditable =
      target instanceof HTMLElement &&
      (target.closest(EDITOR_SELECTOR) !== null ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable);
    if (!wasEditable) return;
    // Defer: focus may be moving to another node inside the same editor.
    window.setTimeout(() => {
      if (signal.aborted) return;
      if (activeEditor() || activeGenericEditable()) return;
      const { mode } = getState();
      if (mode === "insert" || mode === "normal" || mode === "visual") {
        setState({ mode: "nav", pending: "" });
      }
    }, 0);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const state = getState();
    if (!state.enabled || isSyntheticDispatch()) return;
    if (event.defaultPrevented || event.isComposing || (event.repeat && isEscape(event))) {
      return;
    }

    // Palettes (Cmd+K / Cmd+Shift+P) come first: their input is focused and
    // a dialog is open, which would otherwise short-circuit everything.
    const paletteInput = activePaletteInput();
    if (paletteInput) {
      if (handlePaletteKey(event, paletteInput)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }

    const editor = activeEditor();
    if (editor) {
      if (state.mode !== "normal" && state.mode !== "visual") {
        if (state.mode !== "insert") setState({ mode: "insert", pending: "" });
        // Only Escape is ours in insert mode, and only when no mention menu
        // or popup is open (Tiptap needs Escape to dismiss those).
        if (isEscape(event) && !overlayOpen()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.focusNode) {
            sel.collapse(sel.focusNode, sel.focusOffset);
          }
          setState({ mode: "normal", pending: "" });
        }
        return;
      }
      if (overlayOpen()) return;
      if (handleEditorKey(event, editor)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }

    // Any other plugin's textarea or contenteditable gets the same modal
    // treatment as the composer, with no opt-in required.
    const generic = activeGenericEditable();
    if (generic) {
      if (state.mode !== "normal" && state.mode !== "visual") {
        if (state.mode !== "insert") setState({ mode: "insert", pending: "" });
        if (isEscape(event) && !overlayOpen()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (generic.kind === "textarea") {
            const ta = generic.element;
            ta.setSelectionRange(ta.selectionStart, ta.selectionStart);
          } else {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.focusNode) {
              sel.collapse(sel.focusNode, sel.focusOffset);
            }
          }
          setState({ mode: "normal", pending: "" });
        }
        return;
      }
      if (overlayOpen()) return;
      const handled =
        generic.kind === "textarea"
          ? handleTextareaKey(event, generic.element)
          : handleEditorKey(event, generic.element);
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }

    // Nothing editable focused (or a foreign input: leave it alone).
    if (isForeignEditable(event.target)) return;
    if (overlayOpen()) return;
    if (state.mode !== "nav" && state.mode !== "sidebar") {
      setState({ mode: "nav", pending: "" });
    }
    if (handleNavKey(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  // Clicking anywhere drops the sidebar cursor; it is keyboard-only state.
  const onPointerDown = (event: PointerEvent) => {
    notePointerTarget(event.target);
    if (getState().mode === "sidebar") leaveSidebar();
  };

  document.addEventListener("keydown", onKeyDown, { capture: true, signal });
  document.addEventListener("focusin", onFocusIn, { signal });
  document.addEventListener("focusout", onFocusOut, { signal });
  document.addEventListener("pointerdown", onPointerDown, {
    capture: true,
    signal,
  });

  return () => {
    unsubscribe();
    clearCursor();
    style.remove();
    document.documentElement.removeAttribute("data-vim-mode");
  };
}

export function toggleEnabled(): void {
  setEnabled(!getState().enabled);
}

export function setEnabled(enabled: boolean): void {
  window.localStorage.setItem(`${mountedPluginId}:enabled`, String(enabled));
  clearCursor();
  setState({
    enabled,
    mode: enabled ? (activeEditor() ? "insert" : "nav") : "off",
    pending: "",
    helpOpen: false,
  });
}
