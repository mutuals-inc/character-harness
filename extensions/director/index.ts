// Stages each spoken sentence as beats: the emotion the character performs,
// the talking style the body loops through, an optional gesture and an
// optional camera move, each anchored to the phrase where it starts. A second
// model call picks the words from the character's vocabulary; the runtime
// times them to the voice.
//
// Sentences are staged in batches: a batch fires
// at BATCH_SIZE sentences, or once no new sentence has arrived for BATCH_IDLE_MS.
// One call per batch keeps up with long replies and stays under rate limits,
// and the director sees enough of the passage to hold a talking style across
// it. Batches are serialized per session, so each sees what the previous ones
// spent (camera moves, gestures, intense emotions). A batch from an earlier
// turn is dropped. A failed or late call means no beats, never a wrong one.
//
// config (usually a character's director.yaml):
//   model:     { base_url, api_key_env, model }   an OpenAI-compatible chat model
//   emotions:  { name: hint }                     the emotion words, with what each means
//   intense:   [ ... ]                            peak-only emotions
//   registers, gestures, cameras: [ ... ]         the other words
//   limits:    { cameras, intense }               per reply
//   tags:      { tag: emotion }                   synonyms a near-miss word maps through
//   prompt:    the director's instructions

interface Beat {
	span: string;
	emotion: string; // "" = carry over the previous beat's
	register: string; // "" = carry over; "none" = a reaction beat, the gesture is the body
	gesture: string; // "none" = nothing
	camera: string; // "none" = leave the camera alone
}

interface Config {
	model: { base_url: string; api_key_env: string; model: string };
	emotions: Record<string, string>;
	intense?: string[];
	registers?: string[];
	gestures?: string[];
	cameras?: string[];
	limits?: { cameras?: number; intense?: number };
	tags?: Record<string, string>;
	prompt: string;
}

interface Input {
	event: string;
	state: {
		session: { id: string };
		turn?: number;
		sentence?: string;
		beats?: unknown[];
	};
	config: Config;
}

// what the reply has spent so far, so sparsity holds across its sentences
interface Budget {
	beats: number;
	cameras: number;
	gestures: number;
	intense: number;
	lastGesture: string;
	lastRegister: string;
}

// one sentence waiting in a batch, and how to hand back its beats
interface Waiting {
	line: string;
	done: (beats: Beat[]) => void;
}

interface Session {
	turn: number | undefined;
	budget: Budget;
	spoken: string; // this reply's sentences already staged, for context
	chain: Promise<unknown>;
	batch: Waiting[];
	idle: ReturnType<typeof setTimeout> | undefined;
}

const BATCH_SIZE = 3;
const BATCH_IDLE_MS = 400;

const sessions = new Map<string, Session>();

const newBudget = (): Budget => ({ beats: 0, cameras: 0, gestures: 0, intense: 0, lastGesture: "none", lastRegister: "" });

