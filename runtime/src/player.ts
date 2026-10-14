// Starts the player app next to the runtime, so `npm start` is the whole thing.
// HARNESS_PLAYER is the command that opens the player, run by the shell from
// the harness folder: the player binary's path, or any command line that stays
// running while the player is open (on macOS, the binary inside the .app, not
// `open -a`). Unset, the runtime only serves, and prints what the player needs
// to connect.
//
// The player gets HARNESS_URL and HARNESS_CHARACTER in its environment, and
// none of the keys: it never calls a provider itself. Its
// output goes to .cache/player.log; closing the player stops the runtime, and
// stopping the runtime closes the player.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

const LOG = path.resolve(import.meta.dirname, "../../.cache/player.log");
// where the player's output goes, as the console shows it
export const playerLog = path.relative(process.cwd(), LOG);

export interface PlayerLaunch {
	url: string; // the runtime's session socket
	character: string; // a prepared model file, or the name of a profile cooked into the player
}

// what to give the player when starting it by hand, for the console
export function manualStart(launch: PlayerLaunch, platform = process.platform): string {
	if (platform === "win32") {
		const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
		return `$env:HARNESS_URL=${quote(launch.url)}; $env:HARNESS_CHARACTER=${quote(launch.character)}`;
	}
	return `HARNESS_URL=${launch.url} HARNESS_CHARACTER=${JSON.stringify(launch.character)}`;
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
	const secretNames = new Set([...secrets].map((k) => process.platform === "win32" ? k.toLowerCase() : k));
	const child = spawn(command, {
		shell: true,
		env: {
			...Object.fromEntries(Object.entries(process.env).filter(([k]) => !secretNames.has(process.platform === "win32" ? k.toLowerCase() : k))),
			HARNESS_URL: launch.url,
			HARNESS_CHARACTER: launch.character,
		},
		stdio: ["ignore", log, log],
		// its own process group, so stopping it reaches whatever the command starts
		detached: true,
		windowsHide: true,
	});
	closeSync(log);
	let exited = false;
	child.on("exit", (code, signal) => {
		exited = true;
		onExit(code, signal);
	});
	child.on("error", (e) => {
		exited = true;
		console.error(`could not start the player: ${e.message}`);
		onExit(1, null);
	});
	console.log(`player starting (log: ${playerLog})`);
	return () => {
		if (exited || !child.pid) return;
		try {
			if (process.platform === "win32") {
				// exit handlers cannot wait for asynchronous process-tree cleanup.
				spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
			} else {
				process.kill(-child.pid, "SIGTERM");
			}
		} catch {
			// already gone
		}
	};
}
