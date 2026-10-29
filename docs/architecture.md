# Architecture

Three parts: the **player** (`player/`) renders the character, the **runtime** runs the conversation, and **extensions** add behavior. A **character** is a folder the runtime loads through its manifest.

## The turn loop

The runtime fires an event at each step of a turn and knows nothing about what extensions do with it.

```
input (voice, chat, screen, or an offer from a service)
  ├→ before_reply   reply at all?
  └→ before_llm     build the prompt; inject context
     → llm          the character's model writes the reply
       ↻ on_tool_call  a tool it called runs; a result asks the model again
     → after_llm    the full reply is written
  → on_sentence     per sentence, once before_reply is done, while TTS synthesizes it
  → on_speak        the sentence's audio and timing are ready
  → after_turn      the turn is closed
```

`before_reply` runs at the same time as `before_llm` and the LLM call. `on_sentence` fires per sentence while the model is still writing, so staging never delays the first audio, and early sentences may play before `after_llm`.

Around the turns, two session events:

```
on_session_start   someone joined, or a call started
  … turns …
on_session_end     the call or conversation ended
```

## Services and offers

A hook runs when the runtime calls it, in the middle of a turn. Between turns nothing runs, so on hooks alone the character only ever answers.

A **service** is the part of an extension that runs on its own for the whole session, from just after `on_session_start` until the session ends. It watches something outside the conversation (a group chat, a game, a clock) and does two things with what it sees:

- it keeps data in its `state.ext.<name>` at any time, and the next hook sees it there;
- it **offers** a turn: a line of input, like "@ana asked in chat: …" or "nobody has said anything for a while".

The runtime holds an offer until the player says its voice is free, then hands it to the player over the offers link (`protocol.md`). The player takes it as the user's next turn, or refuses it if someone started speaking first. A taken offer is an ordinary turn, through every hook, and its `input` says where it came from.

```
service: chat arrives → ext.set(chat) … picks one → offer("@ana asked: …")
runtime: waits for the voice to be idle → offer → player
player:  idle? takes it as the user's turn → llm
turn:    before_reply, before_llm (sees ext.<name>), the reply, … after_turn
```

So the two halves meet in `ext`. The service decides when the character speaks, and the hooks shape what the turn says. See "Services" in `extensions.md`.

## Cancelling a turn

`before_reply` decides whether the character replies. It runs alongside `before_llm` and the LLM call, so it doesn't add its time to every turn. The first sentence waits until it finishes. Its extensions work on their own copy of the state, and the runtime keeps only `cancel` from them.

A blocking extension on `before_reply` or `before_llm` ends the turn by setting `cancel: true`. The runtime skips or aborts the LLM call, nothing is spoken, and `after_turn` still fires. If a `before_reply` extension times out, the character replies.

The chat model can also stay quiet itself, by answering its `silent_reply` (see "The chat model"). The two work together:

- A `before_reply` gate is cheap and fast. Use it for what a rule or a small model can tell: the line was a cough, or another voice in the room.
- The chat model's silent reply is for what needs the whole context to tell: the persona, its rules, the conversation so far. The line was meant for someone else, or the character has decided to ignore it.

Either way the app gets the same silent reply.

## Hooks

| Hook | Fires | State ready | Typical use |
|---|---|---|---|
| `on_session_start` | a session opens | `character`, `session` | prefetch memories, open a gamification session |
| `before_reply` | input arrived; runs alongside `before_llm` and the LLM call | `input`, `messages` | the gate (reply or stay quiet), moderation that cancels the turn |
| `before_llm` | the prompt is being built | `input`, `messages`, `prompt` | memory recall, context injection, blocking a topic, offering tools |
| `on_tool_call` | the model called one of the extension's tools; runs on that extension only, and its result goes back to the model | `+ call` | running a tool: a lookup, an action in an app or a game |
| `after_llm` | the full reply is written (a silent reply is cut off at the token); early sentences may already be playing | `+ reply`, `tool_calls` | observability spans, logging the reply and the calls it made |
| `on_sentence` | per sentence, while TTS synthesizes it | `+ sentence`, `beats` | staging: emotion, gesture, camera |
| `on_speak` | a sentence's audio and timing are ready | `sentence` + `timing` | sync expressions to the audio |
| `after_turn` | the turn is closed | everything | memory writes, metrics, rewards, transcripts, eval data |
| `on_session_end` | the session closes | everything, plus the end reason | consolidate memory, close metrics, report the session to an eval service |

Every hook is blocking unless the extension sets `blocking: false` for it; `on_tool_call` always is. See `extensions.md` for what that means.

## Speech to text

ElevenLabs is the first speech-to-text provider.

```yaml
stt:
  provider: elevenlabs
  model: scribe_v2_realtime
  language: en
  keyterms: [FoxGlove]               # optional, names from the character's world the model should hear right
```

