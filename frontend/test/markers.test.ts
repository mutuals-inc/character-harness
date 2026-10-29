import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTED_TURN, SILENT_TURN, unvoiced } from "../src/lib/markers.ts";
import * as runtime from "../../runtime/src/markers.ts";

test("the app's markers are the runtime's, and neither is voiced", () => {
  assert.equal(SILENT_TURN, runtime.SILENT_TURN);
  assert.equal(ACTED_TURN, runtime.ACTED_TURN);
  assert.ok(unvoiced(" [acted] ") && unvoiced("…"));
  assert.ok(!unvoiced("I acted."));
});
