import type { Activity, Bootstrap, Settings, Transcript } from "./types.ts";
import { initialStudioLive } from "./lib/studio-live.ts";
const defaults: Settings = {
  inputDevice: "",
  outputDevice: "",
  gain: 1,
  volume: 0.8,
  threshold: 0.025,
  silenceMs: 850,
  echoCancellation: true,
  noiseSuppression: true,
  speakReplies: true,
  captions: true,
  background: "sky",
  paused: false,
};
function load(): Settings {
  try {
    const saved = JSON.parse(
      localStorage.getItem("mutuals-studio-settings") ?? "{}",
    );
    return { ...defaults, ...saved, paused: false };
  } catch {
    return { ...defaults };
  }
}
export const state = {
  bootstrap: null as Bootstrap | null,
  managedCharacter: null as import("./types.ts").CharacterInfo | null,
  settings: load(),
  connected: false,
  connecting: false,
  muted: true,
  micMode: "off" as "off" | "test" | "live",
  micPending: false,
  live: initialStudioLive(),
  messages: [] as Transcript[],
  activity: [] as Activity[],
  status: "Ready when you are",
};
export function saveSettings() {
  localStorage.setItem(
    "mutuals-studio-settings",
    JSON.stringify(state.settings),
  );
}
export function record(kind: string, title: string, detail = "") {
  state.activity.unshift({ time: Date.now(), kind, title, detail });
  state.activity = state.activity.slice(0, 300);
  document.dispatchEvent(new CustomEvent("activity"));
}
export function status(text: string) {
  if (state.status === text) return;
  state.status = text;
  document.dispatchEvent(new CustomEvent("session-state"));
}
