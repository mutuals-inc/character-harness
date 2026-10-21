// How the character reacts to what the user just said, shown as it starts to
// answer: an emotion on its face and maybe a gesture, as a beat at the start
// of the reply's first sentence.
//
// When the user's message arrives (before_reply, alongside the chat model),
// one request to Typesafe's Jev asks a few questions about it: what crosses
// the character's face, what mood it puts the character in, how much it moves
// the character, whether the character would hide it, whether it's funny,
// whether it's about the character, and which gesture fits.
// The code picks one emotion from the answers (a laugh, the reaction itself
// when it's strong, or else the mood) and keeps it for the turn; on_sentence
// puts it on the first sentence. Every threshold is here, never in a rubric:
// questions asked together influence each other.
//
// A failed, late or malformed answer means no beat; the turn goes on.
//
// config (usually a character's reactions.yaml; see README.md):
//   model:      { api_key_env, base_url?, model?, timeout_ms? }
//   about:      a few lines on who the character is, for the judge
//   context:    how many earlier messages the judge sees (default 6)
//   beat:       { option: emotion | { emotion, rubric } }   the reaction to the message
//   settle:     { option: emotion | { emotion, rubric } }   the mood it puts the character in
//   gestures:   { gesture: when it fits }
//   laugh:      { emotion }                                 for a really funny line
//   thresholds: { unsure, strong, settle, settle_intensity, laugh, gesture_intensity, gesture, gesture_sure }

interface Message {
	role: string;
	content: string;
}

interface Input {
	event: string;
	state: {
		session: { id: string };
		turn?: number;
		character?: { name?: unknown; description?: unknown };
		input?: { text?: unknown };
		cancel?: boolean;
		messages?: Message[];
		sentence?: string;
		beats?: unknown[];
	};
	config: unknown;
}

// a beat as the runtime takes it (runtime/src/state.ts)
export interface Beat {
	span: string;
	emotion?: string;
	gesture?: string;
}

interface Option {
	rubric: string;
	emotion: string; // "" = none
}

interface Thresholds {
	unsure: number; // a reaction the judge is less sure of than this isn't shown as such
	strong: number; // a reaction at least this strong is the emotion the reply starts with
	settle: number; // the mood needs at least this confidence...
	settle_intensity: number; // ...and a message that moved the character at least this much
	laugh: number; // amused at least this much: the character laughs
	gesture_intensity: number; // a gesture needs at least this intensity...
	gesture: number; // ...and at least this confidence
	gesture_sure: number; // a gesture this sure plays even for a small message (a wave at hello)
}

export interface Resolved {
	baseUrl: string;
	keyEnv: string;
	model: string;
	timeoutMs: number;
	context: number;
	about: string;
	beat: Map<string, Option>;
	settle: Map<string, Option>;
	gestures: Map<string, string>;
	laugh: string; // "" = no laugh
	thresholds: Thresholds;
}

const DEFAULTS = {
	baseUrl: "https://api.typesafe.ai/v1",
	keyEnv: "TYPESAFE_API_KEY",
	model: "jev-latest",
	timeoutMs: 1200, // under the hook's 1500 ms, so a slow answer fails here, cleanly
	context: 6,
};

// Tuned against the judge with FoxGlove's words. A wrong gesture (a startled
// jump at sad news, a cheer at a compliment) came with confidence 0.5-0.66,
// the right ones 0.75 and up. Small talk is under 0.1 intensity, and a light
// line like "goodnight" at 0.15-0.2 shouldn't carry a mood over. Big news, a
// compliment or a jab comes out at strength 0.65 and up, an odd fact or a
// passing question under 0.45. A pun or an embarrassing story is amused around
// 0.75-0.8, a joke that escalates past 0.85.
const THRESHOLDS: Thresholds = {
	unsure: 0.35,
	strong: 0.55,
	settle: 0.22,
	settle_intensity: 0.25,
	laugh: 0.82,
	gesture_intensity: 0.35,
	gesture: 0.7,
	gesture_sure: 0.95,
};

