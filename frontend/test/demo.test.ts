import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readGlb, readAccessor } from "../../runtime/src/rig/glb.ts";
import { createSalute } from "../scripts/prepare-demo.ts";
import comet from "../../examples/extensions/comet-cues/index.ts";
import { eventsAfter, instrument } from "../server/telemetry.ts";
import { HOOKS, type State } from "../../runtime/src/state.ts";
import type { HookInput } from "../../runtime/src/extensions.ts";

test("the authored salute contains finite normalized rotation tracks and a complete four-second timeline", () => {
  const skeleton = readGlb(
    path.resolve(
      import.meta.dirname,
      "../../characters/foxglove/animations/wave.vrma",
    ),
  );
  const original = JSON.stringify(skeleton.json);
  const clip = createSalute(skeleton);
  assert.equal(JSON.stringify(skeleton.json), original);
  const animation = clip.json.animations![0];
  assert.equal(animation.channels.length, 6);
  for (const sampler of animation.samplers) {
    const times = readAccessor(clip, sampler.input);
    assert.equal(times.length, 121);
    assert.equal(times[0], 0);
    assert.equal(times.at(-1), 4);
    const values = readAccessor(clip, sampler.output);
    for (let i = 0; i < values.length; i += 4) {
      assert.ok(Math.abs(Math.hypot(...values.slice(i, i + 4)) - 1) < 0.00001);
    }
  }
});

test("comet hook stages once per requested turn and preserves other extension state", () => {
  const state: State = {
    schema: 1,
    character: {},
    session: { id: "test", channel: "chat" },
    turn: 1,
    input: { text: "A comet salute please", channel: "chat" },
    ext: { other: { keep: true } },
  };
  const input = { event: "on_sentence", state, config: {} } as HookInput;
  const first = comet(input).state;
  assert.equal(first.beats?.[0].gesture, "comet-salute");
  assert.equal(first.ext.other, state.ext.other);
  assert.equal(state.beats, undefined);
  const again = comet({ ...input, state: { ...first, beats: [] } }).state;
  assert.deepEqual(again.beats, []);
  assert.equal(
    comet({
      ...input,
      state: { ...state, input: { text: "hello", channel: "chat" } },
    }).state.beats,
    undefined,
  );
});

test("closing hook telemetry remains retrievable after a websocket closes", () => {
  const sent: string[] = [];
  const socket = { readyState: 1, send: (data: string) => sent.push(data) };
  const observer = instrument([], socket as never).at(-1)!;
  const state: State = {
    schema: 1,
    character: {},
    session: { id: "test", channel: "chat" },
    ext: {},
  };
  observer.call({ event: HOOKS[0], state, config: {} } as HookInput);
  const last = JSON.parse(sent.at(-1)!).seq;
  socket.readyState = 3;
  observer.call({ event: "on_session_end", state, config: {} } as HookInput);
  const closing = eventsAfter(last);
  assert.equal(closing.length, 1);
  assert.equal(closing[0].event, "on_session_end");
  assert.equal(sent.length, 1);
});
