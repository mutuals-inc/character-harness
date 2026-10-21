// What the runtime gives the player to start it. Run with `npm test`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { listenEnv, manualStart } from "../src/player.ts";

test("HARNESS_LISTEN is empty without listen settings, and JSON with only the keys set", () => {
	assert.equal(listenEnv({}), "");
	assert.deepEqual(JSON.parse(listenEnv({ end_of_speech_ms: 900, speech_threshold: 0.6, silence_threshold: 0.4 })), {
		end_of_speech_ms: 900,
		speech_threshold: 0.6,
		silence_threshold: 0.4,
	});
});

test("the printed start command carries HARNESS_LISTEN, quoted, only when there is one", () => {
	const url = "ws://127.0.0.1:8788/session/t";
	assert.equal(manualStart({ url, character: "foxglove", listen: {} }), `HARNESS_URL=${url} HARNESS_CHARACTER="foxglove"`);
	assert.equal(
		manualStart({ url, character: "foxglove", listen: { barge_in_ms: 1000 } }),
		`HARNESS_URL=${url} HARNESS_CHARACTER="foxglove" HARNESS_LISTEN='{"barge_in_ms":1000}'`,
	);
});
