// Turns the character starts itself. An extension's service offers a line of
// input ("@ana asked in chat: …", "nothing has happened for a while"); the
// runtime holds it until the player says its voice is free, hands it over, and
// the player either takes it as the user's next turn or refuses it.
// docs/protocol.md, "The offers link", is the wire.
//
//   app -> runtime   {t:"status", voice, epoch}   {t:"ack", id, accepted}
//   runtime -> app   {t:"offer", id, epoch, text}
//
// The player is the only one that knows whether anyone is speaking, so it has
// the last word: it refuses an offer unless its voice is idle and the offer
// carries the epoch it last reported. Every time the voice leaves idle the
// epoch moves on, so an offer decided before someone spoke can't land after.

export type VoiceState = "offline" | "idle" | "listening" | "thinking" | "speaking";
const VOICE_STATES: readonly VoiceState[] = ["offline", "idle", "listening", "thinking", "speaking"];

export interface OfferRequest {
	text: string;
	source?: string; // the turn's `input.channel`; "offer" when not given
	ttl_ms?: number; // how long it may wait for the voice to be free
	quiet_ms?: number; // how long the voice must have been idle first
	priority?: number; // higher goes first; then the oldest
}

// accepted: the player took it as a turn. expired: its ttl ran out first.
// closed: the session ended first.
export type OfferOutcome = "accepted" | "expired" | "closed";

export const OFFER_TTL_MS = 10_000;
export const OFFER_QUIET_MS = 2000;
export const OFFER_TEXT_MAX = 4000;
// how long the player has to answer an offer before it goes back in the queue
export const OFFER_ACK_MS = 2000;
// after an accepted offer, how long the voice may stay idle before the runtime
// gives up waiting for its turn to start and offers again
const CLAIM_MS = 5000;
// how long an accepted offer waits for its `llm` to name it
const ACCEPTED_KEEP_MS = 30_000;

// The player's end of the link, shared by every session: the player keeps one
// link open, while its session socket may come and go.
export interface LinkHub {
	isOpen(): boolean;
	send(obj: unknown): boolean;
	nextId(): number;
	subscribe(fn: (msg: Record<string, unknown> | "open" | "closed") => void): () => void;
}

// What the turn that an accepted offer became should say about itself.
export interface Accepted {
	text: string;
	source: string;
	by: string; // the extension that offered it
	at: number;
}

interface Pending {
	req: Required<Omit<OfferRequest, "source">> & { source: string };
	by: string;
	at: number;
	done: (o: OfferOutcome) => void;
	id?: number; // set while it waits for the player's ack
}

export function checkOffer(req: OfferRequest): void {
	if (!req || typeof req.text !== "string" || !req.text.trim()) throw new Error("an offer needs some `text`");
	if (req.text.length > OFFER_TEXT_MAX) throw new Error(`an offer's text is at most ${OFFER_TEXT_MAX} characters`);
	if (req.source !== undefined && (typeof req.source !== "string" || !/^[a-z][a-z0-9_-]*$/.test(req.source)))
		throw new Error("an offer's `source` is a lowercase word, like chat or screen");
	for (const k of ["ttl_ms", "quiet_ms", "priority"] as const)
		if (req[k] !== undefined && !Number.isFinite(req[k])) throw new Error(`an offer's \`${k}\` must be a number`);
}

// One session's offers, and what it knows of the player's voice.
export class Offers {
	voice: VoiceState = "offline";
	since = Date.now(); // when `voice` last changed
	private epoch = 0;
	private queue: Pending[] = [];
	private inFlight: Pending | null = null;
	private ackTimer: ReturnType<typeof setTimeout> | undefined;
	private wake: ReturnType<typeof setTimeout> | undefined;
	// an accepted offer whose turn has not started: nothing else goes out
	private claimed = 0;
	// the player refused an offer: what it knows has moved on, so nothing goes
	// out again until its next status says what
	private stale = false;
	private accepted: Accepted[] = [];
	private listeners = new Set<(v: VoiceState) => void>();
	private unsubscribe: () => void;
	private closed = false;
	private hub: LinkHub | undefined;
	private log: (line: string) => void;

	constructor(hub: LinkHub | undefined, log: (line: string) => void) {
		this.hub = hub;
		this.log = log;
		this.unsubscribe = hub ? hub.subscribe((m) => this.onLink(m)) : () => {};
	}

