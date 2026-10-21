// Which heard utterances a turn's user line is made of. The app keeps the
// history and sends only text, so the runtime keeps its last few finals and
// finds the ones that end the user's line, oldest first. A line it can't build
// whole from them (typed, edited, an offer) gets none: it never guesses.

import type { HeardFinal } from "./stt.ts";
import type { Utterance } from "./state.ts";

const KEEP = 8;
const KEEP_MS = 60_000;

const norm = (text: string) => text.replace(/\s+/g, " ").trim();

export class Heard {
	private finals: { text: string; start_ms: number; end_ms: number; at: number }[] = [];
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	add(f: HeardFinal): void {
		const text = norm(f.text);
		if (!text) return;
		this.finals.push({ text, start_ms: f.start_ms, end_ms: f.end_ms, at: this.now() });
		if (this.finals.length > KEEP) this.finals.shift();
	}

	// the utterances `line` is made of, or undefined. They stay kept, so the app
	// asking again with the same history gets the same ones.
	match(line: string): Utterance[] | undefined {
		const since = this.now() - KEEP_MS;
		this.finals = this.finals.filter((f) => f.at >= since);
		const whole = norm(line);
		if (!whole) return undefined;
		// the newest final that ends the line, then the ones just before it
		for (let last = this.finals.length - 1; last >= 0; last--) {
			let rest = whole;
			const found: Utterance[] = [];
			for (let i = last; i >= 0; i--) {
				const f = this.finals[i];
				if (rest === f.text) rest = "";
				else if (rest.endsWith(" " + f.text)) rest = rest.slice(0, -(f.text.length + 1));
				else break;
				found.unshift({ text: f.text, start_ms: f.start_ms, end_ms: f.end_ms });
				if (!rest) return found;
			}
		}
		return undefined;
	}
}
