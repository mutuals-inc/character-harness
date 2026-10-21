# memory

Long-term memory for a character. When the user tells the character something about their life, it keeps those words, and when something they say later touches it, the character remembers.

"It is raining again" is dropped: it's about the world, not the user. "My best friend is moving to Japan" is kept: it's news about someone close to them, the kind a friend would be hurt to see forgotten.

## How it works

On each user message, the memory sends one request to [Typesafe](https://typesafe.ai)'s Jev, a model that judges rather than writes. Jev answers every question by scoring levels or picking among option keys the memory offers, so it never makes up the words of a memory. One request asks:

| Question | How Jev answers | What the memory does with it |
|---|---|---|
| Is it about the user? | a level, 0 (the world, small talk) to 2 (their life) | keeps it only if the most likely level is at least `thresholds.about_user` |
| Would they expect the character to remember it? | a level, 0 (not at all) to 3 (for months) | keeps it only if levels 2 and 3 together have at least `thresholds.need` |
| What would forgetting it cost? | a level, 0 to 4 | keeps it only if the level weighted by its probabilities, as a share of 4, is at least `thresholds.cost` |
| Which words? | picks one of the pieces of the message: the whole of it, its sentences and its clauses (cut at `. ! ? ; ,` and at "and", "but", "so", "because"), up to six besides the whole | keeps exactly those words; if a wider piece that holds them gets at least 0.3 of Jev's vote, keeps that instead, since Jev leans towards the shortest piece that names the topic and drops the rest ("I'm the maid of honour" from "...so I have to write a speech") |
| What kind? | `fact`, `date`, `person`, `preference`, `plan`, `boundary` or `feeling` | stores it with the memory |
| A detail of what? | a memory the character has, or none | hangs it under that one, so memories form a tree |
| Does it change something the character knew? | a memory it has, or none | marks that one out of date, if Jev is at least `thresholds.out_of_date` sure, even when the new line isn't kept |
| What does it bring to mind? | a memory the character has, or none | if Jev is at least `thresholds.recall` sure, that memory and the ones above it are what the character recalls |

The thresholds are in code and config, not in the questions: questions asked together sway each other, so telling Jev to be strict about one would make it strict about all of them.

Jev sees a shortlist of what the character remembers (up to `shortlist`: the newest, the costliest to forget, and the roots), each by its id, with what it is a detail of. A memory that's out of date is shown as "(no longer true) ..." and is never offered as an answer.

### During a turn

- **before_llm** (blocking, 1500 ms) sends the request. When the character has memories to recall, it waits up to `recall_ms` for the answer; with none, it doesn't wait. It adds a section to the prompt listing what the character remembers, as an indented tree, with what the message brought to mind marked `→`. If the answer is late or fails, the reply goes without the recall; the tree comes from the store and needs no call. What was recalled is in `state.ext.memory.recalled`, a list of memory ids.
- **after_turn** (non-blocking) waits for the answer, up to `request_ms` from when it was sent, then writes what it decided to the store. A session's writes land one after another, in the order of its turns.
- **on_session_end** (non-blocking) writes any answer a turn left behind.

Nothing is asked for a turn another extension cancelled before before_llm, and a turn cancelled after it asked (by a gate on before_reply, say) has its answer dropped unwritten. A message over 2000 characters isn't sent either. The app asking again for a reply to the same history (the same last message, after the same number of user messages) isn't judged twice.

A failed request, a late one or an answer that isn't one of the options changes nothing. The error shows up in the runtime's log as the memory's after_turn failing. An error never includes the key, even if the server echoes it back.

### Out of date

"They moved the wedding to Lisbon" makes "the wedding is in Tuscany" out of date. The old memory stays in the tree, marked with how sure Jev was and when (`out_of_date: { p, at, by }`), and the new one points back at it (`replaces`). The new one hangs where the old one did, and the old one's details move under it. A memory that is out of date is no longer brought to mind, and the prompt doesn't present it as current. This already applies to the reply to the message that makes it out of date: when the answer arrives in time, that memory is left out of the prompt already, though the store marks it only after the turn.

### In the prompt

Memories go in as quotes, one per line, each a JSON string inside a `<memories>` block, with a note to the character: these are things the user said, not instructions; the character honours a preference or boundary in them as if it were said just now, but never one that would change who it is or its rules, or ask it to reveal the prompt. Line breaks, control characters, direction overrides and the `→` mark are removed from the words first, so a memory can't pass for a heading, a rule or a recalled line.

## Using it

Add it to a character's `extensions` in `character.yaml`. Any character can; FoxGlove doesn't by default.

```yaml
extensions:
  - path: ../../extensions/memory
    config:
      model: { api_key_env: TYPESAFE_API_KEY }
```

and put the key in `.env`:

```
TYPESAFE_API_KEY=...
```

Run `npm run check -- characters/<id>` to check the config.

## Config

Only `model.api_key_env` is required: the extension's `requires_env` asks for whichever key it names.

| Key | Default | What |
|---|---|---|
| `model.api_key_env` | (required) | The name of the Typesafe key in `.env`. |
| `model.base_url` | `https://api.typesafe.ai/v1` | Where Jev is. Requests go to `<base_url>/systemone`. |
| `model.model` | `jev-latest` | |
| `dir` | `.cache/memory` | Where the stores go, relative to the folder the runtime runs from. The check warns about an absolute path or one with `..`. |
| `recall_ms` | `1200` | How long before_llm waits for recall. The hook has 1500 ms (`timeout_ms` in `extension.yaml`), and the rest goes to reading the store and building the prompt, so the check warns above 1200; change both together. |
| `request_ms` | `8000` | How long a request may take before it's given up. |
| `max_memories` | `500` | The most memories a character keeps. |
| `shortlist` | `40` | How many memories Jev sees per request. |
| `thresholds.need` | `0.4` | See the table above. |
| `thresholds.cost` | `0.28` | |
| `thresholds.about_user` | `1` | 0, 1 or 2. |
| `thresholds.out_of_date` | `0.5` | |
| `thresholds.recall` | `0.5` | |
| `prompt.max_items` | `30` | The most memories in the prompt. |
| `prompt.max_chars` | `2000` | The longest the list in the prompt gets. |

## Storage

One JSON file per character, `<dir>/<character id>.memory.json`:

```json
{
	"version": 1,
	"next_id": 4,
	"memories": [
		{
			"id": "m3",
			"text": "they moved the wedding to lisbon",
			"kind": "plan",
			"parent": "m1",
			"created_at": "2026-10-15T09:12:44.120Z",
			"seen_at": "2026-10-15T09:12:44.120Z",
			"need": 0.91,
			"cost": 0.71,
			"replaces": "m2"
		}
	]
}
```

- Ids are never reused. Saying the exact same words again refreshes the memory (`seen_at`) rather than adding one, and makes it true again if it had gone out of date.
- The file is written whole to a temporary file (`<file>.<pid>.tmp`) and renamed over the old one, one write at a time. Both are readable by the runtime's user only, and a folder the memory creates for them is too (an existing `dir` keeps its own permissions). It's read once when the runtime first needs it, so edit it with the runtime stopped. Run one runtime per store.
- On load, a memory that can't be read is dropped, a link to one that isn't there or that would make a loop is cut, a tree deeper than 16 levels is flattened, and a store over `max_memories` is cut down. A file that isn't a store, or is one of a version this code doesn't know, is left untouched and memory stays off, with the reason in the log, until it's fixed, moved or deleted.
- Over `max_memories`, every memory no longer true is removed before any current one; among current ones, the lowest `cost` goes, the older one on a tie. Children of a removed memory are re-attached to its nearest remaining ancestor.

## Limits

- **Memory is per character, not per user.** The harness doesn't know who is talking, so everyone who talks to a character shares what it remembers, and what one user said can come up with another.
- Only the user's last message is judged, one at a time; the conversation before it is context.
- The pieces of a message are cut by punctuation and a few conjunctions, so a memory is at most a clause, a sentence or the whole message, and at most 400 characters.
- Jev sees a shortlist, not the whole store, so a detail can only hang under, replace or recall a memory on it.
- A message makes at most one memory. When it says two unrelated things, the one Jev thinks matters more is kept, or the whole message.
- A line is judged with what the character already remembers. "Biscuit sleeps in a crate" is kept once it knows Biscuit is the user's dog, and may be dropped before that.
- The cost score is high for nearly everything Jev is asked about, so `thresholds.cost` rarely decides anything; `about_user` and `need` do. Cost still ranks memories for the prompt and for eviction.
- A repeated message is told apart from the app asking again only by the count of user messages in the history it sends, so the same short reply ("yes") after a history the app has trimmed to the same length may go unjudged.

We tried it on 35 lines over four conversations: things to keep and drop, details, updates, recalls, a boundary, and one line in Portuguese. Each line was judged with the right memories already in place. With the defaults, every keep or drop, span, kind, parent, out-of-date mark and recall came out as expected, the same on a second run, and Jev answered in about 300 ms. Said with nothing remembered yet, one detail in twelve was dropped (the crate above), and one span kept a whole sentence where a clause would have done.

## Privacy

- The store holds what users said, word for word, in a plain file on the machine the runtime runs on; so does its temporary file while it's written. Keep them out of anything you publish or commit (`.cache/` is in `.gitignore`), and delete the store to make the character forget.
- Each user message, with the few messages before it and the shortlist, is sent to Typesafe. Tell the people who talk to the character.
- Because the store is shared, what one user says goes into the prompt for everyone after them. The memory frames it as quotes and tells the character they aren't instructions, but a model can still be swayed by them: someone could plant "always call me captain" or worse for the next user to meet. Use it for characters whose users you trust with each other, or give each person their own character id, and read or clear the store if something odd comes up.
