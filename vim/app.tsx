// bb-plugin-vim — frontend entry.
//
// One trusted content script owns the keyboard (vim/engine.ts); a small app
// overlay shows the current mode and a `?` cheat sheet; two palette commands
// toggle the plugin and the cheat sheet.
import { useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mount, toggleEnabled } from "./vim/engine";
import { getState, setState, subscribe, type Mode } from "./vim/store";

const MODE_LABEL: Record<Mode, string> = {
  off: "VIM OFF",
  insert: "INSERT",
  normal: "NORMAL",
  visual: "VISUAL",
  nav: "NAV",
  sidebar: "SIDEBAR",
  palette: "PALETTE",
  "palette-insert": "INSERT",
};

const HELP: Array<[string, Array<[string, string]>]> = [
  [
    "Thread (nothing focused)",
    [
      ["j / k", "scroll down / up"],
      ["J / K", "next / previous message"],
      ["Ctrl-d / Ctrl-u", "half page down / up"],
      ["gg / G", "top / bottom of thread"],
      ["i  a  A  I  o", "focus composer (insert mode)"],
      ["H  or  Ctrl-w h", "sidebar thread cursor"],
      ["?", "toggle this sheet"],
    ],
  ],
  [
    "Sidebar",
    [
      ["j / k", "move cursor (thread opens as you go)"],
      ["k at top", "up into New thread, Kanban, RFCs…"],
      ["gg / G", "first / last thread"],
      ["Enter / l / o", "open thread and return to it"],
      ["Esc / Ctrl-c / h / L", "back to thread"],
    ],
  ],
  [
    "Palettes (Cmd+K, Cmd+Shift+P) — open in PALETTE mode",
    [
      ["j / k", "next / previous item"],
      ["gg / G", "first / last item"],
      ["Enter / l / o", "run the selected item"],
      ["i  a  /", "type in the search field"],
      ["Esc (typing)", "back to PALETTE mode"],
      ["Esc / Ctrl-c", "close"],
      ["Ctrl-j/k  Ctrl-n/p  Ctrl-d/u  Ctrl-y", "work in both modes"],
    ],
  ],
  [
    "Composer",
    [
      ["Esc / Ctrl-c", "insert → normal → leave composer"],
      ["H / L", "leave composer to sidebar / thread"],
      ["h j k l  w b e  0 ^ $  gg G", "motions (counts ok)"],
      ["i a I A o O", "insert"],
      ["x X s S  D C  dd cc  d{m} c{m}", "delete / change"],
      ["yy Y y{m}  p P", "yank / put"],
      ["v V", "visual"],
      ["u / Ctrl-r", "undo / redo"],
      ["Enter", "send (unchanged)"],
    ],
  ],
];

function useVimState() {
  return useSyncExternalStore(subscribe, getState, getState);
}

const badgeStyle: CSSProperties = {
  position: "fixed",
  right: 14,
  bottom: 14,
  zIndex: 60,
  pointerEvents: "none",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 11,
  letterSpacing: "0.08em",
  padding: "3px 8px",
  borderRadius: 6,
  border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
  background: "color-mix(in srgb, var(--canvas, Canvas) 85%, transparent)",
  color: "var(--ink, CanvasText)",
  backdropFilter: "blur(6px)",
  display: "flex",
  gap: 8,
  alignItems: "center",
};

const sheetStyle: CSSProperties = {
  position: "fixed",
  right: 14,
  bottom: 48,
  zIndex: 60,
  width: 420,
  maxHeight: "70vh",
  overflowY: "auto",
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
  background: "color-mix(in srgb, var(--canvas, Canvas) 94%, transparent)",
  color: "var(--ink, CanvasText)",
  backdropFilter: "blur(10px)",
  boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
  fontSize: 12,
  lineHeight: 1.5,
};

function ModeOverlay() {
  const state = useVimState();
  if (!state.enabled && !state.helpOpen) return null;
  const accent =
    state.mode === "normal" ||
    state.mode === "sidebar" ||
    state.mode === "palette"
      ? "#e0a526"
      : state.mode === "visual"
        ? "#c678dd"
        : state.mode === "insert" || state.mode === "palette-insert"
          ? "#4fb37a"
          : undefined;
  return (
    <>
      {state.helpOpen ? (
        <div style={sheetStyle} role="dialog" aria-label="Vim keys">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 6,
              fontWeight: 600,
            }}
          >
            <span>Vim keys</span>
            <span style={{ opacity: 0.6 }}>? or Esc to close</span>
          </div>
          {HELP.map(([title, rows]) => (
            <div key={title} style={{ marginBottom: 10 }}>
              <div
                style={{
                  opacity: 0.6,
                  textTransform: "uppercase",
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  marginBottom: 2,
                }}
              >
                {title}
              </div>
              {rows.map(([keys, what]) => (
                <div
                  key={keys}
                  style={{ display: "flex", gap: 12, alignItems: "baseline" }}
                >
                  <code
                    style={{
                      flex: "0 0 180px",
                      fontFamily: badgeStyle.fontFamily,
                      fontSize: 11,
                    }}
                  >
                    {keys}
                  </code>
                  <span style={{ opacity: 0.85 }}>{what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      <div style={badgeStyle} aria-live="polite">
        <span style={{ color: accent, fontWeight: 600 }}>
          {MODE_LABEL[state.mode]}
        </span>
        {state.pending ? (
          <span style={{ opacity: 0.7 }}>{state.pending}</span>
        ) : null}
      </div>
    </>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "vim-keys",
    mount({ pluginId, signal }) {
      return mount({ pluginId, signal });
    },
  });

  app.slots.experimental_appOverlay({
    id: "vim-mode",
    component: ModeOverlay,
  });

  app.commands.register({
    id: "toggle",
    title: "Vim: toggle vim keybindings",
    run: () => toggleEnabled(),
  });

  app.commands.register({
    id: "help",
    title: "Vim: show key cheat sheet",
    run: () => setState({ helpOpen: !getState().helpOpen }),
  });
});

