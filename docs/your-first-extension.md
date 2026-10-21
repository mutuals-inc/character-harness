# Your first extension

This guide builds `gesture-cues`, a small extension that plays a gesture when the character says certain words: a wave on "hello", a cheer on "you did it". It makes no model call and needs no key, so you can build and test it without spending anything.

The finished extension is in `examples/extensions/gesture-cues/`. `extensions.md` is the full contract and `architecture.md` explains the turn loop; this guide links to them instead of repeating them.

You need a checkout of this repo with `npm install` done. You don't need keys or the player until the last step.

## 1. The folder

An extension is a folder with a manifest and a handler:

```
extensions/gesture-cues/
  extension.yaml   which hooks it runs on, and the keys it needs
  index.ts         the handler
```

It can live anywhere. A character points at it by path, so you can also keep it in its own repo.

## 2. The manifest

`extensions/gesture-cues/extension.yaml`:

```yaml
name: gesture-cues
handler: index.ts
hooks:
  # no model call, so half a second is plenty
  on_sentence: { timeout_ms: 500 }
```

- `hooks` names the events it runs on. `on_sentence` fires once per sentence of the reply while its audio is being made, which is where staging goes. The other hooks are listed in `architecture.md`.
- Every hook is **blocking** unless you write `blocking: false`. A blocking hook's changes are kept and passed to the next extension. `timeout_ms` (default 5000) is how long the runtime waits before it drops the extension's changes and moves on. It can't stop a handler that loops without yielding, so keep handlers quick, and make anything slow async. On `on_sentence`, blocking never delays the audio.
- A non-blocking hook gets a copy of the state and its return value is dropped. Use it for side effects like logging or metrics.
- `gesture-cues` needs no key. An extension that calls a service lists the key it needs, by name, and the runtime checks the key is in `.env` before it starts:

  ```yaml
  requires_env: [WEATHER_API_KEY]
  # or the key the character's config for it names, like the director does:
  requires_env: [{ config: model.api_key_env }]
  ```

  Never put a key's value in a manifest or a config. Keys go in `.env`; the handler reads them from `process.env`.

## 3. The handler

The handler's default export gets `{ event, state, config }` and returns `{ state }`, or nothing for "no change". It can be sync or async.

`extensions/gesture-cues/index.ts`:

```ts
// Plays a gesture when the character says one of its cue phrases: a wave
// on "hello", a cheer on "you did it". The gesture lands on the phrase itself.
//
// config:
//   cues: { "hello": wave, "you did it": cheer }   phrase -> gesture

interface Input {
	event: string;
	state: { sentence?: string; beats?: object[] };
	config: { cues?: Record<string, string> };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default function ({ state, config }: Input) {
	const sentence = state.sentence ?? "";
	// delivery tags like [laughs] aren't spoken, so they can't be cues; blanked
	// to the same length, so a match's place is its place in the sentence
	const spoken = sentence.replace(/\[[^[\]]*\]/g, (tag) => " ".repeat(tag.length));
	// the cue that comes first in the sentence; one gesture per sentence
	let first: { at: number; span: string; gesture: string } | undefined;
	for (const [phrase, gesture] of Object.entries(config.cues ?? {})) {
		// the whole phrase, in any case, not part of a longer word
		const m = new RegExp(`(?<![\\p{L}\\p{N}])${escape(phrase)}(?![\\p{L}\\p{N}])`, "iu").exec(spoken);
		if (m && (!first || m.index < first.at))
			first = { at: m.index, span: sentence.slice(m.index, m.index + m[0].length), gesture };
	}
	if (!first) return; // nothing to add, so no change
	const beat = { span: first.span, gesture: first.gesture };
	return { state: { ...state, beats: [...(state.beats ?? []), beat] } };
}
```

On `on_sentence`, `state.sentence` is the sentence and `state.beats` is where cues for it go. A beat's `span` is the exact text where it starts, so the runtime can time the wave to the moment "hello" is heard. Its words (`gesture`, `emotion`, `register`, `camera`) come from the character's own vocabulary. See "Beats" in `architecture.md`.

### Which state you may write

Every hook gets the same state object (the table is in "State" in `architecture.md`). An extension writes only:

- **the shared turn fields it means to change**: here `beats`. On `before_llm` it might be `prompt`, or `cancel` to end the turn.
- **its own data**, under `state.ext.<name>`: here that would be `state.ext["gesture-cues"]`. It is kept for the whole session. Never write another extension's key.

