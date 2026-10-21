// Speech to text: the app's mic audio relayed to ElevenLabs Scribe, and its
// transcripts relayed back, in these messages:
//
//   app -> runtime   {t:"stt_start",utterance?} | {t:"stt_eos",utterance?} | {t:"stt_reset"}
//                    binary PCM16 16 kHz mic frames
//   runtime -> app   {t:"stt_partial",text,utterance?} | {t:"stt_final",text,utterance?}
//                    {t:"error",id:0,text:"stt_upstream"}
//
// Without an utterance number one upstream socket is reused across utterances
// and each commit yields a final. With one (stt_start carrying `utterance`),
// each utterance gets its own upstream, auto-committed segments are collected,
// and the first final after the commit carries all of them and closes it.
//
// Each final with words is also handed to `onFinal` with when they were spoken,
// in Unix ms. Scribe times words in seconds from the start of the audio its
// socket got. The mic streams in real time while someone speaks, so within one
// stretch of speech (from a stt_start) a frame's arrival, less the audio before
// it, is when that audio started. A frame can arrive late but never early, so a
// stretch keeps the earliest of these. Audio isn't sent between stretches, so a
// final is timed by the stretch its last word is in.

import WebSocket from "ws";
import type { Stt } from "./manifest.ts";

const MIC_QUEUE_MAX = 256;
// after a failed connect, the next one waits this long, doubling up to the max
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;
const SAMPLES_PER_MS = 16;

export interface HeardFinal {
	text: string;
	start_ms: number;
	end_ms: number;
}

export interface SttOptions {
	onFinal?: (f: HeardFinal) => void;
	now?: () => number;
	url?: string; // for tests: where Scribe is
}

// a stretch of speech: the upstream it went to, where it begins in that
// upstream's audio (samples), and when that audio started (Unix ms)
interface Stretch {
	upstream: number;
	from: number;
	t0: number;
}
const STRETCHES_MAX = 16;

interface Word {
	type?: unknown;
	start?: unknown;
	end?: unknown;
}

// the first word's start and the last word's end, in seconds, or null
export function wordSpan(words: unknown): [number, number] | null {
	if (!Array.isArray(words)) return null;
	let start = Infinity;
	let end = -Infinity;
	for (const w of words as Word[]) {
		if (!w || w.type !== "word" || typeof w.start !== "number" || typeof w.end !== "number") continue;
		if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
		start = Math.min(start, w.start);
		end = Math.max(end, w.end);
	}
	return start <= end ? [start, end] : null;
}

export class SttRelay {
	private readonly url: string;
	private readonly apiKey: string;
	private readonly send: (obj: unknown) => void;
	private readonly onFinal: (f: HeardFinal) => void;
	private readonly now: () => number;
	private sock: WebSocket | null = null;
	private opening = false;
	private closed = false;
	private generation = 0;
	private utterance: number | undefined;
	private commitPending = false;
	// when the last commit went out; the first final after it answers it
	private commitAt: number | null = null;
	private readonly micQueue: { b64: string; samples: number }[] = [];
	// samples sent on the current upstream, and waiting in micQueue for the next
	private sent = 0;
	private queued = 0;
	// upstreams opened so far; audio that waits goes to the next one
	private upstream = 0;
	private stretches: Stretch[] = [];
	private commitUtterance = () => { this.commitPending = true; };
	private retryAt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryMs = RETRY_MIN_MS;

	constructor(stt: Stt, apiKey: string, send: (obj: unknown) => void, opts: SttOptions = {}) {
		this.apiKey = apiKey;
		this.send = send;
		this.onFinal = opts.onFinal ?? (() => {});
		this.now = opts.now ?? Date.now;
		const qs = new URLSearchParams({
			model_id: stt.model,
			audio_format: "pcm_16000",
			commit_strategy: "manual",
			include_timestamps: "true",
		});
		if (stt.language) qs.set("language_code", stt.language);
		for (const k of stt.keyterms) qs.append("keyterms", k);
		this.url = opts.url ?? `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${qs}`;
	}

	start(utterance: unknown): void {
		if (Number.isSafeInteger(utterance) && (utterance as number) > 0) this.reset(utterance as number);
		this.stretches.push({ upstream: this.target(), from: this.isOpen() ? this.sent : this.queued, t0: Infinity });
		if (this.stretches.length > STRETCHES_MAX) this.stretches.shift();
		void this.open();
	}

	endOfSpeech(utterance: unknown): void {
		if (this.utterance !== undefined && utterance !== this.utterance) return;
		// before the upstream is open, the commit waits for it
		this.commitUtterance();
		void this.open();
	}

	reset(utterance?: number): void {
		this.generation++;
		if (this.sock) this.sock.terminate();
		this.sock = null;
		this.opening = false;
		this.utterance = utterance;
		this.micQueue.length = 0;
		this.sent = 0;
		this.queued = 0;
		this.stretches = [];
		this.commitAt = null;
		this.commitPending = false;
		this.commitUtterance = () => { this.commitPending = true; };
	}

	audio(frame: Buffer): void {
		const b64 = frame.toString("base64");
		const samples = Math.floor(frame.length / 2);
		if (!this.isOpen()) {
			this.micQueue.push({ b64, samples });
			this.queued += samples;
			this.heardAudio(this.queued, samples);
			if (this.micQueue.length > MIC_QUEUE_MAX) {
				// a dropped frame never reaches Scribe, so the audio after it moves up
				const dropped = this.micQueue.shift()!.samples;
				this.queued -= dropped;
				for (const s of this.stretches) {
					if (s.upstream !== this.target()) continue;
					s.from = Math.max(0, s.from - dropped);
					s.t0 += dropped / SAMPLES_PER_MS;
				}
			}
			void this.open();
			return;
		}
		this.push(b64, samples);
		this.heardAudio(this.sent, samples);
	}