- The runtime streams the user's audio and puts the transcript in `input`.
- It also notes when each utterance was spoken. A voice turn's `input.utterances` lists the speech its line was heard as, oldest first: `[{text, start_ms, end_ms}]`, from the first word's start to the last word's end, in Unix ms on the runtime's clock. The player makes each transcript its own turn, so its lines hold one utterance; an app that joins transcripts into one line gets one per transcript. The app sends the runtime only text, so the runtime finds the utterances by matching the line against the transcripts it sent in the last minute. A line it can't build whole from them, such as one typed or edited, has no `utterances`.
- An extension can use the times to line the speech up with events from elsewhere, for example to tell who in a group call was speaking. To label a line with a name, it rewrites the user's message in `messages` in `before_llm`.
- It uses the same `ELEVENLABS_API_KEY` as the voice.

## The chat model

`models.chat` says which API to call, where, and with which key. Adding a provider is a manifest edit.

```yaml
models:
  chat:
    api: chat_completions            # or responses
    base_url: https://api.x.ai/v1
    api_key_env: XAI_API_KEY         # the key's name in .env
    model: grok-4-1-fast-non-reasoning
    params:                          # optional
      temperature: 0.9               # chat_completions only
      max_tokens: 1200
      # reasoning_effort: low        # responses only
    silent_reply: "[pass]"           # optional, what the model answers to say nothing
```

| `api` | For |
|---|---|
| `chat_completions` | xAI, or any server that speaks OpenAI Chat Completions |
| `responses` | OpenAI's Responses API, for reasoning models |

- The runtime sends `prompt` as the system message, then `messages`. It streams the answer into sentences for `on_sentence` and writes the full text to `reply`.
- On failure the runtime sets `error` and ends the turn. `after_turn` still fires.
- With `silent_reply` set, a reply that starts with it, after any leading whitespace, is silent, even if text follows. The runtime holds the start of each reply until it can tell, stops the model as soon as it sees the token, and ends the turn like a cancelled one: `cancel` is `true` and `reply` is the token, without anything the model wrote after it. Unlike a cancelled turn, `after_llm` still fires, so a logger sees the model chose silence.
- The runtime never tells the model about `silent_reply`. The character's prompt says when to answer it. The app keeps a silent reply in the history as `…`, and the runtime turns it back into the token before the model sees it. That includes turns an extension cancelled, so the model sees those as its own silent replies too.

## Tools

An extension can give the chat model functions to call, so the character acts in the same reply it speaks, or looks something up before it answers. A tool is a name, a description and a JSON schema of its arguments:

```json
{ "name": "use_item", "description": "Use an item from your bag.", "parameters": { "type": "object", "properties": { "item": { "type": "string" } } } }
```

An extension lists the tools it always offers under `tools` in its `extension.yaml`, or adds them to `state.tools` on `before_llm` when they change from turn to turn. Either way it runs them on `on_tool_call` (see "Tools" in `extensions.md`).

- The runtime sends the turn's tools with the request, in the shape of the character's `api`, as non-strict: the model may leave out a parameter the schema doesn't require, on either `api` (the Responses API would otherwise make every tool strict where it can, so every parameter required). A turn with no tools sends none. A tool whose name isn't 1 to 64 letters, digits, `_` or `-`, or whose `parameters` isn't a schema of type `object`, is left out, and so is a second tool with a name already listed. Tool names are shared by every extension, so pick names unlikely to collide.
- `state.tool_choice` says whether the model must call one: `auto` (the default), `required`, `none`, or `{ "name": "use_item" }` for that one. It applies to the turn's first request only. One that names a tool the turn doesn't send (left out, or never added) is logged and dropped, so the model may call any.
- The runtime marks each tool with `by`, the extension that added it, and sends each call to that extension's `on_tool_call`, all of a reply's calls at once. `by` is the runtime's: a tool an extension adds or changes on `before_llm` is that extension's, whatever `by` it wrote, and one it passes on unchanged keeps its owner. Unchanged means the same JSON value, whatever order its keys are in, so a hook that decodes and encodes the state again (in Go, say) takes over none of them. A call to a tool nobody offered gets an error, and so does one whose extension has no `on_tool_call`.
- No call runs until `before_reply` has let the reply through. A model that calls a tool before then waits, and a turn `before_reply` cancels runs none of its calls.
- A call's result is what the model reads next. When any call of a reply has a result or an error, the runtime asks the model again in the same turn, with its calls and their results, and what it writes then goes on in the same reply. A turn asks the model at most 4 times, and the last time it may call nothing. A call whose tool answered nothing (it is done and has nothing to report), or `pending` (its result comes later), asks nothing more by itself.
- A result that comes later comes in a turn of its own: the extension's service offers it with `ctx.result` (see "Services" in `extensions.md`).
- Speaking first and then calling a lookup is how the character fills the wait: what it said plays while the tool runs. A tool's `signal` is aborted when the app cuts the turn off and when the tool runs out of time, so a tool the model was told failed can stop before it acts.
- `state.tool_calls` has every call that ran, from `after_llm` on: `[{id, name, arguments, by, result}]`, with `arguments` the JSON text as the model wrote it and `result` what the model got back. However the turn ends after its calls ran, cut off by the app or failed, `after_turn` still sees them. A turn closed while its calls still run (a newer `llm`, the socket closing) waits for them, up to their timeouts, before its `after_turn`.
- `reply` is what the app was sent, every time the model was asked, with a space between them. It never has text the app wasn't sent.
- The history keeps the calls and their results (see "Tools in the history" in `protocol.md`), so the model remembers what it did on later turns. A `before_llm` that cuts or edits `messages` may leave a call without its result or a result without its call; the runtime pairs them again before the request, as it does the app's history. The app gets each reply's calls and results as soon as they ran, so it keeps them even when the turn then fails.
- A reply that only calls tools says nothing: the app gets `[acted]` as its text, and doesn't voice it. `cancel` stays unset, since the character did answer. The model reads such a reply as its calls and their results, with nothing after them, never as its `silent_reply`. With tools offered, a model that answers its `silent_reply` is not stopped at the token, so it can still call a tool. Its text after the token is not sent, and the runtime stops it once it has written 200 more characters. A call it finished before that text still runs, on either `api`.
- A turn cancelled or cut off before its calls run runs none of them.

