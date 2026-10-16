# Mutuals Character Harness

The harness [Mutuals](https://github.com/mutuals-inc) uses to give life to its characters: a character you can talk to by voice, with a face and body that react to what it says.

> Status: pre-release. The runtime and the player work end to end. Download a ready-made player below, or build the player yourself with the Kaigen engine.

## Player downloads

<!-- player-releases:start -->
- [Windows x64 — v0.1.0-windows-x64 (pre-release)](https://github.com/mutuals-inc/character-harness/releases/tag/v0.1.0-windows-x64)
<!-- player-releases:end -->

These links track the newest published version for each available platform,
including pre-releases, and update automatically when releases change.
[All releases](https://github.com/mutuals-inc/character-harness/releases).
Follow the release's instructions to run the player and Node harness together;
using a player release needs no Kaigen SDK or licence.

## How it works

The **runtime** runs the conversation: it hears you through ElevenLabs speech to text, writes the reply with a chat model, speaks it with an ElevenLabs voice, and stages each sentence with an emotion, a talking style and a gesture. The **player** app renders the character, plays the voice and captures the mic; it is written in C on the [Kaigen](https://kaigen3d.com) engine and connects to the runtime over a local WebSocket.

A character is a folder with a manifest, a personality prompt and a body: any VRM model, with the animations you bring. Extensions add behavior on every turn.

## What's inside

| Folder | What it is |
|---|---|
| `runtime/` | The conversation loop, and the preparation of VRM models and their animations for the player. |
| `player/` | The app that shows the character. Building it needs a Kaigen licence; using a release build doesn't. |
| `extensions/` | Plug-ins that run on every turn: `emotion-tags` changes the face from a sentence's delivery tag, `director` stages each line, `memory` remembers what the user tells her, `reactions` starts her reply with how she took what the user said. |
| `examples/` | Example extensions to copy from. `gesture-cues` is the one `docs/your-first-extension.md` builds. |
| `characters/` | Character manifests. `foxglove/` is the reference character. |
| `docs/` | How the pieces fit. Start with `docs/architecture.md`. |

## Quickstart

Needs Node 23.6 or later and the keys the character uses. FoxGlove needs two:

- `ELEVENLABS_API_KEY` ([ElevenLabs](https://elevenlabs.io)): speech to text and her voice.
- `XAI_API_KEY` ([xAI](https://x.ai)): her chat model and the director that stages her lines.

The `memory` and `reactions` extensions, if a character uses them, need `TYPESAFE_API_KEY` ([Typesafe](https://typesafe.ai)).

1. Copy `.env.example` to `.env` and fill in the keys.
2. Run `npm install`, then `npm start` for FoxGlove, or `npm start -- characters/<id>` for your own character (`docs/bring-your-own-character.md`). `npm run check -- characters/<id>` checks a character without starting it.
3. Start the player: a release build, or your own build (`player/README.md`). Set `HARNESS_PLAYER` in `.env` to the command that opens it, and `npm start` opens it too; otherwise the runtime prints what the player needs.
4. Open Claude Code or Codex in this folder and ask it to change something. `AGENTS.md` tells it where everything lives.

`npm test` runs the tests; they need no keys or network.

## Docs

- `docs/architecture.md`: the turn loop and the event system
- `docs/character-manifest.md`: what a character is
- `docs/extensions.md`: how to write an extension
- `docs/your-first-extension.md`: build, check and test a small extension step by step
- `docs/protocol.md`: the messages between the player app and the runtime
- `docs/bring-your-own-character.md`: use your own VRM model and animations

## Contributing

Issues and pull requests are welcome; see `CONTRIBUTING.md`. To report a security issue, see `SECURITY.md`.

## License

Apache License 2.0, see `LICENSE` and `NOTICE`. That covers FoxGlove too: her character (`characters/foxglove/`) and her model and art (`player/assets/foxglove/`). Included third-party work keeps its own licence: the Silero VAD model (MIT, `player/assets/vad/LICENSE`) and the MToon shading the player's shaders follow (MIT, credited in their headers). The Kaigen engine is not part of this repo.
