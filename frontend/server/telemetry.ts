import type WebSocket from "ws";
import { HOOKS } from "../../runtime/src/state.ts";
import type { Loaded } from "../../runtime/src/extensions.ts";
import type { WireMessage } from "../src/types.ts";

const history: WireMessage[] = [];
let sequence = 0;
export function eventsAfter(after: number) {
  return history.filter((event) => event.seq! > after);
}

// Observe through the public extension contract; no runtime special cases or state writes.
export function instrument(extensions: Loaded[], socket: WebSocket): Loaded[] {
  const emit = (data: object) => {
    const event = { t: "studio_hook", seq: ++sequence, ...data };
    history.push(event);
    if (history.length > 1000) history.shift();
    if (socket.readyState === 1) socket.send(JSON.stringify(event));
  };
  const observed: Loaded[] = extensions.map((e) => ({
    ...e,
    call: async (input: Parameters<Loaded["call"]>[0]) => {
      const start = performance.now();
      emit({
        event: input.event,
        extension: e.name,
        phase: "start",
        turn: input.state.turn,
      });
      try {
        return await e.call(input);
      } finally {
        emit({
          event: input.event,
          extension: e.name,
          phase: "end",
          duration: Math.round(performance.now() - start),
          turn: input.state.turn,
        });
      }
    },
  }));
  observed.push({
    name: "studio-observer",
    dir: import.meta.dirname,
    handler: "telemetry.ts",
    config: {},
    requires_env: [],
    hooks: new Map(
      HOOKS.map((hook) => [hook, { blocking: true, timeout_ms: 1000 }]),
    ),
    call: ({ event, state }) => {
      emit({ event, phase: "hook", turn: state.turn });
    },
  });
  return observed;
}
