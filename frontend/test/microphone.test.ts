import { test } from "node:test";
import assert from "node:assert/strict";
import { Microphone } from "../src/audio/input.ts";
import type { Settings } from "../src/types.ts";

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