// What each common option means, so a character's config can just map it to
// one of its emotions. An option not listed here needs its own rubric.
const BEAT_RUBRICS: Record<string, string> = {
	nothing: "Nothing crosses the face: small talk, a plain question, logistics, or something the character has no stake in.",
	brow_flick: "Brows go up for a moment: a small surprise, a mildly interesting detail, a \"huh, really?\".",
	lean_in: "Curiosity draws the face in: something intriguing, half understood, or that the character wants to hear more about.",
	held_smile: "A small smile, mostly kept in: something pleasant, kind or mildly funny that doesn't call for more.",
	delight: "An open, happy face: good news, a compliment that lands, something plainly fun.",
	lit_up: "The whole face lights up: something the character loves, an exciting surprise, a wish come true.",
	tease: "A sly, mischievous look: the user is being silly, set up a joke, or left an opening to tease them.",
	startle: "A jolt of surprise: something sudden, shocking or completely unexpected.",
	flustered: "Caught off guard and embarrassed: flattery, flirting, or being called out.",
	soften: "The face softens with warmth or sympathy: the user shares something tender, sad or vulnerable.",
	stung: "A flicker of hurt: a slight, a dismissal, or bad news that lands personally.",
	flare: "A flash of irritation: rudeness, unfairness, or something the character finds annoying.",
	turn_it_over: "A thinking look: a hard question, a puzzle, or something the character has to weigh before answering.",
};

const SETTLE_RUBRICS: Record<string, string> = {
	neutral: "An attentive, even face: the exchange leaves no particular mark.",
	relaxed: "At ease and comfortable, with nothing pressing.",
	content: "Quietly pleased: the exchange went well.",
	warm: "Affectionate and open toward the user.",
	thoughtful: "Pensive, still weighing what was said.",
	playful: "In a joking, mischievous mood.",
	confident: "Self-assured, ready to answer with conviction.",
	dreamy: "Far away in a pleasant thought, wistful or romantic.",
	low: "Subdued: a little down, hurt or disappointed.",
};

const STILL = "still";

// What a request may carry and an answer may be. The message, the history and
// the character's lines go to a third party on every turn, so each is cut to
// a size that still says what matters; an answer is a few KB.
const MAX_MESSAGE = 4000;
const MAX_HISTORY_MESSAGE = 1000;
const MAX_CONTEXT = 50;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 1000;
const MAX_ABOUT = 2000;
const MAX_ANSWER = 64 * 1024;
// under before_reply's 1500 ms (extension.yaml), so no request outlives the hook
const MAX_TIMEOUT_MS = 1400;

// a text cut to `max` characters, never through the middle of a character
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).toWellFormed()}…` : s);
const inputText = (state: Input["state"]) => (typeof state.input?.text === "string" ? state.input.text : "");

// ---- the questions ----

type Question =
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "noul"; instructions: string; criteria: { true: string; false: string } };

const INTENSITY_LEVELS = 5;

// The questions name the character: asked about "the character", the judge
// mixed the character up with the user ("i got the job" read as being about
// the character). `who`
// is the character's name, or "the character" without one.
function questions(c: Resolved, name: string): Record<string, Question> {
	const who = name || "the character";
	const rubrics = (m: Map<string, Option>) => Object.fromEntries([...m].map(([k, o]) => [k, o.rubric]));
	const out: Record<string, Question> = {
		beat: {
			type: "choice",
			instructions: `The user just said \`message\` to ${who}. Which expression flashes across ${who}'s face on first hearing it, unplanned, before any answer is chosen? Judge from who ${who} is and the conversation so far.`,
			criteria: rubrics(c.beat),
		},
		intensity: {
			type: "score",
			instructions: `How much does the user's message move ${who}?`,
			criteria: [
				"Nothing to react to: routine, neutral or purely practical.",
				"A mild flicker: mildly interesting, pleasant or odd.",
				`A clear reaction: news that matters to the user or to ${who}, or something plainly funny, surprising, touching or annoying.`,
				`Strong: big news, good or bad, or a remark that stings; it shows on ${who}'s face at once, unbidden.`,
				"Overwhelming: shocking, thrilling or deeply moving.",
			],
		},
		guarded: {
			type: "noul",
			instructions: `Would ${who} hide or tone down the reaction rather than let it show, out of politeness, pride or professionalism?`,
			criteria: { true: `${who} would mask it.`, false: `${who} would let it show as it is.` },
		},
		amused: {
			type: "noul",
			instructions: "Is the user's message funny: something people would laugh at?",
			criteria: {
				true: "A joke, a witty line, a funny story, an embarrassing mishap, or something absurd.",
				false: "Not funny, or only friendly or polite.",
			},
		},
		personal: {
			type: "noul",
			instructions: `Is the user talking about ${who}, rather than about themselves, someone else or a topic?`,
			criteria: {
				true: `About ${who}: ${who}'s looks, voice, work, feelings or choices, or how the user feels about ${who}.`,
				false: `About the user's own life, someone else, or a topic; a question that only asks ${who}'s opinion counts too.`,
			},
		},
	};
	if (c.settle.size)
		out.settle = {
			type: "choice",
			instructions: `A few seconds on, what mood is ${who} in because of this message?`,
			criteria: rubrics(c.settle),
		};
	if (c.gestures.size)
		out.gesture = {
			type: "choice",
			instructions: `Which body movement, if any, would ${who} make on hearing the message?`,
			criteria: { ...Object.fromEntries(c.gestures), [STILL]: "No movement: the usual answer, for most messages and for sad or tender news." },
		};
	return out;
}

