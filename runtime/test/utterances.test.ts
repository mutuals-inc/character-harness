// When each utterance was spoken: the speech-to-text relay times its finals
// from the mic audio and Scribe's word times, against a local stand-in for
// Scribe, and a turn's user line is matched to the finals it is made of. Run
// with `npm test`.

import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { Stt } from "../src/manifest.ts";
import { SttRelay, wordSpan, type HeardFinal } from "../src/stt.ts";
import { Heard } from "../src/utterances.ts";

const final = (text: string, start_ms: number, end_ms: number): HeardFinal => ({ text, start_ms, end_ms });

test("a line that is one final gets its times", () => {
	const h = new Heard(() => 0);
	h.add(final("hello there", 1000, 2000));
	assert.deepEqual(h.match("hello there"), [{ text: "hello there", start_ms: 1000, end_ms: 2000 }]);
});

test("a line made of two finals gets both, oldest first, whatever the spacing", () => {
	const h = new Heard(() => 0);
	h.add(final("so anyway", 1000, 1500));
	h.add(final("what do you think?", 2500, 3400));
	assert.deepEqual(
		h.match("  so anyway\nwhat do you think? "),
		[
			{ text: "so anyway", start_ms: 1000, end_ms: 1500 },
			{ text: "what do you think?", start_ms: 2500, end_ms: 3400 },
		],
	);
});

test("a line the finals can't make whole gets none", () => {
	const h = new Heard(() => 0);
	h.add(final("hello there", 1000, 2000));
	assert.equal(h.match("hello there, friend"), undefined); // edited
	assert.equal(h.match("there"), undefined); // only part of a final
	assert.equal(h.match("typed line"), undefined);
	assert.equal(h.match(""), undefined);
});

test("a line said twice matches the newer final", () => {
	const h = new Heard(() => 0);
	h.add(final("yes", 1000, 1200));
	h.add(final("no", 2000, 2200));
	h.add(final("yes", 3000, 3200));
	assert.deepEqual(h.match("yes"), [{ text: "yes", start_ms: 3000, end_ms: 3200 }]);
});

test("a final heard after the line still lets the line match the ones before it", () => {
	const h = new Heard(() => 0);
	h.add(final("first", 1000, 1200));
	h.add(final("second", 2000, 2200));
	assert.deepEqual(h.match("first"), [{ text: "first", start_ms: 1000, end_ms: 1200 }]);
});

test("the same line asked again matches again, until its final is a minute old", () => {
	let now = 0;
	const h = new Heard(() => now);
	h.add(final("hello", 1000, 1200));
	assert.ok(h.match("hello"));
	assert.ok(h.match("hello"));
	now = 60_001;
	assert.equal(h.match("hello"), undefined);
});

test("only the last 8 finals are kept", () => {
	const h = new Heard(() => 0);
	for (let i = 0; i < 9; i++) h.add(final(`line ${i}`, i, i));
	assert.equal(h.match("line 0"), undefined);
	assert.ok(h.match("line 1"));
});

test("a span is the first word's start to the last word's end, skipping spacing and bad entries", () => {
	assert.deepEqual(
		wordSpan([
			{ type: "spacing", start: 0.1, end: 0.2 },
			{ type: "word", start: 0.5, end: 0.8 },
			{ type: "word", start: "x", end: 1 },
			null,
			{ type: "word", start: 1.0, end: 1.4 },
		]),
		[0.5, 1.4],
	);
	assert.equal(wordSpan([]), null);
	assert.equal(wordSpan(undefined), null);
});

