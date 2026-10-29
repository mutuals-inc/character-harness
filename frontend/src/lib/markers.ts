// The text of a reply that says nothing, as the runtime sends it: `…` for a
// silent reply, `[acted]` for one that only called tools. Neither is voiced.
// The same as SILENT_TURN and ACTED_TURN in runtime/src/markers.ts, written out
// here since the app bundles nothing from the runtime; test/markers.test.ts
// checks they agree.
export const SILENT_TURN = "…";
export const ACTED_TURN = "[acted]";

// whether a sentence is one of them, so it gets no `tts`
export const unvoiced = (text: string) =>
  text.trim() === SILENT_TURN || text.trim() === ACTED_TURN;
