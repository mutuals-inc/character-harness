# Character manifest

`characters/<id>/character.yaml` describes what a character is and what it needs to run. The runtime loads it from this file and the `extension.yaml` of each extension it lists, so swapping a character is swapping a folder. Paths are relative to the character's folder.

```yaml
schema: 1

id: foxglove
name: FoxGlove
description: <one line on who the character is>
purpose: <optional, what the character is for>
author: Mutuals
license: <what people may do with this character; separate from the code license>

prompt: system.md

models:
  chat:
    api: chat_completions
    base_url: https://api.x.ai/v1
    api_key_env: XAI_API_KEY
    model: grok-4-1-fast-non-reasoning
    params:
      temperature: 0.9
      max_tokens: 1200

stt:
  provider: elevenlabs
  model: scribe_v2_realtime
  language: en
  keyterms: [FoxGlove]

voice:
  provider: elevenlabs
  voice_id: <voice-id>
  model: eleven_v4_turbo
  params:
    stability: 0.5
    similarity_boost: 0.75

rig:
  engine: ">=<engine-version>"
  model: model.vrm
  animations:
    idle: idle.vrma
    talk:
      regular: talk.vrma
      upbeat: talk_upbeat.vrma
    gestures:
      wave: wave.vrma
      nod: nod.vrma

extensions:
  - path: ../../extensions/director
    config_file: director.yaml

env_file: ../../.env
```

## Identity

| Key | Required | What |
|---|---|---|
| `schema` | yes | Manifest version, so older characters keep loading. Currently `1`. |
| `id` | yes | Stable identifier: lowercase letters, digits, `-` and `_`. It names the cache folder, so keep it unique. |
| `name` | yes | Display name. |
| `description` | yes | One line on who the character is. |
| `purpose` | no | What the character is for. |
| `portrait` | no | Local PNG/JPEG/WebP image used by the browser character library, relative to this folder. |
| `created_at` | no | Creation timestamp recorded by the browser editor for library sorting. |
| `author` | yes | Who made the character. |
| `license` | yes | What people may do with the character itself (fan art, revenue, brand deals). Separate from the code license. |
| `prompt` | yes | The personality, as one markdown file. |

## `models.chat`

| Key | Required | What |
|---|---|---|
| `api` | yes | `chat_completions` or `responses`. |
| `base_url` | yes | The provider's API root, like `https://api.x.ai/v1`. |
| `api_key_env` | yes | Name of the key in `.env`. |
| `model` | yes | The provider's model name. |
| `params.temperature` | no | `chat_completions` only. |
| `params.max_tokens` | no | Longest reply, in tokens. |
| `params.reasoning_effort` | no | `responses` only, like `low`. |
| `silent_reply` | no | A token like `[pass]` the model answers when it means to say nothing. A reply that starts with it is silent. The character's prompt teaches the model when to use it; the runtime adds nothing to the prompt. |

Models an extension uses belong to that extension, not here. See "The chat model" in `architecture.md`.

## `stt`

| Key | Required | What |
|---|---|---|
| `provider` | yes | `elevenlabs`. |
| `model` | yes | Like `scribe_v2_realtime`. |
| `language` | no | Language code, like `en`. |
| `keyterms` | no | Names from the character's world the model should hear right. |

## `voice`

| Key | Required | What |
|---|---|---|
| `provider` | yes | `elevenlabs`. |
| `voice_id` | yes | The provider's voice ID. |
| `model` | yes | Like `eleven_v4_turbo`. |
| `params` | no | Voice settings passed to the provider, like `stability` and `similarity_boost`. |
| `drop_tags` | no | Delivery tags removed from each sentence before the voice gets it, like `[quiet, whispers]` for tags it renders too quietly. |

## `listen`

How the player hears the user: when their turn ends, and when talking over the character interrupts it. Optional; a key left out keeps the player's default, so most characters need none of this. A character in a quiet room with one person might end turns sooner; one in a noisy group conversation might wait longer, need more to interrupt, and raise the speech threshold so background talk doesn't start a turn.

