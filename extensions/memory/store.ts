// The memories of one character, as one JSON file. The harness has no idea of
// who the user is, so whoever talks to a character shares what it remembers.
//
// A memory hangs under another (a detail of it) or is a root, so the store is
// a forest. One that stopped being true stays in it, marked out of date, so
// what replaced it can point back at it; it is never shown as true again.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const KINDS = ["fact", "date", "person", "preference", "plan", "boundary", "feeling"] as const;
export type Kind = (typeof KINDS)[number];

export interface Memory {
	id: string; // "m<n>", never reused
	text: string; // the user's own words
	kind: Kind;
	parent: string | null;
	created_at: string;
	seen_at: string; // the last time the user said it
	need: number; // 0..1, how much the character would be expected to remember it
	cost: number; // 0..1, how much forgetting it would cost
	replaces?: string; // id of the older memory this one supersedes
	out_of_date?: { p: number; at: string; by?: string };
}

export interface Store {
	version: 1;
	next_id: number;
	memories: Memory[];
}

export const emptyStore = (): Store => ({ version: 1, next_id: 1, memories: [] });

// A tree deeper than this is flattened: a detail of a detail of ... is still
// a detail of the same thing, and the prompt can't show more levels usefully.
export const MAX_DEPTH = 16;

// ids are "m" and a positive whole number small enough to count exactly
const ID = /^m([1-9][0-9]{0,15})$/;
export const idNumber = (id: string) => {
	const n = Number(ID.exec(id)?.[1] ?? 0);
	return Number.isSafeInteger(n) ? n : 0;
};
const isId = (v: unknown): v is string => typeof v === "string" && idNumber(v) > 0;

const unit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const current = (m: Memory) => !m.out_of_date;

// The store as read from disk, made whole: a memory that can't be read is
// dropped, and a link to a memory that isn't there (or would make a loop) is
// cut. Throws only when the file isn't a store this code can read.
export function validate(raw: unknown, max = Infinity): Store {
	if (!isObj(raw) || !Array.isArray(raw.memories) || !("version" in raw)) throw new Error("it is not a memory store");
	if (raw.version !== 1) throw new Error(`it is a memory store of version ${JSON.stringify(raw.version)}, which this code can't read`);
	const now = new Date().toISOString();
	const byId = new Map<string, Memory>();
	for (const m of raw.memories) {
		if (!isObj(m) || !isId(m.id) || byId.has(m.id)) continue;
		if (typeof m.text !== "string" || !m.text.trim()) continue;
		const created = typeof m.created_at === "string" ? m.created_at : now;
		const mem: Memory = {
			id: m.id,
			text: m.text.trim(),
			kind: KINDS.includes(m.kind as Kind) ? (m.kind as Kind) : "fact",
			parent: typeof m.parent === "string" ? m.parent : null,
			created_at: created,
			seen_at: typeof m.seen_at === "string" ? m.seen_at : created,
			need: unit(m.need),
			cost: unit(m.cost),
		};
		if (typeof m.replaces === "string") mem.replaces = m.replaces;
		const ood = m.out_of_date;
		if (isObj(ood)) {
			mem.out_of_date = { p: unit(ood.p), at: typeof ood.at === "string" ? ood.at : now };
			if (typeof ood.by === "string") mem.out_of_date.by = ood.by;
		}
		byId.set(mem.id, mem);
	}
	for (const m of byId.values()) {
		if (m.parent !== null && (m.parent === m.id || !byId.has(m.parent))) m.parent = null;
		if (m.replaces !== undefined && (m.replaces === m.id || !byId.has(m.replaces))) delete m.replaces;
		if (m.out_of_date?.by !== undefined && !byId.has(m.out_of_date.by)) delete m.out_of_date.by;
	}
	const memories = [...byId.values()].sort((a, b) => idNumber(a.id) - idNumber(b.id));
	const highest = memories.reduce((n, m) => Math.max(n, idNumber(m.id)), 0);
	const next = Number.isSafeInteger(raw.next_id) && (raw.next_id as number) > 0 ? (raw.next_id as number) : 1;
	const store: Store = { version: 1, next_id: Math.max(next, highest + 1), memories };
	tidy(store);
	evict(store, max);
	return store;
}