// A stand-in for Scribe: counts the audio it gets and answers each commit with
// the transcript the test queued, timed from the start of this socket's audio.
async function fakeScribe() {
	const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await once(wss, "listening");
	const answers: Record<string, unknown>[] = [];
	const sockets: WebSocket[] = [];
	let samples = 0;
	wss.on("connection", (ws) => {
		sockets.push(ws);
		samples = 0;
		ws.on("message", (data) => {
			const m = JSON.parse(data.toString());
			samples += Buffer.from(m.audio_base_64, "base64").length / 2;
			if (m.commit) {
				const a = answers.shift();
				if (a) ws.send(JSON.stringify({ message_type: "committed_transcript_with_timestamps", ...a }));
			}
		});
	});
	const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
	return { wss, url, answers, sockets, samples: () => samples };
}

const stt = { provider: "elevenlabs", model: "m", keyterms: [] } as unknown as Stt;
const frame = (ms: number) => Buffer.alloc(ms * 16 * 2); // PCM16, 16 kHz

function relay(url: string, clock: { now: number }) {
	const heard: HeardFinal[] = [];
	const sent: Record<string, unknown>[] = [];
	const r = new SttRelay(stt, "k", (m) => sent.push(m as Record<string, unknown>), {
		onFinal: (f) => heard.push(f),
		now: () => clock.now,
		url,
	});
	return { r, heard, sent };
}

const until = async (ok: () => boolean) => {
	for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
	assert.ok(ok());
};

test("an utterance's times come from its words, with the pre-roll arriving all at once", async (t) => {
	const s = await fakeScribe();
	t.after(() => s.wss.close());
	const clock = { now: 100_000 };
	const { r, heard, sent } = relay(s.url, clock);
	t.after(() => r.close());
	r.start(1);
	// 300 ms of pre-roll lands at once, then 1 s more streams in real time
	r.audio(frame(300));
	await until(() => s.sockets.length === 1);
	for (let i = 0; i < 10; i++) {
		clock.now += 100;
		r.audio(frame(100));
	}
	await until(() => s.samples() === 1300 * 16);
	// the socket's audio started 1.3 s before the last frame arrived (101 000)
	s.answers.push({ text: "hello there", words: [{ type: "word", start: 0.4, end: 0.7 }, { type: "word", start: 0.8, end: 1.1 }] });
	r.endOfSpeech(1);
	await until(() => heard.length === 1);
	assert.deepEqual(heard[0], { text: "hello there", start_ms: 100_100, end_ms: 100_800 });
	assert.deepEqual(sent.at(-1), { t: "stt_final", text: "hello there", utterance: 1 });
});

test("frames the queue dropped don't move the times", async (t) => {
	const s = await fakeScribe();
	t.after(() => s.wss.close());
	const clock = { now: 0 };
	const { r, heard } = relay(s.url, clock);
	t.after(() => r.close());
	r.start(1);
	// 300 frames of 10 ms while the socket opens: the queue keeps the last 256
	for (let i = 0; i < 300; i++) {
		clock.now += 10;
		r.audio(frame(10));
	}
	await until(() => s.samples() === 256 * 10 * 16);
	s.answers.push({ text: "late", words: [{ type: "word", start: 0, end: 2.56 }] });
	r.endOfSpeech(1);
	await until(() => heard.length === 1);
	// Scribe got the last 2.56 s, which ended at 3000
	assert.deepEqual(heard[0], { text: "late", start_ms: 440, end_ms: 3000 });
});

test("on one socket across utterances, each final is timed from its own commit", async (t) => {
	const s = await fakeScribe();
	t.after(() => s.wss.close());
	const clock = { now: 0 };
	const { r, heard } = relay(s.url, clock);
	t.after(() => r.close());
	r.start(undefined);
	r.audio(frame(100));
	await until(() => s.sockets.length === 1 && s.samples() === 100 * 16);
	clock.now = 1000;
	r.audio(frame(1000));
	await until(() => s.samples() === 1100 * 16);
	s.answers.push({ text: "one", words: [{ type: "word", start: 0.2, end: 0.9 }] });
	r.endOfSpeech(undefined);
	await until(() => heard.length === 1);
	// 1.1 s of audio ended at 1000
	assert.deepEqual(heard[0], { text: "one", start_ms: 100, end_ms: 800 });
	// a second utterance after 5 s of quiet: no audio was sent in the gap
	r.start(undefined);
	clock.now = 6000;
	r.audio(frame(500));
	await until(() => s.samples() === 1600 * 16);
	s.answers.push({ text: "two", words: [{ type: "word", start: 1.2, end: 1.5 }] });
	r.endOfSpeech(undefined);
	await until(() => heard.length === 2);
	// the socket's 1.6 s now ends at 6000, so its audio is timed from 4400
	assert.deepEqual(heard[1], { text: "two", start_ms: 5600, end_ms: 5900 });
});

