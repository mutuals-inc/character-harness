#!/usr/bin/env bash
# Builds the macOS player from a release tag, signs it, and attaches it to a
# draft GitHub release. Signed and notarized with a Developer ID:
#
#   MACOS_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)" \
#   MACOS_NOTARY_PROFILE=<profile> \
#   player/release-macos.sh v0.1.0-macos-arm64 [--no-release]
#
# or, with neither set, unsigned: signed ad hoc and not notarized, so macOS
# asks people to allow it on its first start (player/README.md says how).
#
# Needs, on this Mac:
# - the Kaigen SDK linked at player/hz, with your Kaigen licence activated
# - for a signed release: a Developer ID Application certificate in the
#   keychain and a notarytool keychain profile
#   (xcrun notarytool store-credentials <profile>)
# - gh, signed in with access to the repo
#
# The tag must be checked out with a clean tree and pushed. The version comes
# from the tag (v0.1.0-macos-arm64 -> 0.1.0). --no-release builds and signs (and
# notarizes, if signed) but leaves the files in player/out/release/ without
# creating the release.
#
# The engine's publish build makes the app; this script signs it, because the
# app needs the microphone entitlement (macos.entitlements) under the
# hardened runtime, then notarizes a signed one and packages the .zip and .dmg.
set -euo pipefail

tag="${1:-}"
create_release=true
case "$#:${2:-}" in
	1:) ;;
	2:--no-release) create_release=false ;;
	*) echo "usage: $0 vMAJOR.MINOR.PATCH-macos-arm64 [--no-release]" >&2; exit 1 ;;
esac
if [[ ! "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-macos-arm64$ ]]; then
	echo "usage: $0 vMAJOR.MINOR.PATCH-macos-arm64 [--no-release]" >&2
	exit 1
fi
version="${BASH_REMATCH[1]}"
# both set: signed and notarized; neither: unsigned
signed=false
if [ -n "${MACOS_SIGNING_IDENTITY:-}" ] && [ -n "${MACOS_NOTARY_PROFILE:-}" ]; then
	signed=true
elif [ -n "${MACOS_SIGNING_IDENTITY:-}${MACOS_NOTARY_PROFILE:-}" ]; then
	echo "set both MACOS_SIGNING_IDENTITY and MACOS_NOTARY_PROFILE for a signed release, or neither for an unsigned one" >&2
	exit 1
else
	echo "no signing identity: making an unsigned release (signed ad hoc, not notarized)" >&2
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
	# an annotated tag lists its commit on the ^{} line
	remote="$(git -C "$repo_root" ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}" |
		awk '$2 ~ /\^\{\}$/ { peeled = $1 } $2 !~ /\^\{\}$/ { plain = $1 } END { print peeled ? peeled : plain }')"
	if [ "$remote" != "$commit" ]; then
		echo "$tag on origin is not this commit; push it (git push origin $tag)" >&2
		exit 1
	fi
fi
[ -x hz/hzbuild ] || { echo "player/hz is not linked to a Kaigen SDK (see player/README.md)" >&2; exit 1; }

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
rm -rf cooked/vrm out/macos/publish
hz/hzbuild macos publish

apps=(out/macos/publish/*.app)
if [ ${#apps[@]} -ne 1 ] || [ ! -d "${apps[0]}" ]; then
	echo "the publish build did not produce one .app in out/macos/publish" >&2
	exit 1
fi
app="${apps[0]}"
mkdir -p "$app/Contents/Resources"
cp "$repo_root/LICENSE" "$app/Contents/Resources/LICENSE.txt"
cp "$repo_root/NOTICE" "$app/Contents/Resources/NOTICE.txt"
name="$(basename "$app" .app)"
out="out/release"
rm -rf "$out"
mkdir -p "$out"
zip="$out/character-player-$version-macos-arm64.zip"
dmg="$out/character-player-$version-macos-arm64.dmg"

if $signed; then
	sign() { codesign --force --timestamp --options runtime -s "$MACOS_SIGNING_IDENTITY" "$@"; }
else
	sign() { codesign --force --options runtime -s - "$@"; }
fi
notarize() { xcrun notarytool submit "$1" --keychain-profile "$MACOS_NOTARY_PROFILE" --wait; }

# code nested in the app is signed before the app itself
if [ -d "$app/Contents/Frameworks" ]; then
	find "$app/Contents/Frameworks" -depth \( -name "*.dylib" -o -name "*.framework" \) -print0 |
		while IFS= read -r -d '' nested; do sign "$nested"; done
fi
sign --entitlements macos.entitlements "$app"
codesign --verify --strict --verbose=2 "$app"
entitlements="$(codesign -d --entitlements - "$app" 2>/dev/null)"
grep -q "com.apple.security.device.audio-input" <<<"$entitlements" ||
	{ echo "the signed app is missing the microphone entitlement" >&2; exit 1; }

# when signed, the app is notarized through a zip of it, then the ticket is
# stapled to it, so it opens offline too; the zip and the disk image are made
# from the app after that
if $signed; then
	ditto -c -k --keepParent "$app" "$out/notarize.zip"
	notarize "$out/notarize.zip"
	rm "$out/notarize.zip"
	xcrun stapler staple "$app"
fi
ditto -c -k --keepParent "$app" "$zip"

stage="$out/dmg"
mkdir -p "$stage"
ditto "$app" "$stage/$name.app"
ln -s /Applications "$stage/Applications"
hdiutil create -volname "$name" -srcfolder "$stage" -ov -format UDZO "$dmg"
rm -rf "$stage"
if $signed; then
	codesign --force --timestamp -s "$MACOS_SIGNING_IDENTITY" "$dmg"
	notarize "$dmg"
	xcrun stapler staple "$dmg"
	spctl -a -t exec -vv "$app"
	spctl -a -t open --context context:primary-signature -vv "$dmg"
fi

(cd "$out" && shasum -a 256 character-player-* > SHA256SUMS)
cat "$out/SHA256SUMS"

if ! $create_release; then
	echo "built $out; no release created"
	exit 0
fi
notes="$out/notes.md"
if $signed; then
	kind="signed and notarized"
else
	kind="unsigned: macOS blocks it on its first start; see \`player/README.md\` for allowing it"
fi
cat > "$notes" <<EOF
The player app for macOS (Apple Silicon), $kind.

Built from $tag ($commit) with Kaigen $(sed -n 's/^engine_version //p' hzproject.hzt). See \`player/README.md\` for installing it and pointing the runtime at it.

SHA-256:

\`\`\`
$(cat "$out/SHA256SUMS")
\`\`\`
EOF
gh release create "$tag" --draft --verify-tag --title "v$version - macOS Apple Silicon" --notes-file "$notes" "$dmg" "$zip" "$out/SHA256SUMS"
echo "draft release $tag created; review it on GitHub and publish it"