// Cuts loops in the parent links and flattens the tree to MAX_DEPTH levels, a
// deeper memory moving up to the deepest level allowed. Linear in the store.
export function tidy(store: Store): void {
	const byId = new Map(store.memories.map((m) => [m.id, m]));
	const state = new Map<string, "walking" | "done">();
	for (const m of store.memories) {
		const walked: Memory[] = [];
		let at: Memory | undefined = m;
		while (at && !state.has(at.id)) {
			state.set(at.id, "walking");
			walked.push(at);
			at = at.parent !== null ? byId.get(at.parent) : undefined;
		}
		// came back to a memory on this walk: the last link closes a loop
		if (at && state.get(at.id) === "walking") walked[walked.length - 1].parent = null;
		for (const w of walked) state.set(w.id, "done");
	}
	const kids = new Map<string, Memory[]>();
	for (const m of store.memories) if (m.parent !== null) (kids.get(m.parent) ?? kids.set(m.parent, []).get(m.parent)!).push(m);
	const depth = new Map<string, number>();
	const queue = store.memories.filter((m) => m.parent === null);
	for (const r of queue) depth.set(r.id, 0);
	for (let i = 0; i < queue.length; i++) {
		const m = queue[i];
		const d = depth.get(m.id)!;
		for (const k of kids.get(m.id) ?? []) {
			if (d >= MAX_DEPTH - 1) {
				k.parent = m.parent;
				depth.set(k.id, d);
			} else depth.set(k.id, d + 1);
			queue.push(k);
		}
	}
}

// Reads a store; a missing file is an empty one. A file that isn't a store
// this code can read is left as it is, and the error says so: it may be
// something else entirely, and only its owner knows.
export async function loadStore(file: string, max = Infinity): Promise<Store> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
		throw e;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		raw = undefined;
	}
	try {
		return validate(raw, max);
	} catch (e) {
		throw new Error(`${file} can't be used (${e instanceof Error ? e.message : String(e)}); memory is off until it is fixed, moved or deleted`);
	}
}

// Written whole to a temporary file, then renamed over the old one, so a crash
// mid-write leaves the old store, never half of one. Only the runtime's user
// can read either: they hold what users said.
export async function saveStore(file: string, store: Store): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(store, null, "\t")}\n`, { mode: 0o600 });
	await rename(tmp, file);
}

// One write at a time per file: every session of a character shares it.
const queues = new Map<string, Promise<unknown>>();
export function locked<T>(file: string, fn: () => Promise<T>): Promise<T> {
	const run = (queues.get(file) ?? Promise.resolve()).then(fn, fn);
	const tail = run.catch(() => undefined);
	queues.set(file, tail);
	void tail.then(() => {
		if (queues.get(file) === tail) queues.delete(file);
	});
	return run;
}

// The store in memory, read once per file and shared by every session. A
// store that failed to load is read again next time.
const open = new Map<string, Promise<Store>>();
export function storeFor(file: string, max = Infinity): Promise<Store> {
	let s = open.get(file);
	if (!s) {
		s = loadStore(file, max);
		open.set(file, s);
		s.catch(() => open.delete(file));
	}
	return s;
}

// Keeps the store at `max` memories. Every memory no longer true is removed
// before any current one; among current ones, the lowest `cost` goes, and on a
// tie the older one. Children of a removed memory are re-attached to its
// nearest remaining ancestor, and links to it are dropped. `keep` stays.
export function evict(store: Store, max: number, keep?: string): void {
	const over = store.memories.length - max;
	if (over <= 0) return;
	const order = store.memories
		.filter((m) => m.id !== keep)
		.sort((a, b) => Number(current(a)) - Number(current(b)) || (current(a) ? a.cost - b.cost : 0) || idNumber(a.id) - idNumber(b.id));
	const gone = new Set(order.slice(0, over).map((m) => m.id));
	const byId = new Map(store.memories.map((m) => [m.id, m]));
	const staying = (id: string | null): string | null => {
		while (id !== null && gone.has(id)) id = byId.get(id)!.parent;
		return id;
	};
	store.memories = store.memories.filter((m) => !gone.has(m.id));
	for (const m of store.memories) {
		m.parent = staying(m.parent);
		if (m.replaces !== undefined && gone.has(m.replaces)) delete m.replaces;
		if (m.out_of_date?.by !== undefined && gone.has(m.out_of_date.by)) delete m.out_of_date.by;
	}
}
