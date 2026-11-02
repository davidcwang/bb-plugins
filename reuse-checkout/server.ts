// bb-plugin-reuse-checkout — backend entry.
//
// Frontend-only plugin: the behavior is a composer customization in app.tsx.
// The server exists because the manifest requires one.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded (frontend-only plugin)");
  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
