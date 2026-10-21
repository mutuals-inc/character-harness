# Agent notes

Read `docs/architecture.md` first.

## Where things live

- A character is `characters/<id>/`. Its `character.yaml` is the single source of truth: it points to the prompt, voice, rig, emotions and extensions. Never hard-code character details in `runtime/`.
- Personality: the file `character.yaml` names under `prompt` (usually `system.md`).
- Voice and hearing: `voice:` and `stt:` in `character.yaml`.
- Look and body: `rig:`, a VRM model and the animations it plays (or a profile cooked into the player, like FoxGlove's).
- The app that shows the character: `player/`, C on the Kaigen engine. Building it needs a Kaigen licence.
- Behavior that runs every turn: an extension under `extensions/<name>/`, described by its `extension.yaml` and listed in the character's `extensions:`.
- Behavior that runs between turns and may start one (a chat to watch, a timer): the extension's `service`, with `service: true` in its `extension.yaml` (`docs/extensions.md`, "Services").

## Rules

- Keys only ever go in `.env`. Manifests name keys (`api_key_env`, `requires_env`), never their values.
- To add behavior, write an extension. Do not edit `runtime/` to special-case a character.
- An extension writes only the state keys it owns, plus the shared turn fields it means to change.