## The voice

ElevenLabs is the first voice provider.

```yaml
voice:
  provider: elevenlabs
  voice_id: <voice-id>
  model: eleven_v4_turbo
  params:                            # optional voice settings
    stability: 0.5
    similarity_boost: 0.75
```

- Each sentence comes back as streamed audio plus per-character timing. The runtime puts the timing in `timing` for `on_speak`, so expressions land on the word.
- The sentence goes to ElevenLabs as written, so delivery tags like `[laughs]` work.
- Tags like `[quiet]` or `[whispers]` come back 5-10x quieter than normal speech. A character can list them under `voice.drop_tags` to have them removed before the voice. As a backup, the runtime lifts a quiet sentence toward normal loudness (up to 12x) and never turns one down.
- ElevenLabs uses `ELEVENLABS_API_KEY`.
- If a sentence fails, the runtime sets `error` and the app retries it.

## Beats

An extension on `on_sentence` stages the sentence by adding beats to `state.beats`:

```json
{ "span": "you actually did it", "emotion": "happy", "register": "upbeat", "gesture": "cheer", "camera": "push-in" }
```

`span` is the exact text where the beat starts (`""` is the start of the sentence). The words come from the character's own vocabulary, the emotions, talking styles, gestures and camera moves the app has assets for. The runtime never interprets them. It waits until the span is voiced, then sends the beat to the app timed to that moment, and the app animates the character. A beat with only an emotion at the start changes the face at once.

Each extension's beats go out as soon as it returns, so a fast extension isn't held back by a slower one after it.

## State

Every event carries one JSON state object. Extensions receive it, may change it, and pass it on. Shared fields:

| Key | What |
|---|---|
| `schema` | state version |
| `character` | the loaded manifest |
| `session` | session id, the channel, and the end reason on `on_session_end` |
| `input` | what came in this turn: `text`, and `channel` (`voice`, `chat` or `screen`, or the `source` of the offer it came from). A turn from an offer also has `offered_by`, the name of the extension that offered it. A voice turn also has `utterances` when the runtime heard all of its line (see "Speech to text") |
| `messages` | recent conversation, with the calls and results of earlier turns |
| `prompt` | the system prompt being built |
| `tools` | functions the chat model may call this turn: the ones extensions declare, and any `before_llm` adds (see "Tools") |
| `tool_choice` | whether the model must call a tool this turn, set on `before_llm` |
| `reply` | the full reply as the app got it, once written; the `silent_reply` token when the model answered it and said nothing |
| `tool_calls` | the calls the chat model made that ran, and what they gave back, from `after_llm` on |
| `turn` | the turn's number, the same for every hook of one turn |
| `sentence` | the current sentence, inside `on_sentence` and `on_speak` |
| `beats` | inside `on_sentence`: cues an extension adds for this sentence (see "Beats") |
| `timing` | when each character of the sentence is heard, inside `on_speak` |
| `cancel` | `true` to end the turn without replying, set on `before_reply` or `before_llm`, or by the runtime when the model answers its `silent_reply` |
| `error` | why the turn failed, if it did |
| `ext.<name>` | whatever an extension wants to keep. Its service can write it between turns |

The state shape is a public API and is versioned with `schema`. Renaming a key is a breaking change.

## Order

Extensions run in the order the character's manifest lists them. Within a hook, each one sees what the previous blocking ones wrote. Later hooks never see what `before_reply` wrote, only its `cancel`.
