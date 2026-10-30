#!/usr/bin/env bash
# Builds the WebAssembly player from a release tag, packages it as a .tar.gz
# for Studio's Browser mode and attaches it to a draft GitHub release:
#
#   player/release-web.sh v0.1.0-web-wasm [--no-release]
#
# Needs, on this Linux machine:
# - the Kaigen SDK linked at player/hz with its wasm component, and your Kaigen
#   licence activated
# - a Vulkan device for the cook (on a machine without a GPU, Mesa's lavapipe:
#   point VK_ICD_FILENAMES at its lvp_icd.json)
# - node (to look inside the brotli files), and gh, signed in with access to
#   the repo
#
# The tag must be checked out with a clean tree and pushed. The version comes
# from the tag (v0.1.0-web-wasm -> 0.1.0). --no-release builds and packages but
# leaves the files in player/out/release/web-wasm/ without creating the release.
set -euo pipefail

tag="${1:-}"
create_release=true
case "$#:${2:-}" in
	1:) ;;
	2:--no-release) create_release=false ;;
	*) echo "usage: $0 vMAJOR.MINOR.PATCH-web-wasm [--no-release]" >&2; exit 1 ;;
esac
if [[ ! "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-web-wasm$ ]]; then
	echo "usage: $0 vMAJOR.MINOR.PATCH-web-wasm [--no-release]" >&2
	exit 1
fi
version="${BASH_REMATCH[1]}"
if [ "$(uname -s)" != "Linux" ]; then
	echo "run this on Linux" >&2
	exit 1
fi

cd "$(dirname "$0")"
repo_root="$(git rev-parse --show-toplevel)"
if [ -n "$(git -C "$repo_root" status --porcelain)" ]; then
	echo "the tree has changes; release from a clean checkout of $tag" >&2
	exit 1
fi
if ! git -C "$repo_root" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
	echo "there is no tag $tag; create and push it first" >&2
	exit 1
fi
commit="$(git -C "$repo_root" rev-parse HEAD)"
if [ "$commit" != "$(git -C "$repo_root" rev-parse "$tag^{commit}")" ]; then
	echo "HEAD is not $tag; check it out first" >&2
	exit 1
fi
# the release is made from the tag on GitHub, so it must be there, on this commit
if $create_release; then
	command -v gh >/dev/null || { echo "gh is not installed" >&2; exit 1; }
	# an annotated tag lists its commit on the ^{} line
	remote="$(git -C "$repo_root" ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}" |
		awk '$2 ~ /\^\{\}$/ { peeled = $1 } $2 !~ /\^\{\}$/ { plain = $1 } END { print peeled ? peeled : plain }')"
	if [ "$remote" != "$commit" ]; then
		echo "$tag on origin is not this commit; push it (git push origin $tag)" >&2
		exit 1
	fi
fi
[ -x hz/hzbuild ] || { echo "player/hz is not linked to a Kaigen SDK (see player/README.md)" >&2; exit 1; }
for tool in python3 node sha256sum; do
	command -v "$tool" >/dev/null || { echo "$tool is not installed" >&2; exit 1; }
done
engine_version="$(sed -n 's/^engine_version //p' hzproject.hzt)"

# The version goes into hzproject.hzt only for this build; the file is put
# back however the build ends.
unpacked=""
cp hzproject.hzt hzproject.hzt.release-backup
trap 'mv -f hzproject.hzt.release-backup hzproject.hzt; [ -z "$unpacked" ] || rm -rf "$unpacked"' EXIT
python3 - "$version" <<'EOF'
import re, sys
s = open("hzproject.hzt").read()
s, n = re.subn(r"^(  version ).*$", lambda m: m.group(1) + sys.argv[1], s, flags=re.M)
if n != 1:
	sys.exit("hzproject.hzt: expected one publish version line")
open("hzproject.hzt", "w").write(s)
EOF

# what the player cached while developing must not ship
rm -rf cooked/vrm out/wasm/publish
hz/hzbuild wasm publish

# the engine puts the web build in a folder in out/wasm/publish/<project>/
bundles=()
while IFS= read -r -d '' found; do bundles+=("$found"); done < <(find out/wasm/publish -mindepth 2 -maxdepth 2 -type d -print0)
if [ ${#bundles[@]} -ne 1 ]; then
	echo "the publish build did not produce one folder in out/wasm/publish" >&2
	exit 1
fi
bundle="${bundles[0]}"
# what Studio serves; index.html is the engine's test page and _headers is for
# static hosts, so neither ships. Anything else new has to be looked at first
files=(main.js main_worker.js worker.js audio_worklet.js mic_worklet.js game.wasm.br)
for name in "${files[@]}"; do
	[ -f "$bundle/$name" ] || { echo "the publish build left no $name in $bundle" >&2; exit 1; }
done
unknown="$(find "$bundle" -mindepth 1 -maxdepth 1 ! -name cooked ! -name index.html ! -name _headers \
	$(printf '! -name %s ' "${files[@]}") -print)"
if [ -n "$unknown" ]; then
	echo "the publish build made files this script doesn't know; check them:" >&2
	echo "$unknown" >&2
	exit 1
fi
cooked="$bundle/cooked"
[ -f "$cooked/catalog.hza" ] || { echo "the publish build left no cooked/catalog.hza" >&2; exit 1; }
[ -f "$cooked/characters/foxglove.hza" ] || { echo "the publish build has no FoxGlove profile" >&2; exit 1; }
# a link would ship pointing at this machine
if [ -n "$(find "$cooked" -type l -print -quit)" ]; then
	echo "$cooked has symlinks; remove them before a release" >&2
	exit 1
fi

out="out/release/web-wasm"
name="character-player-$version-web-wasm"
stage="$out/$name"
rm -rf "$out"
mkdir -p "$stage"
for name_ in "${files[@]}"; do cp "$bundle/$name_" "$stage/"; done
cp -R "$cooked" "$stage/cooked"
# .zst files are for native builds; gameplay_blocks are the engine's sample
# assets, which the player doesn't use
rm -rf "$stage/cooked/vrm" "$stage/cooked/cook_deps" "$stage/cooked/gameplay_blocks"
find "$stage/cooked" -name '*.zst' -type f -delete
cp "$repo_root/LICENSE" "$stage/LICENSE.txt"
cp "$repo_root/NOTICE" "$stage/NOTICE.txt"
cp assets/vad/LICENSE "$stage/LICENSE-silero-vad.txt"
cat > "$stage/README.txt" <<EOF
Character Player $version - web (WebAssembly)

The player built for the browser, for Character Studio's Browser mode. It is
not a website on its own: Studio serves it, with the headers it needs, and
drives it with the conversation's cues. It shows the FoxGlove profile cooked
into it and can't import a .vrm. No Kaigen installation or licence is needed
to run it.

From a matching character-harness source checkout, run from the repo root:
  npm run web-player -- download $tag

or extract this folder's contents into .cache/web-player/ yourself. Then
start Studio (npm run frontend) and open it in a recent Chrome or Edge,
with WebGPU.

Built from $tag ($commit), Kaigen $engine_version.
EOF

# nothing in the package may point back at this machine or carry a licence
# key. The .br files are brotli, so they are checked unpacked as well
unpacked="$(mktemp -d)"
node -e '
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const [from, to] = process.argv.slice(1);
(function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(file);
		else if (entry.name.endsWith(".br")) {
			const target = path.join(to, path.relative(from, file));
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, zlib.brotliDecompressSync(fs.readFileSync(file)));
		}
	}
})(from);
' "$stage" "$unpacked"
here=(-e "$repo_root" -e "$(readlink -f hz)" -e "KGEN-")
[ -n "${HOME:-}" ] && [ "$HOME" != / ] && here+=(-e "$HOME/")
# grep finds nothing: 1; fails: 2
leaks="$(grep -rlaF "${here[@]}" "$stage" "$unpacked")" && status=0 || status=$?
[ "$status" -le 1 ] || exit 1
if [ -n "$leaks" ]; then
	echo "these files name paths on this machine or a licence key; check them:" >&2
	echo "$leaks" >&2
	exit 1
