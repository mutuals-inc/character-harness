# Mutuals Character Studio

A local frontend draft for the character harness. The character is rendered in
the page; this app does not spawn the native Kaigen player. Conversation uses the
existing runtime and its public session and extension contracts.

## Run

Use Node 24 or later. Install the harness dependencies from the repository root
first, then:

```powershell
cd frontend
npm install
npm run dev
```

Open **http://127.0.0.1:4173**. To run the built version:

```powershell
npm run build
npm start
```

Stop the dev server before starting the built version. `FRONTEND_PORT` changes
the default port. The server only listens on loopback. Use one hostname
consistently because authentication is scoped to that origin.

## What works

| View | Features |
| --- | --- |
| Studio | Embedded GLB/VRM stage, idle and gesture clips, expressions, camera framing, orbit/zoom, three backdrops, expanded stage, transparent stage capture, text conversation, voice interruption, captions and transcript export |
| Character | Discover characters from `characters/`, edit identity, prompt, chat model and temperature; inspect rig capabilities |
| Voice & audio | Input and output device selection, input gain, local level test, local output tone, volume, speech threshold, end-of-speech pause, echo cancellation, noise suppression; edit voice, transcription, language and recognition keyterms; a bundled synthetic greeting and optional recording input for reproducible speech checks |
| Hooks & extensions | All eight lifecycle hooks, declared bindings, blocking/timeout requirements, extension enable/disable for the next studio session |
| Activity | Actual hook events, handler duration, input events, animation cues and errors; filter and export |
| Settings | Local connection, key presence, offline character checks, captions and animation preferences |

Start session connects to the runtime. Sending a message or speaking uses the
providers in the selected character's manifest and can incur their normal usage
charges. Starting a session by itself does not send a conversation turn, though
an installed extension may do work on `on_session_start`.

Voice capture resamples to 16 kHz mono PCM16 using an AudioWorklet. Replies stream
as 24 kHz PCM16; sentences play in order, and beats are scheduled against their
audio. Mouth motion follows audio energy (approximate lip sync). Microphone
access starts only after a user action. Muting or ending a session releases the
microphone. Device and appearance preferences are browser-local; conversations
and activity are in memory until exported. The microphone test sends no audio
to a provider.

Save buttons update only the selected character's supported fields and prompt,
preserving YAML comments. Every save creates a backup in
`.cache/frontend/backups/`. A revision check rejects stale edits. End a session
before saving. Extension switches affect studio sessions only; shared extension
files and the character's extension list remain unchanged.

## Current limits

- This is a **browser renderer**, not Kaigen compiled into a web view. It uses
  the same model and animation data. Kaigen's custom shading, cloth and certain
  expression effects are not reproduced exactly. Standard VRM spring bones are
  handled by the VRM loader when present. Profile joints hidden by the native
  rig are also hidden in the browser.
- Profile models must have a matching GLB source in `player/assets/`. Model
  characters use the harness's prepared animation model. Missing assets show an
  error instead of an image placeholder.
- Screen input currently accepts a **text description**, matching the runtime's
  `source: "screen"` protocol. It does not capture or send screen pixels.
- One live studio conversation per server. Character creation, provider key
  entry, shared extension source editing and persistent conversation storage
  are outside this draft.
- Hook timeout/blocking settings are displayed from extension manifests; they
  are not rewritten through the UI. New extensions appear after reloading.
- Speech activity detection is an adjustable RMS threshold, rather than the
  native player's Silero VAD. Headphones are helpful for interruption tests.
- Output-device selection depends on browser support. Key status checks
  presence, not provider availability, permissions or quota.

## Code layout

- `server/catalog.ts`: manifest discovery, safe metadata, character edits, backups
- `server/security.ts`: local host, same-origin and HttpOnly session checks
- `server/telemetry.ts`: observes hooks through the extension contract
- `server/index.ts`: local HTTP and WebSocket host; reuses `runSession`
- `src/stage/`: renderer, animation and expressions
- `src/audio/`: microphone capture and streamed playback
- `src/session.ts`: browser side of the existing session protocol
- `src/ui/`: small view templates
- `src/main.ts`: view routing and event bindings

Keys are read from the character's existing `.env` on the server. The browser
receives only key names and presence status. HTTP writes and the browser session
socket require an exact same-origin request and a random HttpOnly SameSite cookie.
The runtime's native socket security policy remains unchanged.

## Verify

```powershell
npm test
npm run build
```

Run the harness's existing `npm test` and `npm run typecheck` at the repository
root as well. Browser QA should cover all views, gesture and emotion changes,
camera/backdrop changes, keyboard navigation, narrow screens, missing keys,
session start/end, audio permissions, interruption and a real provider turn.

### Rehearsal example

Run `npm run demo:prepare` from this directory, then choose **FoxGlove Studio**
in the character picker. The script generates a local VRM model and rehearsal
manifest, using the repository's existing FoxGlove assets. It leaves the original
character unchanged. The authored animation lives in
`examples/characters/studio-demo/comet-salute.vrma`; its generator samples an
original four-second salute at 30 Hz. Only the skeleton metadata is reused from
the wave clip.

`examples/extensions/comet-cues/` is an independent example that subscribes to all
eight hooks and stages the salute once when the input contains “comet salute”.
Disable it, end the session, and start another to compare behavior. Enable it
again and try **Voice & audio → Try sample greeting** to exercise the audio
worklet, VAD, actual STT, model reply, TTS and timed animation cue. The included
WAV is a synthetic Microsoft Zira greeting. Provider usage is the same as a
normal conversation. A recording does not verify physical microphone hardware.

### Local validation — October 20, 2026

- Frontend build/typecheck and all **10 frontend tests pass**, including origin
  checks, character edits, authored animation tracks, hook isolation, closing
  telemetry and cancellation of pending microphone permission.
- The harness runtime typecheck passes: **131 tests pass, 0 fail, 1 skip**.
  Example fixtures now normalize CRLF. The owner-only POSIX file-mode check is
  skipped on Windows, where NTFS ACLs govern access; ACL isolation is not proven
  by that skip.
- Browser checks exercised all six views, all eight gestures, all 19 expressions,
  camera/backdrop controls, pause/captions, character and voice saving, discard,
  extension switching, text and screen-context turns, actual speech services,
  reply cancellation, all eight observed hooks, new conversation, activity
  filtering/clearing, preference reset, expanded stage/Escape and exports.
  Downloaded transcript/activity JSON and transparent stage PNG were inspected.
- A phone layout was inspected. The browser connection stalled during subsequent
  responsive navigation, so that part of the run is incomplete.
- Physical microphone permission/capture, acoustic interruption, alternate
  hardware output and user-selected local file upload remain **unverified**.
  The extension refused file upload because file URL access is disabled. The
  bundled sample verifies the speech pipeline without changing that permission.
- The walkthrough uses real browser captures with chapter captions and synthetic
  explanatory narration. Original app audio is not present in the video.

## Visual sources

The draft follows [Mutuals' official website](https://mutuals.inc): its painterly
sky, white organic wordmark and warm accents. `public/brand/sky.webp`,
`wordmark.svg` and `symbol.svg` are from that site, retained for this Mutuals
project. The model, clips and expression definitions come from the harness's
existing licensed assets. DM Sans is licensed under the SIL Open Font License;
see `public/fonts/OFL.txt`.
