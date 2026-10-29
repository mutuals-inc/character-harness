import { test } from "node:test";
import assert from "node:assert/strict";
import {
  languages,
  findLanguage,
  searchLanguages,
} from "../src/lib/languages.ts";

test("language search matches native names, accents, codes and keyword combinations", () => {
  assert.ok(languages.length >= 90);
  assert.equal(new Set(languages.map((l) => l.code)).size, languages.length);
  for (const query of [
    "Português",
    "portugues",
    "Brazil",
    "por",
    "brazil portuguese",
  ])
    assert.ok(
      searchLanguages(query).some((l) => l.code === "pt"),
      query,
    );
  assert.ok(searchLanguages("日本語").some((l) => l.code === "ja"));
  assert.ok(searchLanguages("jpn").some((l) => l.code === "ja"));
  assert.equal(findLanguage("eng")?.code, "en");
  assert.equal(searchLanguages("en")[0].code, "en");
  assert.equal(searchLanguages("por")[0].code, "pt");
  assert.equal(findLanguage("pt")?.name, "Portuguese");
  assert.equal(searchLanguages("not-a-language").length, 0);
});
