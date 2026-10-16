# Player

The app that shows the character: it renders it, plays its voice, captures the mic, and talks to the runtime over the session WebSocket (`../docs/protocol.md`). It is written in C on the [Kaigen](https://kaigen3d.com) engine.

Ready-made builds are on this repo's GitHub Releases; using one needs no Kaigen licence. To change the player, you build it yourself, which needs a Kaigen licence.

## Install a release (macOS)

1. Download `character-player-<version>-macos-arm64.dmg` and `SHA256SUMS` from the release (Apple Silicon Macs), and check it (`shasum -a 256 -c --ignore-missing SHA256SUMS`).
2. Open it and drag Character Player to Applications.

   If the release notes say the build is unsigned, macOS blocks it the first time you open it. Open it once, then go to System Settings > Privacy & Security, click Open Anyway and confirm (on macOS 14 and earlier, Control-click the app and choose Open). Or, after checking the checksum, allow it from Terminal:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Character Player.app"
   ```

3. Put this in the harness's `.env`, so `npm start` opens it:

   ```
   HARNESS_PLAYER="'/Applications/Character Player.app/Contents/MacOS/'*"
   ```

4. On its first start, allow the microphone when macOS asks. When `npm start` opens the player, macOS asks for the app you ran `npm start` in (your terminal or editor); if it doesn't ask, allow it in System Settings > Privacy & Security > Microphone.

The app keeps what it writes, like the cache of imported models and its logs, in `~/Library/Application Support/com.mutuals.characterplayer`.

## Build

1. Install Kaigen and activate your licence (`kaigen activate <licence-key> --accept-terms`). The project is pinned to the engine version in `hzproject.hzt`.
2. Link this folder to the engine you installed (git ignores the link):

   ```bash
   ln -s "$HOME/Library/Application Support/hz/engines/<engine-version>" hz
   ```

3. Build and run:

   ```bash
   hz/hzbuild macos run
   ```

   The first build cooks the assets, which takes about half a minute. On macOS, allow microphone access for the app you start it from (System Settings > Privacy & Security > Microphone).

To have the runtime's `npm start` open it, put this in the harness's `.env`:

```
HARNESS_PLAYER="cd player && hz/hzbuild macos run"
```

### Windows

From `player/`, link the pinned engine with `kaigen restore`, then build with
`hz\hzbuild.exe windows` (add `run` to launch). The development executable is
`out/windows/debug/CharacterPlayer.exe`. For distribution, use the publish build
through `release-windows.ps1` below, rather than copying the debug executable.

## Install a release (Windows)

1. Download `character-player-<version>-windows-x64.zip` and
   `SHA256SUMS-windows-x64` from the GitHub release. Compare the ZIP's hash from
   `Get-FileHash .\character-player-<version>-windows-x64.zip -Algorithm SHA256`
   with the checksum file, then extract the ZIP to a permanent folder.
2. Keep the entire extracted folder together: its `.exe`, cooked assets and
   any DLLs. No Kaigen SDK, licence, compiler or Developer Mode is needed to run
   the player. The current Windows packages are unsigned.
3. Install Node 24 or later, download the matching harness source release and
   run these commands from its root:

   ```powershell
   npm.cmd install
   Copy-Item .env.example .env
   notepad .env
   ```

4. Fill in `XAI_API_KEY` and `ELEVENLABS_API_KEY`. Set `HARNESS_PLAYER` to the
   extracted executable, keeping the nested quotes for a path with spaces:

   ```dotenv
   HARNESS_PLAYER='"C:/Users/you/Apps/character-player-0.1.0-windows-x64/Character Player.exe"'
   ```

5. Run `npm.cmd start` from the harness root. It starts the runtime and the
   prebuilt player together. Allow microphone access for desktop apps in Windows
   Settings and speak first. The player alone does not run the conversation.

## Settings

The runtime sets the first two when it starts the player.

| Variable | Default | What |
|---|---|---|
| `HARNESS_URL` | `ws://127.0.0.1:8788/session` | the runtime's session socket. The runtime only accepts it with its token (`/session/<token>`), which it passes when it starts the player and prints otherwise |
| `HARNESS_CHARACTER` | | the character: a path to a `.vrm` / `.glb` (the runtime passes a prepared one), or the name of a profile cooked into the build (`foxglove`) |
| `HARNESS_MIC_DEBUG` | `0` | `1` logs what the mic hears twice a second |
| `HARNESS_PREVIEW` | | for checking a character without a conversation: `talk`, `talk:<style>`, `gesture:<name>` or `emotion:<name>`, repeated every few seconds |
| `HARNESS_SCREENSHOT` | | saves frame `HARNESS_SCREENSHOT_FRAME` (default 240) to this `.png` and quits |

## What it does

- Puts the character on the stage, with a portrait camera framed on the upper body.
- Runs the engine's voice session against the runtime. The engine owns the socket, voice activity detection, playback and lip sync.
- Applies beats: emotions reach the face, talking styles switch the body's loop, gestures play once, and camera words ease the framing toward `assets/mutuals/camera_moves.hzt`.
- Never speaks first.

## FoxGlove

FoxGlove is a profile cooked into the player (`assets/characters/foxglove.hzt`): her model, rig, face and expressions are in `assets/foxglove/`, with hair, skirt and bust physics and her own expression effects (sparkling eyes, tears, blush). Her idle loops, idle breaks and gestures are animations in her model, played through `assets/foxglove/states.hzt`, `assets/foxglove/emotes/` and `assets/mutuals/gestures.hzt`; their `.vrma` sources are in `characters/foxglove/animations/`. She has no talking loops yet: while she talks she stays in her idle loop.

## Loading a VRM

The runtime prepares a character's model: its `.vrm` with the character's animations retargeted onto it, and a table of which clip is idle, which talking style, which gesture. The first load imports it with the engine's glTF importer (`src/app/player_vrm.c`) and caches it under `cooked/vrm/<name>/` (in this folder for your own build, in the app's Application Support folder for a release), a few seconds for a typical model; later loads reuse the cache until the file changes.