// What the judge reads: who the character is, the conversation so far, and
// the message.
function situation(state: Input["state"], c: Resolved) {
	const ch = state.character ?? {};
	const messages = (state.messages ?? []).filter((m) => m && typeof m.content === "string");
	// the conversation ends with the user's message, which is `message`
	const earlier = messages.at(-1)?.role === "user" ? messages.slice(0, -1) : messages;
	return {
		character: {
			name: typeof ch.name === "string" ? cut(ch.name, MAX_NAME) : "",
			description: typeof ch.description === "string" ? cut(ch.description, MAX_DESCRIPTION) : "",
			...(c.about ? { about: c.about } : {}),
		},
		conversation: (c.context ? earlier.slice(-c.context) : []).map((m) => ({ role: String(m.role), content: cut(m.content, MAX_HISTORY_MESSAGE) })),
		message: cut(inputText(state), MAX_MESSAGE),
	};
}

// ---- the judge ----

export interface Answer {
	choice?: unknown;
	confidence?: unknown;
	score?: unknown;
	noul?: unknown;
	probabilities?: unknown;
}

async function ask(c: Resolved, key: string, body: unknown): Promise<Record<string, Answer>> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), c.timeoutMs);
	// the runtime logs what this throws, so each failure gets a message of its
	// own, never what fetch said (which could carry the request)
	const failed = (why: string) => new Error(ac.signal.aborted ? `the judge didn't answer in ${c.timeoutMs} ms` : why);
	try {
		let resp: Response;
		try {
			resp = await fetch(`${c.baseUrl}/systemone`, {
				method: "POST",
				signal: ac.signal,
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify(body),
			});
		} catch {
			throw failed("the judge couldn't be reached");
		}
		if (!resp.ok) {
			await resp.body?.cancel().catch(() => undefined);
			throw new Error(`the judge answered HTTP ${resp.status}`);
		}
		const length = Number(resp.headers.get("content-length"));
		if (length > MAX_ANSWER) {
			await resp.body?.cancel().catch(() => undefined);
			throw new Error("the judge's answer is too large");
		}
		let raw: string | null;
		try {
			raw = await readCapped(resp, MAX_ANSWER);
		} catch {
			throw failed("the judge's answer was cut off");
		}
		if (raw === null) throw new Error("the judge's answer is too large");
		let j: { answers?: unknown } | null;
		try {
			j = JSON.parse(raw) as { answers?: unknown } | null;
		} catch {
			throw new Error("the judge's answer isn't JSON");
		}
		if (!j || !isMap(j.answers)) throw new Error("the judge's answer has no answers");
		return j.answers as Record<string, Answer>;
	} finally {
		clearTimeout(timer);
	}
}

// the body as text, or null once it passes `max` bytes (the rest isn't read)
async function readCapped(resp: Response, max: number): Promise<string | null> {
	if (!resp.body) return "";
	const reader = resp.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

const unit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
const probabilities = (a: Answer | undefined): Record<string, number> => {
	const p = a?.probabilities;
	if (!p || typeof p !== "object") return {};
	// a negative or non-finite one is no probability at all
	return Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0)) as Record<string, number>;
};

// a choice among `options`, with how sure the judge is
function choice(a: Answer | undefined, options: Iterable<string>): { choice: string; confidence: number } | null {
	const legal = new Set(options);
	const p = probabilities(a);
	if (typeof a?.choice === "string" && legal.has(a.choice))
		return { choice: a.choice, confidence: unit(a.confidence) ?? unit(p[a.choice]) ?? 0 };
	// no usable `choice`: the most likely legal option, as sure as its own
	// probability (`confidence` was about the choice that isn't usable)
	const best = Object.entries(p).filter(([k]) => legal.has(k)).sort((x, y) => y[1] - x[1])[0];
	return best ? { choice: best[0], confidence: unit(best[1]) ?? 0 } : null;
}