fi

tarball="$out/$name.tar.gz"
# owned by root:root in the archive, in a stable order, so it unpacks the same
# for everyone
tar -C "$out" --sort=name --owner=0 --group=0 --numeric-owner \
	--mtime="@$(git -C "$repo_root" log -1 --format=%ct)" -cf - "$name" | gzip -n > "$tarball"
sums="$out/SHA256SUMS-web-wasm"
(cd "$out" && sha256sum "$name.tar.gz") > "$sums"
cat "$sums"

if ! $create_release; then
	echo "built $out; no release created"
	exit 0
fi
notes="$out/notes.md"
source_url="https://github.com/mutuals-inc/character-harness/blob/$tag"
cat > "$notes" <<EOF
Web player v$version, for Character Studio's Browser mode. With it, Studio shows FoxGlove with Kaigen's own renderer and shaders instead of three.js. It isn't a website on its own; Studio serves it. The compiled engine and FoxGlove model and animations are included; no Kaigen installation or licence is required.

### Use it in Studio

1. Install Node.js 24 or later and download this tag's **Source code (tar.gz)**, or use a checkout of $tag.
2. From the harness root, run \`npm ci\`, \`npm --prefix frontend ci\`, then:

\`\`\`sh
npm run web-player -- download $tag
\`\`\`

   It downloads **$(basename "$tarball")**, checks it against **SHA256SUMS-web-wasm** and unpacks it into \`.cache/web-player/\`.
3. Run \`npm run frontend\` and open http://127.0.0.1:4173 in a recent Chrome or Edge, with WebGPU.

Without WebGPU, in other browsers, or for characters with a \`.vrm\` model, Studio uses three.js as before. Conversations need Node and provider API keys; provider usage is billed to your accounts.

See the [Studio README]($source_url/frontend/README.md) and the [player README]($source_url/player/README.md#studio-in-a-browser-webassembly).

Verify the download with \`sha256sum -c SHA256SUMS-web-wasm\`.
Built from $tag ($commit), Kaigen $engine_version.

SHA-256:
\`\`\`text
$(cat "$sums")
\`\`\`
EOF
# a rerun puts the files on the draft it made before; a published release is
# never changed
if ! draft="$(gh release view "$tag" --json isDraft --jq .isDraft 2>"$out/gh-error")"; then
	if grep -qi "not found" "$out/gh-error"; then
		draft=none
	else
		cat "$out/gh-error" >&2
		exit 1
	fi
fi
rm -f "$out/gh-error"
if [ "$draft" = "false" ]; then
	echo "release $tag is already published; make a new version instead" >&2
	exit 1
elif [ "$draft" = "true" ]; then
	gh release upload "$tag" --clobber "$tarball" "$sums"
	gh release edit "$tag" --notes-file "$notes"
	echo "files on draft $tag replaced; review it on GitHub and publish it"
else
	# none: no release with this tag yet
	gh release create "$tag" --draft --verify-tag --title "v$version - Web (WebAssembly)" --notes-file "$notes" "$tarball" "$sums"
	echo "draft release $tag created; review it on GitHub and publish it"
fi