// delivery tags are the speaking model's hints, not director words: left in,
// the director echoes them back and quotes spans that were never voiced
const stripTags = (text: string) =>
	text.replace(/\[[a-zA-Z][a-zA-Z ,_'-]*\]/g, " ").replace(/^[\s.!?,;:—-]+/, "").replace(/\s+/g, " ").trim();

const list = (a: readonly string[]) => a.map((s) => `\`${s}\``).join(" ");

function systemPrompt(c: Config): string {
	const hints = Object.entries(c.emotions)
		.filter(([, hint]) => hint)
		.map(([name, hint]) => `- \`${name}\` — ${hint}`)
		.join("\n");
	return (
		c.prompt +
		`\n## Vocabularies (the ONLY legal words)\n\n` +
		`**emotion**: ${list(Object.keys(c.emotions))}\n` +
		(hints ? `\nWhat each one means:\n${hints}\n` : "") +
		`\nUse the whole range; staging every beat with the same few emotions wastes the palette.\n\n` +
		(c.intense?.length
			? `These are the INTENSE ones, peak-only and capped at ${c.limits?.intense ?? 2} per reply: ${list(c.intense)}\n\n`
			: "") +
		`**register**: ${list(c.registers ?? [])} — or \`none\` for a reaction beat.\n\n` +
		`**gesture**: ${list(c.gestures ?? [])} — or \`none\`.\n\n` +
		`**camera**: ${list(c.cameras ?? [])} — or \`none\`.\n`
	);
}

function continuity(b: Budget, c: Config): string {
	const cameras = c.limits?.cameras ?? 1;
	const intense = c.limits?.intense ?? 2;
	return (
		`CONTINUITY — register currently running: ${b.lastRegister || "none yet"}` +
		` (default to continuing it). beats staged so far this reply: ${b.beats}.` +
		` camera moves used: ${b.cameras}/${cameras}. gestures used: ${b.gestures}.` +
		` intense emotions used: ${b.intense}/${intense}. previous beat's gesture: ${b.lastGesture}.` +
		(b.cameras >= cameras ? ` CAMERA BUDGET IS SPENT — every camera must be "none".` : "")
	);
}

function parseJson(text: string): unknown {
	const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
	try {
		return JSON.parse(t);
	} catch {
		const a = t.indexOf("{");
		const b = t.lastIndexOf("}");
		if (a >= 0 && b > a) {
			try {
				return JSON.parse(t.slice(a, b + 1));
			} catch {
				// give up
			}
		}
	}
	return null;
}

// keeps only legal words; a near-miss emotion goes through the tag synonyms
function coerce(raw: unknown, c: Config): Beat[] {
	const arr = (raw as { beats?: unknown } | null)?.beats;
	if (!Array.isArray(arr)) return [];
	const emotions = Object.keys(c.emotions);
	const legal = (words: string[] | undefined, none: boolean) => (w: string) =>
		(none && w === "none") || (words ?? []).includes(w);
	const pick = (v: unknown, ok: (w: string) => boolean, fallback: string) => {
		const w = typeof v === "string" ? v.trim().toLowerCase() : "";
		if (!w) return fallback;
		if (ok(w)) return w;
		const synonym = c.tags?.[w];
		return synonym && ok(synonym) ? synonym : fallback;
	};
	const out: Beat[] = [];
	for (const it of arr) {
		const o = it as Record<string, unknown>;
		if (!o || typeof o.span !== "string" || !o.span) continue;
		const beat: Beat = {
			span: o.span,
			emotion: pick(o.emotion, legal(emotions, false), ""),
			register: pick(o.register, legal(c.registers, true), ""),
			gesture: pick(o.gesture, legal(c.gestures, true), "none"),
			camera: pick(o.camera, legal(c.cameras, true), "none"),
		};
		// a reaction beat with no gesture would freeze the body; keep it talking
		if (beat.register === "none" && beat.gesture === "none") beat.register = "";
		out.push(beat);
	}
	return out;
}

function spend(b: Budget, beats: Beat[], c: Config): void {
	for (const beat of beats) {
		b.beats++;
		if (beat.camera !== "none") b.cameras++;
		if (beat.gesture !== "none") {
			b.gestures++;
			b.lastGesture = beat.gesture;
		} else {
			b.lastGesture = "none";
		}
		if (c.intense?.includes(beat.emotion)) b.intense++;
		if (beat.register) b.lastRegister = beat.register;
	}
}

// One call for a batch of consecutive lines, staged as one passage. Returns the
// beats for each line, matched by where each span falls in the passage.
async function stage(lines: string[], s: Session, c: Config): Promise<Beat[][]> {
	const passage = lines.join("\n");
	const user =
		`ALREADY SPOKEN (context only — do not stage this):\n${s.spoken || "(this is the opening)"}\n\n` +
		`${continuity(s.budget, c)}\n\n` +
		`STAGE THIS PASSAGE (spans must be exact substrings of it):\n${passage}`;
	const resp = await fetch(`${c.model.base_url.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		signal: AbortSignal.timeout(7000),
		headers: {
			Authorization: `Bearer ${process.env[c.model.api_key_env] ?? ""}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: c.model.model,
			temperature: 0.4,
			max_completion_tokens: 900,
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: systemPrompt(c) },
				{ role: "user", content: user },
			],
		}),
	});
	if (!resp.ok) throw new Error(`the director model answered HTTP ${resp.status}`);
	const j = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
	const beats = coerce(parseJson(j.choices?.[0]?.message?.content ?? ""), c);
	// where each line starts in the passage
	const starts: number[] = [];
	let at = 0;
	for (const line of lines) {
		starts.push(at);
		at += line.length + 1;
	}
	const perLine: Beat[][] = lines.map(() => []);
	let cursor = 0; // spans come in order, so a repeated phrase can't match backwards
	for (const beat of beats) {
		let found = passage.indexOf(beat.span, cursor);
		if (found < 0) found = passage.indexOf(beat.span); // the model reordered
		if (found < 0) continue; // not in the passage; it could never be timed
		cursor = found + beat.span.length;
		let line = 0;
		for (let i = 0; i < starts.length; i++) if (found >= starts[i]) line = i;
		perLine[line].push(beat);
	}
	return perLine;
}

// stages the waiting batch after the ones before it
function fire(s: Session, c: Config): void {
	clearTimeout(s.idle);
	s.idle = undefined;
	const batch = s.batch;
	s.batch = [];
	if (!batch.length) return;
	const turn = s.turn;
	s.chain = s.chain.then(async () => {
		// a new turn began while this batch waited; its sentences are gone
		if (turn !== s.turn) return batch.forEach((w) => w.done([]));
		try {
			const lines = batch.map((w) => w.line);
			const perLine = await stage(lines, s, c);
			if (turn !== s.turn) return batch.forEach((w) => w.done([]));
			spend(s.budget, perLine.flat(), c);
			s.spoken = `${s.spoken} ${lines.join(" ")}`.trim();
			batch.forEach((w, i) => w.done(perLine[i]));
		} catch {
			batch.forEach((w) => w.done([]));
		}
	});
}

