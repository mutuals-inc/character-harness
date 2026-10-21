// What the memory asks Jev about one user message, and what it does with the
// answers. Jev only judges: it scores whether the message is worth keeping and
// picks among options this file offers, by key. Every threshold that turns an
// answer into a decision lives here, in code; a prompt that told Jev to be
// strict would drag every answer in the request down with it.

import type { Answer, Question } from "./jev.ts";
import { KINDS, current, evict, idNumber, tidy, type Kind, type Memory, type Store } from "./store.ts";

export interface Thresholds {
	need: number; // the probability that a friend would be expected to remember it, at least
	cost: number; // how much forgetting it costs, 0..1, at least
	about_user: number; // the most likely "about the user" level, at least
	out_of_date: number; // how sure Jev must be that a memory stopped being true
	recall: number; // how sure Jev must be of what the message brings back
}

// What one request asked, to read its answers against.
export interface Plan {
	spans: Record<string, string>; // c0.. -> the user's exact words
	options: string[]; // memory ids offered for parent, out_of_date and recall
	questions: Record<string, Question>;
	state: Record<string, unknown>;
}

// --- the user's words ---

// The longest message cut into pieces; a longer one isn't judged at all (see
// index.ts), and this keeps the cutting cheap whatever it's given.
export const MAX_MESSAGE = 2000;

const SENTENCE_END = ".!?;";
const CONJUNCTIONS = ["and", "but", "so", "because"];
const PUNCT = " \t\n\r\f\v,.!?;:—-";
const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v" || /\s/.test(ch);
const isPunct = (ch: string) => PUNCT.includes(ch) || isSpace(ch);

// Where sentences end in text[from, to): a run of . ! ? ; followed by a space
// or the end. One pass, no regular expression, so a long run of dots or
// spaces costs no more than its length.
function sentenceBreaks(text: string, from: number, to: number): [number, number][] {
	const out: [number, number][] = [];
	let i = from;
	while (i < to) {
		if (!SENTENCE_END.includes(text[i])) {
			i++;
			continue;
		}
		let j = i;
		while (j < to && SENTENCE_END.includes(text[j])) j++;
		if (j === to || isSpace(text[j])) out.push([i, j]);
		i = j;
	}
	return out;
}

// Where clauses end in text[from, to): a comma followed by a space or the
// end, or one of CONJUNCTIONS between spaces. Each run of spaces is read once.
function clauseBreaks(text: string, from: number, to: number): [number, number][] {
	const out: [number, number][] = [];
	let i = from;
	while (i < to) {
		const ch = text[i];
		if (ch === "," && (i + 1 === to || isSpace(text[i + 1]))) {
			out.push([i, i + 1]);
			i++;
			continue;
		}
		if (!isSpace(ch)) {
			i++;
			continue;
		}
		let j = i;
		while (j < to && isSpace(text[j])) j++;
		let matched = false;
		for (const w of CONJUNCTIONS) {
			const end = j + w.length;
			if (end < to && text.slice(j, end).toLowerCase() === w && isSpace(text[end])) {
				let k = end;
				while (k < to && isSpace(text[k])) k++;
				out.push([i, k]);
				i = k;
				matched = true;
				break;
			}
		}
		if (!matched) i = j;
	}
	return out;
}

// [start, end) ranges of text[from, to) between the breaks, trimmed of spaces
// and punctuation, so each is still exactly a piece of the text
function between(text: string, from: number, to: number, breaks: [number, number][]): [number, number][] {
	const out: [number, number][] = [];
	let at = from;
	for (const [a, b] of [...breaks, [to, to] as [number, number]]) {
		let s = at;
		let e = a;
		while (s < e && isPunct(text[s])) s++;
		while (e > s && isPunct(text[e - 1])) e--;
		if (e > s) out.push([s, e]);
		at = b;
	}
	return out;
}

// the piece without what trails it, to tell "do you like jazz?" and "do you
// like jazz" apart as one option
function bare(s: string): string {
	let e = s.length;
	while (e > 0 && isPunct(s[e - 1])) e--;
	return s.slice(0, e).toLowerCase();
}

