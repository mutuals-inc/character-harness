# Runtime

The conversation loop: speech in, the chat model's reply, each sentence staged by extensions, speech out. It fires the events described in `../docs/architecture.md` and holds no character-specific logic.

It runs on Node and loads extensions from their folders.

```bash
npm install
npm start -- characters/<id>   # a character
npm start                      # FoxGlove, whose body needs a player build that includes it
```

For a character with `rig.model`, it first retargets the character's animations onto its model and writes the result to `.cache/characters/<id>/` for the player (`src/rig/`). With `HARNESS_PLAYER` set to the command that opens the player, it then starts it and stops when the player closes (`src/player.ts`).

It serves the app on `ws://127.0.0.1:8788/session/<token>`, with a new token on every start; it prints the URL, and gives it to the player it starts. Set `PORT` in `.env` to change the port, and `HOST=0.0.0.0` so another device on the same network can reach it (it still needs the token).

`../docs/protocol.md` describes the app protocol; `src/session.ts` implements it.

`npm test` runs the tests in `test/`; they need no keys or network.
