import { createRequire as __createRequire } from "node:module";
import { dirname as __pathDirname } from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";
const require = __createRequire(import.meta.url);
var __filename = __fileURLToPath(import.meta.url);
var __dirname = __pathDirname(__filename);

// settings.ts
var LOADERS = ["drive", "dots", "orbit", "coins", "bb"];
var CHIP_STYLES = ["surface", "outline", "plain"];

// server.ts
async function plugin(bb) {
  bb.settings.define({
    loader: {
      type: "select",
      label: "Loading animation",
      description: "Icon on pending work rows. drive: pixel grid sweep; dots: round pixels; orbit: pixels circling the edge; coins: a ring of tumbling coins; bb: BB's own icon.",
      options: [...LOADERS],
      default: "drive"
    },
    shimmer: {
      type: "boolean",
      label: "Label shimmer",
      description: "BeautifulUI's brighter, faster shimmer on pending labels such as \u201CThinking\u2026\u201D and \u201CRunning\u201D.",
      default: true
    },
    toolChips: {
      type: "select",
      label: "Tool call rows",
      description: "surface: filled chip with a hairline; outline: hairline only; plain: no background or border.",
      options: [...CHIP_STYLES],
      default: "surface"
    },
    workRows: {
      type: "boolean",
      label: "Compact work rows",
      description: "Pill-shaped row headers, 12.5px text, monospace durations, a guide line under expanded details, smoother expand.",
      default: true
    },
    streamingCaret: {
      type: "boolean",
      label: "Streaming caret",
      description: "A caret at the end of the reply while a run is live.",
      default: true
    },
    approvalCard: {
      type: "boolean",
      label: "Approval cards",
      description: "Raised cards with pill buttons for permission requests and agent questions.",
      default: true
    },
    promptBar: {
      type: "boolean",
      label: "Prompt bar",
      description: "Raised composer, 28px controls, filled send button, background-commands card.",
      default: true
    },
    userBubbles: {
      type: "boolean",
      label: "User message bubbles",
      description: "Soft filled bubbles for your messages.",
      default: true
    },
    codeChips: {
      type: "boolean",
      label: "Code chips",
      description: "Hairline chips for inline code and hairline cards for code blocks.",
      default: true
    },
    selectionPill: {
      type: "boolean",
      label: "Selection pill",
      description: "Pill style for the Add to chat / Reply in side chat popover on selected text.",
      default: true
    },
    treeLines: {
      type: "boolean",
      label: "Tree lines",
      description: "Indent the rows of an expanded work group under its header and connect them with tree lines.",
      default: true
    },
    minimizeWhileRunning: {
      type: "boolean",
      label: "Minimize prompt while generating",
      description: "Shrink the prompt box to one line while a response is generating; click into it to expand for a follow-up.",
      default: true
    },
    mergedBanners: {
      type: "boolean",
      label: "Merged banner stack",
      description: "Group the cards above the composer (background commands, git, parent and child threads) into one card with hairline dividers.",
      default: true
    },
    unreadMarker: {
      type: "boolean",
      label: "Unread marker",
      description: "Put NEW on the same line as the first unread row, in the success colour, without the rule line.",
      default: true
    },
    messageActions: {
      type: "boolean",
      label: "Message actions",
      description: "Spatial tooltips that glide along rows of 3+ icon buttons, plus hover chips.",
      default: true
    }
  });
  bb.log.info("loaded");
}
export {
  plugin as default
};
//# sourceMappingURL=server.js.map
