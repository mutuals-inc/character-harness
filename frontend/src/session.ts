import { state, record, status } from "./store.ts";
import { request, toast } from "./lib/dom.ts";
import { AudioOutput } from "./audio/output.ts";
import { Microphone } from "./audio/input.ts";
import type { WireMessage } from "./types.ts";
import { speechRecording } from "./audio/recording.ts";

export const output = new AudioOutput();
export const microphone = new Microphone();
let socket: WebSocket | null = null;
let sequence = 0;
let replyId: number | null = null;
let speechId: number | null = null;
let remainder = "";
const sentences: string[] = [];
const cues = new Map<number, WireMessage[]>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let resolveStart: (() => void) | null = null;
let rejectStart: ((reason: Error) => void) | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let lastHookSequence = 0;
let recordingCleanup: (() => Promise<void>) | null = null;

export async function sendRecording(file: File) {
  if (!state.connected) await startSession();
  await recordingCleanup?.();
  const recording = await speechRecording(file);
  recordingCleanup = recording.dispose;
  try {
    await microphone.start(
      state.settings,
      send,
      () => {
        cancelReply();
        status("Listening to recording…");
      },
      recording.stream,
    );
    state.muted = false;
    status("Listening to recording…");
    record("input", "Speech recording started", file.name);
    await recording.start(() => {
      void microphone.stop().finally(() => {
        state.muted = true;
        void recording.dispose();
        recordingCleanup = null;
        status("Recording finished");
      });
    });
  } catch (error) {
    await recording.dispose();
    recordingCleanup = null;
    throw error;
  }
}

function hookEvent(message: WireMessage) {
  if (message.seq && message.seq <= lastHookSequence) return;
  lastHookSequence = message.seq ?? lastHookSequence;
  if (message.phase !== "start")
    record(
      "hook",
      message.event ?? "",
      message.extension
        ? `${message.extension} · ${message.duration ?? 0} ms`
        : `Turn ${message.turn ?? "—"}`,
    );
}

async function collectClosingHooks() {
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      (
        await request<WireMessage[]>(`/api/events?after=${lastHookSequence}`)
      ).forEach(hookEvent);
    } catch {
      return;
    }
  }
}

function send(data: object | ArrayBuffer) {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(data instanceof ArrayBuffer ? data : JSON.stringify(data));
}
function changed() {
  document.dispatchEvent(new CustomEvent("transcript"));
}
function cue(message: WireMessage) {
  document.dispatchEvent(new CustomEvent("stage-cue", { detail: message }));
}
function scheduleCues(id: number) {
  for (const message of cues.get(id) ?? []) {
    const delay = output.remaining(id, message.bt ?? 0);
    if (delay === null) continue;
    const timer = setTimeout(() => {
      timers.delete(timer);
      cue(message);
    }, delay);
    timers.add(timer);
  }
  if (output.remaining(id, 0) !== null) cues.delete(id);
}

export async function startSession(): Promise<void> {
  if (state.connected) return;
  if (state.connecting) throw new Error("The session is still connecting.");
  if (socket?.readyState === WebSocket.CLOSING) {
    await new Promise<void>((resolve) =>
      socket!.addEventListener("close", () => resolve(), { once: true }),
    );
  }
  state.connecting = true;
  status("Connecting…");
  if (microphone.running) {
    await microphone.stop();
    state.muted = true;
  }
  try {
    await output.ready(state.settings.volume, state.settings.outputDevice);
  } catch (error) {
    state.connecting = false;
    status("Audio unavailable");
    throw error;
  }
  const params = new URLSearchParams({
    character: state.bootstrap!.character.id,
    disabled: state.settings.disabledExtensions.join(","),
  });
  return new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
    socket = new WebSocket(`ws://${location.host}/studio-session?${params}`);
    socket.binaryType = "arraybuffer";
    startupTimer = setTimeout(() => {
      rejectStart?.(new Error("The session took too long to connect."));
      endSession();
    }, 15000);
    socket.onmessage = handleMessage;
    socket.onerror = () => {
      toast("Could not connect to the local runtime.", true);
    };
    socket.onclose = () => {
      rejectStart?.(new Error("The session closed before it was ready."));
      resetStartup();
      state.connected = false;
      state.connecting = false;
      state.muted = true;
      void microphone.stop();
      cancelReply(false);
      status("Session ended");
      record("session", "Session ended");
      void collectClosingHooks();
      socket = null;
    };
  });
}

function resetStartup() {
  if (startupTimer) clearTimeout(startupTimer);
  startupTimer = null;
  resolveStart = null;
  rejectStart = null;
}

