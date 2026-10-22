// bb-plugin-sidebar-rail — backend entry.
//
// This plugin is frontend-only: the rail is app.css plus one
// content script in app.tsx. The server exists because the manifest requires one; it
// only logs lifecycle so `bb plugin list` shows the plugin as healthy.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded (frontend-only plugin)");
  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