	// the upstream audio sent now goes to
	private target(): number {
		return this.isOpen() ? this.upstream : this.upstream + 1;
	}

	// a frame ending at `upTo` in its upstream's audio arrived now
	private heardAudio(upTo: number, samples: number): void {
		const upstream = this.target();
		let s = this.stretches.at(-1);
		// audio with no stt_start before it, or after the upstream changed
		if (!s || s.upstream !== upstream) {
			s = { upstream, from: upTo - samples, t0: Infinity };
			this.stretches.push(s);
			if (this.stretches.length > STRETCHES_MAX) this.stretches.shift();
		}
		s.t0 = Math.min(s.t0, this.now() - upTo / SAMPLES_PER_MS);
	}

	// when words from `start` to `end` seconds into an upstream's audio were spoken
	private span(upstream: number, [start, end]: [number, number]): Omit<HeardFinal, "text"> | null {
		const at = end * 1000 * SAMPLES_PER_MS;
		const s = this.stretches.findLast((x) => x.upstream === upstream && x.from < at);
		if (!s || !Number.isFinite(s.t0)) return null;
		return { start_ms: Math.round(s.t0 + start * 1000), end_ms: Math.round(s.t0 + end * 1000) };
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.retryTimer);
		this.sock?.terminate();
		this.sock = null;
	}

	private isOpen(): boolean {
		return this.sock !== null && this.sock.readyState === WebSocket.OPEN;
	}

	private push(b64: string, samples: number): void {
		if (!this.isOpen()) return;
		this.sent += samples;
		this.sock!.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64, commit: false, sample_rate: 16000 }));
	}

	private commit(): void {
		// the upstream closed under us: the next one commits on open
		if (!this.isOpen()) {
			this.commitPending = true;
			return;
		}
		this.commitAt = Date.now();
		this.sock!.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: 16000 }));
	}

	private async open(): Promise<void> {
		if (this.sock || this.opening || this.closed) return;
		// waiting after a failed connect: try once the wait is over
		if (Date.now() < this.retryAt) {
			this.retryTimer ??= setTimeout(() => {
				this.retryTimer = undefined;
				if (this.micQueue.length || this.commitPending) void this.open();
			}, this.retryAt - Date.now());
			return;
		}
		this.opening = true;
		const generation = this.generation;
		const utterance = this.utterance;
		let committed = false;
		const segments: string[] = [];
		let segmentWords: [number, number] | null = null;
		const sock = new WebSocket(this.url, { headers: { "xi-api-key": this.apiKey } });
		sock.on("error", () => { if (this.sock === sock) this.sock = null; });
		const ok = await new Promise<boolean>((resolve) => {
			sock.once("open", () => resolve(true));
			sock.once("error", () => resolve(false));
		});
		if (generation !== this.generation || this.closed) {
			sock.terminate();
			return;
		}
		this.opening = false;
		if (!ok) {
			this.retryAt = Date.now() + this.retryMs;
			this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
			this.send({ t: "error", id: 0, text: "stt_upstream" });
			// what is waiting to go is sent once the wait is over
			if (this.micQueue.length || this.commitPending) void this.open();
			return;
		}
		this.sock = sock;
		const upstream = ++this.upstream;
		this.stretches = this.stretches.filter((s) => s.upstream >= upstream);
		// the wait resets once the upstream has answered; one that accepts and then
		// closes at once (a bad key, no quota) counts as a failed connect
		let heard = false;
		sock.on("message", (data, isBinary) => {
			if (!heard) {
				heard = true;
				this.retryMs = RETRY_MIN_MS;
			}
			if (this.closed || generation !== this.generation || isBinary) return;
			let m: Record<string, unknown>;
			try { m = JSON.parse(data.toString()); } catch { return; }
			const text = typeof m.text === "string" ? m.text : "";
			const tag = utterance === undefined ? {} : { utterance };
			if (m.message_type === "partial_transcript") {
				this.send({ t: "stt_partial", text, ...tag });
			} else if (m.message_type === "committed_transcript_with_timestamps") {
				let words = wordSpan(m.words);
				// auto-committed segments belong to this socket's utterance, never a later one
				if (utterance !== undefined) {
					if (segmentWords && words) words = [Math.min(segmentWords[0], words[0]), Math.max(segmentWords[1], words[1])];
					else words ??= segmentWords;
					if (!committed) { segments.push(text); segmentWords = words; return; }
					if (this.commitAt === null) return;
				}
				// the first final after a commit is the one the person waited on
				this.commitAt = null;
				const final = utterance === undefined ? text : [...segments, text].filter(Boolean).join(" ");
				this.send({ t: "stt_final", text: final, ...tag });
				const spoken = final.trim() && words ? this.span(upstream, words) : null;
				if (spoken) this.onFinal({ text: final, ...spoken });
				if (utterance !== undefined) sock.terminate();
			}
		});
		sock.on("close", () => {
			if (this.sock === sock) this.sock = null;
			if (!heard && generation === this.generation && !this.closed) {
				this.retryAt = Date.now() + this.retryMs;
				this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
			}
		});
		// the queued audio is the start of this upstream's
		this.sent = 0;
		while (this.micQueue.length) {
			const f = this.micQueue.shift()!;
			this.push(f.b64, f.samples);
		}
		this.queued = 0;
		this.commitUtterance = () => { committed = true; this.commit(); };
		if (this.commitPending) {
			this.commitPending = false;
			this.commitUtterance();
		}
	}
}
