// The one JSON object every hook receives. docs/architecture.md, "State", is the
// contract; renaming a key here is a breaking change for every extension.

export const STATE_SCHEMA = 1;

export interface Message {
	role: string;
	content: string;
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

export interface State {
	schema: number;
	character: Record<string, unknown>;
	session: { id: string; channel: string; end_reason?: string };
	// `offered_by`: the extension whose offer this turn is, when it is one
	input?: { text: string; channel: string; offered_by?: string };
	messages?: Message[];
	prompt?: string;
	reply?: string;
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
	"on_sentence",
	"on_speak",
	"after_turn",
	"on_session_end",
] as const;

export type HookName = (typeof HOOKS)[number];
