# reactions

How the character reacts to what the user just said: delight at good news, a softer face at bad, a flash of irritation at a jab, a laugh at a good joke, a wave at hello. It shows as the character starts to answer, as one emotion on its face and maybe a gesture, on the reply's first sentence.

When the user's message arrives, one request to [Typesafe](https://typesafe.ai)'s judge model, Jev, asks a few questions about it. The extension picks an emotion and a gesture from the answers and adds them as a beat at the start of the reply's first sentence (see "Beats" in `docs/architecture.md`). The player already knows what to do with it.

## What it is and isn't

- **It shows when the reply starts, not while the character listens.** Beats ride on the reply's audio, so the face changes when the reply's first sentence starts playing.
- **One emotion and a gesture, nothing finer.** The emotion plays the way the player's emotion set says (its own timing and strength); there is no separate rise, hold or fall.
- **Then the reply takes over.** The director's beats replace it as they come.

## Using it

Put the key in `.env` (`TYPESAFE_API_KEY=...`), write a config for the character (`example.yaml`, next to this README, is a complete one, written for FoxGlove's emotions and gestures), and add the extension to the character's `extensions:`, after `emotion-tags` and before `director`:

```yaml
extensions:
  - path: ../../extensions/emotion-tags
    config_file: director.yaml
  - path: ../../extensions/reactions
    config_file: reactions.yaml
  - path: ../../extensions/director
    config_file: director.yaml
```

The order matters, because the extensions on a sentence run one after another and each one's beats go out as it returns; at the start of a sentence, the last emotion sent is the one that shows.

- **After `emotion-tags`, before `director`** (the one to use): the reaction's emotion lands after the one `emotion-tags` took from the line's delivery tag, so the line starts with how the character took the message, and the director's beats stage the rest of it.
- **Before `emotion-tags`**: the emotion from the delivery tag lands right after the reaction's and replaces it before any audio plays. A character whose model opens most lines with a tag, like FoxGlove, would hardly ever show a reaction.
- **After `director`**: don't. The director can take up to 10 s on a sentence, so the reaction would land late, in the middle of a line. And this extension tells the reply's first sentence by which one reaches it first; behind the director, which answers sentences in batches, that can be a later one.

`npm run check -- characters/<id>` checks the config against the emotions and gestures the player has for the character.

## When it runs

- **`before_reply`** asks the judge, alongside the chat model. The reply's first sentence waits for it, at most 1.5 s; the judge gives up at 1.2 s (at most 1.4). In our runs it answered in 230-520 ms (median about 270 ms), usually before the chat model's first sentence. It keeps what it decided for that turn, in memory. A turn an earlier extension has already cancelled isn't judged. `before_reply` extensions run one after another, so a gate listed after this one waits up to the judge's timeout before it can decide; list gates first.
- **`on_sentence`** adds the beat to the turn's first sentence only: the first sentence of the turn it sees, which is the reply's first as long as nothing listed before it holds sentences back. Later sentences, other turns and other sessions get nothing, and so does a turn where nothing was decided.
- **`on_session_end`** forgets the session. A newer turn replaces an older one's decision, and a session quiet for 30 minutes is dropped.

A failed, late or malformed answer means no beat, and the runtime logs why; the turn goes on as if it weren't there. It makes one paid request per user message.

What it sends is bounded: the message is cut to 4000 characters, each earlier message to 1000, the name to 200, the description to 1000 and `about` to 2000, with at most 50 earlier messages. An answer over 64 KB is refused.

## What it asks

| Question | Kind | What |
|---|---|---|
| `beat` | choice | the expression that flashes across the character's face on first hearing it, from the config's `beat` options |
| `settle` | choice | the mood the message puts the character in a few seconds on, from the `settle` options |
| `intensity` | score 0..4 | how much it moves the character, from nothing to overwhelming |
| `guarded` | yes/no | would the character keep it off its face, out of politeness or pride |
| `amused` | yes/no | is the message funny |
| `personal` | yes/no | is it about the character rather than the user's own life, someone else or a topic |
| `gesture` | choice | which of the character's `gestures` fits, or `still` |

The judge sees the character's name, description and `about`, the last few messages and the user's message. The questions name the character: asked about "the character", the judge mixed the character up with the user and rated "i got the job" as being about the character. Its rubrics only describe; every threshold is in the code, since questions asked together influence each other.

## How it picks

Intensity becomes 0..1 (its weighted level over the top level), and yes/no answers the probability of yes. The reaction's strength is `(0.14 + 1.05 × intensity) × (1 − 0.55 × guarded) × (1 + 0.2 × personal)`, at most 1.4: the character shows less of what it would hide and more of what's about itself.

One emotion, the first that applies:

1. **A laugh** when amused is at least `laugh` (with `laugh` configured).
2. **The reaction's emotion** when it has one, the judge is at least `unsure` sure of it, and its strength is at least `strong`.
3. **The mood's emotion** when the judge is at least `settle` sure of it and intensity is at least `settle_intensity`, so small talk and light lines like "goodnight" leave the face alone instead of carrying a mood over.
4. Otherwise none.

**A gesture** comes with it when it isn't `still`, the judge is at least `gesture` sure, and intensity is at least `gesture_intensity` or the judge is at least `gesture_sure` (a wave at hello). With neither an emotion nor a gesture, there is no beat.

## Config

| Key | Required | What |
|---|---|---|
| `model.api_key_env` | yes | the key's name in `.env`, usually `TYPESAFE_API_KEY` |
| `model.base_url` | no | default `https://api.typesafe.ai/v1` |
| `model.model` | no | default `jev-latest` |
| `model.timeout_ms` | no | how long it waits for the answer, default 1200, at most 1400 (the hook gives up at 1500; the check warns about more) |
| `about` | no | a few lines on who the character is, for the judge: what the character cares about, what annoys it, names the judge should know |
| `context` | no | how many earlier messages the judge sees, default 6, at most 50 |
| `beat` | yes | `{ option: emotion }`: at least two. `""` is no emotion. The options below have rubrics built in; any other needs `{ emotion, rubric }` |
| `settle` | no | `{ option: emotion }`, the same way. Without it a mild reaction shows nothing |
| `gestures` | no | `{ gesture: when it fits }`. Without it there's no gesture |
| `laugh` | no | `{ emotion }`. Without it a funny line is like any other |
| `thresholds` | no | any of `unsure` (0.35), `strong` (0.55, up to 1.4), `settle` (0.22), `settle_intensity` (0.25), `laugh` (0.82), `gesture_intensity` (0.35), `gesture` (0.7), `gesture_sure` (0.95) |

Built-in `beat` options: `nothing`, `brow_flick`, `lean_in`, `held_smile`, `delight`, `lit_up`, `tease`, `startle`, `flustered`, `soften`, `stung`, `flare`, `turn_it_over`.

Built-in `settle` options: `neutral`, `relaxed`, `content`, `warm`, `thoughtful`, `playful`, `confident`, `dreamy`, `low`.

A built-in option takes a `rubric` of its own to change what it means. The check makes an unusable config an error, and an emotion or gesture the character doesn't have a warning.

## How the defaults were tuned

Against Jev, with FoxGlove's words and 36 lines: big news good and bad, small talk and filler, jokes and jokes that escalate, teasing, compliments, rude lines, questions to FoxGlove, odd facts and mundane updates.

- A gesture the judge picked with 0.5-0.66 confidence was usually wrong (a startled jump at "my dog died", a cheer at a compliment); the right ones came at 0.75 and up. Hence `gesture` 0.7, and gesture rubrics that say when not to move.
- Small talk ("hey", "ok", "um, yeah, so") comes back as `nothing` with intensity under 0.1. A "goodnight" after a sad exchange scored 0.15 and would have carried a sad face over, so the mood needs 0.25.
- Big news, compliments and jabs come out at strength 0.65 and up; odd facts, passing questions and an embarrassing story under 0.5. `strong` at 0.55 shows the first as the reaction itself and leaves the second to the mood.
- With mishaps counted as funny, an embarrassing story or a pun is amused about 0.75-0.8 and a joke that escalates about 0.88, so `laugh` is 0.82.
- Asked which face she rests in, FoxGlove (loud and proud) answered `confident` after almost anything, sad news included; asked what mood the message puts her in, sad news makes her low, a pastel jab sulky, a joke playful.
- Repeated three times, the same lines got the same choices, with numbers within about 0.03.
