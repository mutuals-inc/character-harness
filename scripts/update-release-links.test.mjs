import assert from "node:assert/strict";
import test from "node:test";
import { releaseLinks, updateReadme } from "./update-release-links.mjs";

test("selects the highest version separately for each platform, including previews", () => {
	const releases = [
		{ tag_name: "v0.9.0-windows-x64" },
		{ tag_name: "v0.10.0-windows-x64", prerelease: true },
		{ tag_name: "v0.8.0-macos-arm64" },
		{ tag_name: "v0.10.0-macos-arm64", draft: true },
		{ tag_name: "v99.0.0" },
		{ tag_name: "v0.1.0-linux-x64" },
	];
	const links = releaseLinks(releases, "mutuals-inc/character-harness");
	assert.match(links, /Windows x64 — v0\.10\.0-windows-x64 \(pre-release\)/);
	assert.match(links, /macOS Apple Silicon — v0\.8\.0-macos-arm64/);
	assert.match(links, /Linux x64 — v0\.1\.0-linux-x64/);
	assert.doesNotMatch(links, /v0\.9\.0|v99|v0\.10\.0-macos/);
	assert.equal(links, releaseLinks(releases.toReversed(), "mutuals-inc/character-harness"));
});

test("handles no releases and rejects invalid repository names", () => {
	assert.equal(releaseLinks([], "owner/repo"), "No player builds have been published yet.");
	assert.throws(() => releaseLinks([], "owner/repo/extra"));
});

test("updates only the marked block, preserves CRLF, and is idempotent", () => {
	const before = "Intro\r\n<!-- player-releases:start -->\r\nold\r\n<!-- player-releases:end -->\r\nRest\r\n";
	const updated = updateReadme(before, "one\ntwo");
	assert.equal(updated, before.replace("old", "one\r\ntwo"));
	assert.equal(updateReadme(updated, "one\ntwo"), updated);
	assert.throws(() => updateReadme("no markers", "links"));
	assert.throws(() => updateReadme(before + before, "links"));
	assert.throws(() => updateReadme("<!-- player-releases:end --><!-- player-releases:start -->", "links"));
});
