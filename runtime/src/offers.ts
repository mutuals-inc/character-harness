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
	signal?: AbortSignal; // withdraws the offer when aborted, unless the player has taken it
}

// accepted: the player took it as a turn. expired: its ttl ran out first.
// withdrawn: its `signal` was aborted first. closed: the session ended first.
export type OfferOutcome = "accepted" | "expired" | "withdrawn" | "closed";

export const OFFER_TTL_MS = 10_000;
export const OFFER_QUIET_MS = 2000;
export const OFFER_TEXT_MAX = 4000;
// the longest an offer may wait, or ask the voice to be quiet: a day
export const OFFER_WAIT_MAX_MS = 86_400_000;
// how long the player has to answer an offer before it counts as refused
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
	// `fn` hears every message from the player; it is told the last status at
	// once, so a session that starts while the link is up knows the voice
	subscribe(fn: (msg: LinkMessage) => void): () => void;
}
export type LinkMessage = Record<string, unknown> | "open" | "closed";

// The minimum of a WebSocket the link uses, so tests can hand it a fake one.
interface LinkSocket {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	on(event: "message", fn: (data: unknown, isBinary: boolean) => void): unknown;
	on(event: "close" | "error", fn: () => void): unknown;
}
const OPEN = 1; // WebSocket.OPEN

// The runtime's end of the link. One at a time: a newer one replaces the old.
export class LinkServer implements LinkHub {
	private link: LinkSocket | null = null;
	private ids = 0;
	private last: Record<string, unknown> | null = null;
	private listeners = new Set<(m: LinkMessage) => void>();

	attach(ws: LinkSocket): void {
		if (this.link) this.link.close(1000, "replaced by a newer link");
		this.link = ws;
		this.last = null;
		this.tell("open");
		ws.on("message", (data, isBinary) => {
			if (isBinary || this.link !== ws) return;
			let msg: unknown;
			try {
				msg = JSON.parse(String(data));
			} catch {
				return; // not JSON: not for us
			}
			if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
			const m = msg as Record<string, unknown>;
			if (m.t === "status") this.last = m;
			this.tell(m);
		});
		ws.on("close", () => {
			if (this.link !== ws) return;
			this.link = null;
			this.last = null;
			this.tell("closed");
		});
		ws.on("error", () => ws.close());
	}

	isOpen(): boolean {
		return this.link?.readyState === OPEN;
	}
	send(obj: unknown): boolean {
		if (!this.link || this.link.readyState !== OPEN) return false;
		this.link.send(JSON.stringify(obj));
		return true;
	}
	nextId(): number {
		return ++this.ids;
	}
	subscribe(fn: (m: LinkMessage) => void): () => void {
		this.listeners.add(fn);
		if (this.last) fn(this.last);
		return () => { this.listeners.delete(fn); };
	}
	private tell(m: LinkMessage): void {
		for (const fn of [...this.listeners]) fn(m);
	}
}

// What the turn that an accepted offer became should say about itself.
export interface Accepted {
	text: string;
	source: string;
	by: string; // the extension that offered it
	at: number;
}

interface Pending {
	req: Required<Omit<OfferRequest, "source" | "signal">> & { source: string };
	by: string;
	at: number;
	done: (o: OfferOutcome) => void;
	ids: number[]; // every id it went out under: a late ack names an old one
	epoch: number; // the epoch it last went out with
	withdrawn?: boolean; // withdrawn while the player had it: unless it takes it, it is over
}

// control characters other than a newline or a tab
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

// The text of the turn that hands the model a pending call's result. A result
// a tool hands back at once goes to the model as it is; this one goes to the
// player as an offer, so it is made to fit one rather than refused: a `\r`
// becomes a newline, any other control character a space, and a result too
// long for an offer is cut short, saying so.
export function pendingResultText(name: string, content: string): string {
	const head = `The result of ${name}: `;
	const clean = String(content)
		.replace(/\r\n?/g, "\n")
		.replace(new RegExp(CONTROL.source, "g"), " ");
	const cut = " … (cut short)";
	const room = OFFER_TEXT_MAX - head.length;
	return head + (clean.length > room ? clean.slice(0, Math.max(0, room - cut.length)) + cut : clean);
}

