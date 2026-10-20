import type { HookInput } from "../../../runtime/src/extensions.ts";
import type { State } from "../../../runtime/src/state.ts";

interface Config {
  phrase?: string;
  gesture?: string;
}

// A small, deterministic example: ask for a comet salute and stage it once.
// All private bookkeeping lives under the extension's own state namespace.
export default function ({ event, state, config }: HookInput) {
  const options = config as Config;
  const previous = (state.ext["comet-cues"] ?? {}) as {
    stagedTurn?: number;
    events?: string[];
  };
  const own = {
    ...previous,
    events: [...(previous.events ?? []), event].slice(-32),
  };
  const next: State = { ...state, ext: { ...state.ext, "comet-cues": own } };
  const wanted = state.input?.text
    .toLowerCase()
    .includes(options.phrase ?? "comet salute");
  if (event === "on_sentence" && wanted && own.stagedTurn !== state.turn) {
    own.stagedTurn = state.turn;
    next.beats = [
      ...(state.beats ?? []),
      {
        span: "",
        gesture: options.gesture ?? "comet-salute",
        emotion: "happy",
        camera: "pull-back",
      },
    ];
  }
  return { state: next };
}

export function check({
  config,
  body,
}: {
  config: Config;
  body: { gestures: string[] | null };
}) {
  const gesture = config.gesture ?? "comet-salute";
  return {
    errors:
      body.gestures && !body.gestures.includes(gesture)
        ? [`The rig needs the ${gesture} gesture.`]
        : [],
  };
}