// The pieces of a message a memory could be, in the user's own words: the
// whole message first, then up to `max` of its sentences and clauses, the
// longest ones, listed in the order they were said. Pieces under `minChars`
// or over `maxChars`, or of a single word, aren't offered.
export function spans(message: string, max = 6, minChars = 12, maxChars = 400): string[] {
	const text = message.slice(0, MAX_MESSAGE).trim();
	const ok = (s: string) => s.length >= minChars && s.length <= maxChars && /\s/.test(s);
	const pieces: [number, number][] = [];
	for (const [a, b] of between(text, 0, text.length, sentenceBreaks(text, 0, text.length))) {
		pieces.push([a, b]);
		for (const c of between(text, a, b, clauseBreaks(text, a, b))) pieces.push(c);
	}
	// the same words twice would split Jev's answer between them
	const seen = new Set<string>([bare(text)]);
	const found: { at: number; s: string }[] = [];
	for (const [a, b] of pieces) {
		const s = text.slice(a, b);
		if (!ok(s) || seen.has(bare(s))) continue;
		seen.add(bare(s));
		found.push({ at: a, s });
	}
	const chosen = found
		.sort((x, y) => y.s.length - x.s.length)
		.slice(0, max)
		.sort((x, y) => x.at - y.at || y.s.length - x.s.length)
		.map((f) => f.s);
	return ok(text) ? [text, ...chosen] : chosen;
}

// --- the request ---

const KIND_HINTS: Record<Kind, string> = {
	fact: "Something true about the user's life as it is now: where they live, their work, their health, their home and pets, their routines, what happened to them.",
	date: "An event on a day or time that matters to them: a birthday, a wedding, an anniversary, a deadline, a trip.",
	person: "Someone in their life: who that person is to them, or what is going on with them.",
	preference: "What they like, dislike, want or care about.",
	plan: "Something the user means to do, or promised to do, and hasn't done yet.",
	boundary: "Something they ask the character not to do: a topic to stay away from, or a way not to treat or call them.",
	feeling: "How they feel about something in their life, or what they are going through.",
};

// Up to `max` memories to show Jev: the newest, the ones costliest to forget,
// and the roots of the tree. Out-of-date ones come along only as the newest,
// so Jev sees what changed recently.
export function shortlist(store: Store, max: number): Memory[] {
	const picked = new Map<string, Memory>();
	const add = (list: Memory[], n: number) => {
		for (const m of list) {
			if (picked.size >= max || n <= 0) return;
			if (!picked.has(m.id)) {
				picked.set(m.id, m);
				n--;
			}
		}
	};
	const newest = [...store.memories].sort((a, b) => idNumber(b.id) - idNumber(a.id));
	const live = newest.filter(current);
	const third = Math.ceil(max / 3);
	add(newest, third);
	add([...live].sort((a, b) => b.cost - a.cost), third);
	add(live.filter((m) => m.parent === null), max);
	add(live, max);
	return [...picked.values()].sort((a, b) => idNumber(a.id) - idNumber(b.id));
}

