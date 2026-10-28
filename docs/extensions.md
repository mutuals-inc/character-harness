# Extensions

An extension subscribes to events in the turn loop, receives the state, changes it, and passes it on.

New to extensions? `your-first-extension.md` builds a small one step by step, with its check and tests.

## The extension manifest

Every extension is a folder with an `extension.yaml`. The extension decides which hooks it runs on and which `.env` keys it needs.

```yaml
# extensions/my-extension/extension.yaml
name: my-extension
handler: index.ts                    # a module in this folder, or an http(s) URL
hooks:
  before_llm: { blocking: true, timeout_ms: 1000 }
  after_turn: { blocking: false }
requires_env: [MY_EXTENSION_API_KEY]
# service: true                      # also runs a service for the whole session (see "Services")
# tools: [...]                       # functions the chat model may call (see "Tools")
```

| Key | Required | What |
|---|---|---|
| `name` | yes | Unique among a character's extensions. By convention, its data goes under `state.ext.<name>`. |
| `handler` | yes | A module file in the folder, or an `http(s)` URL. |
| `hooks` | yes, unless `service` is set | A list of hook names, or a map of hook name to options. In the list form every hook is blocking. |
| `hooks.<hook>.blocking` | no | Default `true`. |
| `hooks.<hook>.timeout_ms` | no | Blocking hooks only. Default `5000`. |
| `service` | no | `true` to run the handler's exported `service` for the whole session. Module handlers only. See "Services". |
| `tools` | no | Tools the chat model gets every turn, each `{ name, description, parameters }`. Needs the `on_tool_call` hook. See "Tools". |
| `requires_env` | no | Keys the extension needs from `.env`: names, or `{ config: model.api_key_env }` for a key the character's config for the extension names (dotted path). The runtime checks them at startup and keeps them from the player. |

Hooks: `on_session_start`, `before_reply`, `before_llm`, `after_llm`, `on_tool_call`, `on_sentence`, `on_speak`, `after_turn`, `on_session_end`.

## Using it in a character

The character lists the extensions it uses, in the order they run, with any config:

```yaml
extensions:
  - path: ../../extensions/my-extension
    config: { anything: you-need }
```

The runtime passes `config` to the extension untouched. For a long config, `config_file` names a YAML file in the character's folder instead.

Five extensions ship with the harness: `emotion-tags` changes the face from the tag that opens each sentence, `director` stages each sentence with beats (see "Beats" in `architecture.md`), `memory` remembers what the user tells the character about their life, `reactions` starts each reply with how the character took what the user said, and `game-link` lets the character play games that speak the Neuro API.

## Handlers

| Kind | `handler` | When |
|---|---|---|
| Module | a file in the extension's folder, like `index.ts` | default; runs inside the runtime |
| HTTP | `http(s)://…` | any language, or a separate service |

Both get the same input and return the same output:

```
in:  { event, state, config }
out: { state }
```

A module's default export is that function, sync or async. Returning nothing means no change. An HTTP handler gets the input as a JSON `POST` and answers with the output. Keys from `.env` are in `process.env`.

An extension runs with the runtime's access: your keys, your files, the network. Only use extensions you trust (see `SECURITY.md`).

### Checking its config

A module may also export `check({ config, body })` (the name is reserved for this), which `npm run check` and `npm start` call before any conversation. `body` is what the player has for the character: `{ emotions, registers, gestures, cameras }`, each a list of names, or `null` when it can't be told from here (a profile this checkout doesn't have, say). It returns `{ errors, warnings }`, lists of messages, or nothing when all is well. The extension picks how serious each problem is: a warning is shown and the character starts anyway; an error is shown and `npm start` stops. The runtime only shows what it gets. The director, for example, makes a missing model or prompt an error, since it can't work without them, and a gesture, emotion, talking style or camera move the character doesn't have a warning, since on stage it would only do nothing.

## Tools

An extension gives the chat model tools by listing them in its `extension.yaml`, or by adding them to `state.tools` on `before_llm` when they change from turn to turn. It runs them on `on_tool_call`, which the runtime calls only on the extension whose tool the model called, once per call, with the call beside the state. See "Tools" in `architecture.md` for the whole turn.

```yaml
name: weather
handler: index.ts
hooks:
  on_tool_call: { timeout_ms: 3000 }
tools:
  - name: weather
    description: The weather now in a city.
    parameters: { type: object, properties: { city: { type: string } }, required: [city] }
```

