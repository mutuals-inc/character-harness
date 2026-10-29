import assert from "node:assert/strict";
import { test } from "node:test";
import { historyOf } from "../src/lib/history.ts";
import type { HistoryEntry, Transcript } from "../src/types.ts";

const asked: HistoryEntry = {
  role: "assistant",
  content: "Let me check.",
  tool_calls: [{ id: "c", name: "weather", arguments: "{}" }],
};
const answer: HistoryEntry = { role: "tool", tool_call_id: "c", content: "18C, sunny" };
const user: Transcript = { role: "user", content: "weather in Lisbon?" };

test("a reply cut off after its calls ran keeps what it said after them", () => {
  // llm_calls came after "Let me check."; the rest streamed and was voiced before the cut
  const reply: Transcript = {
    role: "assistant",
    content: "Let me check. It's 18 and sunny in Lisbon.",
    entries: [asked, answer],
    covered: "Let me check.".length,
  };
  assert.deepEqual(historyOf([user, reply]), [
    { role: "user", content: "weather in Lisbon?" },
    asked,
    answer,
    { role: "assistant", content: "It's 18 and sunny in Lisbon." },
  ]);
});

test("a finished reply's entries are all it adds, and a reply without calls is its text", () => {
  const done: Transcript = {
    role: "assistant",
    content: "Let me check. It's sunny.",
    entries: [asked, answer, { role: "assistant", content: "It's sunny." }],
    covered: "Let me check. It's sunny.".length,
  };
  const plain: Transcript = { role: "assistant", content: "Hi!" };
  const empty: Transcript = { role: "assistant", content: "  " };
  assert.deepEqual(historyOf([user, done, plain, empty]), [
    { role: "user", content: "weather in Lisbon?" },
    asked,
    answer,
    { role: "assistant", content: "It's sunny." },
    { role: "assistant", content: "Hi!" },
  ]);
  // nothing said after the calls adds nothing
  assert.deepEqual(historyOf([{ role: "assistant", content: "Let me check.", entries: [asked, answer], covered: 13 }]), [asked, answer]);
});
