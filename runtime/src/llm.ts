// The character's chat model, as `models.chat` names it. Two request formats,
// picked by `api`; everything else (where, which key, which model) comes from
// the manifest, so adding a provider never touches this file.
//
//   chat_completions  <base_url>/chat/completions  xAI, OpenAI, any compatible server
//   responses         <base_url>/responses         OpenAI's Responses API
//
// The responses request sends the system
// prompt as `instructions`, the conversation as `input`, `store: false`, and
// one `prompt_cache_key`, so the long system prompt, the same on every turn,
// lands on a server that already has it. Reasoning models reject
// `temperature`, and their reasoning spends the same `max_output_tokens` the
// answer does, so a responses call gets headroom on top of `max_tokens`.
//
// Tools the turn offers go with the request in each API's own shape, and the
// calls the model makes come back beside the text. So do the calls and results
// in the conversation: an assistant message's `tool_calls` and the tool
// messages after it. Tools go as non-strict on both APIs: the Responses API
// makes a tool strict when it isn't told otherwise, which turns its optional
// parameters into required ones, and Chat Completions doesn't.

import type { ChatModel } from "./manifest.ts";
import type { Message, Tool, ToolCall, ToolChoice } from "./state.ts";

// room for the thinking before the answer; a guess, not measured
const REASONING_HEADROOM = 2000;
const PROMPT_CACHE_KEY = "character";

export class LlmHttpError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`the model answered HTTP ${status}`);
		this.status = status;
	}
}

const parameters = (t: Tool) => t.parameters ?? { type: "object", properties: {} };

const chatMessage = (x: Message) => {
	if (x.role === "tool") return { role: "tool", tool_call_id: x.tool_call_id, content: x.content };
	if (!x.tool_calls?.length) return { role: x.role, content: x.content };
	return {
		role: x.role,
		content: x.content || null,
		tool_calls: x.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
	};
};

// The Responses API has calls and their results as items of their own
const responseItems = (x: Message): unknown[] => {
	if (x.role === "tool") return [{ type: "function_call_output", call_id: x.tool_call_id, output: x.content }];
	const calls = (x.tool_calls ?? []).map((c) => ({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments }));
	return [...(x.content || !calls.length ? [{ role: x.role, content: x.content }] : []), ...calls];
};

function request(m: ChatModel, messages: Message[], tools: Tool[], choice?: ToolChoice): { url: string; body: Record<string, unknown> } {
	const { temperature, max_tokens, reasoning_effort } = m.params;
	// a choice only means something beside tools
	const pick = tools.length && choice !== undefined ? choice : undefined;
	if (m.api === "chat_completions")
		return {
			url: `${m.base_url}/chat/completions`,
			body: {
				model: m.model,
				stream: true,
				messages: messages.map(chatMessage),
				...(tools.length
					? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: parameters(t) } })) }
					: {}),
				...(pick !== undefined
					? { tool_choice: typeof pick === "string" ? pick : { type: "function", function: { name: pick.name } } }
					: {}),
				...(temperature !== undefined ? { temperature } : {}),
				...(max_tokens !== undefined ? { max_completion_tokens: max_tokens } : {}),
			},
		};
	const instructions = messages.filter((x) => x.role === "system").map((x) => x.content).join("\n\n");
	return {
		url: `${m.base_url}/responses`,
		body: {
			model: m.model,
			stream: true,
			...(instructions ? { instructions } : {}),
			input: messages.filter((x) => x.role !== "system").flatMap(responseItems),
			...(tools.length
				? { tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description ?? "", parameters: parameters(t), strict: false })) }
				: {}),
			...(pick !== undefined ? { tool_choice: typeof pick === "string" ? pick : { type: "function", name: pick.name } } : {}),
			...(reasoning_effort !== undefined ? { reasoning: { effort: reasoning_effort } } : {}),
			...(max_tokens !== undefined ? { max_output_tokens: max_tokens + REASONING_HEADROOM } : {}),
			store: false,
			prompt_cache_key: PROMPT_CACHE_KEY,
		},
	};
}

// The model failed partway, after answering 200: an error payload in the stream.
export class LlmStreamError extends Error {}

// What one streamed `data:` payload adds: text, and the calls it finishes.
// Chat Completions streams each call in pieces, by index, so they wait in
// `calls`, in the order they began. One is handed over once something comes
// after it, another call or text, and its arguments are whole: a JSON object,
// or nothing, as some servers send for a call with no arguments; the rest
// when the stream ends, or when it is stopped, those whose arguments are whole.
// So a reply stopped partway (a silent reply that writes on) keeps the calls it
// finished, as on the Responses API, which hands each call over whole as its
// item is done. Throws LlmStreamError on an error event.
interface Pending {
	calls: ToolCall[];
	at: Map<number, number>; // a piece's index -> the call in `calls` it adds to
	out: number; // how many of `calls`, from the first, were handed over
}

