// Beautiful Chat settings → attributes on <html> that app.css switches on.
// Pure so it can be tested; values arrive from the settings store and are untrusted.

/** Pending-row loader. drive/dots/orbit are BeautifulUI's variants, coins is Originkit's
    Coin Loader; bb keeps BB's own icon. */
export const LOADERS = ["drive", "dots", "orbit", "coins", "bb"] as const;

/** Tool call rows: filled chip, hairline only, or BB's plain row. */
export const CHIP_STYLES = ["surface", "outline", "plain"] as const;

/** Boolean settings → the token app.css looks for in `data-bui-off` when turned off. */
export const TOGGLES = {
  promptBar: "prompt",
  userBubbles: "bubbles",
  codeChips: "code",
  messageActions: "actions",
  workRows: "rows",
  shimmer: "shimmer",
  streamingCaret: "caret",
  approvalCard: "approval",
  selectionPill: "selection",
  unreadMarker: "unread",
  mergedBanners: "banners",
  minimizeWhileRunning: "minimize",
  treeLines: "tree",
} as const;

export function rootAttributes(values: Record<string, unknown>) {
  return {
    loader: LOADERS.find((option) => option === values.loader) ?? "drive",
    chips: CHIP_STYLES.find((option) => option === values.toolChips) ?? "surface",
    off: Object.entries(TOGGLES)
      .filter(([key]) => values[key] === false)
      .map(([, token]) => token),
  };
}
