# dead-air

Has the character speak up when nobody has said anything for a while. It is the smallest service: no hooks, no model call and no key, just the voice and an offer. See "Services" in `docs/extensions.md`.

After `after_s` seconds of a quiet voice it offers the character a line of input saying so, and the character answers it as a turn of its own, through every hook. Then it waits `cooldown_s` before it may do it again. Someone speaking resets the quiet.

It needs a player with the offers link (`docs/protocol.md`). With an older one the voice stays `offline` and it never speaks up.

## Use it

```yaml
extensions:
  - path: ../../examples/extensions/dead-air
    config:
      after_s: 45
```

| Key | Default | What |
|---|---|---|
| `after_s` | `60` | seconds of quiet before it speaks up |
| `cooldown_s` | `90` | seconds after that before it may again |
| `text` | a line saying nobody has spoken for a while | what the character is told. It is the user's side of the turn, not what the character says |

The turn's `input.channel` is `idle` and its `input.offered_by` is `dead-air`, so other extensions can tell it apart.

Its tests are in `runtime/test/examples.test.ts`.
