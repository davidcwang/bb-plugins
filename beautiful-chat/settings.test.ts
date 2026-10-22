// node --experimental-strip-types --test settings.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { rootAttributes } from "./settings.ts";

test("defaults: drive loader, surface chips, nothing turned off", () => {
  assert.deepEqual(rootAttributes({}), { loader: "drive", chips: "surface", off: [] });
});

test("turned-off toggles become CSS tokens; unknown values fall back", () => {
  assert.deepEqual(
    rootAttributes({ loader: "orbit", toolChips: "plain", shimmer: false, streamingCaret: false, promptBar: true }),
    { loader: "orbit", chips: "plain", off: ["shimmer", "caret"] },
  );
  assert.deepEqual(rootAttributes({ loader: "surfer", toolChips: 3, workRows: "no" }), { loader: "drive", chips: "surface", off: [] });
});
