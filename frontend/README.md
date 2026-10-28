# Mutuals Character Studio

A minimal local frontend for the character harness. The character is rendered in
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

Each page has its title and the sidebar toggle in a shared header. The sidebar
opens Studio, Character, Extensions and Settings as
separate pages. On phones the toggle hides or reveals a compact icon rail.

- **Studio** shows the character preview beside the conversation; on narrow
  screens they stack. Session controls, text input, microphone and speaker
  controls live inside Studio. The sidebar is the only place to switch characters.
- **Characters** is a management library with name search, newest/oldest/recently
  updated/name sorting, and 12 other-character portrait cards per page. The
  current character stays pinned above search and pagination. Opening a card
  never changes the character active in Studio or clears a conversation.
- The sidebar account switcher shows the current name and portrait. Its searchable
  menu renders six characters per page and supports keyboard navigation. Switching
  loads all pages for that character and starts a fresh conversation; the last
  selection is remembered locally. An unfinished creation form survives switching.
- Character cards offer confirmed deletion. FoxGlove carries a lock badge and
  is protected by the server from deletion, while its supported fields remain
  editable. Deleted folders are moved to `.cache/frontend/deleted-characters`
  for local recovery. Deleting the character active in Studio switches Studio
  to FoxGlove and clears that conversation, with notice in the confirmation.
- **New character** starts with an empty definition organized into expandable
  cards: Identity, Body, Chat, Voice and Extensions. Every card starts collapsed
  and the bottom action bar stays visible. Upload a VRM model, optional portrait, and .vrma animations;
  assign idle loops, named talking styles, gestures and held poses. The server
  validates and writes a standalone character folder, prompt and assets.
- Identity asks for name, description and personality, with Write/Preview modes
  for the Markdown prompt. New characters default to author `Local creator` and
  license `All rights reserved`; existing metadata stays unchanged when editing.
  Chat choices reuse distinct saved model connections, with a custom connection
  option. New voices use the existing harness speech defaults; editing preserves
  existing speech and model tuning settings.
- Voice selection defaults to the saved FoxGlove voice, with a Custom option
  for any ElevenLabs voice ID. Language selection searches the documented Scribe
  presets by English/native name, ISO code, or common keywords; it saves the
  language code used for speech recognition.
- Character management groups identity/chat, body uploads, voice and extensions
  into collapsible sections. Extension choices, order and YAML configuration
  are saved per character; the registry is discovered from installed extension
  folders, not a hard-coded character or plugin list.
- Extension cards support dragging, keyboard up/down on the grip, and arrow
  buttons. Position numbers, original-position badges and move announcements
  make order changes visible. Configuration panels start collapsed; reordering
  keeps each extension's configuration and enabled state attached.
- **Studio audio setup** uses system defaults, with device selection, local
  microphone/speaker tests, and optional gain, detection and noise controls.
  The main Studio bar shows microphone off/on in red/green, live listening and
  input level, character mute and volume. Voice and language belong to each
  character's Voice & hearing card; there is no separate audio sidebar page.
- **Live character** in Studio shows current emotion, last reaction and recent
  enabled-extension events from actual runtime messages. The background menu
  offers Clouds, Plain and Blue. Screen note under More sends an optional text
  description through the existing screen-input channel.
- **Settings** shows the current connection, per-key Edit controls revealing masked replacement fields for the
  character's required API keys, and the local captions toggle. Blank key fields
  preserve existing values. Saves update the character's local .env file;
  values are never returned to the browser, and a new session reads changes
  without restarting the app. End a running session before replacing keys.
- Conversation export, screen-context text, expanded stage and a fresh
  conversation are available from Studio.

The UI uses vanilla TypeScript and native HTML controls, with one stylesheet in
`src/styles.css`. Vite builds it; Three.js and three-vrm render the character.
No UI framework or component library is used.

Start session connects to the runtime. Sending a message or speaking uses the
providers in the selected character's manifest and can incur their normal usage
charges. Starting a session by itself does not send a conversation turn, though
an installed extension may do work on `on_session_start`.

Voice capture resamples to 16 kHz mono PCM16 using an AudioWorklet. Replies stream
as 24 kHz PCM16; sentences play in order, and beats are scheduled against their
audio. Mouth motion follows audio energy (approximate lip sync). Microphone
access starts only after a user action. Muting or ending a session releases the
microphone. Device and appearance preferences are browser-local; conversations
are in memory until exported. The microphone test sends no audio
to a provider.

Save buttons update only the managed character's supported fields and prompt,
preserving YAML comments. Every save creates a backup in
`.cache/frontend/backups/`. A revision check rejects stale edits. End a session
before saving. Extension changes persist in the character manifest. Enabled entries are in
`extensions`; disabled entries retain their configuration under
`disabled_extensions`. Shared extension source files remain unchanged.

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
- One live studio conversation per server. Provider key values, shared extension
  source editing and persistent conversation storage remain outside this draft.
- Creation requires a self-contained VRM model. Portraits accept PNG/JPEG/WebP;
  animations accept .vrma. Limits: 100 MB per model, 20 MB per clip, 10 MB per
  portrait, 160 MB per upload request. No assets or personalities are copied
  from an existing character during creation.
- Hook timeout/blocking settings are displayed from extension manifests; they
  are not rewritten through the UI. New extensions appear after reloading.
- Speech activity detection is an adjustable RMS threshold, rather than the
  native player's Silero VAD. Headphones are helpful for interruption tests.
- Output-device selection depends on browser support. Key status checks
  presence, not provider availability, permissions or quota.

## Code layout

- `server/catalog.ts`: manifest discovery, safe metadata, character edits, backups
- `server/character-files.ts`: blank character creation, validated uploads and atomic asset updates
- `server/extensions.ts`: installed extension discovery and per-character configuration
- `server/security.ts`: local host, same-origin and HttpOnly session checks
- `server/telemetry.ts`: observes hooks through the extension contract
- `server/index.ts`: local HTTP and WebSocket host; reuses `runSession`
- `src/stage/`: renderer, animation and expressions
- `src/audio/`: microphone capture and streamed playback
- `src/session.ts`: browser side of the existing session protocol
- `src/ui/`: small view templates
- `src/main.ts`: page navigation and event bindings

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
root as well. Browser QA should cover the workspace and settings sections, gesture and emotion changes,
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
again and use Studio's microphone for the speech pipeline. Studio's Audio setup
microphone test is local only; a live session sends detected speech to the
configured providers. The recording diagnostic is no longer part of the UI.

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

### Extension library

Extensions are shared installed code; enablement, order and YAML configuration belong to each character. The Extensions page searches installed packages and links to the current character's configuration. Upload a trusted ZIP containing `extension.yaml`, its handler, supporting files and optional `defaults.yaml`, at the archive root or in one folder. Installation never executes the handler or enables it. Packages are limited to 20 MB compressed, 50 MB expanded and 200 entries; traversal, environment files and duplicate installed names are rejected. To install another version alongside an existing extension, give it a unique manifest name.
