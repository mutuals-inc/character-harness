# Player

The app that shows the character: it renders it, plays its voice, captures the mic, and talks to the runtime over the session WebSocket (`../docs/protocol.md`). It is written in C on the [Kaigen](https://kaigen3d.com) engine.

Ready-made builds are on this repo's GitHub Releases; using one needs no Kaigen licence. To change the player, you build it yourself, which needs a Kaigen licence.

For any platform, prepare the harness first: install Node 24 or later,
download the matching harness source release, run `npm install` from its root,
and copy `.env.example` to `.env`. Fill in the keys your character uses;
FoxGlove needs `XAI_API_KEY` and `ELEVENLABS_API_KEY`. See the
[harness quickstart](../README.md#quickstart). Then follow the installation or
build steps for your platform below. The player alone does not run the conversation.

## Install a release (macOS)

1. Download `character-player-<version>-macos-arm64.dmg` and `SHA256SUMS-macos-arm64` from the release (Apple Silicon Macs), and check it (`shasum -a 256 -c --ignore-missing SHA256SUMS-macos-arm64`).
2. Open it and drag Character Player to Applications.

   If the release notes say the build is unsigned, macOS blocks it the first time you open it. Open it once, then go to System Settings > Privacy & Security, click Open Anyway and confirm (on macOS 14 and earlier, Control-click the app and choose Open). Or, after checking the checksum, allow it from Terminal:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Character Player.app"
   ```

3. Put this in the harness's `.env`, so `npm start` opens it:

   ```dotenv
   HARNESS_PLAYER="'/Applications/Character Player.app/Contents/MacOS/'*"
   ```

4. Run `npm start` from the harness root. It starts the runtime and the prebuilt player together. Allow the microphone when macOS asks, then speak first. When `npm start` opens the player, macOS asks for the app you ran `npm start` in (your terminal or editor); if it doesn't ask, allow it in System Settings > Privacy & Security > Microphone.

The app keeps what it writes, like the cache of imported models and its logs, in `~/Library/Application Support/com.mutuals.characterplayer`.

## Install a release (Windows)

1. Download `character-player-<version>-windows-x64.zip` and
   `SHA256SUMS-windows-x64` from the release, and compare the ZIP's hash from
   `Get-FileHash .\character-player-<version>-windows-x64.zip -Algorithm SHA256`
   with the checksum file.
2. Extract the ZIP to a permanent folder. Keep the entire extracted folder
   together: its `.exe`, cooked assets and any DLLs. No Kaigen SDK, licence,
   compiler or Developer Mode is needed to run the player. The current Windows
   packages are unsigned.
3. Put this in the harness's `.env`, so `npm start` opens it. Use the extracted
   executable's actual path, keeping both quote levels for paths with spaces:

   ```dotenv
   HARNESS_PLAYER='"C:/Users/you/Apps/character-player-0.1.0-windows-x64/Character Player.exe"'
   ```

4. Run `npm.cmd start` from the harness root. It starts the runtime and the
   prebuilt player together. Allow microphone access for desktop apps in Windows
   Settings, then speak first.

## Install a release (Linux)

1. Download `character-player-<version>-linux-x64.tar.gz` and
   `SHA256SUMS-linux-x64` from the release, and check it
   (`sha256sum -c SHA256SUMS-linux-x64`).
2. Extract it somewhere you can write to, like your home folder
   (`tar -xzf character-player-<version>-linux-x64.tar.gz`), and keep the
   folder together. The player runs in its own folder and keeps its cache of
   imported models there (`cooked/vrm/`); its logs go to
   `~/.local/share/Character Player/`.

   It needs an x86_64 Linux desktop (X11 or Wayland), a Vulkan driver (Mesa's
   `mesa-vulkan-drivers`, or your GPU vendor's) and a microphone through
   PulseAudio or PipeWire (`pipewire-pulse`). No Kaigen SDK or licence is
   needed to run it.
3. Put this in the harness's `.env`, so `npm start` opens it. Use the extracted
   player's actual path, keeping both quote levels for the space in its name:

   ```dotenv
   HARNESS_PLAYER="'/home/you/Apps/character-player-0.1.0-linux-x64/Character Player'"
   ```

4. Run `npm start` from the harness root. It starts the runtime and the
   prebuilt player together. Speak first.

## Build (macOS)

For the integrated desktop interface, use the [Windows/macOS Studio guide](../docs/desktop-studio.md).
It builds this player automatically and keeps it in the background. The steps
below build and run the standalone player.

Run these steps from `player/`.

1. Install Kaigen and activate your licence (`kaigen activate <licence-key> --accept-terms`). The project is pinned to the engine version in `hzproject.hzt` (`0.6.3.001`); install it with `kaigen engine install`.
2. Link this folder to the pinned engine (git ignores the link):

   ```bash
   kaigen restore
   ```

3. Build and run:

   ```bash
   hz/hzbuild macos run
   ```

   The first build cooks the assets, which takes about half a minute. On macOS, allow microphone access for the app you start it from (System Settings > Privacy & Security > Microphone).

To have the runtime's `npm start` open it, put this in the harness's `.env`:

```dotenv
HARNESS_PLAYER="cd player && hz/hzbuild macos run"
```

## Build (Windows)

Run these steps from `player/`.

1. Install Kaigen and activate your licence (`kaigen activate <licence-key> --accept-terms`). The project is pinned to the engine version in `hzproject.hzt` (`0.6.3.001`); install it with `kaigen engine install`.
2. Link this folder to the pinned engine (git ignores the link):

   ```powershell
   kaigen restore
   ```

3. Build and run:

   ```powershell
   .\hz\hzbuild.exe windows run
   ```

   The first build cooks the assets. Allow microphone access for desktop apps
   in Windows Settings.

To have the runtime's `npm start` open it, put this in the harness's `.env`:

```dotenv
HARNESS_PLAYER="cd player && hz\hzbuild.exe windows run"
```

To build without launching, use `.\hz\hzbuild.exe windows`. The development
executable is `out/windows/debug/CharacterPlayer.exe`. For distribution, use
the publish build through `release-windows.ps1` below, rather than copying the
debug executable.

## Build (Linux)

Run these steps from `player/`, after installing and activating Kaigen as above.

```bash
kaigen restore
hz/hzbuild linux run
```

The cook mip-generates and compresses textures on the GPU, so it needs a Vulkan
device. On a machine without a GPU, Mesa's software Vulkan driver (lavapipe,
`mesa-vulkan-drivers`) works: point `VK_ICD_FILENAMES` at its `lvp_icd.json`
for the build and the run. Studio's desktop mode doesn't run on Linux yet
(`../docs/desktop-studio.md`).

## Build and run in a browser (WebAssembly)

The engine's WebAssembly build renders with WebGPU, with the same shaders as
the desktop player. It needs the engine's `wasm` component
(`kaigen engine add wasm --version 0.6.3.001`). From `player/`:

```bash
kaigen restore
hz/hzbuild wasm run
```

`hz/hzbuild wasm` alone builds into `out/wasm/debug/` without serving it.
`run` serves that folder with the cross-origin isolation headers its threads
need (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`); any server that sends them
works. Open it in a browser with WebGPU (Chrome or Edge) and pass the settings
below as URL parameters, for example
`/index.html?HARNESS_CHARACTER=foxglove&HARNESS_PREVIEW=emotion:happy`.

In the browser the player shows a cooked-in profile (FoxGlove). It can't import
a `.vrm` yet, because the import writes its cache to disk. On its own it hasn't
been tried against the runtime's session socket, so use it to preview the
character (`HARNESS_PREVIEW`); for conversations, use it in Studio (below).

## Studio in a browser (WebAssembly)

Studio's Browser mode shows FoxGlove with the web build when it is installed and
the browser has WebGPU (a recent Chrome or Edge), and with three.js
otherwise. Studio serves it from `.cache/web-player/` with the isolation headers
its threads need, and drives it like the desktop app drives the native player:
over `HARNESS_STUDIO_URL` it gets emotions, gestures, talking styles, camera
moves and the mouth level of the speech Studio plays. The conversation, mic and
voice stay in Studio. See the [Studio README](../frontend/README.md#kaigen-in-the-browser).

Install it from the repo root, from a `vX.Y.Z-web-wasm` release:

```bash
npm run web-player -- download
```

or from your own build, after `hz/hzbuild wasm publish` in `player/`:

```bash
npm run web-player -- copy
```

`WEB_PLAYER_DIR` points Studio at another folder, from the repo root, such as
`player/out/wasm/debug/`. In Studio the web build draws Kaigen's stage behind
her: a WebGPU canvas from the engine is always opaque, so Studio's backgrounds
don't apply to it.

## Settings

The runtime sets the first three when it starts the player.

| Variable | Default | What |
|---|---|---|
| `HARNESS_URL` | `ws://127.0.0.1:8788/session` | the runtime's session socket. The runtime only accepts it with its token (`/session/<token>`), which it passes when it starts the player and prints otherwise |
| `HARNESS_CHARACTER` | | the character: a path to a `.vrm` / `.glb` (the runtime passes a prepared one), or the name of a profile cooked into the build (`foxglove`) |
| `HARNESS_LISTEN` | | the character's `listen` settings as JSON, like `{"end_of_speech_ms":900}`. Set them in `character.yaml` (`docs/character-manifest.md`), not here: the runtime always sets this one and ignores a value in the shell or `.env`. A key left out, or a value the player can't use, keeps the default |
| `HARNESS_MIC_DEBUG` | `0` | `1` logs what the mic hears twice a second |
| `HARNESS_PREVIEW` | | for checking a character without a conversation: `talk`, `talk:<style>`, `gesture:<name>` or `emotion:<name>`, repeated every few seconds |
| `HARNESS_SCREENSHOT` | | saves frame `HARNESS_SCREENSHOT_FRAME` (default 240) to this `.png` and quits |

## What it does

- Puts the character on the stage, with a portrait camera framed on the upper body.
- Runs the engine's voice session against the runtime. The engine owns the socket, voice activity detection, playback and lip sync.
- Applies beats: emotions reach the face, talking styles switch the body's loop, gestures play once, and camera words ease the framing toward `assets/mutuals/camera_moves.hzt`.
- Speaks first only when an extension offers it a turn: it keeps a second socket to the runtime, the offers link, reports what its voice is doing there, and takes an offered line as the user's next turn while nobody is speaking (`../docs/protocol.md`, "The offers link"). The engine's own greeting stays off.

## FoxGlove

FoxGlove is a profile cooked into the player (`assets/characters/foxglove.hzt`): her model, rig, face and expressions are in `assets/foxglove/`, with hair, skirt and bust physics and her own expression effects (sparkling eyes, tears, blush). Her idle loops, idle breaks and gestures are animations in her model, played through `assets/foxglove/states.hzt`, `assets/foxglove/emotes/` and `assets/mutuals/gestures.hzt`; their `.vrma` sources are in `characters/foxglove/animations/`. She has no talking loops yet: while she talks she stays in her idle loop.

## Toon shading and light

The toon shader takes the sun as MToon's light colour: at 1, the lit side shows the material's base colour and the shade side its shade colour. The engine hands shaders a directional light as pre-exposed lux over pi, so at the engine's default exposure (EV100 15) the stage's sun is 1.2 × 2^15 × π ≈ 123,533 lux, which reaches the shader at 1. The ambient (`ambient_intensity`) has no pi: 19,661 at EV100 15 is 0.5 of its colour.

WebGPU allows 16 textures per shader stage, and the shadows, sky light and fog take 7, which leaves 9 of `mtoon.glsl`'s 14 maps. A material leaves out the maps it never sets with `MTOON_NO_<MAP>` keywords (FoxGlove's materials in `assets/foxglove/materials/` do). On the web those maps aren't bound and read as their defaults, as unset maps do on the desktop, so both builds draw the same. A material with more than 9 maps, like one the VRM importer makes, still draws on the web, without sky light and fog. The desktop build binds every map whatever the keywords say.

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
| `release-linux.sh` | builds a Linux release from a tag, packages it as a `.tar.gz`, and attaches it to a draft GitHub release |
| `release-windows.ps1` | builds a Windows release from a tag, packages it as a `.zip`, and attaches it to a draft GitHub release |
| `release-web.sh` | builds the web player from a tag, packages it as a `.tar.gz` for Studio, and attaches it to a draft GitHub release |
| `release-macos.sh`, `macos.entitlements` | builds a release from a tag, signs it (ad hoc, or with a Developer ID and notarized), and attaches it to a draft GitHub release; the entitlements let the app use the mic |
| `src/app/player.c`, `player.h` | the app: init, frame loop, mic, beats, camera, and the Studio link (`HARNESS_STUDIO_URL`) |
| `src/app/player_vrm.c`, `.h` | runtime VRM import and caching: clips, face, rig and the generated character profile |
| `src/app/player_offers.c`, `.h` | the offers link: the voice's status out, offered turns in |
| `src/app/player_json.c`, `.h` | a small JSON reader for the VRM extensions and the runtime's clip table |
| `src/app/app_character.c`, `.h`, `app_emote_clips.c` | loading and swapping the character, emote clips |
| `src/app/app.c` | the build's entry file, which includes the others |
| `src/app/app_config.h` | every tunable and launch setting |
| `assets/characters/foxglove.hzt`, `assets/foxglove/` | FoxGlove: her profile, model and animations, rig, face, expressions, physics, states and emotes |
| `assets/mutuals/` | the stage, camera moves, emotions, the gesture set of a cooked-in profile, the lip sync profile, an upper-body mask (empty; the engine expects one) |
| `assets/vad/` | the voice activity model ([Silero VAD](https://github.com/snakers4/silero-vad), MIT licence) |
| `shaders/mutuals/` | the toon and outline shaders (`mtoon.glsl`, `mtoon_outline.glsl`); the engine's VRM importer binds VRM materials to `mtoon.glsl`. The web build draws them like the desktop build, sky light and fog included; see "Toon shading and light" below |

## Release tags and download links

Use one tag and GitHub release per version, OS and architecture:
`v0.1.0-windows-x64`, `v0.1.0-macos-arm64` and `v0.1.0-linux-x64` can all
release app version `0.1.0`, independently and from different commits. The
platform suffix is omitted from the app's product version. The web player uses
`v0.1.0-web-wasm`; it isn't in the README's download links, because
`npm run web-player -- download` finds it.

Create and push the tag on the commit you will build, then check it out before
running the platform's release script. For example:

```powershell
git tag v0.1.0-windows-x64
git push origin v0.1.0-windows-x64
git switch --detach v0.1.0-windows-x64
```

After publishing, the `Update player download links` GitHub Actions workflow
updates only the marked downloads block in the root README on the default
branch. It selects the highest published numeric version per platform,
includes pre-releases and excludes drafts. Editing, deleting or unpublishing
a release refreshes the links too. You can also run it manually from Actions
→ Update player download links → Run workflow, for example after merging this
workflow for the first time. It needs permission to push README updates to
the default branch; future branch protection must allow those bot commits.
GitHub's generic `/releases/latest` link excludes pre-releases and does not
select a platform, so the README links directly to the selected tags.

## Releasing (macOS)

From a clean checkout of a `vX.Y.Z-macos-arm64` tag pushed to GitHub, on a Mac with your Kaigen licence activated:

```bash
player/release-macos.sh vX.Y.Z-macos-arm64
```

It builds the app with the engine's publish build, signs it ad hoc with the microphone entitlement (`macos.entitlements`), packages the `.zip` and `.dmg`, writes `SHA256SUMS-macos-arm64`, and creates a draft release with them and notes on running the full harness. Gatekeeper treats such a build as unsigned, so people allow it on its first start (see "Install a release"). With both a Developer ID Application certificate (`MACOS_SIGNING_IDENTITY`) and a notarytool keychain profile (`MACOS_NOTARY_PROFILE`) set, it signs and notarizes it instead, and it opens with no warning; set both or neither:

```bash
MACOS_SIGNING_IDENTITY="Developer ID Application: <name> (<team id>)" MACOS_NOTARY_PROFILE=<profile> player/release-macos.sh vX.Y.Z-macos-arm64
```

Either way, review the draft and publish it. CI doesn't build the player, so releases are made this way.

## Releasing (Linux)

From a clean checkout of a `vX.Y.Z-linux-x64` tag pushed to GitHub, on x86_64
Linux with the Kaigen SDK linked at `player/hz` and your licence activated:

```bash
player/release-linux.sh vX.Y.Z-linux-x64
```

The cook needs a Vulkan device; without a GPU, point `VK_ICD_FILENAMES` at
lavapipe's `lvp_icd.json` (see "Build (Linux)"). The script sets the product
version from the tag for the build only, removes cached VRM imports and old
publish output, and runs `hz/hzbuild linux publish`. It packages the published
executable and its cooked assets (without the web build's `.br` files), the
licences and a README into:

```text
player/out/release/linux-x64/
  character-player-0.1.0-linux-x64/
  character-player-0.1.0-linux-x64.tar.gz
  SHA256SUMS-linux-x64
```

Debug symbols, object files and the engine's release entry stay out of it, and
the script stops if anything in the package names a path on the build machine.
It then creates a draft release with the files and notes on running the full
harness; a rerun replaces the files on that draft, and a published release is
never changed. `--no-release` stops after packaging. Review the draft and
publish it.

## Releasing (web)

From a clean checkout of a `vX.Y.Z-web-wasm` tag pushed to GitHub, on Linux with
the Kaigen SDK and its `wasm` component linked at `player/hz` and your licence
activated:

```bash
player/release-web.sh vX.Y.Z-web-wasm
```

The cook needs a Vulkan device, as for Linux. The script sets the product
version from the tag for the build only, removes cached VRM imports and old
publish output, and runs `hz/hzbuild wasm publish`. It packages the player's
scripts, `game.wasm.br` and its cooked assets (without the native `.zst` files,
the engine's test page and its static-host headers), the licences and a README
into:

```text
player/out/release/web-wasm/
  character-player-0.1.0-web-wasm/
  character-player-0.1.0-web-wasm.tar.gz
  SHA256SUMS-web-wasm
```

It stops if anything in the package, the brotli files unpacked included, names a
path on the build machine or holds a Kaigen licence key. It then creates a draft
release; a rerun replaces the files on that draft, and a published release is
never changed. `--no-release` stops after packaging. Review the draft and
publish it; `npm run web-player -- download` takes the highest published version.

## Releasing (Windows)

From a clean checkout of a `vX.Y.Z-windows-x64` tag, on Windows with the Kaigen SDK linked at
`player/hz`, an activated licence and the native toolchain installed:

```powershell
.\player\release-windows.ps1 v0.1.0-windows-x64 -NoRelease
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
  character-player-0.1.0-windows-x64.zip
  SHA256SUMS-windows-x64
```

During the release build, MSVC's compiler PDB is directed to
`out/windows/compiler/vc.pdb` using `/Fd`. The script preserves existing
compiler environment options and restores them after success or failure.
Direct `hzbuild` calls still use the SDK's default PDB location.

The ZIP contains the native player executable and its required runtime files.
Keep the entire extracted folder together. The executable is not published as
a separate download because it cannot run without those files. This is a
portable package, not an installer.
The script includes the external `cooked/` assets even when publish output omits
them from its publish output, including the `.zst` files the native publish
build reads. Browser-only `.br` sidecars are excluded.
The release packages the
player, like the macOS script; users still install Node, fetch the harness
source, configure their own keys and run `npm start` as described above.

For a local preview of uncommitted work, without creating a tag or uploading:

```powershell
.\player\release-windows.ps1 v0.1.0-windows-x64 -NoRelease -AllowDirty
```

To attach the ZIP and checksums to a draft GitHub release, push the tag and run
without `-NoRelease` (requires `gh` installed and authenticated):

```powershell
.\player\release-windows.ps1 v0.1.0-windows-x64
```

Each platform has its own tag and release. If a Windows draft already exists
for this tag, missing assets are added without replacing its notes or checksums.
Existing assets are not silently overwritten, and public releases are not modified. Review the draft before
publishing. Artifacts stay under the platform-specific output directory so
this script does not delete macOS packages.

The SDK must include `hz/tools/brotli/brotli.exe` for publish asset compression.
If it is missing, repair the SDK installation or obtain the missing build tool
from Kaigen before releasing. The release script checks this prerequisite but
does not modify the installed SDK. A successful development build does not
verify publish prerequisites.
