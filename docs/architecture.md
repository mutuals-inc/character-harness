# Architecture

Three parts: the **player** (`player/`) renders the character, the **runtime** runs the conversation, and **extensions** add behavior. A **character** is a folder the runtime loads through its manifest.

## The turn loop

The runtime fires an event at each step of a turn and knows nothing about what extensions do with it.

```
input (voice, chat, screen, or an offer from a service)
  ├→ before_reply   reply at all?
  └→ before_llm     build the prompt; inject context
     → llm          the character's model writes the reply
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
| `before_llm` | the prompt is being built | `input`, `messages`, `prompt` | memory recall, context injection, blocking a topic |
| `after_llm` | the full reply is written (a silent reply is cut off at the token); early sentences may already be playing | `+ reply` | observability spans, logging the reply |
| `on_sentence` | per sentence, while TTS synthesizes it | `+ sentence`, `beats` | staging: emotion, gesture, camera |
| `on_speak` | a sentence's audio and timing are ready | `sentence` + `timing` | sync expressions to the audio |
| `after_turn` | the turn is closed | everything | memory writes, metrics, rewards, transcripts, eval data |
| `on_session_end` | the session closes | everything, plus the end reason | consolidate memory, close metrics, report the session to an eval service |

Every hook is blocking unless the extension sets `blocking: false` for it. See `extensions.md` for what that means.

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
- It also notes when each utterance was spoken. A voice turn's `input.utterances` lists the speech its line was heard as, oldest first: `[{text, start_ms, end_ms}]`, from the first word's start to the last word's end, in Unix ms on the runtime's clock. A line usually holds one utterance, and more when the person paused partway. The app sends the runtime only text, so the runtime finds the utterances by matching the line against the transcripts it sent in the last minute. A line it can't build whole from them, such as one typed or edited, has no `utterances`.
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
- With `silent_reply` set, a reply that starts with it, after any leading whitespace, is silent, even if text follows. The runtime holds the start of each reply until it can tell, stops the model as soon as it sees the token, and ends the turn like a cancelled one: `cancel` is `true` and `reply` is what had arrived when the model was stopped. Unlike a cancelled turn, `after_llm` still fires, so a logger sees the model chose silence.
- The runtime never tells the model about `silent_reply`. The character's prompt says when to answer it. The app keeps a silent reply in the history as `…`, and the runtime turns it back into the token before the model sees it. That includes turns an extension cancelled, so the model sees those as its own silent replies too.

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
| `messages` | recent conversation |
| `prompt` | the system prompt being built |
| `reply` | the full reply, once written |
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
