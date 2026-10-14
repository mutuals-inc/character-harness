# Mutuals Character Harness

The harness [Mutuals](https://github.com/mutuals-inc) uses to give life to its characters: a character you can talk to by voice, with a face and body that react to what it says.

> Status: pre-release. The runtime and the player work end to end; player builds will be attached to this repo's GitHub Releases.

## How it works

The **runtime** runs the conversation: it hears you through ElevenLabs speech to text, writes the reply with a chat model, speaks it with an ElevenLabs voice, and stages each sentence with an emotion, a talking style and a gesture. The **player** app renders the character, plays the voice and captures the mic; it is written in C on the [Kaigen](https://kaigen3d.com) engine and connects to the runtime over a local WebSocket.

A character is a folder with a manifest, a personality prompt and a body: any VRM model, with the animations you bring. Extensions add behavior on every turn.

## What's inside

| Folder | What it is |
|---|---|
| `runtime/` | The conversation loop, and the preparation of VRM models and their animations for the player. |
| `player/` | The app that shows the character. Building it needs a Kaigen licence; using a release build doesn't. |
| `extensions/` | Plug-ins that run on every turn: `emotion-tags` changes the face from a sentence's delivery tag, `director` stages each line. |
| `characters/` | Character manifests. `foxglove/` is the reference character. |
| `docs/` | How the pieces fit. Start with `docs/architecture.md`. |

## Quickstart

Needs Node 23.6 or later, an ElevenLabs key and a key for the chat model the character uses.

1. Copy `.env.example` to `.env` and fill in the keys.
2. Run `npm install`, then `npm start -- characters/<id>` with a character whose body is a VRM model (`docs/bring-your-own-character.md`). FoxGlove's body is not included in this repo.
3. Start the player: a release build, or your own build (`player/README.md`). Set `HARNESS_PLAYER` in `.env` to the command that opens it, and `npm start` opens it too; otherwise the runtime prints what the player needs.
4. Open Claude Code or Codex in this folder and ask it to change something. `AGENTS.md` tells it where everything lives.

`npm test` runs the tests; they need no keys or network.

## Docs

- `docs/architecture.md`: the turn loop and the event system
- `docs/character-manifest.md`: what a character is
- `docs/extensions.md`: how to write an extension
- `docs/protocol.md`: the messages between the player app and the runtime
- `docs/bring-your-own-character.md`: use your own VRM model and animations

## Contributing

Issues and pull requests are welcome; see `CONTRIBUTING.md`. To report a security issue, see `SECURITY.md`.

## License

MIT, see `LICENSE`. Included third-party work keeps its own licence: the Silero VAD model (MIT, `player/assets/vad/LICENSE`) and the MToon shading the player's shaders follow (MIT, credited in their headers). The Kaigen engine is not part of this repo.
