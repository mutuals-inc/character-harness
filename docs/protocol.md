# App protocol

The player app and the runtime talk over one WebSocket for the whole conversation, at `ws://127.0.0.1:8788/session/<token>` by default (`HOST` and `PORT` change it; see `runtime/README.md`). The token is new every time the runtime starts and is given only to the player, in `HARNESS_URL`; a connection without it, or from a web page (any request with an `Origin` header), is refused. Messages are at most 4 MB. Text frames are JSON objects with a `t` field; binary frames carry audio. `runtime/src/session.ts` is the implementation.

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
| `{t:"llm", id, history, source?}` | write a reply. `history` is the conversation so far, `[{role, content}]` with `role` `user` or `assistant` (others are dropped; the system prompt is the character's), ending with the user's turn. `source` is `voice` (default), `chat` or `screen`; the player sends voice only |
| `{t:"tts", id, text}` | voice one sentence of the reply. A `tts` with empty text, or the `…` of a silent reply, gets no answer at all |
| `{t:"cancel", id}` | stop the reply or sentence with that `id`, for example when the user interrupts. Nothing more is sent for it: no `llm_done`, `tts_done` or `error`. The `id` may then be used again at once |

## Runtime to app

| Message | What |
|---|---|
| `{t:"mode", text:"companion", v}` | sent when the socket opens; `v` is the protocol version, currently `1` |
| `{t:"stt_partial", text, utterance?}` | the transcript so far |
| `{t:"stt_final", text, utterance?}` | the transcript of a finished utterance |
| `{t:"llm_delta", id, text}` | the next piece of the reply |
| `{t:"llm_done", id}` | the reply is complete |
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
| `llm_<status>`, `llm_network`, `llm_failed`, `llm_empty` | the reply's | the chat model failed: an HTTP error, no connection, an error partway through the reply, or a reply with no text | no `llm_done` |
| `llm_busy`, `tts_busy` | the request's | too many replies (2) or sentences (8) in flight, or a reply (for `llm`) or sentence (for `tts`) on the same `id` still in flight; the request was not run | nothing more for the refused request; one already in flight on that `id` goes on |
| `tts_<status>`, `tts_network`, `tts_connect`, `tts_dropped` | the sentence's | the voice failed | no `tts_done`; the app may ask for the sentence again with the same `id` |
| `stt_upstream` | `0` | speech to text could not connect | it tries again after a wait that grows from 1 s to 15 s, as soon as there is mic audio or an `stt_eos` to send |

### Silent replies

When an extension cancels a turn, the reply is a single `{t:"llm_delta", id, text:"…"}` followed by `llm_done`. The app voices `…` as silence: its `tts` gets no answer.

A turn the chat model chose to stay quiet on, by answering the character's `models.chat.silent_reply`, looks the same to the app. The app keeps `…` in the history as it would for any silent reply.
