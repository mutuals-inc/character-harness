// Loads each extension's handler and runs a hook through the character's
// extensions, in the order the character lists them. docs/extensions.md is
// the contract:
//
//   in:  { event, state, config }      out: { state }, or nothing for "no change"
//
// A module handler is a file whose default export is that function, sync or
// async. It may also export `check({ config, body })`, which `npm run check`
// and `npm start` call to check its config against the character (check.ts),
// and, when its extension.yaml says `service: true`, `service(ctx)`, which runs
// for the whole session beside the hooks (session.ts).
// An HTTP handler gets the same object as a JSON POST and answers the
// same way. Keys come from .env, which the runtime loads into process.env.

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Body, Problems } from "./check.ts";
import type { Extension } from "./manifest.ts";
import type { OfferOutcome, OfferRequest, VoiceState } from "./offers.ts";
import type { HookName, State } from "./state.ts";

export interface HookInput {
	event: HookName;
	state: State;
	config: unknown;
}
type HookOutput = { state?: State } | null | undefined | void;
type Handler = (input: HookInput) => HookOutput | Promise<HookOutput>;

type Check = (input: { config: unknown; body: Body }) => Problems | void | Promise<Problems | void>;

// What a service gets: the session it runs in, a way to keep its data where the
// hooks see it, a way to start a turn, and the player's voice.
export interface ServiceContext {
	config: unknown;
	session: { id: string; channel: string };
	signal: AbortSignal; // aborted when the session ends
	log: (line: string) => void;
	ext: {
		get(): unknown; // a copy of state.ext.<name>
		set(value: unknown): void; // replaces state.ext.<name>; the next hook sees it
	};
	offer(req: OfferRequest): Promise<OfferOutcome>;
	voice: {
		readonly state: VoiceState;
		readonly since: number; // Date.now() when `state` last changed
		on(fn: (state: VoiceState) => void): () => void; // returns the unsubscribe
	};
}
type Service = (ctx: ServiceContext) => unknown;

export interface Loaded extends Extension {
	call: Handler;
	check?: Check;
	run?: Service;
}

class TimedOut extends Error {}

function httpHandler(url: string): Handler {
	return async (input) => {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const text = await resp.text();
		return text.trim() ? (JSON.parse(text) as HookOutput) : undefined;
	};
}

export async function loadExtensions(exts: Extension[]): Promise<Loaded[]> {
	const out: Loaded[] = [];
	for (const e of exts) {
		if (/^https?:\/\//.test(e.handler)) {
			out.push({ ...e, call: httpHandler(e.handler) });
			continue;
		}
		const file = path.join(e.dir, e.handler);
		const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; check?: unknown; service?: unknown };
		// a service-only extension has no hooks, so it needs no default export
		if (typeof mod.default !== "function" && (e.hooks.size || !e.service))
			throw new Error(`${file}: the extension's handler must export a default function`);
		if (e.service && typeof mod.service !== "function")
			throw new Error(`${file}: extension.yaml says \`service: true\`, so the handler must export a \`service\` function`);
		out.push({
			...e,
			call: typeof mod.default === "function" ? (mod.default as Handler) : () => undefined,
			check: typeof mod.check === "function" ? (mod.check as Check) : undefined,
			run: e.service ? (mod.service as Service) : undefined,
		});
	}
	return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		p,
		new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimedOut()), ms); }),
	]).finally(() => clearTimeout(timer));
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Runs `hook` through every extension that declared it and returns the state
// the last blocking one handed on. A blocking extension that throws or runs out
// of time is logged and skipped, its changes dropped. A non-blocking one gets a
// copy and is not waited on; what it returns is dropped.
//
// `step`, when given, sees each blocking extension's output as soon as it
// returns and hands on what the next one sees.
export async function runHook(
	exts: Loaded[],
	hook: HookName,
	state: State,
	log: (line: string) => void,
	step?: (s: State) => State,
): Promise<State> {
	for (const e of exts) {
		const opts = e.hooks.get(hook);
		if (!opts) continue;
		// every extension gets its own copy, so one still running after its
		// timeout cannot change what the next one sees. Copying throws on state
		// an earlier extension filled with something that can't be copied.
		const input = () => ({ event: hook, state: structuredClone(state), config: e.config }) satisfies HookInput;
		if (!opts.blocking) {
			Promise.resolve()
				.then(() => e.call(input()))
				.catch((err) => log(`[ext] ${e.name} ${hook} (non-blocking) failed: ${errorText(err)}`));
			continue;
		}
		try {
			const out = await withTimeout(Promise.resolve().then(() => e.call(input())), opts.timeout_ms);
			if (out && typeof out === "object" && out.state && typeof out.state === "object") {
				// what the next extension and the session get must be copyable
				structuredClone(out.state);
				state = out.state;
			}
			if (step) state = step(state);
		} catch (err) {
			log(
				err instanceof TimedOut
					? `[ext] ${e.name} ${hook} timed out after ${opts.timeout_ms}ms; its changes were dropped`
					: `[ext] ${e.name} ${hook} failed: ${errorText(err)}; its changes were dropped`,
			);
		}
	}
	return state;
}

// True when at least one extension runs on `hook`.
export function hasHook(exts: Loaded[], hook: HookName): boolean {
	return exts.some((e) => e.hooks.has(hook));
}
