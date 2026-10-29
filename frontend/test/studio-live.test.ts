import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialStudioLive,
  withStudioCue,
  withStudioHook,
  studioPresence,
} from "../src/lib/studio-live.ts";

test("Studio shows listening only for live capture and keeps local tests distinct", () => {
  const input = {
    connected: false,
    connecting: false,
    microphone: false,
    mode: "off" as "off" | "test" | "live",
    hearing: false,
    playing: false,
    status: "Ready",
  };
  assert.equal(studioPresence(input).kind, "idle");
  assert.equal(
    studioPresence({ ...input, connected: true }).label,
    "Microphone off · text chat ready",
  );
  assert.equal(
    studioPresence({
      ...input,
      connected: true,
      microphone: true,
      mode: "test",
      hearing: true,
    }).kind,
    "testing",
  );
  assert.equal(
    studioPresence({
      ...input,
      connected: true,
      microphone: true,
      mode: "live",
      hearing: true,
    }).label,
    "Listening to you",
  );
  assert.equal(
    studioPresence({ ...input, connected: true, status: "Thinking" }).kind,
    "waiting",
  );
  assert.equal(
    studioPresence({
      ...input,
      connected: true,
      status: "Ready",
      playing: true,
    }).label,
    "Speaking",
  );
});

test("live character details follow emitted cues and named extension events", () => {
  const initial = initialStudioLive();
  const reaction = withStudioCue(initial, {
    t: "beat",
    emotion: "curious",
    gesture: "wave",
  });
  assert.equal(reaction.emotion, "curious");
  assert.equal(reaction.reaction, "wave");
  assert.equal(
    withStudioCue(reaction, { t: "beat", gesture: "none" }).reaction,
    "wave",
  );
  assert.equal(
    withStudioHook(initial, {
      t: "studio_hook",
      event: "before_llm",
      phase: "hook",
    }),
    initial,
  );
  const running = withStudioHook(initial, {
    t: "studio_hook",
    extension: "memory",
    event: "before_llm",
    phase: "start",
  });
  assert.equal(running.extensions.memory.running, true);
  const finished = withStudioHook(running, {
    t: "studio_hook",
    extension: "memory",
    event: "before_llm",
    phase: "end",
    duration: 42,
  });
  assert.equal(finished.extensions.memory.running, false);
  assert.equal(finished.extensions.memory.duration, 42);
  assert.equal(initial.emotion, "neutral");
});