export function checkOffer(req: OfferRequest): void {
	if (!req || typeof req.text !== "string" || !req.text.trim()) throw new Error("an offer needs some `text`");
	if (req.text.length > OFFER_TEXT_MAX) throw new Error(`an offer's text is at most ${OFFER_TEXT_MAX} characters`);
	if (CONTROL.test(req.text)) throw new Error("an offer's text may not have control characters other than newlines and tabs");
	if (req.source !== undefined && (typeof req.source !== "string" || !/^[a-z][a-z0-9_-]*$/.test(req.source)))
		throw new Error("an offer's `source` is a lowercase word, like chat or screen");
	if (req.priority !== undefined && !Number.isFinite(req.priority)) throw new Error("an offer's `priority` must be a number");
	if (req.signal !== undefined && !(req.signal instanceof AbortSignal)) throw new Error("an offer's `signal` must be an AbortSignal");
	for (const k of ["ttl_ms", "quiet_ms"] as const) {
		const v = req[k];
		if (v !== undefined && (typeof v !== "number" || !(v >= 0 && v <= OFFER_WAIT_MAX_MS)))
			throw new Error(`an offer's \`${k}\` must be a number of milliseconds from 0 to ${OFFER_WAIT_MAX_MS}`);
	}
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
	// the player refused an offer, or never answered, while nothing newer was
	// known: nothing goes out again until its next status says what changed
	private stale = false;
	private accepted: Accepted[] = [];
	private listeners = new Set<(v: VoiceState) => void>();
	private unsubscribe: () => void = () => {};
	private closed = false;
	private hub: LinkHub | undefined;
	private log: (line: string) => void;

	constructor(hub: LinkHub | undefined, log: (line: string) => void) {
		this.hub = hub;
		this.log = log;
		if (hub) this.unsubscribe = hub.subscribe((m) => this.onLink(m));
	}

	onVoice(fn: (v: VoiceState) => void): () => void {
		this.listeners.add(fn);
		return () => { this.listeners.delete(fn); };
	}

	offer(req: OfferRequest, by: string): Promise<OfferOutcome> {
		checkOffer(req);
		if (this.closed) return Promise.resolve("closed");
		if (req.signal?.aborted) return Promise.resolve("withdrawn");
		return new Promise((resolve) => {
			const signal = req.signal;
			const done = (o: OfferOutcome) => {
				signal?.removeEventListener("abort", withdraw);
				resolve(o);
			};
			const withdraw = () => this.withdraw(p);
			const p: Pending = {
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
				ids: [],
				epoch: 0,
			};
			signal?.addEventListener("abort", withdraw, { once: true });
			this.queue.push(p);
			this.pump();
		});
	}

	// The accepted offer an `llm` turn came from, if its user line is one: the
	// player sends the offer's text back as the user's turn. An offer still
	// waiting with that text was taken too, its ack lost on a link that dropped.
	take(lastUser: string): Accepted | undefined {
		const text = lastUser.trim();
		const now = Date.now();
		this.accepted = this.accepted.filter((a) => now - a.at < ACCEPTED_KEEP_MS);
		const i = this.accepted.findIndex((a) => a.text === text);
		if (i >= 0) return this.accepted.splice(i, 1)[0];
		const waiting = [...(this.inFlight ? [this.inFlight] : []), ...this.queue].find((p) => p.ids.length && p.req.text === text);
		if (!waiting) return undefined;
		this.settle(waiting);
		return this.accepted.pop();
	}

	// An offer still in the queue leaves it. One the player has may still be
	// taken; if it is refused or never answered, it is over.
	private withdraw(p: Pending): void {
		if (this.closed) return;
		const i = this.queue.indexOf(p);
		if (i >= 0) {
			this.queue.splice(i, 1);
			this.log(`[offers] ${p.by}: withdrew "${p.req.text.slice(0, 60)}"`);
			p.done("withdrawn");
			this.pump();
		} else if (p === this.inFlight) {
			p.withdrawn = true;
		}
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
		const failed = (e: unknown) =>
			this.log(`[offers] a voice listener failed: ${e instanceof Error ? e.message : String(e)}`);
		for (const fn of [...this.listeners]) {
			try {
				const r: unknown = fn(v);
				if (r instanceof Promise) r.catch(failed);
			} catch (e) {
				failed(e);
			}
		}
	}

	// The player took `p`: it leaves the queue and waits for its turn.
	private settle(p: Pending): void {
		if (p === this.inFlight) {
			this.inFlight = null;
			clearTimeout(this.ackTimer);
		} else {
			const i = this.queue.indexOf(p);
			if (i >= 0) this.queue.splice(i, 1);
		}
		this.log(`[offers] ${p.by}: accepted "${p.req.text.slice(0, 60)}"`);
		this.claimed = Date.now();
		this.accepted.push({ text: p.req.text, source: p.req.source, by: p.by, at: Date.now() });
		p.done("accepted");
	}

	private onLink(m: LinkMessage): void {
		if (this.closed) return;
		if (m === "open") return;
		if (m === "closed") {
			this.requeue();
			this.setVoice("offline");
			this.pump();
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
		if (m.t !== "ack" || !Number.isSafeInteger(m.id)) return;
		const id = m.id as number;
		const p = [...(this.inFlight ? [this.inFlight] : []), ...this.queue].find((q) => q.ids.includes(id));
		if (!p) return;
		if (m.accepted === true) {
			// even an ack that came after its time: the player took it
			this.settle(p);
		} else if (p === this.inFlight && id === p.ids[p.ids.length - 1]) {
			// refused: someone spoke first. It waits for the next quiet moment,
			// and for a status after the one the refusal was decided against.
			this.requeue();
			if (this.epoch === p.epoch) this.stale = true;
		} else {
			return; // a refusal of an older send changes nothing
		}
		this.pump();
	}

	private requeue(): void {
		clearTimeout(this.ackTimer);
		const p = this.inFlight;
		if (!p) return;
		this.inFlight = null;
		if (!p.withdrawn) return void this.queue.push(p);
		this.log(`[offers] ${p.by}: withdrew "${p.req.text.slice(0, 60)}"`);
		p.done("withdrawn");
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
				if (this.send(best)) return;
			} else {
				next = Math.min(next, ...this.queue.map((p) => p.req.quiet_ms - quiet));
			}
		}
		this.wake = setTimeout(() => this.pump(), Math.min(Math.max(1, next), OFFER_WAIT_MAX_MS));
	}

	private send(p: Pending): boolean {
		const id = this.hub!.nextId();
		if (!this.hub!.send({ t: "offer", id, epoch: this.epoch, text: p.req.text })) return false;
		this.queue.splice(this.queue.indexOf(p), 1);
		p.ids.push(id);
		p.epoch = this.epoch;
		this.inFlight = p;
		this.ackTimer = setTimeout(() => {
			// no answer counts as a refusal; an `accepted` that comes later still counts
			this.log(`[offers] the player did not answer offer ${id}; it waits again`);
			this.requeue();
			this.stale = true;
			this.pump();
		}, OFFER_ACK_MS);
		return true;
	}
}