// a score as 0..1: its probability-weighted level over the top level
function score(a: Answer | undefined, levels: number): number | null {
	if (typeof a?.score === "number" && Number.isFinite(a.score)) return unit(a.score / (levels - 1));
	const p = probabilities(a);
	let sum = 0;
	let weight = 0;
	for (let k = 0; k < levels; k++) {
		sum += k * (p[String(k)] ?? 0);
		weight += p[String(k)] ?? 0;
	}
	return weight > 0 ? unit(sum / weight / (levels - 1)) : null;
}

// the probability it's true: the judge answers it as `noul`, a number
function noul(a: Answer | undefined): number | null {
	if (typeof a?.noul === "number") return unit(a.noul);
	const p = probabilities(a);
	if ("true" in p) return unit(p.true);
	if ("false" in p) return unit(1 - p.false);
	return typeof a?.noul === "boolean" ? (a.noul ? 1 : 0) : null;
}

export interface Judgement {
	beat: { choice: string; confidence: number };
	settle: { choice: string; confidence: number } | null;
	gesture: { choice: string; confidence: number } | null;
	intensity: number; // 0..1
	guarded: number; // P(true)
	amused: number;
	personal: number;
}

// The judge's answers as one judgement, or null when the ones that matter
// are missing.
export function judgement(answers: Record<string, Answer>, c: Resolved): Judgement | null {
	const beat = choice(answers.beat, c.beat.keys());
	const intensity = score(answers.intensity, INTENSITY_LEVELS);
	if (!beat || intensity === null) return null;
	return {
		beat,
		settle: c.settle.size ? choice(answers.settle, c.settle.keys()) : null,
		gesture: c.gestures.size ? choice(answers.gesture, [...c.gestures.keys(), STILL]) : null,
		intensity,
		guarded: noul(answers.guarded) ?? 0,
		amused: noul(answers.amused) ?? 0,
		personal: noul(answers.personal) ?? 0,
	};
}

// ---- from a judgement to a beat ----

// How strongly the reaction shows: a guarded character shows less, one
// hearing about itself shows more. 0..1.4.
export function strength(j: Judgement): number {
	const u = (v: number) => unit(v) ?? 0;
	return Math.min(1.4, (0.14 + 1.05 * u(j.intensity)) * (1 - 0.55 * u(j.guarded)) * (1 + 0.2 * u(j.personal)));
}

// The emotion and gesture the answer starts with, or null for none. One
// emotion, since the face takes one at a time: a laugh if it's that funny,
// else the reaction itself if it's strong and the judge is sure of it, else
// the mood the message puts the character in, if it moved the character at all.
export function decide(j: Judgement, c: Resolved): Beat | null {
	const t = c.thresholds;
	let emotion = "";
	const reaction = c.beat.get(j.beat.choice)?.emotion ?? "";
	const settle = j.settle ? (c.settle.get(j.settle.choice)?.emotion ?? "") : "";
	if (c.laugh && j.amused >= t.laugh) emotion = c.laugh;
	else if (reaction && j.beat.confidence >= t.unsure && strength(j) >= t.strong) emotion = reaction;
	else if (settle && j.settle!.confidence >= t.settle && j.intensity >= t.settle_intensity) emotion = settle;

	const g = j.gesture;
	const gesture =
		g && g.choice !== STILL && c.gestures.has(g.choice) && g.confidence >= t.gesture && (j.intensity >= t.gesture_intensity || g.confidence >= t.gesture_sure)
			? g.choice
			: "";
	if (!emotion && !gesture) return null;
	return { span: "", ...(emotion ? { emotion } : {}), ...(gesture ? { gesture } : {}) };
}

// ---- config ----

