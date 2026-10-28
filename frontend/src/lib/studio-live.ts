import type { WireMessage } from "../types.ts";

export interface StudioLive {
  emotion: string;
  reaction: string;
  partialTranscript: string;
  extensions: Record<
    string,
    { event: string; running: boolean; duration?: number; at: number }
  >;
}
export function initialStudioLive(): StudioLive {
  return {
    emotion: "neutral",
    reaction: "None yet",
    partialTranscript: "",
    extensions: {},
  };
}
export function withStudioCue(
  live: StudioLive,
  message: WireMessage,
): StudioLive {
  return {
    ...live,
    emotion: message.emotion || live.emotion,
    reaction:
      message.gesture && message.gesture !== "none"
        ? message.gesture
        : live.reaction,
  };
}
export function withStudioHook(
  live: StudioLive,
  message: WireMessage,
): StudioLive {
  if (!message.extension || !["start", "end"].includes(message.phase ?? ""))
    return live;
  return {
    ...live,
    extensions: {
      ...live.extensions,
      [message.extension]: {
        event: message.event ?? "",
        running: message.phase === "start",
        duration: message.duration,
        at: Date.now(),
      },
    },
  };
}
export function studioPresence(input: {
  connected: boolean;
  connecting: boolean;
  microphone: boolean;
  mode: "off" | "test" | "live";
  hearing: boolean;
  playing: boolean;
  status: string;
}) {
  if (input.connecting) return { label: "Connecting…", kind: "waiting" };
  if (input.status === "Needs attention")
    return { label: "Needs attention", kind: "error" };
  if (input.microphone && input.mode === "test")
    return {
      label: "Microphone test · audio stays on this device",
      kind: "testing",
    };
  if (input.connected && input.microphone && input.hearing)
    return { label: "Listening to you", kind: "listening" };
  if (input.playing) return { label: "Speaking", kind: "speaking" };
  if (input.connected && ["Thinking", "Transcribing…"].includes(input.status))
    return { label: input.status, kind: "waiting" };
  if (input.connected && input.microphone && input.mode === "live")
    return { label: "Listening · speak anytime", kind: "listening" };
  if (input.connected)
    return { label: "Microphone off · text chat ready", kind: "idle" };
  return { label: "Microphone off · session not started", kind: "idle" };
}
