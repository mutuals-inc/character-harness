// Starts the player app next to the runtime, so `npm start` is the whole thing.
// HARNESS_PLAYER is the command that opens the player, run by the shell from
// the harness folder: the player binary's path, or any command line that stays
// running while the player is open (on macOS, the binary inside the .app, not
// `open -a`). Unset, the runtime only serves, and prints what the player needs
// to connect.
//
// The player gets HARNESS_URL, HARNESS_CHARACTER and HARNESS_LISTEN (the
// character's `listen` settings as JSON, "" for none) in its environment, and
// none of the keys: it never calls a provider itself. Its
// output goes to .cache/player.log; closing the player stops the runtime, and
// stopping the runtime closes the player.

import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import type { Listen } from "./manifest.ts";

const LOG = path.resolve(import.meta.dirname, "../../.cache/player.log");
// where the player's output goes, as the console shows it
export const playerLog = path.relative(process.cwd(), LOG);

export interface PlayerLaunch {
	url: string; // the runtime's session socket
	character: string; // a prepared model file, or the name of a profile cooked into the player
	listen: Listen;
}

// `listen` as the player reads it: JSON with only the keys the character sets
export function listenEnv(listen: Listen): string {
	return Object.keys(listen).length ? JSON.stringify(listen) : "";
}

// what to give the player when starting it by hand, for the console
export function manualStart(launch: PlayerLaunch): string {
	const listen = listenEnv(launch.listen);
	return `HARNESS_URL=${launch.url} HARNESS_CHARACTER=${JSON.stringify(launch.character)}${listen ? ` HARNESS_LISTEN='${listen}'` : ""}`;
}

// Starts the player; the returned stop() closes it and anything it started.
export function startPlayer(
	command: string,
	launch: PlayerLaunch,
	secrets: Set<string>,
	onExit: (code: number | null, signal: NodeJS.Signals | null) => void,
): () => void {
	mkdirSync(path.dirname(LOG), { recursive: true });
	const log = openSync(LOG, "w");
	const child = spawn(command, {
		shell: true,
		env: {
			...Object.fromEntries(Object.entries(process.env).filter(([k]) => !secrets.has(k))),
			HARNESS_URL: launch.url,
			HARNESS_CHARACTER: launch.character,
			// always set, so one left in the shell does not reach a character without `listen`
			HARNESS_LISTEN: listenEnv(launch.listen),
		},
		stdio: ["ignore", log, log],
		// its own process group, so stopping it reaches whatever the command starts
		detached: true,
	});
	child.on("exit", (code, signal) => onExit(code, signal));
	child.on("error", (e) => {
		console.error(`could not start the player: ${e.message}`);
		onExit(1, null);
	});
	console.log(`player starting (log: ${playerLog})`);
	return () => {
		try {
			if (child.pid) process.kill(-child.pid, "SIGTERM");
		} catch {
			// already gone
		}
	};
}