function handleMessage(event: MessageEvent) {
  if (event.data instanceof ArrayBuffer) {
    if (
      speechId !== null &&
      new Uint8Array(event.data)[0] === (speechId & 255)
    ) {
      output.push(speechId, event.data);
      scheduleCues(speechId);
      status("Speaking");
    }
    return;
  }
  const message = JSON.parse(event.data) as WireMessage;
  if (message.t === "mode") {
    state.connected = true;
    state.connecting = false;
    status("Listening for a message");
    record(
      "session",
      "Session started",
      "Text and voice are connected to the local runtime.",
    );
    resolveStart?.();
    resetStartup();
  } else if (message.t === "studio_hook") {
    hookEvent(message);
  } else if (message.t === "llm_delta" && message.id === replyId) {
    state.messages.at(-1)!.content += message.text ?? "";
    remainder += message.text ?? "";
    changed();
    collectSentences(false);
  } else if (message.t === "llm_calls" && message.id === replyId) {
    // calls that ran are kept even if the reply is cut off or fails later
    const reply = state.messages.at(-1)!;
    reply.entries = [...(reply.entries ?? []), ...(message.entries ?? [])];
  } else if (message.t === "llm_done" && message.id === replyId) {
    // a reply that called tools keeps its calls, their results and what it said after
    if (message.entries?.length) state.messages.at(-1)!.entries = message.entries;
    collectSentences(true);
    replyId = null;
    if (!sentences.length && speechId === null) status("Ready for a reply");
  } else if (message.t === "tts_done" && message.id === speechId) {
    speechId = null;
    nextSentence();
  } else if (message.t === "beat" || message.t === "emotion") {
    if (message.id !== speechId) return;
    if (message.t === "emotion") cue(message);
    else {
      const list = cues.get(message.id!) ?? [];
      list.push(message);
      cues.set(message.id!, list);
      scheduleCues(message.id!);
    }
    record(
      "animation",
      message.emotion || message.gesture || message.camera || "Sentence ready",
      message.t === "beat" ? `${message.bt ?? 0}s into speech` : "Expression",
    );
  } else if (message.t === "stt_partial") {
    status(message.text || "Listening…");
  } else if (message.t === "stt_final" && message.text?.trim()) {
    void submit(message.text, "voice").catch((error) =>
      toast(error.message, true),
    );
  } else if (message.t === "error") {
    const text = message.text ?? "The request failed.";
    toast(text, true);
    record("error", text);
    status("Needs attention");
    if (message.id === replyId) {
      replyId = null;
      remainder = "";
    }
    if (message.id === speechId) {
      cues.delete(speechId!);
      speechId = null;
      nextSentence();
    }
    rejectStart?.(new Error(text));
  }
}

function collectSentences(final: boolean) {
  const chunks = remainder.split(/(?<=[.!?。！？])\s+(?![^\[]*\])/u);
  remainder = final ? "" : (chunks.pop() ?? "");
  for (const text of chunks)
    if (text.trim() && text.trim() !== "…" && text.trim() !== "[acted]") sentences.push(text.trim());
  nextSentence();
}

function nextSentence() {
  if (speechId !== null) return;
  if (!state.settings.speakReplies) {
    sentences.length = 0;
    return;
  }
  const text = sentences.shift();
  if (text) {
    speechId = ++sequence;
    send({ t: "tts", id: speechId, text });
  } else if (replyId === null) status("Ready for a reply");
}

export async function submit(
  text: string,
  source: "chat" | "voice" | "screen" = "chat",
) {
  if (!text.trim()) return;
  if (text.length > 20000)
    throw new Error("Keep each message under 20,000 characters.");
  if (!state.connected) await startSession();
  cancelReply();
  state.messages.push({ role: "user", content: text.trim(), source });
  const history = state.messages
    .filter((m) => m.content.trim() || m.entries?.length)
    .flatMap(({ role, content, entries }) => entries ?? [{ role, content }]);
  state.messages.push({ role: "assistant", content: "" });
  replyId = ++sequence;
  remainder = "";
  send({ t: "llm", id: replyId, history, source });
  changed();
  status("Thinking");
  record(
    "input",
    `${source === "chat" ? "Text" : source === "voice" ? "Voice" : "Screen context"} received`,
  );
}

export function cancelReply(notify = true) {
  if (notify && (replyId !== null || speechId !== null || output.playing))
    record(
      "session",
      "Reply cancelled",
      "Pending model requests and queued audio were stopped.",
    );
  if (notify) {
    if (replyId !== null) send({ t: "cancel", id: replyId });
    if (speechId !== null) send({ t: "cancel", id: speechId });
  }
  replyId = null;
  speechId = null;
  remainder = "";
  sentences.length = 0;
  cues.clear();
  timers.forEach(clearTimeout);
  timers.clear();
  output.stop();
}

export async function toggleMicrophone(testOnly = false) {
  await recordingCleanup?.();
  recordingCleanup = null;
  if (microphone.running) {
    await microphone.stop();
    send({ t: "stt_reset" });
    state.muted = true;
    status("Microphone off");
    return;
  }
  if (!testOnly && !state.connected) await startSession();
  await microphone.start(
    state.settings,
    testOnly ? () => {} : send,
    testOnly
      ? () => {}
      : () => {
          cancelReply();
          status("Listening…");
        },
  );
  state.muted = false;
  status(
    testOnly
      ? "Testing microphone · audio stays on this device"
      : "Microphone on",
  );
}

export function endSession() {
  void recordingCleanup?.();
  recordingCleanup = null;
  cancelReply();
  void microphone.stop();
  state.muted = true;
  socket?.close();
  state.connected = false;
  state.connecting = false;
  status("Ready when you are");
}

window.addEventListener("beforeunload", () => {
  endSession();
  void output.dispose();
});
