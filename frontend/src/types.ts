export interface HookOptions {
  blocking: boolean;
  timeout_ms: number;
}
export interface ExtensionSelection {
  id: string;
  enabled: boolean;
  config: string;
}
export interface AvailableExtension {
  service?: boolean;
  description?: string;
  id: string;
  name: string;
  hooks: string[];
  defaultConfig: string;
}
export interface ExtensionInfo {
  service?: boolean;
  enabled: boolean;
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
  license: string;
  purpose: string;
  chatKeyName: string;
  maxTokens: number | null;
  reasoningEffort: string;
  dropTags: string[];
  springs: boolean;
  rigKind: "model" | "profile";
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
  extensionSettings: ExtensionSelection[];
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
export interface CharacterSummary {
  protected?: boolean;
  id: string;
  name: string;
  portrait: string | null;
  createdAt: number;
  modifiedAt: number;
}
export interface ChatPreset {
  api: string;
  model: string;
  baseUrl: string;
  keyName: string;
}
export interface Bootstrap {
  voicePresets: { name: string; voiceId: string }[];
  chatPresets: ChatPreset[];
  characters: CharacterSummary[];
  availableExtensions: AvailableExtension[];
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
  paused: boolean;
}
export interface WireMessage {
  alignment?: {characters?:string[];character_start_times_seconds?:number[];character_end_times_seconds?:number[]};
  seq?: number;
  t: string;
  id?: number;
  text?: string;
  entries?: HistoryEntry[];
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
// A history entry as the runtime reads it: a message, a reply that called
// tools (`tool_calls`), or a tool's result (`tool_call_id`)
export interface HistoryEntry {
  role: string;
  content: string;
  tool_calls?: { id: string; name: string; arguments: string }[];
  tool_call_id?: string;
}
export interface Transcript {
  role: "user" | "assistant";
  content: string;
  source?: string;
  // a reply that called tools: what it adds to the history in place of `content`
  entries?: HistoryEntry[];
  // how much of `content` the entries hold; the rest was said after them
  covered?: number;
}
export interface Activity {
  time: number;
  kind: string;
  title: string;
  detail: string;
}