// One request with every question about this message. `spanList` empty means
// the message has nothing to keep, so only the questions about what the
// character already knows are asked.
export function plan(
	who: { name: string; description?: string },
	message: string,
	recent: { role: string; content: string }[],
	store: Store,
	spanList: string[],
	max: number,
): Plan | null {
	const listed = shortlist(store, max);
	const byId = new Map(store.memories.map((m) => [m.id, m]));
	const live = listed.filter(current);
	const said = (m: Memory) => {
		const parent = m.parent ? byId.get(m.parent) : undefined;
		return parent ? `${m.text} (a detail of: ${parent.text})` : m.text;
	};
	const questions: Record<string, Question> = {};
	const spansById: Record<string, string> = {};
	spanList.forEach((s, i) => (spansById[`c${i}`] = s));

	if (spanList.length) {
		questions.about_user = {
			type: "score",
			instructions: "Is the user's last message about the user themselves?",
			criteria: [
				"No: it is about the world, the weather, the news, small talk, or a question for the character.",
				"Partly: it touches the user's own life in passing.",
				"Yes: it is about the user's life, the people in it, their plans, tastes, limits or feelings.",
			],
		};
		questions.need = {
			type: "score",
			instructions: "If the user talked to the character again next week, how much would they expect her to remember what they just said?",
			criteria: [
				"Not at all: nothing in it would matter later.",
				"Hardly: a passing detail of their day, like a meal, an errand or the weather; nobody would expect her to remember it.",
				"Yes: a friend would be expected to remember this next week.",
				"Very much: a friend would be expected to remember this for months.",
			],
		};
		questions.cost = {
			type: "score",
			instructions: "If the character later forgot what the user just said, how would that feel to the user?",
			criteria: [
				"It wouldn't matter at all.",
				"They wouldn't notice.",
				"A little awkward.",
				"They would feel she hadn't been listening.",
				"It would hurt: it matters to them, or they asked her to keep it in mind.",
			],
		};
		questions.span = {
			type: "choice",
			instructions: "Which part of the user's last message holds everything worth remembering about them? Leave out only what adds nothing to it.",
			criteria: spansById,
		};
		questions.kind = {
			type: "choice",
			instructions: "What kind of thing does the user's last message say about them?",
			criteria: { ...KIND_HINTS },
		};
	}
	if (live.length) {
		const options = (none: string) => ({ none, ...Object.fromEntries(live.map((m) => [m.id, said(m)])) });
		if (spanList.length)
			questions.parent = {
				type: "choice",
				instructions: "Which memory is the user's last message a detail of?",
				criteria: options("None of them: it is its own topic."),
			};
		questions.out_of_date = {
			type: "choice",
			instructions: "After the user's last message, which of these memories has stopped being true?",
			criteria: options("None: all of them still hold."),
		};
		questions.recall = {
			type: "choice",
			instructions: "Which memory does the user's last message bring to mind?",
			criteria: options("None of them."),
		};
	}
	if (!Object.keys(questions).length) return null;
	const state: Record<string, unknown> = {
		character: who,
		conversation: recent,
		user_message: message,
		memories: listed.map((m) => {
			const parent = m.parent ? byId.get(m.parent) : undefined;
			return {
				id: m.id,
				text: `${m.out_of_date ? "(no longer true) " : ""}${m.text}`,
				kind: m.kind,
				...(parent ? { detail_of: parent.text } : {}),
			};
		}),
	};
	return { spans: spansById, options: live.map((m) => m.id), questions, state };
}

// --- the answers ---

