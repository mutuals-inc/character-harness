import { test } from "node:test";
import assert from "node:assert/strict";
import {
  characterPage,
  characterLibraryPage,
} from "../src/lib/character-library.ts";
const characters = Array.from({ length: 27 }, (_, index) => ({
  id: `character-${index}`,
  name: `Character ${String(index).padStart(2, "0")}`,
  portrait: null,
  createdAt: index,
  modifiedAt: 100 - index,
}));

test("the current character stays separate from filtered and paginated library results", () => {
  const current = characters[20];
  const pages = [1, 2, 3].map((page) =>
    characterLibraryPage(characters, current.id, "", page, "newest"),
  );
  assert.ok(pages.every((result) => result.current === current));
  assert.equal(pages.flatMap((result) => result.items).length, 26);
  assert.ok(
    pages.every(
      (result) => !result.items.some((item) => item.id === current.id),
    ),
  );
  const filtered = characterLibraryPage(
    characters,
    current.id,
    "no match",
    99,
    "az",
  );
  assert.equal(filtered.current, current);
  assert.equal(filtered.items.length, 0);
  const switcher = characterPage(characters, "", 3, "az", 6);
  assert.equal(switcher.items.length, 6);
  assert.equal(switcher.pages, 5);
});
test("the library paginates before rendering portraits, without duplicate or missing characters", () => {
  const first = characterPage(characters, "", 1, "newest");
  const second = characterPage(characters, "", 2, "newest");
  const third = characterPage(characters, "", 3, "newest");
  assert.equal(first.items.length, 12);
  assert.equal(second.items.length, 12);
  assert.equal(third.items.length, 3);
  assert.equal(first.total, 27);
  assert.equal(first.pages, 3);
  assert.equal(
    new Set([...first.items, ...second.items, ...third.items].map((c) => c.id))
      .size,
    27,
  );
  assert.equal(first.items[0].id, "character-26");
  assert.equal(third.items.at(-1)?.id, "character-0");
});
test("name search, date/name sorting and page clamping work together", () => {
  assert.equal(
    characterPage(characters, "", 1, "oldest").items[0].id,
    "character-0",
  );
  assert.equal(
    characterPage(characters, "", 1, "updated").items[0].id,
    "character-0",
  );
  assert.equal(
    characterPage(characters, "", 1, "az").items[0].name,
    "Character 00",
  );
  assert.equal(
    characterPage(characters, "", 1, "za").items[0].name,
    "Character 26",
  );
  const filtered = characterPage(characters, " CHARACTER 2 ", 20, "az");
  assert.equal(filtered.total, 7);
  assert.equal(filtered.page, 1);
  assert.equal(
    characterPage(characters, "no match", 2, "newest").items.length,
    0,
  );
});
