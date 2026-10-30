#!/usr/bin/env bash
# Builds the Linux x64 player from a release tag, packages it as a .tar.gz and
# attaches it to a draft GitHub release:
#
#   player/release-linux.sh v0.1.0-linux-x64 [--no-release]
#
# Needs, on this x86_64 Linux machine:
# - the Kaigen SDK linked at player/hz, with your Kaigen licence activated
# - a Vulkan device for the cook (on a machine without a GPU, Mesa's lavapipe:
#   point VK_ICD_FILENAMES at its lvp_icd.json)
# - gh, signed in with access to the repo
#
# The tag must be checked out with a clean tree and pushed. The version comes
# from the tag (v0.1.0-linux-x64 -> 0.1.0). --no-release builds and packages
# but leaves the files in player/out/release/linux-x64/ without creating the
# release.
set -euo pipefail

tag="${1:-}"
create_release=true
case "$#:${2:-}" in
	1:) ;;
	2:--no-release) create_release=false ;;
	*) echo "usage: $0 vMAJOR.MINOR.PATCH-linux-x64 [--no-release]" >&2; exit 1 ;;
esac
if [[ ! "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-linux-x64$ ]]; then
	echo "usage: $0 vMAJOR.MINOR.PATCH-linux-x64 [--no-release]" >&2
	exit 1
fi
version="${BASH_REMATCH[1]}"
if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
	echo "run this on x86_64 Linux" >&2
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
for tool in python3 readelf sha256sum; do
	command -v "$tool" >/dev/null || { echo "$tool is not installed" >&2; exit 1; }
done
engine_version="$(sed -n 's/^engine_version //p' hzproject.hzt)"

# The version goes into hzproject.hzt only for this build; the file is put
# back however the build ends.
cp hzproject.hzt hzproject.hzt.release-backup
trap 'mv -f hzproject.hzt.release-backup hzproject.hzt' EXIT
python3 - "$version" <<'EOF'
import re, sys
s = open("hzproject.hzt").read()
s, n = re.subn(r"^(  version ).*$", lambda m: m.group(1) + sys.argv[1], s, flags=re.M)
if n != 1:
	sys.exit("hzproject.hzt: expected one publish version line")
open("hzproject.hzt", "w").write(s)
EOF

# what the player cached while developing must not ship
rm -rf cooked/vrm out/linux/publish
hz/hzbuild linux publish

# the engine puts the app in a folder in out/linux/publish: the executable, its
# cooked assets and a release entry for the engine's own update hosting, which
# this release doesn't use. Debug symbols and objects go elsewhere in out/linux.
bundles=()
while IFS= read -r -d '' found; do bundles+=("$found"); done < <(find out/linux/publish -mindepth 1 -maxdepth 1 -type d -print0)
if [ ${#bundles[@]} -ne 1 ]; then
	echo "the publish build did not produce one folder in out/linux/publish" >&2
	exit 1
fi
bundle="${bundles[0]}"
exes=()
while IFS= read -r -d '' found; do exes+=("$found"); done < <(find "$bundle" -mindepth 1 -maxdepth 1 -type f -perm -u+x -print0)
if [ ${#exes[@]} -ne 1 ]; then
	echo "the publish build did not produce one executable in $bundle" >&2
	exit 1
fi
exe="${exes[0]}"
exe_name="$(basename "$exe")"
# anything else the engine starts putting there has to be looked at before it ships
unknown="$(find "$bundle" -mindepth 1 -maxdepth 1 ! -path "$exe" ! -name cooked ! -name '*.entry.hzt' -print)"
if [ -n "$unknown" ]; then
	echo "the publish build made files this script doesn't know; check them:" >&2
	echo "$unknown" >&2
	exit 1
fi
sections="$(readelf -SW "$exe")"
if grep -q ' \.debug_' <<<"$sections"; then
	echo "$exe has debug sections; a publish build should not" >&2
	exit 1
fi
# the publish build copies the cooked assets beside the executable; the
# player's own cooked/ may hold leftovers from development, so it isn't used
cooked="$bundle/cooked"
[ -f "$cooked/catalog.hza" ] || { echo "the publish build left no cooked/catalog.hza beside the executable" >&2; exit 1; }
# a link would ship pointing at this machine
if [ -n "$(find "$cooked" -type l -print -quit)" ]; then
	echo "$cooked has symlinks; remove them before a release" >&2
	exit 1
fi

out="out/release/linux-x64"
name="character-player-$version-linux-x64"
stage="$out/$name"
rm -rf "$out"
mkdir -p "$stage"
cp "$exe" "$stage/"
cp -R "$cooked" "$stage/cooked"
# .br files are for the web build; gameplay_blocks are the engine's sample
# assets, which the player doesn't use
rm -rf "$stage/cooked/vrm" "$stage/cooked/cook_deps" "$stage/cooked/gameplay_blocks"
find "$stage/cooked" -name '*.br' -type f -delete
cp "$repo_root/LICENSE" "$stage/LICENSE.txt"
cp "$repo_root/NOTICE" "$stage/NOTICE.txt"
cp assets/vad/LICENSE "$stage/LICENSE-silero-vad.txt"
cat > "$stage/README.txt" <<EOF
Character Player $version - Linux x64

Keep this entire folder together: the player, its cooked/ assets and the
licences. Put it somewhere you can write to, like your home folder; the player
keeps its cache of imported models in cooked/vrm/ here, and its logs in
~/.local/share/$exe_name/. This is the player, not the Node conversation
runtime. No Kaigen installation or licence is needed to run it.

It needs an x86_64 Linux desktop (X11 or Wayland), a Vulkan driver (Mesa's
mesa-vulkan-drivers, or your GPU vendor's) and a microphone through PulseAudio
or PipeWire (pipewire-pulse).

From a matching character-harness source checkout:
  npm ci --omit=dev
  cp .env.example .env

Add your XAI_API_KEY and ELEVENLABS_API_KEY to .env, then set:
  HARNESS_PLAYER="'/path/to/$name/$exe_name'"

From the harness root run:
  npm start

Then speak first.
Built from $tag ($commit), Kaigen $engine_version.
EOF
# nothing in the package may point back at this machine
here=(-e "$repo_root" -e "$(readlink -f hz)")
[ -n "${HOME:-}" ] && [ "$HOME" != / ] && here+=(-e "$HOME/")
# grep finds nothing: 1; fails: 2
leaks="$(grep -rlaF "${here[@]}" "$stage")" && status=0 || status=$?
[ "$status" -le 1 ] || exit 1
if [ -n "$leaks" ]; then
	echo "these files name paths on this machine; check them:" >&2
	echo "$leaks" >&2
	exit 1
fi

tarball="$out/$name.tar.gz"
# owned by root:root in the archive, in a stable order, so it unpacks the same
# for everyone; the executable keeps its mode
tar -C "$out" --sort=name --owner=0 --group=0 --numeric-owner \
	--mtime="@$(git -C "$repo_root" log -1 --format=%ct)" -cf - "$name" | gzip -n > "$tarball"
sums="$out/SHA256SUMS-linux-x64"
(cd "$out" && sha256sum "$name.tar.gz") > "$sums"
cat "$sums"

if ! $create_release; then
	echo "built $out; no release created"
	exit 0
fi
notes="$out/notes.md"
source_url="https://github.com/mutuals-inc/character-harness/blob/$tag"
cat > "$notes" <<EOF
Linux x64 player v$version. Download and extract **$(basename "$tarball")** somewhere you can write to, like your home folder, and keep the folder together. It needs a Vulkan driver (Mesa's \`mesa-vulkan-drivers\` or your GPU vendor's) and PulseAudio or PipeWire for the microphone. The compiled engine and FoxGlove model and animations are included; no Kaigen installation or licence is required.

### Run the full harness

1. Install Node.js 24 or later and download this tag's **Source code (tar.gz)**.
2. Extract the source, open a terminal in its root (beside package.json), and run \`npm ci --omit=dev\`.
3. Copy \`.env.example\` to \`.env\` and add your own \`XAI_API_KEY\` and \`ELEVENLABS_API_KEY\`.
4. Set \`HARNESS_PLAYER\` in \`.env\` to the extracted player, keeping both quote levels:

\`\`\`dotenv
HARNESS_PLAYER="'/home/you/Apps/$name/$exe_name'"
\`\`\`

5. Run \`npm run check -- characters/foxglove\`, then \`npm start\` from the harness root.
   The runtime opens the player automatically. **Speak first**.

The player alone does not run the conversation; Node and provider API keys are required.
FoxGlove needs no additional animation setup. Provider usage is billed to your accounts.
For startup problems, read the terminal output and \`.cache/player.log\`.

See the [harness quickstart]($source_url/README.md#quickstart),
[Linux installation guide]($source_url/player/README.md#install-a-release-linux),
[custom character guide]($source_url/docs/bring-your-own-character.md), and
[architecture]($source_url/docs/architecture.md).

Verify the download with \`sha256sum -c SHA256SUMS-linux-x64\`.
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
	gh release create "$tag" --draft --verify-tag --title "v$version - Linux x64" --notes-file "$notes" "$tarball" "$sums"
	echo "draft release $tag created; review it on GitHub and publish it"
fi