test("a final without words, or with no text, isn't heard", async (t) => {
	const s = await fakeScribe();
	t.after(() => s.wss.close());
	const clock = { now: 0 };
	const { r, heard } = relay(s.url, clock);
	t.after(() => r.close());
	r.start(1);
	await until(() => s.sockets.length === 1);
	clock.now = 2000;
	r.audio(frame(800));
	await until(() => s.samples() === 800 * 16);
	s.answers.push({ text: "hm" });
	r.endOfSpeech(1);
	await until(() => s.sockets[0].readyState !== 1);
	assert.equal(heard.length, 0);

	r.start(2);
	await until(() => s.sockets.length === 2);
	r.audio(frame(100));
	await until(() => s.samples() === 100 * 16);
	s.answers.push({ text: " ", words: [{ type: "word", start: 0, end: 0.1 }] });
	r.endOfSpeech(2);
	await until(() => s.sockets[1].readyState !== 1);
	assert.equal(heard.length, 0);
});

test("a frame that arrives late doesn't move the times", async (t) => {
	const s = await fakeScribe();
	t.after(() => s.wss.close());
	const clock = { now: 0 };
	const { r, heard } = relay(s.url, clock);
	t.after(() => r.close());
	r.start(1);
	await until(() => s.sockets.length === 1);
	for (let i = 1; i <= 10; i++) {
		clock.now = i * 100;
		r.audio(frame(100));
	}
	// the last frame was held up 200 ms on its way
	clock.now = 1300;
	r.audio(frame(100));
	await until(() => s.samples() === 1100 * 16);
	s.answers.push({ text: "steady", words: [{ type: "word", start: 0.2, end: 1.0 }] });
	r.endOfSpeech(1);
	await until(() => heard.length === 1);
	assert.deepEqual(heard[0], { text: "steady", start_ms: 200, end_ms: 1000 });
});

test("on one socket, a final that comes back after the next utterance began keeps its own times", async (t) => {
	const s = await fakeScribe();
	t.after(() => s.wss.close());
	const clock = { now: 0 };
	const { r, heard } = relay(s.url, clock);
	t.after(() => r.close());
	r.start(undefined);
	await until(() => s.sockets.length === 1);
	clock.now = 1000;
	r.audio(frame(1000)); // utterance one: socket audio 0 to 1 s, heard 0 to 1000
	await until(() => s.samples() === 1000 * 16);
	r.endOfSpeech(undefined); // nothing queued to answer it yet
	r.start(undefined);
	clock.now = 5500;
	r.audio(frame(500)); // utterance two, after a gap: socket audio 1 to 1.5 s, heard 5000 to 5500
	await until(() => s.samples() === 1500 * 16);
	// Scribe answers the first commit only now, then the second
	const ws = s.sockets[0];
	ws.send(JSON.stringify({ message_type: "committed_transcript_with_timestamps", text: "one", words: [{ type: "word", start: 0.1, end: 0.9 }] }));
	ws.send(JSON.stringify({ message_type: "committed_transcript_with_timestamps", text: "two", words: [{ type: "word", start: 1.1, end: 1.4 }] }));
	await until(() => heard.length === 2);
	assert.deepEqual(heard[0], { text: "one", start_ms: 100, end_ms: 900 });
	assert.deepEqual(heard[1], { text: "two", start_ms: 5100, end_ms: 5400 });
});
