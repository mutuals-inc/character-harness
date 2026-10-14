# Player

The app that shows the character: it renders it, plays its voice, captures the mic, and talks to the runtime over the session WebSocket (`../docs/protocol.md`). It is written in C on the [Kaigen](https://kaigen3d.com) engine.

Builds will be attached to this repo's GitHub Releases; using one needs no Kaigen licence. To change the player, you build it yourself, which needs a Kaigen licence.

## Build

For PowerShell setup, build commands and the test handoff, see
[`docs/windows.md`](../docs/windows.md).

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

## Settings

The runtime sets the first two when it starts the player.

| Variable | Default | What |
|---|---|---|
| `HARNESS_URL` | `ws://127.0.0.1:8788/session` | the runtime's session socket. The runtime only accepts it with its token (`/session/<token>`), which it passes when it starts the player and prints otherwise |
| `HARNESS_CHARACTER` | | the character: a path to a `.vrm` / `.glb` (the runtime passes a prepared one), or the name of a profile cooked into the build (this repo ships none) |
| `HARNESS_MIC_DEBUG` | `0` | `1` logs what the mic hears twice a second |
| `HARNESS_PREVIEW` | | for checking a character without a conversation: `talk`, `talk:<style>`, `gesture:<name>` or `emotion:<name>`, repeated every few seconds |
| `HARNESS_SCREENSHOT` | | saves frame `HARNESS_SCREENSHOT_FRAME` (default 240) to this `.png` and quits |

## What it does

- Puts the character on the stage, with a portrait camera framed on the upper body.
- Runs the engine's voice session against the runtime. The engine owns the socket, voice activity detection, playback and lip sync.
- Applies beats: emotions reach the face, talking styles switch the body's loop, gestures play once, and camera words ease the framing toward `assets/mutuals/camera_moves.hzt`.
- Never speaks first.

## Loading a VRM

The runtime prepares a character's model: its `.vrm` with the character's animations retargeted onto it, and a table of which clip is idle, which talking style, which gesture. The first load imports it with the engine's glTF importer (`src/app/player_vrm.c`) and caches it under `cooked/vrm/<name>/`, a few seconds for a typical model; later loads reuse the cache until the file changes.

- **Body:** the baked clips become the character's idle loop, talking styles and gestures. Without them it stands in its rest pose.
- **Face:** built from the model's own VRM expressions (happy, sad, blink, the vowels for lip sync), with the emotions in `assets/mutuals/emotions.hzt` mixed from those.
- **Rig:** head, neck, eyes and chest come from the model's VRM humanoid.
- **Not yet:** hair and cloth physics; models with several skins (common in VRMs exported from Unity); VRM 0.x models with transparent materials.

## Layout

| Path | What |
|---|---|
| `hzproject.hzt` | the project: name, folders, engine version |
| `src/app/player.c`, `player.h` | the app: init, frame loop, mic, beats, camera |
| `src/app/player_vrm.c`, `.h` | runtime VRM import and caching: clips, face, rig and the generated character profile |
| `src/app/player_json.c`, `.h` | a small JSON reader for the VRM extensions and the runtime's clip table |
| `src/app/app_character.c`, `.h`, `app_emote_clips.c` | loading and swapping the character, emote clips |
| `src/app/app.c` | the build's entry file, which includes the others |
| `src/app/app_config.h` | every tunable and launch setting |
| `assets/mutuals/` | the stage, camera moves, emotions, the lip sync profile, an empty upper-body mask the engine loads |
| `assets/vad/` | the voice activity model ([Silero VAD](https://github.com/snakers4/silero-vad), MIT licence) |
| `shaders/mutuals/` | the toon and outline shaders |