const isWhole = (args: string) => {
	if (!args.trim()) return true;
	try {
		const v = JSON.parse(args);
		return typeof v === "object" && v !== null && !Array.isArray(v);
	} catch {
		return false;
	}
};

function delta(m: ChatModel, j: unknown, pending: Pending): { text: string; done: ToolCall[] } {
	const failed = (what: unknown) => new LlmStreamError(`the model failed: ${JSON.stringify(what).slice(0, 200)}`);
	if (m.api === "chat_completions") {
		type Piece = { index?: number; id?: string; function?: { name?: string; arguments?: string } };
		const c = j as { error?: unknown; choices?: Array<{ delta?: { content?: string; tool_calls?: Piece[] } }> };
		if (c.error) throw failed(c.error);
		const d = c.choices?.[0]?.delta;
		const { calls, at } = pending;
		for (const p of d?.tool_calls ?? []) {
			// A piece goes on the call its index names, or without an index the last
			// one. One that brings an id other than that call's starts a new call:
			// some servers send every parallel call at index 0.
			const index = typeof p.index === "number" ? p.index : undefined;
			let i = index !== undefined ? at.get(index) : calls.length - 1;
			const was = i !== undefined && i >= 0 ? calls[i] : undefined;
			if (!was || (p.id && was.id && p.id !== was.id)) {
				i = calls.push({ id: "", name: "", arguments: "" }) - 1;
				if (index !== undefined) at.set(index, i);
			}
			// a call already handed over is done; a stray piece can't change it
			if (i! < pending.out) continue;
			const call = calls[i!];
			if (p.id) call.id = p.id;
			// some servers repeat the whole name on every piece
			if (p.function?.name && !call.name) call.name = p.function.name;
			if (p.function?.arguments) call.arguments += p.function.arguments;
		}
		const text = d?.content ?? "";
		// each call followed by another one, or by text, is done once its arguments are whole
		const done: ToolCall[] = [];
		while (pending.out < calls.length && (text || pending.out < calls.length - 1)) {
			const call = calls[pending.out];
			if (!call.name || !isWhole(call.arguments)) break;
			done.push(call);
			pending.out++;
		}
		return { text, done };
	}
	const e = j as {
		type?: string;
		delta?: string;
		error?: unknown;
		response?: { error?: unknown };
		item?: { type?: string; call_id?: string; name?: string; arguments?: string };
	};
	if (e.type === "error" || e.type === "response.failed") throw failed(e.error ?? e.response?.error ?? e.type);
	if (e.type === "response.output_item.done" && e.item?.type === "function_call" && e.item.name)
		return { text: "", done: [{ id: e.item.call_id ?? "", name: e.item.name, arguments: e.item.arguments ?? "" }] };
	return { text: e.type === "response.output_text.delta" ? e.delta ?? "" : "", done: [] };
}

// Yields the reply as it streams: its text, and each tool call once it is
// whole. Throws LlmHttpError on a non-2xx answer, LlmStreamError on an error
// in the stream, and whatever fetch throws on a network failure or an abort
// before the answer starts. A reply cut short (response.incomplete) ends with
// what was written, and so does one `signal` stops while it streams: a reader
// that aborts and reads on gets the calls that were whole.
export async function* streamChat(
	m: ChatModel,
	apiKey: string,
	messages: Message[],
	signal: AbortSignal,
	tools: Tool[] = [],
	choice?: ToolChoice,
): AsyncGenerator<string | ToolCall> {
	const { url, body } = request(m, messages, tools, choice);
	const resp = await fetch(url, {
		method: "POST",
		signal,
		headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!resp.ok || !resp.body) throw new LlmHttpError(resp.status);
	const dec = new TextDecoder();
	const pending: Pending = { calls: [], at: new Map(), out: 0 };
	let buf = "";
	let stopped = false;
	try {
		for await (const chunk of resp.body) {
			buf += dec.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "[DONE]") continue;
				let j: unknown;
				try { j = JSON.parse(data); } catch { continue; }
				const { text, done } = delta(m, j, pending);
				// calls the text came after go first, so a reader stopped by the text has them
				yield* done;
				if (text) yield text;
			}
		}
	} catch (e) {
		if (!signal.aborted) throw e;
		stopped = true;
	}
	for (const call of pending.calls.slice(pending.out)) if (call.name && (!stopped || isWhole(call.arguments))) yield call;
}