export interface Decision {
	keep?: { text: string; kind: Kind; parent: string | null; need: number; cost: number };
	out_of_date?: { id: string; p: number };
	recall?: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// Jev leans towards the shortest piece that names the topic ("I'm the maid of
// honour" over "...so I have to write a speech"). A wider piece that holds the
// chosen one and still gets this much of its vote is kept instead, so a memory
// doesn't lose half of what was said.
const WIDER = 0.3;

// a probability as the memory uses it: a number from 0 to 1, whatever came back
const unit = (v: unknown) => (isNum(v) ? Math.min(1, Math.max(0, v)) : 0);

function words(p: Plan, a: Answer, key: string): string {
	let best = key;
	for (const [k, s] of Object.entries(p.spans)) {
		if (unit(a.probabilities[k]) >= WIDER && s.length > p.spans[best].length && s.includes(p.spans[key])) best = k;
	}
	return p.spans[best];
}

function chosen(a: Answer | undefined, keys: string[]): { key: string; p: number } {
	const p = a?.probabilities;
	if (!p || typeof p !== "object" || typeof a?.choice !== "string" || !keys.includes(a.choice)) throw new Error("its choice isn't one of the options");
	return { key: a.choice, p: unit(p[a.choice] ?? a.confidence) };
}

// a score's level probabilities, "0".."n-1", each read as 0..1 and summing to 1
function levels(a: Answer | undefined, n: number): number[] {
	const p = a?.probabilities;
	if (!p || typeof p !== "object") throw new Error("a score has no probabilities");
	const raw = Array.from({ length: n }, (_, i) => unit(p[String(i)]));
	const sum = raw.reduce((s, v) => s + v, 0);
	if (!(sum > 0)) throw new Error("a score has no levels");
	return raw.map((v) => v / sum);
}

// What the answers decide, by the thresholds. Throws when an answer to a
// question that was asked is missing or isn't one of the options, so a
// malformed answer changes nothing.
export function decide(p: Plan, answers: Record<string, Answer>, t: Thresholds): Decision {
	const d: Decision = {};
	const q = p.questions;
	const memoryKeys = ["none", ...p.options];
	if (q.out_of_date) {
		const c = chosen(answers.out_of_date, memoryKeys);
		if (c.key !== "none" && c.p >= t.out_of_date) d.out_of_date = { id: c.key, p: c.p };
	}
	if (q.recall) {
		const c = chosen(answers.recall, memoryKeys);
		if (c.key !== "none" && c.p >= t.recall) d.recall = c.key;
	}
	if (q.span) {
		const about = levels(answers.about_user, 3);
		const need = levels(answers.need, 4);
		const cost = levels(answers.cost, 5);
		const span = chosen(answers.span, Object.keys(p.spans));
		const kind = chosen(answers.kind, [...KINDS]);
		const parent = q.parent ? chosen(answers.parent, memoryKeys).key : "none";
		const top = about.indexOf(Math.max(...about));
		const needed = unit(need[2] + need[3]);
		// the level weighted by its probabilities, as a share of the top level
		const costly = unit(cost.reduce((s, v, i) => s + v * i, 0) / (cost.length - 1));
		if (top >= t.about_user && needed >= t.need && costly >= t.cost)
			d.keep = { text: words(p, answers.span!, span.key), kind: kind.key as Kind, parent: parent === "none" ? null : parent, need: needed, cost: costly };
	}
	return d;
}

// --- the store ---

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

// Applies a decision to the store. Memories named by the answers may have
// changed since the request was sent (another session, an eviction), so each
// is looked up again and skipped if it's gone. Returns whether anything
// changed.
export function apply(store: Store, d: Decision, max: number, now = new Date()): boolean {
	const at = now.toISOString();
	const byId = new Map(store.memories.map((m) => [m.id, m]));
	const stale = d.out_of_date ? byId.get(d.out_of_date.id) : undefined;
	const target = stale && current(stale) ? stale : undefined;
	let changed = false;
	let added: Memory | undefined;

	if (d.keep) {
		const dup = store.memories.find((m) => same(m.text, d.keep!.text));
		if (dup) {
			// said again: it's fresh, and true again if it had gone out of date
			dup.seen_at = at;
			dup.need = Math.max(dup.need, d.keep.need);
			dup.cost = Math.max(dup.cost, d.keep.cost);
			if (dup !== target) delete dup.out_of_date;
			changed = true;
		} else {
			let parent = d.keep.parent !== null ? byId.get(d.keep.parent) : undefined;
			if (parent && !current(parent)) parent = undefined;
			// what replaces a memory hangs where it hung, not under it
			if (target && (!parent || parent === target)) parent = target.parent !== null ? byId.get(target.parent) : undefined;
			added = {
				id: `m${store.next_id++}`,
				text: d.keep.text,
				kind: d.keep.kind,
				parent: parent && current(parent) ? parent.id : null,
				created_at: at,
				seen_at: at,
				need: d.keep.need,
				cost: d.keep.cost,
			};
			if (target) {
				added.replaces = target.id;
				// what was a detail of the old memory is a detail of the new one,
				// unless that would hang the new one under itself
				const above = new Set<string>();
				for (let p = added.parent; p !== null; p = byId.get(p)?.parent ?? null) above.add(p);
				for (const m of store.memories) if (m.parent === target.id && current(m) && !above.has(m.id)) m.parent = added.id;
			}
			store.memories.push(added);
			changed = true;
		}
	}
	if (target && d.out_of_date) {
		target.out_of_date = { p: d.out_of_date.p, at, ...(added ? { by: added.id } : {}) };
		changed = true;
	}
	if (changed) {
		tidy(store);
		evict(store, max, added?.id);
	}
	return changed;
}

// The path from a memory up to its root, current memories only, root first.
export function pathTo(store: Store, id: string): string[] {
	const byId = new Map(store.memories.map((m) => [m.id, m]));
	const out: string[] = [];
	const seen = new Set<string>();
	const start = byId.get(id);
	if (!start || !current(start)) return out;
	for (let m: Memory | undefined = start; m && !seen.has(m.id); m = m.parent ? byId.get(m.parent) : undefined) {
		seen.add(m.id);
		if (current(m)) out.unshift(m.id);
	}
	return out;
}
