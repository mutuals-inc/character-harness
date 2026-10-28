import { test } from "node:test";
import assert from "node:assert/strict";
import { Microphone } from "../src/audio/input.ts";
import type { Settings } from "../src/types.ts";

test("speech activity and end-of-speech feedback follow captured audio levels", async (context) => {
  const originals = ["AudioContext", "AudioWorkletNode"].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const node = {
    connect() {
      return this;
    },
    disconnect() {},
  };
  class TestContext {
    audioWorklet = { async addModule() {} };
    destination = {};
    async resume() {}
    async close() {}
    createMediaStreamSource() {
      return node;
    }
    createGain() {
      return { ...node, gain: { value: 1 } };
    }
  }
  let processor!: TestWorklet;
  class TestWorklet {
    port = {
      onmessage: null as null | ((event: { data: Float32Array }) => void),
    };
    constructor() {
      processor = this;
    }
    connect() {
      return node;
    }
    disconnect() {}
  }
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: TestContext,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: TestWorklet,
  });
  context.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const microphone = new Microphone();
  let started = 0,
    ended = 0,
    released = false;
  const messages: object[] = [];
  const stream = {
    getTracks: () => [
      {
        stop() {
          released = true;
        },
      },
    ],
  } as unknown as MediaStream;
  await microphone.start(
    { gain: 1, threshold: 0.05, silenceMs: 20 } as Settings,
    (data) => messages.push(data),
    () => started++,
    stream,
    () => ended++,
  );
  processor.port.onmessage!({ data: new Float32Array(320).fill(0.25) });
  assert.equal(microphone.hearingSpeech, true);
  assert.equal(started, 1);
  processor.port.onmessage!({ data: new Float32Array(320) });
  assert.equal(microphone.hearingSpeech, false);
  assert.equal(ended, 1);
  assert.ok(
    messages.some((message) => (message as { t?: string }).t === "stt_start"),
  );
  assert.ok(
    messages.some((message) => (message as { t?: string }).t === "stt_eos"),
  );
  await microphone.stop();
  assert.equal(released, true);
  assert.equal(microphone.level, 0);
});

test(
  "ending capture while permission is pending releases a subsequently granted stream",
  { timeout: 3000 },
  async (context) => {
    let resolveStream!: (stream: MediaStream) => void;
    let requested!: () => void;
    const permissionRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const permission = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: () => {
            requested();
            return permission;
          },
        },
      },
    });
    context.after(() => {
      if (original) Object.defineProperty(globalThis, "navigator", original);
    });
    const microphone = new Microphone();
    const started = microphone.start(
      {} as Settings,
      () => {},
      () => {},
    );
    const rejected = assert.rejects(started, { name: "AbortError" });
    await permissionRequested;
    await microphone.stop();
    let stopped = false;
    resolveStream({
      getTracks: () => [
        {
          stop: () => {
            stopped = true;
          },
        },
      ],
    } as unknown as MediaStream);
    await rejected;
    assert.equal(stopped, true);
    assert.equal(microphone.running, false);
  },
);
