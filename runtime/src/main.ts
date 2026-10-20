// npm start [characters/<id>]
// npm run check [characters/<id>]
//
// Loads the character and its extensions, checks it (check.ts: every key it
// needs is in .env, its body, what its extensions ask of the player), prepares
// the model the player shows (rig/prepare.ts), serves the app's session socket
// on ws://HOST:PORT/session/<token> and its offers link on
// ws://HOST:PORT/session/<token>/offers (offers.ts), and starts the player when HARNESS_PLAYER
// gives the command that opens it (player.ts). With --check it stops after the
// checks and prints them all; a missing key or .env is then only a warning.
// HOST defaults to 127.0.0.1; set HOST=0.0.0.0 to reach it from another device on the network.
//
// The socket spends the keys in .env, so only the player may use it: the
// token is new on every start and only the player is given it, and a
// connection from a web page (any request with an Origin) is refused.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseEnv } from "node:util";
import path from "node:path";
import { WebSocketServer } from "ws";
import { checkCharacter, printable, printReport, shortPath } from "./check.ts";
import { loadExtensions } from "./extensions.ts";
import { ManifestError, loadCharacter, requiredKeys } from "./manifest.ts";
import { manualStart, playerLog, startPlayer, type PlayerLaunch } from "./player.ts";
import { runSession } from "./session.ts";
import { LinkServer } from "./offers.ts";

function fail(message: string): never {
	console.error(printable(message));
	process.exit(1);
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const unknownFlag = args.find((a) => a.startsWith("--") && a !== "--check");
if (unknownFlag) fail(`unknown option ${unknownFlag}; the only one is --check`);
const dir = path.resolve(args.find((a) => !a.startsWith("--")) ?? "characters/foxglove");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8788);
// the largest message the app sends is an `llm` with the whole conversation
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
// the offers link carries small JSON: a status, an ack
const MAX_LINK_MESSAGE_BYTES = 64 * 1024;

let character;
try {
	character = loadCharacter(dir);
} catch (e) {
	fail(e instanceof ManifestError ? e.message : String(e));
}

const hasEnv = existsSync(character.env_file);
if (!hasEnv && !checkOnly)
	fail(`${character.env_file} does not exist. Copy .env.example to .env and fill in the keys.`);
if (hasEnv) process.loadEnvFile(character.env_file);
// what the player must not inherit: every key the character names, and
// everything .env sets except the player's own HARNESS_* settings
const secrets = new Set([
	...requiredKeys(character),
	...(hasEnv ? Object.keys(parseEnv(readFileSync(character.env_file, "utf8"))) : []).filter((k) => !k.startsWith("HARNESS_")),
]);

const extensions = await loadExtensions(character.extensions).catch((e: unknown) =>
	fail(e instanceof Error ? e.message : String(e)),
);

// the checks prepare the model too, as the player will show it
const report = await checkCharacter(character, extensions, process.env, !checkOnly);
if (checkOnly) {
	printReport(character, report, true);
	// the report goes out whole before the process ends, even into a pipe
	await new Promise((done) => process.stdout.write("", done));
	process.exit(report.errors.length ? 1 : 0);
}
printReport(character, report, false);
if (report.errors.length) fail(`${character.name} can't start; \`npm run check -- ${shortPath(dir)}\` shows every check`);
if (report.prepared?.rebuilt && character.rig.kind === "model")
	console.log(printable(`prepared ${path.basename(character.rig.model)} with ${report.prepared.clips} animations`));

// what the player shows: a profile cooked into its build, or the character's
// model with its animations baked in
const shown = character.rig.kind === "profile" ? character.rig.profile : report.prepared!.file;

const server = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end(`mutuals character harness: ${character.name}. The player connects to the session socket the runtime printed.\n`);
});
const token = randomBytes(16).toString("hex");
const sessionPath = `/session/${token}`;
const linkPath = `${sessionPath}/offers`;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
const links = new WebSocketServer({ noServer: true, maxPayload: MAX_LINK_MESSAGE_BYTES });
server.on("upgrade", (req, socket, head) => {
	const at = new URL(req.url ?? "/", "http://localhost").pathname;
	const to = at === sessionPath ? wss : at === linkPath ? links : null;
	// the player sends no Origin; a browser always does
	if (!to || req.headers.origin !== undefined) {
		socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
		socket.destroy();
		return;
	}
	to.handleUpgrade(req, socket, head, (ws) => to.emit("connection", ws, req));
});

// The player keeps one offers link, and a newer one replaces it. Every session
// hears it, so the link outlives a session socket that reconnects.
const hub = new LinkServer();
links.on("connection", (ws) => hub.attach(ws));
wss.on("connection", (ws) => runSession(ws, character, extensions, hub));
const listenFailed = (e: Error) => fail(`could not listen on ${host}:${port}: ${e.message}`);
server.on("error", listenFailed);
server.listen(port, host, () => {
	const exts = extensions.map((e) => e.name).join(", ") || "none";
	console.log(printable(`${character.name} on ws://${host}:${port}${sessionPath} (extensions: ${exts})`));
	// the player is local: loopback, unless the runtime listens on one address only
	const reach = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	const launch: PlayerLaunch = { url: `ws://${reach}:${port}${sessionPath}`, character: shown };
	const where = process.env.HARNESS_PLAYER;
	if (!where) {
		console.log(`start the player with:\n  ${manualStart(launch)}`);
		return;
	}
	try {
		const stopPlayer = startPlayer(where, launch, secrets, (code, signal) => {
			if (code) fail(`the player exited with ${code}; see ${playerLog}`);
			if (signal) fail(`the player was stopped by ${signal}; see ${playerLog}`);
			console.log("the player closed");
			process.exit(0);
		});
		// the player runs in its own process group, so every way out stops it
		process.on("exit", stopPlayer);
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
	} catch (e) {
		fail(e instanceof Error ? e.message : String(e));
	}
});
