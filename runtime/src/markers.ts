// The text of a reply that says nothing, as the app gets it. Both are plain
// text, not fields, so an app that keeps only a reply's text still has one
// (docs/protocol.md). The app voices neither, and keeps both in its history.
// frontend/src/lib/markers.ts and the bundled extensions write them out again,
// since they import nothing from the runtime; a test there checks they agree.

// A turn that makes no sound: cancelled, or the model's silent reply. The app
// waits ~12 s on a turn with no text before calling the model dead, so it gets
// this one character and `llm_done`.
export const SILENT_TURN = "…";
// A turn that only called tools, and the last of its history entries, so a
// later turn can tell it from a silent reply.
export const ACTED_TURN = "[acted]";
