// node --experimental-strip-types --test spatial-tooltip.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { placeTip } from "./spatial-tooltip.ts";

const btn = (left: number, top: number) => ({ left, top, bottom: top + 20, width: 20 });

test("centers below the trigger with a 4px gap", () => {
  assert.deepEqual(placeTip(btn(1155, 498), 108, 28, 1440, 900, "bottom"), { x: 1111, y: 522, origin: "top" });
});

test("flips above near the bottom edge, and below when top has no room", () => {
  assert.equal(placeTip(btn(500, 870), 100, 28, 1440, 900, "bottom").y, 838);
  assert.equal(placeTip(btn(500, 10), 100, 28, 1440, 900, "top").y, 34);
});

test("clamps to the viewport edges", () => {
  assert.equal(placeTip(btn(0, 100), 100, 28, 1440, 900, "bottom").x, 8);
  assert.equal(placeTip(btn(1430, 100), 100, 28, 1440, 900, "bottom").x, 1332);
});