```ts
export default async function ({ call, state, config, signal }) {
  const { city } = JSON.parse(call.arguments);
  const now = await fetch(`https://weather.example/now?city=${encodeURIComponent(city)}`, { signal }).then((r) => r.text());
  return { result: { content: now } };
}
```

`call` is `{ id, name, arguments }`, with `arguments` the JSON text as the model wrote it. It may not parse or match the schema, so check it. It hands back one of:

| `result` | What the model gets | Asks the model again |
|---|---|---|
| `{ content }` | the content | yes |
| `{ error }` | `Error: ` and the error, so it can say so or try again | yes |
| `{ pending: true }` | that the result will come later | no |
| nothing | `Done.` | no |

So a lookup answers `content`, and an action with nothing to report, like playing a song, answers nothing. A tool that throws or runs out of time gives the model an error. `on_tool_call` is always blocking; its `timeout_ms` is how long the model waits for the tool. `signal` is aborted when the app cuts the turn off; an HTTP handler gets everything else as JSON.

A tool that answers `pending` gives its result later from the extension's service, with `result(call, content)` (see "Services"). It offers a turn that hands the model the result.

## Services

A hook runs when the runtime calls it, inside a turn. A service runs on its own for the whole session: it watches something outside the conversation and can start a turn. See "Services and offers" in `architecture.md`.

An extension with `service: true` in its `extension.yaml` exports a `service` function beside its default one. An extension that is only a service needs no `hooks` and no default export.

```ts
export async function service({ config, session, signal, log, ext, offer, result, voice }) {
  // runs until `signal` is aborted, when the session ends
}
```

| Field | What |
|---|---|
| `config` | the character's config for the extension, as its hooks get it |
| `session` | `{ id, channel }` |
| `signal` | an `AbortSignal` the runtime aborts when the session ends. Stop when it fires |
| `log(line)` | writes a line to the runtime's log |
| `ext.get()` / `ext.set(value)` | read and replace the extension's own `state.ext.<name>`. A write is kept for the session, and the next hook sees it, even one running on the turn already open |
| `offer(req)` | offers a turn (below). Resolves to `accepted`, `expired` or `closed` |
| `result(call, content, req?)` | offers a turn with the result of a call whose tool answered `pending`, with `source: tool`. `req` takes the rest of an offer's keys |
| `voice.state` | what the player's voice is doing: `idle`, `listening`, `thinking`, `speaking`, or `offline` when the player has no offers link |
| `voice.since` | `Date.now()` when `voice.state` last changed |
| `voice.on(fn)` | calls `fn(state)` on every change; returns the function that stops it |

The runtime starts each service just after `on_session_start`. When the session ends it aborts `signal`, waits up to 2 seconds for the services to return, then runs `on_session_end`. A service that throws is logged and started again, after a wait that doubles from 1 second up to 30. One that returns is done, and is not started again. Either way, when a run ends its `signal` is aborted and its `voice.on` listeners are removed, so a service that only reacts to the voice keeps running until `signal` fires.

A service writes only its own `ext.<name>`. To give a hook something to put in the prompt, the service writes it there and the hook reads `state.ext.<name>`. To learn what happened in a turn, a hook of the same extension writes it there and the service reads it with `ext.get()`.

### Offers

`offer(req)` asks the runtime to start a turn with a line of input:

```ts
const outcome = await offer({ text: "@ana asked in chat: what's your favorite song?", source: "chat" });
```

| Key | Default | What |
|---|---|---|
| `text` | required | the user's side of the turn, up to 4000 characters, with no control characters other than newlines and tabs. The character answers it; it is not said as written |
| `source` | `offer` | the turn's `input.channel`, a lowercase word like `chat`, `screen` or `idle` |
| `quiet_ms` | `2000` | how long the voice must have been idle before the offer goes out, so the character doesn't take the floor the moment it stops. At most a day |
| `ttl_ms` | `10000` | how long the offer may wait. Past it, the offer resolves `expired`. At most a day |
| `priority` | `0` | higher goes first; among equals, the oldest |

The runtime keeps a queue per session and hands one offer at a time to the player, only while its voice is idle. After the player takes one, nothing else goes out until that turn has started, or the voice has stayed idle for 5 s more. If the player refuses one because someone just started speaking, it goes back in the queue and waits for the next quiet moment. A taken offer is an ordinary turn. The player sends it back as the user's line, and its `input` has `channel` set to the offer's `source` and `offered_by` set to the extension's name.

`offer` resolves `accepted` when the player takes it, `expired` when its `ttl_ms` ran out first, and `closed` when the session ended first. A service paces itself on that. For example, after `accepted` it can wait out a cooldown before it offers again.

`examples/extensions/dead-air` is the smallest service: it offers one line once the voice has been quiet for a while.

## Blocking and non-blocking

- **Blocking** (default): the turn waits; the returned state goes to the next extension.
- **Non-blocking**: the extension gets a copy of the state and the turn moves on. Its return value is dropped. Use it for side effects like metrics or transcripts.

On `on_sentence` and `on_speak`, blocking only makes the next extension wait. It never delays the audio. On `before_reply`, blocking holds back only the first sentence, not `before_llm` or the LLM call, and the runtime keeps only `cancel`. See "Cancelling a turn" in `architecture.md`.

A blocking extension has 5 seconds by default. Set `timeout_ms` on the hook in `extension.yaml` to change it. If it runs out, the runtime logs it, drops the extension's changes, and the turn goes on.

## Examples

The extensions in `extensions/` ship with the harness and show the shape:

| Extension | Hooks | What it does |
|---|---|---|
| `emotion-tags` | `on_sentence`, blocking (500 ms) | changes the face the moment a sentence starts, from the delivery tag it opens with and the character's `tags` map (`[teasing]` → `playful` for FoxGlove). No model call |
| `director` | `on_sentence` blocking (10 s), `on_session_end` non-blocking | asks a second model to stage each line: an emotion, a talking style, a gesture and a camera move per phrase |
| `memory` | `before_llm` blocking (1.5 s), `after_turn` and `on_session_end` non-blocking | asks Typesafe's Jev whether what the user said is worth keeping, keeps it in their own words in a tree per character, marks what it makes out of date, and puts what the character remembers in the prompt. See `extensions/memory/README.md` |
| `reactions` | `before_reply` blocking (1.5 s), `on_sentence` blocking (500 ms), `on_session_end` non-blocking | asks Typesafe's Jev how the character takes the user's message, and starts the reply's first sentence with a beat: the emotion that fits and maybe a gesture. List it after `emotion-tags` and before `director`. See `extensions/reactions/README.md` |
| `game-link` | `before_llm` blocking (500 ms), `on_tool_call` (3 s), and a service | the server games built with neuro-sdk connect to. It puts what a game says in the prompt and its actions in `tools` (see "Tools" in `architecture.md`), offers a turn when the game speaks up or forces an action, and sends the game the action the character calls, with the game's answer as its result. See `extensions/game-link/README.md` |
| `dead-air` (in `examples/extensions/`) | none; a service | speaks up after a while of quiet: it offers the character a line saying nobody has spoken, then waits out a cooldown. See `examples/extensions/dead-air/README.md` |

### The director's config

The director reads its words from the character's config, usually a `director.yaml` next to `character.yaml` (`config_file: director.yaml`). `characters/foxglove/director.yaml` is a complete one to copy.

| Key | What |
|---|---|
| `model` | `{ base_url, api_key_env, model }`: an OpenAI-compatible chat model that stages the lines |
| `emotions` | `{ name: hint }`: the emotions it may pick, each with what it means |
| `intense` | emotions only for peaks, capped per reply |
| `registers` | talking styles: the names under `rig.animations.talk` |
| `gestures` | the names under `rig.animations.gestures` |
| `cameras` | camera moves: `hold`, `push-in`, `close-up`, `pull-back` |
| `limits` | `{ cameras, intense }`: how many of each per reply |
| `tags` | `{ tag: emotion }`: delivery tags and near-miss words mapped to an emotion (`emotion-tags` reads it too) |
| `prompt` | the director's instructions |

Its `extension.yaml` asks for the key `model.api_key_env` names, so the runtime checks whichever key the character's director uses.

Other ideas the hooks and services fit: watching a group chat and offering a message to answer (a service, plus `before_llm` to put the chat in the prompt), awarding points from how the character ended a turn (`after_turn`), sending turns to a monitoring or eval service (`after_llm`, non-blocking), or blocking a topic before the model sees it (`before_llm`).

## Sharing extensions

An extension is a folder with an `extension.yaml`; its `handler` is a file in that folder or an HTTP URL. A character uses one from anywhere by pointing `path` at its folder, so an extension can live in its own repo.

## What the runtime does not do

Namespacing, retries and storage are up to each extension. Convention: keep your data under `state.ext.<name>`.
