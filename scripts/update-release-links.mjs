// Update only the marked player download links in the root README.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const platforms = {
	"windows-x64": "Windows x64",
	"macos-arm64": "macOS Apple Silicon",
	"linux-x64": "Linux x64",
};

export function releaseLinks(releases, repository) {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
	const latest = new Map();
	for (const release of releases) {
		if (release.draft) continue;
		const match = /^v(\d+)\.(\d+)\.(\d+)-(windows-x64|macos-arm64|linux-x64)$/.exec(release.tag_name);
		if (!match) continue;
		const version = match.slice(1, 4).map(Number);
		const platform = match[4];
		const previous = latest.get(platform);
		const difference = previous && version.map((n, i) => n - previous.version[i]).find((n) => n !== 0);
		if (!previous || difference > 0) latest.set(platform, { release, version });
	}
	return Object.entries(platforms).flatMap(([platform, label]) => {
		const entry = latest.get(platform);
		if (!entry) return [];
		const { tag_name: tag, prerelease } = entry.release;
		return [`- [${label} — ${tag}${prerelease ? " (pre-release)" : ""}](https://github.com/${repository}/releases/tag/${tag})`];
	}).join("\n") || "No player builds have been published yet.";
}

export function updateReadme(readme, links) {
	const start = "<!-- player-releases:start -->";
	const end = "<!-- player-releases:end -->";
	if (readme.split(start).length !== 2 || readme.split(end).length !== 2 || readme.indexOf(start) > readme.indexOf(end)) {
		throw new Error("README must contain exactly one ordered pair of player release markers");
	}
	const newline = readme.includes("\r\n") ? "\r\n" : "\n";
	return readme.slice(0, readme.indexOf(start) + start.length) + newline +
		links.replaceAll("\n", newline) + newline + readme.slice(readme.indexOf(end));
}

async function main() {
	const repository = process.env.GITHUB_REPOSITORY ?? "mutuals-inc/character-harness";
	const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
	if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
	const releases = [];
	for (let page = 1; ; page++) {
		const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, { headers });
		if (!response.ok) throw new Error(`Cannot list releases: HTTP ${response.status}`);
		const batch = await response.json();
		releases.push(...batch);
		if (batch.length < 100) break;
	}
	const file = new URL("../README.md", import.meta.url);
	const readme = await readFile(file, "utf8");
	const updated = updateReadme(readme, releaseLinks(releases, repository));
	if (updated !== readme) await writeFile(file, updated);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
