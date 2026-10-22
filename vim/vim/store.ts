// Tiny external store shared by the content script (writer) and the overlay
// component (reader). No React in here so the engine stays testable.

export type Mode =
  | "off" // plugin disabled by the user
  | "insert" // composer focused, keys go to the editor
  | "normal" // composer focused, vim normal mode
  | "visual" // composer focused, vim visual mode
  | "nav" // no editable focused: scroll / jump keys
  | "sidebar" // nav mode with the sidebar thread cursor active
  | "palette" // Cmd+K / Cmd+Shift+P open, j/k move items, i to type
  | "palette-insert"; // palette open, keys type into the search field

export interface VimState {
  enabled: boolean;
  mode: Mode;
  /** Pending multi-key prefix (count, operator, `g`, `Ctrl-w`). */
  pending: string;
  helpOpen: boolean;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let state: VimState = {
  enabled: true,
  mode: "nav",
  pending: "",
  helpOpen: false,
};

export function getState(): VimState {
  return state;
}

export function setState(patch: Partial<VimState>): void {
  const next = { ...state, ...patch };
  if (
    next.enabled === state.enabled &&
    next.mode === state.mode &&
    next.pending === state.pending &&
    next.helpOpen === state.helpOpen
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
