// bb-plugin-vim — backend entry.
//
// This plugin is frontend-only: every keybinding lives in app.tsx as a trusted
// content script. The server exists because the manifest requires one; it
// only logs lifecycle so `bb plugin list` shows the plugin as healthy.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded (frontend-only plugin)");
  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
