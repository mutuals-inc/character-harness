// Speaks up when nobody has said anything for a while: after `after_s` seconds
// of a quiet voice it offers the character a line of input saying so, and the
// character answers it like any other turn. Then it waits `cooldown_s` before
// it may do it again.
//
// config:
//   after_s: 60        seconds of quiet before it speaks up
//   cooldown_s: 90     seconds after that before it may again
//   text: "…"          what the character is told; it isn't said as written

interface Config {
	after_s?: number;
	cooldown_s?: number;
	text?: string;
}

interface Context {
	config: Config;
	signal: AbortSignal;
	offer(req: { text: string; source?: string; ttl_ms?: number; quiet_ms?: number }): Promise<string>;
}

const TEXT = "Nobody has said anything for a while. Say something to get things going again, in a line or two.";

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((done) => {
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
	});

export async function service({ config, signal, offer }: Context) {
	const after = (config.after_s ?? 60) * 1000;
	const cooldown = (config.cooldown_s ?? 90) * 1000;
	while (!signal.aborted) {
		// the runtime holds it until the voice has been quiet for `after`, so
		// waiting for the quiet is the offer itself
		const outcome = await offer({ text: config.text ?? TEXT, source: "idle", quiet_ms: after, ttl_ms: 10 * 60_000 });
		if (outcome === "closed") return;
		if (outcome === "accepted") await sleep(cooldown, signal);
	}
}

export function check({ config }: { config: Config }) {
	const errors: string[] = [];
	for (const k of ["after_s", "cooldown_s"] as const) {
		const v = config[k];
		if (v !== undefined && (typeof v !== "number" || !(v > 0))) errors.push(`\`${k}\` must be a number of seconds above 0`);
	}
	if (config.text !== undefined && (typeof config.text !== "string" || !config.text.trim()))
		errors.push("`text` must be some text");
	return { errors };
}
