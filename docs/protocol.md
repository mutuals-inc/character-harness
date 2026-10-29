# App protocol

The player app and the runtime talk over one WebSocket for the whole conversation, at `ws://127.0.0.1:8788/session/<token>` by default (`HOST` and `PORT` change it; see `runtime/README.md`). The token is new every time the runtime starts and is given only to the player, in `HARNESS_URL`; a connection without it, or from a web page (any request with an `Origin` header), is refused. Messages are at most 4 MB. Text frames are JSON objects with a `t` field; binary frames carry audio. `runtime/src/session.ts` is the implementation.

Beside it, the player keeps a second, smaller socket, the offers link, through which extensions start turns (see "The offers link" below).

## Who does what

The app owns the conversation. It captures the mic, decides when the user has finished speaking, keeps the history, sends it with each request, splits the reply into sentences, and asks for each sentence's voice when it has room to play it. The runtime runs the models: speech to text, the chat model and the voice, plus the extensions.

So one turn is: speech in (`stt_*`), one `llm` request, then a `tts` request per sentence. Replies and sentences share one id space: every `llm` and `tts` needs its own `id`.

## App to runtime

| Message | When |
|---|---|
| binary: PCM16, 16 kHz, mono | mic audio, while the user speaks. Up to 256 frames sent before the speech-to-text connection is open are queued |
| `{t:"stt_start", utterance?}` | the user started speaking. With an `utterance` (a positive integer), each utterance gets its own transcription session, and `stt_eos` must carry the same number |
| `{t:"stt_eos", utterance?}` | the user stopped speaking: commit the transcript |
| `{t:"stt_reset"}` | throw away what was heard |
| `{t:"llm", id, history, source?}` | write a reply. `history` is the conversation so far, `[{role, content}]` with `role` `user` or `assistant`, plus the tool entries of replies that called tools (see "Tools in the history"), ending with the user's turn. Other roles are dropped; the system prompt is the character's. `source` is `voice` (default), `chat` or `screen`; the player sends voice only |
| `{t:"tts", id, text}` | voice one sentence of the reply. A `tts` with empty text, the `…` of a silent reply, or the `[acted]` of a reply that only acted, gets no answer at all |
| `{t:"cancel", id}` | stop the reply or sentence with that `id`, for example when the user interrupts. Nothing more is sent for it: no `llm_done`, `tts_done` or `error`. The `id` may then be used again at once |

## Runtime to app

| Message | What |
|---|---|
| `{t:"mode", text:"companion", v}` | sent when the socket opens; `v` is the protocol version, currently `1` |
| `{t:"stt_partial", text, utterance?}` | the transcript so far |
| `{t:"stt_final", text, utterance?}` | the transcript of a finished utterance |
| `{t:"llm_delta", id, text}` | the next piece of the reply |
| `{t:"llm_calls", id, entries}` | tools the reply called have run: the calls and their results, to keep in the history even if the reply then fails or is cut off (see "Tools in the history") |
| `{t:"llm_done", id, entries?}` | the reply is complete. A reply that called tools also has `entries`, everything it adds to the history (see "Tools in the history") |
| binary: `[id: u8][PCM16, 24 kHz, mono]` | voice audio for a sentence, streamed as it is synthesized. The first byte is the low byte of the sentence's `id`, so sentences in flight together need ids that differ in their low byte |
| `{t:"tts_done", id}` | all audio for sentence `id` has been sent |
| `{t:"beat", id, bt, emotion, talk, gesture, camera}` | staging for sentence `id`, starting `bt` seconds into its audio: the face's emotion, the body's talking style (`talk`), a one-shot gesture and a camera move. An empty field changes nothing; `none` means none |
| `{t:"emotion", id, emotion}` | an emotion that applies at once, at the start of sentence `id` |
| `{t:"error", id, text}` | a request failed (see below) |

### Beats

The beats come from extensions (`on_sentence`). The runtime times each one to the moment its phrase is spoken, so they can arrive while the sentence plays.

The first sentence of a reply always gets an empty `beat` before any of its audio, while the reply is open. The app may hold the start of a reply for up to 2 s waiting for it; it changes nothing and lets the audio start. A sentence that arrives after the reply has closed gets no beats.

### Errors

| `text` | `id` | What happened | What follows |
|---|---|---|---|
| `llm_<status>`, `llm_network`, `llm_failed`, `llm_empty` | the reply's | the chat model failed: an HTTP error, no connection, an error partway through the reply, or a reply with no text | no `llm_done`; any `llm_calls` already sent stand |
| `llm_busy`, `tts_busy` | the request's | too many replies (2) or sentences (8) in flight, or a reply (for `llm`) or sentence (for `tts`) on the same `id` still in flight; the request was not run | nothing more for the refused request; one already in flight on that `id` goes on |
| `tts_<status>`, `tts_network`, `tts_connect`, `tts_dropped` | the sentence's | the voice failed | no `tts_done`; the app may ask for the sentence again with the same `id` |
| `stt_upstream` | `0` | speech to text could not connect | it tries again after a wait that grows from 1 s to 15 s, as soon as there is mic audio or an `stt_eos` to send |