Return the whole state with your change, not just the part you changed. `gesture-cues` keeps nothing, but if it counted turns it would look like this on `before_llm` (with `ext: Record<string, unknown>` added to `Input`'s `state`):

```ts
const mine = (state.ext["gesture-cues"] ?? { turns: 0 }) as { turns: number };
return { state: { ...state, ext: { ...state.ext, "gesture-cues": { turns: mine.turns + 1 } } } };
```

Hooks for different sentences of one reply run side by side, each on its own copy, so count and accumulate on `before_llm` or a blocking `after_turn`, not `on_sentence`.

## 4. Add it to a character

A character lists its extensions in `character.yaml`, in the order they run, each with its config. To try it without touching FoxGlove, copy her:

```sh
cp -r characters/foxglove characters/my-fox
```

Then, in `characters/my-fox/character.yaml`, set `id: my-fox` and add `gesture-cues` to `extensions:`, after `emotion-tags`:

```yaml
extensions:
  - path: ../../extensions/emotion-tags
    config_file: director.yaml
  - path: ../../extensions/gesture-cues
    config:
      cues:
        hello: wave
        "you did it": cheer
  - path: ../../extensions/director
    config_file: director.yaml
```

Extensions on one hook run one after another, so put fast ones with no model call, like this one, before the director. After it, a cue would wait for the director's model call, and its beat would queue behind the director's.

The runtime hands `config` to the handler as it is. For a longer config, put it in a YAML file next to `character.yaml` and name it with `config_file`; keys in `config` win over the file's.

## 5. Check the config

A config with a typo shouldn't wait until a call to show up. A handler module may also export `check({ config, body })`. `npm run check` and `npm start` call it before any conversation. `body` has the names the player has for this character: `{ emotions, registers, gestures, cameras }`, each a list, or `null` when it can't be told from here.

`check` returns `{ errors, warnings }`, or nothing when all is well. Your extension decides how serious each problem is:

- an **error** is for a config it can't work with. `npm start` stops.
- a **warning** is for something that only won't do anything. The character starts anyway.

Add this to `extensions/gesture-cues/index.ts`:

```ts
// What `npm run check` and `npm start` ask before a call. A config it can't
// use is an error, so the character doesn't start; a gesture the character
// doesn't have is a warning, since on stage it would only do nothing.
export function check({ config, body }: { config: { cues?: unknown }; body: { gestures: string[] | null } }) {
	const cues = config.cues;
	if (!cues || typeof cues !== "object" || Array.isArray(cues))
		return { errors: ["`cues` must map a phrase to a gesture, like { hello: wave }"] };
	const errors: string[] = [];
	const warnings: string[] = [];
	for (const [phrase, gesture] of Object.entries(cues)) {
		if (!phrase.trim() || phrase.length > 200 || typeof gesture !== "string")
			errors.push(`cue ${JSON.stringify(phrase.slice(0, 40))} must map a phrase (up to 200 characters) to a gesture's name`);
		else if (body.gestures && !body.gestures.includes(gesture))
			warnings.push(`"${phrase}" plays "${gesture}", a gesture this character doesn't have`);
	}
	return { errors, warnings };
}
```

Run it. It needs no keys or player, and makes no calls:

```sh
npm run check -- characters/my-fox
```

```
FoxGlove (characters/my-fox)
  ✓ manifest, prompt, 3 extensions
  ✓ keys: XAI_API_KEY, ELEVENLABS_API_KEY
  ✓ body: profile foxglove, 7 gestures
  ✓ emotion-tags: config
  ✓ gesture-cues: config
  ✓ director: config
0 errors, 0 warnings
```

Change `wave` to `bow`, a gesture FoxGlove doesn't have, and run it again:

```
  ⚠ gesture-cues: "hello" plays "bow", a gesture this character doesn't have
```

Your list of keys and gestures may differ; without a `.env` the keys line is a warning, which is fine for a check.

## 6. Test it

The repo's tests use `node:test` and need no keys or network. Call the handler and `check` directly with the state and config you want.

`runtime/test/my-gesture-cues.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import cues, { check } from "../../extensions/gesture-cues/index.ts";

const config = { cues: { hello: "wave" } };

test("a cue phrase adds its gesture on the phrase", () => {
	const out = cues({ event: "on_sentence", state: { sentence: "Well, hello there!", beats: [] }, config });
	assert.deepEqual(out?.state.beats, [{ span: "hello", gesture: "wave" }]);
});

test("a sentence without a cue is left alone", () => {
	assert.equal(cues({ event: "on_sentence", state: { sentence: "Othello is a play." }, config }), undefined);
});

test("a gesture the character doesn't have is a warning, a config it can't use an error", () => {
	const body = { gestures: ["wave"] };
	assert.match(check({ config: { cues: { hello: "bow" } }, body }).warnings!.join(), /bow/);
	assert.ok(check({ config: {}, body }).errors!.length);
});
```

```sh
node --test runtime/test/my-gesture-cues.test.ts
npm test             # every test
npm run typecheck
```

`runtime/test/examples.test.ts` goes further: it loads a character that lists the example, runs its `check` the way `npm run check` does, and runs the hook through the runtime.

## 7. Try it live

With keys in `.env` and the player open (see the README's quickstart):

```sh
npm start -- characters/my-fox
```

Say hello. The wave comes from `gesture-cues`; the director may stage the same sentence too. A blocking extension that throws or runs out of time is logged as `[ext] gesture-cues on_sentence ...` and the turn goes on without its changes.

When you're done, delete `characters/my-fox`, and `extensions/gesture-cues` and `runtime/test/my-gesture-cues.test.ts` unless you mean to keep them, so they don't end up in a commit.

## Share it

Keep the folder in its own repo and people point a character's `path` at it. A handler can also be an `http(s)://` URL to a service in any language that takes the same input as a JSON `POST` (see "Handlers" in `extensions.md`). Say in your README what config it takes and which keys it needs.

An extension runs with the runtime's access: the keys in `.env`, the files, the network. Use only extensions you trust, and see `SECURITY.md`.

## Next

- `extensions.md`: the manifest, handlers, blocking and `check` in full.
- `architecture.md`: every hook, the state, beats and cancelling a turn.
- `extensions/`: the bundled extensions. `emotion-tags` is the closest to this one; `director` and `memory` call models.