- **Body:** the baked clips become the character's idle loop, talking styles and gestures. Without them it stands in its rest pose.
- **Face:** built from the model's own VRM expressions (happy, sad, blink, the vowels for lip sync), with the emotions in `assets/mutuals/emotions.hzt` mixed from those.
- **Rig:** head, neck, eyes and chest come from the model's VRM humanoid.
- **Hair and cloth:** the model's VRM spring bones, which the runtime lists in the same table, become bone cloth (`cooked/vrm/<name>/cloth/`), with their colliders.
- **Prepared by the runtime:** a model with several skins gets them merged into one, and a VRM 0.x model is turned to face forward with its MToon materials converted to VRM 1.0's (`runtime/src/rig/normalize.ts`), so load models through the runtime.
- **Not yet:** turning a VRM 0.x model whose joint or triangle data is stored sparse.

## Layout

| Path | What |
|---|---|
| `hzproject.hzt` | the project: name, folders, engine version, and the app's name, bundle id and version for a release |
| `release-macos.sh`, `macos.entitlements` | builds a release from a tag, signs it (ad hoc, or with a Developer ID and notarized), and attaches it to a draft GitHub release; the entitlements let the app use the mic |
| `src/app/player.c`, `player.h` | the app: init, frame loop, mic, beats, camera |
| `src/app/player_vrm.c`, `.h` | runtime VRM import and caching: clips, face, rig and the generated character profile |
| `src/app/player_json.c`, `.h` | a small JSON reader for the VRM extensions and the runtime's clip table |
| `src/app/app_character.c`, `.h`, `app_emote_clips.c` | loading and swapping the character, emote clips |
| `src/app/app.c` | the build's entry file, which includes the others |
| `src/app/app_config.h` | every tunable and launch setting |
| `assets/characters/foxglove.hzt`, `assets/foxglove/` | FoxGlove: her profile, model and animations, rig, face, expressions, physics, states and emotes |
| `assets/mutuals/` | the stage, camera moves, emotions, the gesture set of a cooked-in profile, the lip sync profile, an upper-body mask (empty; the engine expects one) |
| `assets/vad/` | the voice activity model ([Silero VAD](https://github.com/snakers4/silero-vad), MIT licence) |
| `shaders/mutuals/` | the toon and outline shaders |

## Releasing (macOS)

From a clean checkout of a `vX.Y.Z` tag pushed to GitHub, on a Mac with your Kaigen licence activated:

```bash
player/release-macos.sh vX.Y.Z
```

It builds the app with the engine's publish build, signs it ad hoc with the microphone entitlement (`macos.entitlements`), packages the `.zip` and `.dmg`, writes `SHA256SUMS`, and creates a draft release with them. Gatekeeper treats such a build as unsigned, so people allow it on its first start (see "Install a release"). With both a Developer ID Application certificate (`MACOS_SIGNING_IDENTITY`) and a notarytool keychain profile (`MACOS_NOTARY_PROFILE`) set, it signs and notarizes it instead, and it opens with no warning; set both or neither:

```bash
MACOS_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)" MACOS_NOTARY_PROFILE=<profile> player/release-macos.sh vX.Y.Z
```

Either way, review the draft and publish it. CI doesn't build the player, so releases are made this way.

## Releasing (Windows)

From a clean checkout of a `vX.Y.Z` tag, on Windows with the Kaigen SDK linked at
`player/hz`, an activated licence and the native toolchain installed:

```powershell
.\player\release-windows.ps1 v0.1.0 -NoRelease
```

The script temporarily sets the product version from the tag, removes cached
VRM imports and old publish output, runs `hz\hzbuild.exe windows publish`, and
restores `hzproject.hzt` even if the build fails. It packages the published
executable and runtime files, excluding linker intermediates, into:

```text
player/out/release/windows-x64/
  character-player-0.1.0-windows-x64/
    Character Player.exe
    ...published runtime files, README and licences...
  character-player-0.1.0-windows-x64.exe
  character-player-0.1.0-windows-x64.zip
  SHA256SUMS-windows-x64
```

During the release build, MSVC's compiler PDB is directed to
`out/windows/compiler/vc.pdb` using `/Fd`. The script preserves existing
compiler environment options and restores them after success or failure.
Direct `hzbuild` calls still use the SDK's default PDB location.

The `.exe` release asset is the native player application, also included inside
the ZIP. It needs any published runtime files beside it; it is not a
self-extracting installer. Recommend the ZIP for a complete download and keep
the separate EXE alongside those same-version runtime files when using it.
The script includes the external `cooked/` assets even when publish output omits
them from its publish output, including the `.zst` files the native publish
build reads. Browser-only `.br` sidecars are excluded.
The release packages the
player, like the macOS script; users still install Node, fetch the harness
source, configure their own keys and run `npm start` as described above.

For a local preview of uncommitted work, without creating a tag or uploading:

```powershell
.\player\release-windows.ps1 v0.1.0 -NoRelease -AllowDirty
```

To attach the EXE, ZIP and checksums to a draft GitHub release, push the tag and run
without `-NoRelease` (requires `gh` installed and authenticated):

```powershell
.\player\release-windows.ps1 v0.1.0
```

If a macOS draft already exists for the tag, the Windows assets are added to
it without replacing its notes or checksums. Existing assets are not silently
overwritten, and public releases are not modified. Review the draft before
publishing. Artifacts stay under the platform-specific output directory so
this script does not delete macOS packages.

The SDK must include `hz/tools/brotli/brotli.exe` for publish asset compression.
If it is missing, repair the SDK installation or obtain the missing build tool
from Kaigen before releasing. The release script checks this prerequisite but
does not modify the installed SDK. A successful development build does not
verify publish prerequisites.
