# Run Character Studio on Windows or macOS

Desktop Studio opens the existing interface in Electron and automatically starts
the native Kaigen renderer. It renders with Kaigen's character shaders, cloth and
animations. There is no window picker, screen capture or Screen Recording
permission. Use this mode for the native character appearance.

Desktop mode doesn't run on Linux yet. On Linux, use Studio in the browser
(`npm run frontend`) and run the native player on its own: the Linux release or
your own build (`player/README.md`).

## Prerequisites

- Node.js 24 or later, npm, and this repository checked out locally.
- A licensed Kaigen SDK for your operating system and CPU architecture, with the
  version pinned in `player/hzproject.hzt`: currently `0.6.3.001`.
- The SDK linked as `player/hz`. SDK binaries and licences are not committed.
- A working native compiler: the Kaigen Windows toolchain, or Xcode Command Line
  Tools on macOS (`xcode-select --install` if they are missing).
- For conversations, the provider keys named by the character. Copy `.env.example`
  to `.env` only if `.env` does not already exist, then supply the keys locally.
  You can also replace individual keys in Studio's Settings. Previewing the model
  does not require provider keys.

Install the pinned engine with `kaigen engine install` (it reads the pin) and
link it with `kaigen restore` from `player/`. If the installer cannot provide it
for your platform, ask the team; do not silently substitute another engine
version. The installed Windows SDK does not contain the macOS engine library:
build the macOS player on a Mac with the corresponding SDK.

## Windows (PowerShell)

From the repository root:

```powershell
npm.cmd ci
npm.cmd --prefix frontend ci
```

If `player/hz` has not been restored, install Kaigen and activate your licence
following its setup instructions, then restore the pinned engine:

```powershell
Set-Location player
kaigen restore
Set-Location ..
```

Start Studio from the repository root:

```powershell
npm.cmd run desktop
```

The launcher typechecks/builds the frontend, runs `player/hz/hzbuild.exe windows`,
then opens Electron. It starts `player/out/windows/debug/CharacterPlayer.exe`
itself; do not start a separate player or `npm start` for this mode.

## macOS (Terminal)

From the repository root:

```sh
npm ci
npm --prefix frontend ci
```

Install Kaigen and activate your licence following its setup instructions. If
`player/hz` does not already exist, link the pinned engine:

```sh
cd player
kaigen restore
cd ..
```

`kaigen restore` links `player/hz` to the engine installed under
`~/Library/Application Support/hz/engines/<version>`. The target must contain
the macOS `hzbuild` executable and engine libs.

Start Studio from the repository root:

```sh
npm run desktop
```

The launcher typechecks/builds the frontend, runs `player/hz/hzbuild macos`, then
opens Electron. It finds the debug `CharacterPlayer` executable directly or
inside a `.app` bundle under `player/out/macos/debug`. The player runs in the
background using Metal; Studio owns microphone capture and audio playback.
Allow microphone access when you intentionally enable Studio's microphone.

**Verification:** Windows build, GPU frame delivery, imported-model loading,
clouds compositing and live conversation have been exercised locally. The macOS
launcher and window-hiding implementation are present, but still require a build
and runtime test on an actual Mac. These are development launch instructions,
not a claim that signed macOS/Windows installers have been produced.

## Daily use

- `npm run desktop` builds and opens the native-rendered desktop interface.
- `npm run desktop:prepare` builds without opening it. Close Studio before
  rebuilding the player; Windows locks an executable while it is running.
- Closing the desktop window stops its renderer and local server processes.
- Studio uses `http://127.0.0.1:4174` internally. This stable origin keeps its
  browser preferences and current-character selection across restarts.
- The browser-only interface remains available with `npm run frontend` at
  `http://127.0.0.1:4173`, using Three.js. Opening that URL does not switch it to
  the native renderer.

If port 4174 is already occupied, close the other process or choose another port:

```powershell
# Windows
$env:STUDIO_DESKTOP_PORT = '4175'
npm.cmd run desktop
```

```sh
# macOS
STUDIO_DESKTOP_PORT=4175 npm run desktop
```

A different port has separate browser-local preferences. Only one desktop
instance per application profile runs at a time.

## How rendering works

Electron starts the local Node runtime and launches Kaigen with a prepared
character path, never with provider keys. Kaigen renders to an offscreen GPU
target. An application-owned shader combines the display color with a mask from
the scene depth; Studio draws the resulting RGBA frames over its existing Clouds,
Plain or Blue background. The render targets use sRGB to preserve display color.
No engine source or character material strengths are changed.

A private WebSocket binds to `127.0.0.1` on an ephemeral port. Its URL has a random
token, and browser-origin connections are refused. Binary messages contain an
8-byte little-endian width/height header followed by RGBA8 pixels. Studio sends
small JSON messages back for preview size, mouth movement and animation cues.
Frames are capped at 1280 pixels per side and 30 fps. An acknowledgement is
required before the next frame readback, bounding queued work for slow consumers.

This is local frame streaming, not a video codec or shared GPU texture. It has
readback/copy overhead. Depth masking also does not reproduce full partial
transparency or bloom outside the character silhouette. The native application
window is hidden using Windows/macOS APIs; its render output is still active.

Chat and voice remain in the existing frontend session. Captions use ElevenLabs'
character timestamps against the actual audio playback clock, showing short
phrases. The full reply remains available in the independently scrolling
conversation card. Interruption clears audio, animation timers and captions.

## Troubleshooting and checks

- **Missing SDK / engine library:** check `player/hz` and the pinned version.
  macOS needs the macOS SDK, not a copy of the Windows SDK directory.
- **Build cannot write CharacterPlayer.exe:** close the running desktop app and
  rebuild. Do not stop unrelated player processes.
- **Empty native preview:** inspect `.cache/frontend/desktop/player.log` and
  `.cache/frontend/desktop/server.log`. Imported models are prepared in
  `.cache/characters`; Windows paths are normalized before reaching Kaigen.
- **No speech:** check Settings' key status and the selected character's voice
  configuration. Kaigen preview and provider availability are independent.
- **WASM:** the player builds for the browser with WebGPU (`hz/hzbuild wasm run`
  from `player/`, which needs the engine's `wasm` component). Studio still renders
  with the native player; see the player README's
  [WebAssembly section](../player/README.md#build-and-run-in-a-browser-webassembly)
  for what the browser build does today.

```sh
npm --prefix frontend test
npm --prefix frontend run build
npm run typecheck
npm test
```

With desktop Studio running, this optional check starts and cleans up its own
temporary renderer, verifies 12 frames contain character pixels, and uses no
provider services:

```sh
node frontend/desktop/smoke.mjs foxglove
node frontend/desktop/smoke.mjs <another-local-character-id>
```
