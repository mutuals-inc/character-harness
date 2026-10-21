export interface HookOptions {
  blocking: boolean;
  timeout_ms: number;
}
export interface ExtensionInfo {
  name: string;
  handler: string;
  hooks: Record<string, HookOptions>;
  keys: string[];
}
export interface CharacterInfo {
  id: string;
  name: string;
  description: string;
  author: string;
  revision: string;
  prompt: string;
  model: string;
  api: string;
  baseUrl: string;
  temperature: number;
  voice: {
    provider: string;
    model: string;
    voice_id: string;
    stability: number;
    similarity: number;
  };
  stt: { model: string; language: string; keyterms: string[] };
  extensions: ExtensionInfo[];
  keys: { name: string; ready: boolean }[];
  body: {
    emotions: string[];
    gestures: string[];
    cameras: string[];
    registers: string[];
  };
  expressions: Record<string, Record<string, number>>;
  hiddenJoints: string[];
  rig: string;
  errors: string[];
  warnings: string[];
}
export interface Bootstrap {
  characters: { id: string; name: string }[];
  character: CharacterInfo;
  hooks: string[];
}
export interface Settings {
  inputDevice: string;
  outputDevice: string;
  gain: number;
  volume: number;
  threshold: number;
  silenceMs: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  speakReplies: boolean;
  captions: boolean;
  background: "sky" | "paper" | "blue";
  disabledExtensions: string[];
  paused: boolean;
}
export interface WireMessage {
  seq?: number;
  t: string;
  id?: number;
  text?: string;
  utterance?: number;
  bt?: number;
  emotion?: string;
  gesture?: string;
  camera?: string;
  talk?: string;
  event?: string;
  extension?: string;
  duration?: number;
  turn?: number;
  phase?: string;
}
export interface Transcript {
  role: "user" | "assistant";
  content: string;
  source?: string;
}
export interface Activity {
  time: number;
  kind: string;
  title: string;
  detail: string;
}