```yaml
listen:
  end_of_speech_ms: 1500
  barge_in_ms: 1000
  speech_threshold: 0.65
  silence_threshold: 0.45
```

| Key | Default | Range | What |
|---|---|---|---|
| `end_of_speech_ms` | 1200 | 200 to 5000 | How long the user must be quiet before their turn ends. Lower answers sooner but cuts off people who pause mid-sentence. |
| `barge_in_ms` | 700 | 100 to 3000 | How long the user must talk over the character to interrupt it. |
| `speech_threshold` | 0.5 | 0.05 to 0.95 | How sure the voice detector must be that it hears speech to start the user's turn. Higher ignores more background noise and distant voices. |
| `silence_threshold` | 0.35 | 0.05 to 0.95 | Below this, the detector counts the mic as quiet again. Set it with `speech_threshold`, at least 0.01 below it. |
| `echo_floor` | 0.10 | 0.01 to 0.9 | While the character talks, mic input quieter than this (peak level, 0 to 1) is taken as its own voice coming back through the speakers, not as the user. Raise it for loud speakers without headphones. |

The milliseconds are whole numbers. The runtime passes these to the player in `HARNESS_LISTEN` when it starts it (see `player/README.md`). Players from release v0.1.0 don't read it and keep the defaults, so `listen` needs a player built from this source or a later release.

## `rig`

The body. Either a VRM model with the animations it plays, or a profile cooked into the player (FoxGlove's: `player/assets/characters/foxglove.hzt`).

| Key | Required | What |
|---|---|---|
| `rig.engine` | yes | Engine versions the character works with (not checked by the runtime yet). |
| `rig.model` | one of these | A `.vrm` file (VRM 0.x or 1.0). |
| `rig.profile` | one of these | A profile cooked into a player build, by its bare name (no path or extension). Needs `emotions` too. |
| `rig.springs` | no | With `rig.model`: `false` keeps the model's VRM spring bones (hair, skirts) still. Default `true`. |
| `rig.animations.idle` | no | The loop played while listening. One clip or a list. |
| `rig.animations.talk.<style>` | no | Loops played while talking, per talking style. `regular` is the default style; the others are what the director's `registers` pick from. |
| `rig.animations.gestures.<name>` | no | One-shot gestures the director's `gestures` pick from. A clip, or `{ clip, hold: true }` for a pose that holds until the next beat. |
| `emotions` | with `profile` | The profile's emotion set file. |

A clip is a `.vrma` file (VRM Animation), retargeted onto the model when the runtime starts, or the name of an animation already inside the model. Without an idle clip the model stands in its rest pose.

Gesture and style names are the words the director picks, so list the same names in its config (`director.yaml`). See `bring-your-own-character.md`.

## `extensions`

A list, in the order the extensions run. Each extension declares its own hooks and the `.env` keys it needs in its `extension.yaml`. See `extensions.md`.

| Key | Required | What |
|---|---|---|
| `path` | yes | The extension's folder. |
| `config` | no | Anything. Passed to the extension untouched. |
| `config_file` | no | A YAML file in the character's folder with more config. Keys in `config` win. |

## Keys

| Key | Required | What |
|---|---|---|
| `env_file` | yes | Path to the `.env` file. At startup the runtime checks it has every key the character needs: `models.chat.api_key_env`, `ELEVENLABS_API_KEY` for speech to text and the voice, and each extension's `requires_env`. |

## Browser authoring metadata

The browser editor saves disabled extension entries under `disabled_extensions`,
with the same path/config shape as `extensions`. The runtime runs only the
`extensions` list. This keeps enable/disable choices and configurations local to
each character without changing shared extension code.

The editor also saves `extension_order`, a list of extension registry IDs, to
preserve the displayed order across enabled and disabled entries. Runtime
execution still follows the enabled `extensions` list.

The library sorts existing characters without `created_at` by their local folder
creation time. Creating a new character writes an explicit timestamp. Uploaded
models, portraits and animations are stored in the new character's own folder.