	onVoice(fn: (v: VoiceState) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	offer(req: OfferRequest, by: string): Promise<OfferOutcome> {
		checkOffer(req);
		if (this.closed) return Promise.resolve("closed");
		return new Promise((done) => {
			this.queue.push({
				req: {
					text: req.text.trim(),
					source: req.source ?? "offer",
					ttl_ms: req.ttl_ms ?? OFFER_TTL_MS,
					quiet_ms: req.quiet_ms ?? OFFER_QUIET_MS,
					priority: req.priority ?? 0,
				},
				by,
				at: Date.now(),
				done,
			});
			this.pump();
		});
	}

	// The accepted offer an `llm` turn came from, if its user line is one: the
	// player sends the offer's text back as the user's turn.
	take(lastUser: string): Accepted | undefined {
		const now = Date.now();
		this.accepted = this.accepted.filter((a) => now - a.at < ACCEPTED_KEEP_MS);
		const i = this.accepted.findIndex((a) => a.text === lastUser.trim());
		if (i < 0) return undefined;
		return this.accepted.splice(i, 1)[0];
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		clearTimeout(this.ackTimer);
		clearTimeout(this.wake);
		const all = [...this.queue, ...(this.inFlight ? [this.inFlight] : [])];
		this.queue = [];
		this.inFlight = null;
		for (const p of all) p.done("closed");
		this.listeners.clear();
	}

	private setVoice(v: VoiceState): void {
		if (v === this.voice) return;
		this.voice = v;
		this.since = Date.now();
		// the offer's turn has started; once it is over, offers may go out again
		if (v !== "idle") this.claimed = 0;
		for (const fn of [...this.listeners]) {
			try {
				fn(v);
			} catch (e) {
				this.log(`[offers] a voice listener failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	private onLink(m: Record<string, unknown> | "open" | "closed"): void {
		if (this.closed) return;
		if (m === "open") return;
		if (m === "closed") {
			this.requeue();
			this.setVoice("offline");
			return;
		}
		if (m.t === "status") {
			if (typeof m.voice !== "string" || !VOICE_STATES.includes(m.voice as VoiceState)) return;
			if (Number.isSafeInteger(m.epoch)) this.epoch = m.epoch as number;
			this.stale = false;
			this.setVoice(m.voice as VoiceState);
			this.pump();
			return;
		}
		if (m.t === "ack" && this.inFlight && m.id === this.inFlight.id) {
			const p = this.inFlight;
			this.inFlight = null;
			clearTimeout(this.ackTimer);
			if (m.accepted === true) {
				this.log(`[offers] ${p.by}: accepted "${p.req.text.slice(0, 60)}"`);
				this.claimed = Date.now();
				this.accepted.push({ text: p.req.text, source: p.req.source, by: p.by, at: Date.now() });
				p.done("accepted");
			} else {
				// refused: someone spoke first. It waits for the next quiet moment.
				p.id = undefined;
				this.stale = true;
				this.queue.push(p);
			}
			this.pump();
		}
	}

	private requeue(): void {
		clearTimeout(this.ackTimer);
		if (!this.inFlight) return;
		this.inFlight.id = undefined;
		this.queue.push(this.inFlight);
		this.inFlight = null;
	}

	// Hands the best offer that may go now to the player, and sets a timer for
	// the next moment something changes: an offer expiring, or the voice having
	// been quiet long enough for one.
	private pump(): void {
		if (this.closed) return;
		clearTimeout(this.wake);
		const now = Date.now();
		this.queue = this.queue.filter((p) => {
			if (now - p.at < p.req.ttl_ms) return true;
			this.log(`[offers] ${p.by}: expired "${p.req.text.slice(0, 60)}"`);
			p.done("expired");
			return false;
		});
		if (!this.queue.length) return;
		let next = Math.min(...this.queue.map((p) => p.at + p.req.ttl_ms - now));
		const free = this.voice === "idle" && !this.inFlight && !this.stale && this.hub?.isOpen() === true;
		const claimLeft = this.claimed ? this.claimed + CLAIM_MS - now : 0;
		if (free && claimLeft > 0) next = Math.min(next, claimLeft);
		if (free && claimLeft <= 0) {
			this.claimed = 0;
			const quiet = now - this.since;
			const ready = this.queue.filter((p) => quiet >= p.req.quiet_ms);
			if (ready.length) {
				const best = ready.reduce((a, b) =>
					b.req.priority > a.req.priority || (b.req.priority === a.req.priority && b.at < a.at) ? b : a,
				);
				this.queue.splice(this.queue.indexOf(best), 1);
				this.send(best);
				return;
			}
			next = Math.min(next, ...this.queue.map((p) => p.req.quiet_ms - quiet));
		}
		this.wake = setTimeout(() => this.pump(), Math.max(1, next));
	}

	private send(p: Pending): void {
		const id = this.hub!.nextId();
		p.id = id;
		this.inFlight = p;
		if (!this.hub!.send({ t: "offer", id, epoch: this.epoch, text: p.req.text })) {
			this.requeue();
			return;
		}
		this.ackTimer = setTimeout(() => {
			this.log(`[offers] the player did not answer offer ${id}; it waits again`);
			this.requeue();
			this.pump();
		}, OFFER_ACK_MS);
	}
}
