import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bootstrap } from "../src/types.ts";

test("muting character speech cancels TTS while the text reply continues", async (context) => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  const sent: { t: string; id?: number }[] = [];
  let connection!: MockSocket;
  class MockSocket {
    static OPEN = 1;
    static CLOSING = 2;
    readyState = 1;
    binaryType = "";
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() {
      connection = this;
      queueMicrotask(() => this.receive({ t: "mode" }));
    }
    send(value: string) {
      sent.push(JSON.parse(value));
    }
    receive(value: object) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  install("window", { addEventListener() {} });
  install("document", {
    dispatchEvent() {
      return true;
    },
  });
  install("location", { host: "127.0.0.1:4173" });
  install("localStorage", {
    getItem() {
      return null;
    },
    setItem() {},
  });
  install("WebSocket", MockSocket);
  const session = await import("../src/session.ts");
  const { state } = await import("../src/store.ts");
  session.output.ready = async () => {};
  state.bootstrap = { character: { id: "audio-test" } } as Bootstrap;
  context.after(() => {
    session.endSession();
    state.bootstrap = null;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  await session.submit("A test message");
  const reply = sent.find((message) => message.t === "llm")!;
  connection.receive({
    t: "llm_delta",
    id: reply.id,
    text: "First sentence. ",
  });
  const speech = sent.find((message) => message.t === "tts")!;
  assert.ok(speech);
  state.settings.speakReplies = false;
  session.stopCharacterSpeech();
  assert.ok(
    sent.some((message) => message.t === "cancel" && message.id === speech.id),
  );
  assert.ok(
    !sent.some((message) => message.t === "cancel" && message.id === reply.id),
  );
  connection.receive({
    t: "llm_delta",
    id: reply.id,
    text: "The text reply continues.",
  });
  assert.equal(
    state.messages.at(-1)?.content,
    "First sentence. The text reply continues.",
  );
});
