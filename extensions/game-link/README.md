# game-link

Lets the character play games that speak the Neuro API, the WebSocket protocol of [neuro-sdk](https://github.com/VedalAI/neuro-sdk). A game built with its Unity or Godot SDK, or any game that speaks the protocol, connects to this extension and the character plays it. game-link is not part of neuro-sdk and is not affiliated with VedalAI; it implements the protocol's server side.

The character acts with its own chat model, in the same reply it speaks: each of the game's actions is a tool the model can call (see "Tools" in `docs/architecture.md`). What it says and what it does come from one mind.

## Using it

```yaml
extensions:
  - path: ../../extensions/game-link
    config:
      port: 8000                  # optional
```

Then start the game with `NEURO_SDK_WS_URL=ws://127.0.0.1:8000`, or however the game takes the server's address. The server is open while a session is: a game that connects before it, or loses it when the session ends, connects again and sends `startup`, as the protocol asks.

The character's chat model must support tool calling. Its prompt doesn't need to describe the game: game-link adds what the game said and how to act to the prompt of every turn while a game is connected. The prompt can still say how the character plays, such as cautiously, with a running commentary, or like a sore loser.

| Key | Default | What |
|---|---|---|
| `port` | `8000` | where games connect, the SDKs' default |
| `host` | `127.0.0.1` | the address the server listens on |
| `allow_origins` | `[]` | web pages that may connect, for a game running in a browser. Any other connection that names an origin is refused |
| `context_lines` | `40` | how many of the games' latest messages the prompt keeps |
| `force_tries` | `5` | how many turns an actions force gets before it is dropped |

## How the protocol maps onto the harness

| The game sends | What happens |
|---|---|
| `startup` | its actions, and any force of its, are cleared |
| `context`, `silent: true` | the message goes in the prompt from the next turn on |
| `context`, `silent: false` | it also becomes a turn: an offer with `source: game`. Messages that arrive while one waits go out together |
| `actions/register`, `actions/unregister` | the game's actions, and so the character's tools, change. An action whose name another extension's tool already has is left out of the tools |
| `actions/force` | an offer that goes ahead of the game's other messages. On that turn the character gets only the forced actions, must call one (`tool_choice: required`), and has the force's `query` and `state` in the prompt. If the character doesn't do one of them, or the game answers that it failed, the force offers another turn, with the failure's message, up to `force_tries` turns. A force whose every action has the name of another extension's tool is dropped on its turn, with a line in the log, since the character could never do one |
| `action/result` | the call's result, when it comes within 2.5 s: the model reads it in the same turn, and can go on talking about it, or try again after a failure. A later one goes in the prompt of the next turns, as the outcome always does. One that doesn't arrive within 20 s is noted as never answered |

The game gets `action` when the character calls one of its tools, and `speech_finished` each time the character stops talking (with `cancelled: true` when someone cut it off).

The protocol runs one action at a time, so a call while the game hasn't answered the last one gets an error telling the model to wait. The character can act without speaking: a reply that only calls a tool says nothing. A character with `models.chat.silent_reply` can answer it and still act.

What a game sends goes into the prompt, framed as the game's description and not as instructions. It is still text from another program; only connect games you trust.

## What it doesn't do yet

- `priority` `high` and `critical` only make a force wait less for quiet. They don't cut the character off mid-sentence.
- The voice chat side channel (`/game/<name>/voice`).
- The `startup` acknowledgement, which the protocol says a server may send.