function trimSlashes(url: string): string {
	let end = url.length;
	while (end > 0 && url[end - 1] === "/") end--;
	return url.slice(0, end);
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// The config as the handler uses it, or the reasons it can't be used.
function read(config: unknown): { c: Resolved } | { errors: string[] } {
	const errors: string[] = [];
	const cfg = isMap(config) ? config : {};
	if (!isMap(config)) errors.push("the config must be a map (see extensions/reactions/README.md)");
	const model = isMap(cfg.model) ? cfg.model : {};
	if (!isMap(cfg.model)) errors.push("`model` is required, with at least `api_key_env`");
	else if (model.api_key_env === undefined || model.api_key_env === null)
		errors.push("`model.api_key_env` is required: the name of the key in .env, like TYPESAFE_API_KEY");
	const text = (k: string, v: unknown, fallback: string) => {
		if (v === undefined || v === null) return fallback;
		if (typeof v === "string" && v.trim()) return v.trim();
		errors.push(`\`${k}\` must be a non-empty string`);
		return fallback;
	};
	const positive = (k: string, v: unknown, fallback: number) => {
		if (v === undefined || v === null) return fallback;
		if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
		errors.push(`\`${k}\` must be a positive number`);
		return fallback;
	};

	const options = (k: "beat" | "settle", rubrics: Record<string, string>) => {
		const out = new Map<string, Option>();
		const v = cfg[k];
		if (v === undefined || v === null) return out;
		if (!isMap(v)) {
			errors.push(`\`${k}\` must map each option to an emotion`);
			return out;
		}
		for (const [name, o] of Object.entries(v)) {
			const entry = isMap(o) ? o : { emotion: o };
			const emotion = entry.emotion ?? "";
			const rubric = entry.rubric ?? (Object.hasOwn(rubrics, name) ? rubrics[name] : undefined);
			if (typeof emotion !== "string") errors.push(`\`${k}.${name}\` must name an emotion`);
			else if (typeof rubric !== "string" || !rubric.trim())
				errors.push(`\`${k}.${name}\` needs a \`rubric\`: it isn't one of the options the extension knows`);
			else out.set(name, { rubric: rubric.trim(), emotion: emotion.trim() });
		}
		return out;
	};
	// one option is no choice at all
	const beat = options("beat", BEAT_RUBRICS);
	if (cfg.beat === undefined || cfg.beat === null) errors.push("`beat` is required: how the character can react");
	else if (isMap(cfg.beat) && Object.keys(cfg.beat).length < 2) errors.push("`beat` needs at least two options");
	const settle = options("settle", SETTLE_RUBRICS);
	if (isMap(cfg.settle) && Object.keys(cfg.settle).length === 1) errors.push("`settle` needs at least two options, or none");

	const gestures = new Map<string, string>();
	if (cfg.gestures !== undefined && cfg.gestures !== null) {
		if (!isMap(cfg.gestures)) errors.push("`gestures` must map each gesture to when it fits");
		else
			for (const [name, rubric] of Object.entries(cfg.gestures)) {
				if (name === STILL) errors.push(`\`gestures\` can't have "${STILL}": it is always there, for no movement`);
				else if (typeof rubric !== "string" || !rubric.trim()) errors.push(`\`gestures.${name}\` must say when it fits`);
				else gestures.set(name, rubric.trim());
			}
	}

	let laugh = "";
	if (cfg.laugh !== undefined && cfg.laugh !== null) {
		const l = isMap(cfg.laugh) ? cfg.laugh : {};
		if (typeof l.emotion !== "string" || !l.emotion.trim()) errors.push("`laugh.emotion` is required with `laugh`");
		else laugh = l.emotion.trim();
	}

	const thresholds = { ...THRESHOLDS };
	if (cfg.thresholds !== undefined && cfg.thresholds !== null) {
		if (!isMap(cfg.thresholds)) errors.push("`thresholds` must map a threshold to a number");
		else
			for (const [k, v] of Object.entries(cfg.thresholds)) {
				if (!Object.hasOwn(THRESHOLDS, k)) errors.push(`\`thresholds.${k}\` isn't a threshold (${Object.keys(THRESHOLDS).join(", ")})`);
				else if (typeof v !== "number" || !(v >= 0 && v <= (k === "strong" ? 1.4 : 1)))
					errors.push(`\`thresholds.${k}\` must be a number from 0 to ${k === "strong" ? 1.4 : 1}`);
				else thresholds[k as keyof Thresholds] = v;
			}
	}

	const c: Resolved = {
		baseUrl: trimSlashes(text("model.base_url", model.base_url, DEFAULTS.baseUrl)),
		keyEnv: text("model.api_key_env", model.api_key_env, DEFAULTS.keyEnv),
		model: text("model.model", model.model, DEFAULTS.model),
		timeoutMs: Math.min(MAX_TIMEOUT_MS, positive("model.timeout_ms", model.timeout_ms, DEFAULTS.timeoutMs)),
		context: cfg.context === 0 ? 0 : Math.min(MAX_CONTEXT, Math.floor(positive("context", cfg.context, DEFAULTS.context))),
		about: cut(text("about", cfg.about, ""), MAX_ABOUT),
		beat,
		settle,
		gestures,
		laugh,
		thresholds,
	};
	return errors.length ? { errors } : { c };
}

// a config read once per config object, since it doesn't change in a session
const resolved = new WeakMap<object, Resolved>();
export function resolve(config: unknown): Resolved {
	if (isMap(config) && resolved.has(config)) return resolved.get(config)!;
	const r = read(config);
	if ("errors" in r) throw new Error(`its config can't be used: ${r.errors.join("; ")}`);
	if (isMap(config)) resolved.set(config, r.c);
	return r.c;
}

// ---- what each turn decided ----

// By session, the turn being answered: what was decided for it (null while the
// judge is asked, or when it decided nothing) and whether its first sentence
// has been staged. Only the latest turn of a session is kept.
interface Turn {
	turn: number | undefined;
	beat: Beat | null;
	staged: boolean;
	at: number;
}
const turns = new Map<string, Turn>();
// a session that ended without on_session_end (the runtime stopped) is dropped
// once it has been quiet this long
const STALE_MS = 30 * 60 * 1000;

// The map is in the order sessions were last judged (a session is moved to
// the end each turn), so the stale ones are at the front and the sweep stops
// at the first fresh one.
function forget(now: number): void {
	for (const [session, t] of turns) {
		if (now - t.at <= STALE_MS) break;
		turns.delete(session);
	}
}

// what's kept, for the tests
export function kept(): number {
	return turns.size;
}

// ---- the handler ----

export default async function ({ event, state, config }: Input) {
	const session = state.session.id;
	if (event === "on_session_end") {
		turns.delete(session);
		return;
	}
	if (event === "before_reply") {
		const now = Date.now();
		forget(now);
		// a new turn: whatever an earlier one decided is no longer wanted
		const t: Turn = { turn: state.turn, beat: null, staged: false, at: now };
		turns.delete(session);
		turns.set(session, t);
		// a gate before it has cancelled the turn: there's no reply to start
		if (state.cancel === true || !inputText(state).trim()) return;
		const c = resolve(config);
		const key = process.env[c.keyEnv];
		if (!key) throw new Error(`${c.keyEnv} isn't set`);
		const name = typeof state.character?.name === "string" ? cut(state.character.name, MAX_NAME) : "";
		const answers = await ask(c, key, { model: c.model, state: situation(state, c), questions: questions(c, name) });
		const j = judgement(answers, c);
		if (!j) throw new Error("the judge's answer is missing the reaction or how much it moved the character");
		// too late: the first sentence went out without it, or a newer turn began
		if (turns.get(session) !== t || t.staged) return;
		t.beat = decide(j, c);
		return;
	}
	if (event === "on_sentence") {
		const t = turns.get(session);
		// only the reply's first sentence, of the turn that was judged
		if (!t || t.turn !== state.turn || t.staged) return;
		t.staged = true;
		if (!t.beat) return;
		return { state: { ...state, beats: [...(state.beats ?? []), { ...t.beat }] } };
	}
}

// What `npm run check` and `npm start` ask before a call. A config the
// extension can't use is an error. A word the character has nothing for
// (`body`) is a warning: on stage it would only do nothing.
interface Body {
	emotions: string[] | null;
	gestures: string[] | null;
}

export function check({ config, body }: { config: unknown; body: Body }) {
	const r = read(config);
	if ("errors" in r) return { errors: r.errors };
	const c = r.c;
	const warnings: string[] = [];
	const asked = isMap(config) && isMap(config.model) ? config.model.timeout_ms : undefined;
	if (typeof asked === "number" && asked > MAX_TIMEOUT_MS)
		warnings.push(`\`model.timeout_ms\` is cut to ${MAX_TIMEOUT_MS}: the hook gives up at 1500 ms, and the reply's first sentence waits for it`);
	const unknown = (what: string, words: string[], have: string[] | null, where: string) => {
		if (!have) return;
		const missing = [...new Set(words.filter((w) => w && !have.includes(w)))];
		if (missing.length) warnings.push(`${what} ${missing.map((w) => `"${w}"`).join(", ")} ${missing.length > 1 ? "aren't" : "isn't"} in ${where}`);
	};
	const emotions = [...[...c.beat.values(), ...c.settle.values()].map((o) => o.emotion), c.laugh];
	unknown("emotion", emotions, body.emotions, "the player's emotion set");
	unknown("gesture", [...c.gestures.keys()], body.gestures, "the character's gestures");
	return { errors: [], warnings };
}
