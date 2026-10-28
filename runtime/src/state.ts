// The one JSON object every hook receives. docs/architecture.md, "State", is the
// contract; renaming a key here is a breaking change for every extension.

export const STATE_SCHEMA = 1;

// One entry of the conversation. `role` is user, assistant or tool. An
// assistant entry that called tools lists them in `tool_calls`, and each call's
// result follows it as a tool entry naming the call in `tool_call_id`.
export interface Message {
	role: string;
	content: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface Timing {
	characters: string[];
	starts: number[]; // seconds into this sentence's audio
	ends: number[];
}

// A performance cue for the sentence being spoken: what the character's face,
// body and camera do from `span` on. The words are the character's own
// vocabulary (emotions, talking styles, gestures, camera moves); the
// runtime only times them to the audio and forwards them to the app.
export interface Beat {
	span: string; // exact text in the sentence where it starts; "" = the start
	emotion?: string;
	register?: string;
	gesture?: string;
	camera?: string;
}

// A function the chat model may call this turn: one an extension declares in
// its extension.yaml, or puts in `tools` on before_llm. `parameters` is a JSON
// schema of `type: "object"`. `by` is the extension that added it, which the
// runtime fills in; its on_tool_call runs the tool.
export interface Tool {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
	by?: string;
}

// A call the chat model made. `arguments` is the JSON text as the model wrote
// it, so it may not parse or match the tool's schema. In `tool_calls`, `by` is
// the extension whose tool it called, and `result` what the model got back.
export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
	by?: string;
	result?: string;
}

// What on_tool_call hands back for a call: its result, why it failed, or
// `pending` when the result comes later (see ServiceContext.result).
export type ToolResult = { content: string } | { error: string } | { pending: true };

// Which tools the model must use this turn: any or none (`auto`, the default),
// at least one (`required`), none at all, or the one named.
export type ToolChoice = "auto" | "required" | "none" | { name: string };

// One stretch of speech the runtime heard, with when its words were spoken, in
// Unix ms on the runtime's clock.
export interface Utterance {
	text: string;
	start_ms: number;
	end_ms: number;
}

export interface State {
	schema: number;
	character: Record<string, unknown>;
	session: { id: string; channel: string; end_reason?: string };
	// `offered_by`: the extension whose offer this turn is, when it is one.
	// `utterances`: the speech the user's line was heard as, oldest first, when
	// the runtime heard all of it
	input?: { text: string; channel: string; offered_by?: string; utterances?: Utterance[] };
	messages?: Message[];
	prompt?: string;
	tools?: Tool[];
	tool_choice?: ToolChoice;
	reply?: string;
	tool_calls?: ToolCall[];
	turn?: number;
	sentence?: string;
	beats?: Beat[];
	timing?: Timing;
	cancel?: boolean;
	error?: string;
	ext: Record<string, unknown>;
}

export const HOOKS = [
	"on_session_start",
	"before_reply",
	"before_llm",
	"after_llm",
	"on_tool_call",
	"on_sentence",
	"on_speak",
	"after_turn",
	"on_session_end",
] as const;

export type HookName = (typeof HOOKS)[number];
