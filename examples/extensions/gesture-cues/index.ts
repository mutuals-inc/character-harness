// Plays a gesture when the character says one of its cue phrases: a wave
// on "hello", a cheer on "you did it". The gesture lands on the phrase itself.
//
// config:
//   cues: { "hello": wave, "you did it": cheer }   phrase -> gesture

interface Input {
	event: string;
	state: { sentence?: string; beats?: object[] };
	config: { cues?: Record<string, string> };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default function ({ state, config }: Input) {
	const sentence = state.sentence ?? "";
	// delivery tags like [laughs] aren't spoken, so they can't be cues; blanked
	// to the same length, so a match's place is its place in the sentence
	const spoken = sentence.replace(/\[[^[\]]*\]/g, (tag) => " ".repeat(tag.length));
	// the cue that comes first in the sentence; one gesture per sentence
	let first: { at: number; span: string; gesture: string } | undefined;
	for (const [phrase, gesture] of Object.entries(config.cues ?? {})) {
		// the whole phrase, in any case, not part of a longer word
		const m = new RegExp(`(?<![\\p{L}\\p{N}])${escape(phrase)}(?![\\p{L}\\p{N}])`, "iu").exec(spoken);
		if (m && (!first || m.index < first.at))
			first = { at: m.index, span: sentence.slice(m.index, m.index + m[0].length), gesture };
	}
	if (!first) return; // nothing to add, so no change
	const beat = { span: first.span, gesture: first.gesture };
	return { state: { ...state, beats: [...(state.beats ?? []), beat] } };
}

// What `npm run check` and `npm start` ask before a call. A config it can't
// use is an error, so the character doesn't start; a gesture the character
// doesn't have is a warning, since on stage it would only do nothing.
export function check({ config, body }: { config: { cues?: unknown }; body: { gestures: string[] | null } }) {
	const cues = config.cues;
	if (!cues || typeof cues !== "object" || Array.isArray(cues))
		return { errors: ["`cues` must map a phrase to a gesture, like { hello: wave }"] };
	const errors: string[] = [];
	const warnings: string[] = [];
	for (const [phrase, gesture] of Object.entries(cues)) {
		if (!phrase.trim() || phrase.length > 200 || typeof gesture !== "string")
			errors.push(`cue ${JSON.stringify(phrase.slice(0, 40))} must map a phrase (up to 200 characters) to a gesture's name`);
		else if (body.gestures && !body.gestures.includes(gesture))
			warnings.push(`"${phrase}" plays "${gesture}", a gesture this character doesn't have`);
	}
	return { errors, warnings };
}
