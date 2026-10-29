import type { HistoryEntry, Transcript } from "../types.ts";

// The history an `llm` sends: each message as it is, and for a reply that
// called tools, its entries. `llm_calls` brings the calls and results as they
// run, and `llm_done` all of the reply's entries; `covered` is how much of the
// reply's text they hold. What it said after that (a reply cut off or failed
// after its calls ran) goes after them, so the model knows it was said.
export function historyOf(messages: Transcript[]): HistoryEntry[] {
  return messages
    .filter((m) => m.content.trim() || m.entries?.length)
    .flatMap(({ role, content, entries, covered }) => {
      if (!entries?.length) return [{ role, content }];
      const rest = content.slice(covered ?? content.length).trim();
      return rest ? [...entries, { role, content: rest }] : entries;
    });
}