export default async function ({ event, state, config }: Input) {
	if (event === "on_session_end") {
		const s = sessions.get(state.session.id);
		if (s) {
			clearTimeout(s.idle);
			s.batch.forEach((w) => w.done([]));
		}
		sessions.delete(state.session.id);
		return;
	}
	const line = stripTags(state.sentence ?? "");
	if (event !== "on_sentence" || !line) return;
	let s = sessions.get(state.session.id);
	if (!s) {
		s = { turn: state.turn, budget: newBudget(), spoken: "", chain: Promise.resolve(), batch: [], idle: undefined };
		sessions.set(state.session.id, s);
	}
	// a new reply starts a new budget; the talking style carries over
	if (s.turn !== state.turn) {
		clearTimeout(s.idle);
		s.batch.forEach((w) => w.done([]));
		s.batch = [];
		s.turn = state.turn;
		s.budget = { ...newBudget(), lastRegister: s.budget.lastRegister };
		s.spoken = "";
	}
	const session = s;
	const beats = await new Promise<Beat[]>((done) => {
		session.batch.push({ line, done });
		if (session.batch.length >= BATCH_SIZE) fire(session, config);
		else {
			clearTimeout(session.idle);
			session.idle = setTimeout(() => fire(session, config), BATCH_IDLE_MS);
		}
	});
	if (!beats.length) return;
	return { state: { ...state, beats: [...(state.beats ?? []), ...beats] } };
}

// What `npm run check` and `npm start` ask before a call. An incomplete config
// is an error: the director can't work, so the character doesn't start. A word
// the character has nothing for (`body`) is a warning: on stage it would only
// do nothing.
interface Body {
	emotions: string[] | null;
	registers: string[] | null;
	gestures: string[] | null;
	cameras: string[] | null;
}

export function check({ config, body }: { config: Partial<Config>; body: Body }) {
	const errors: string[] = [];
	const warnings: string[] = [];
	const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
	for (const k of ["base_url", "api_key_env", "model"] as const)
		if (typeof config.model?.[k] !== "string" || !config.model[k]) errors.push(`\`model.${k}\` is required`);
	if (typeof config.prompt !== "string" || !config.prompt.trim()) errors.push("`prompt` is required");
	const emotions = config.emotions && typeof config.emotions === "object" && !Array.isArray(config.emotions) ? Object.keys(config.emotions) : [];
	if (!emotions.length) errors.push("`emotions` must map at least one emotion to what it means");
	// a key left empty in YAML reads as null, which is the same as leaving it out
	for (const k of ["intense", "registers", "gestures", "cameras"] as const)
		if (config[k] !== undefined && config[k] !== null && !strings(config[k])) errors.push(`\`${k}\` must be a list of words`);
	if (errors.length) return { errors };

	const unknown = (what: string, words: string[], have: string[] | null, where: string) => {
		if (!have) return;
		const missing = words.filter((w) => w !== "none" && !have.includes(w));
		if (missing.length) warnings.push(`${what} ${missing.map((w) => `"${w}"`).join(", ")} ${missing.length > 1 ? "aren't" : "isn't"} in ${where}`);
	};
	unknown("emotion", emotions, body.emotions, "the player's emotion set");
	unknown("talking style", config.registers ?? [], body.registers, "the character's talking styles");
	unknown("gesture", config.gestures ?? [], body.gestures, "the character's gestures");
	unknown("camera move", config.cameras ?? [], body.cameras, "the player's camera moves");

	// these only do nothing for the director, so they're worth a note, not a stop
	const outside = (words: string[]) => [...new Set(words)].filter((w) => !emotions.includes(w));
	const intense = outside(config.intense ?? []);
	if (intense.length) warnings.push(`\`intense\` lists ${intense.map((w) => `"${w}"`).join(", ")}, not in \`emotions\``);
	const tags = outside(config.tags && typeof config.tags === "object" ? Object.values(config.tags) : []);
	if (tags.length) warnings.push(`\`tags\` maps to ${tags.map((w) => `"${w}"`).join(", ")}, which the director never picks`);
	const unused = (body.gestures ?? []).filter((g) => !(config.gestures ?? []).includes(g));
	if (unused.length) warnings.push(`never picks gesture ${unused.map((w) => `"${w}"`).join(", ")}, which the character has`);
	const styles = (body.registers ?? []).filter((r) => r !== "regular" && !(config.registers ?? []).includes(r));
	if (styles.length) warnings.push(`never picks talking style ${styles.map((w) => `"${w}"`).join(", ")}, which the character has`);
	return { errors, warnings };
}