### Silent replies

When an extension cancels a turn, the reply is a single `{t:"llm_delta", id, text:"…"}` followed by `llm_done`. The app voices `…` as silence: its `tts` gets no answer.

A turn the chat model chose to stay quiet on, by answering the character's `models.chat.silent_reply`, looks the same to the app. The app keeps `…` in the history as it would for any silent reply.

A turn where the chat model only called tools (see "Tools" in `architecture.md`) is its `llm_calls`, then a single `{t:"llm_delta", id, text:"[acted]"}`, then `llm_done` with its `entries`. The app voices `[acted]` as silence, like `…`. It is plain text, not a field of `llm_done`, because an app that keeps only the reply's text (the player) needs a reply with text, and keeps `[acted]` in its history so the model can tell the turn from a silent reply. Both strings are `SILENT_TURN` and `ACTED_TURN` in `runtime/src/markers.ts`; the app and the bundled extensions write them out again, and tests check theirs agree.

### Tools in the history

Each time the calls of a reply have run, the app gets `{t:"llm_calls", id, entries}`: the model's message that made them (what it said and its calls) and each call's result. The app adds them to what it keeps for the reply, in place of the text they hold, so a reply that fails (`error`) or that the app cuts off afterwards still has them. Text that streams after an `llm_calls` is not in its entries: if no `llm_done` comes, the app sends it in the history after them, as an `assistant` message, so the model knows it was said. A call still running when the app sends `cancel` has its `signal` aborted and is not sent.

A reply that called tools ends with `{t:"llm_done", id, entries}`. `entries` is everything the reply adds to the history, in order, and replaces what `llm_calls` brought: each time the model was asked, what it said and the calls it made, then each call's result, and last what it said after them: `[acted]` when it said nothing, or `…` when it answered its silent reply.

```json
[
  { "role": "assistant", "content": "Let me look.", "tool_calls": [{ "id": "c1", "name": "weather", "arguments": "{\"city\":\"Lisbon\"}" }] },
  { "role": "tool", "tool_call_id": "c1", "content": "18°C and sunny" },
  { "role": "assistant", "content": "It's 18 and sunny." }
]
```

The app keeps them as they are and sends them back in later `history`, so the model sees what it did. It may still mark the last one `interrupted`, or cut its `content` to what was voiced. The runtime puts each call's result right after its call, drops a result without one, and gives a call with no result one that says so. An `[acted]` right after the results is dropped, so the model reads a reply that only acted as its calls and their results, not as a silent reply.

An app that keeps only the reply's text still works: it ignores `llm_calls`, keeps `[acted]` for a reply that only acted, which the model reads as `…` (not as the silent reply), and the model doesn't see its earlier calls.

## The offers link

A service can start a turn by offering a line of input (see "Services" in `extensions.md`). The engine owns the session socket, so offers travel on a second WebSocket at the session's path plus `/offers`: `ws://127.0.0.1:8788/session/<token>/offers`. The same token and Origin rules apply. Messages are JSON text frames of at most 64 KB. The runtime keeps one link, and a newer one replaces it; the link outlives a session socket that reconnects. `runtime/src/offers.ts` is the runtime's end, `player/src/app/player_offers.c` the player's.

The player decides whether an offer becomes a turn, because only it knows whether anyone is speaking. It reports its voice, the runtime offers a line when the voice has been idle long enough, and the player takes it or refuses it. To take it, it sends the offer's text as the user's turn in an ordinary `llm` on the session socket. The runtime recognizes the text and marks the turn as the offer's.

| Message | Direction | When |
|---|---|---|
| `{t:"status", voice, epoch}` | app to runtime | when the link opens, and whenever `voice` or `epoch` changes. `voice` is `idle`, `listening`, `thinking`, `speaking` or `offline` (the session socket is down) |
| `{t:"offer", id, epoch, text}` | runtime to app | a line to take as the user's turn. `epoch` is the one from the last status the runtime saw |
| `{t:"ack", id, accepted}` | app to runtime | the answer to an offer, within 2 s. Past that the runtime treats it as refused, but an `accepted` that comes later still counts |

The player bumps `epoch` every time its voice leaves `idle`, and right after it takes an offer. It refuses an offer whose `epoch` isn't its current one, or that arrives while its voice isn't idle. So when someone starts speaking while an offer is on its way, the player refuses it, since the runtime decided it while the voice was still quiet. And two offers that arrive together can't both be taken.

After a refusal the runtime sends nothing until the next status, unless a newer status than the one the refusal was decided against has already come in. The player sends a status after every refusal, even when nothing changed. After an `accepted`, the runtime sends nothing until the voice has left `idle` (the offer's turn started) or 5 s have passed.

The runtime keeps the last status, so a session socket that reconnects while the link stays up knows the voice at once. If the link drops between the player taking an offer and the runtime reading the ack, the offer's `llm` still settles it: the runtime matches the turn's user line against the offers it has sent.

A player without the link still works. Its voice reads `offline` to services, and offers wait until they expire.
