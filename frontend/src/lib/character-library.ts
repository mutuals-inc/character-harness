import type { CharacterSummary } from "../types.ts";

export function characterPage(
  characters: CharacterSummary[],
  query: string,
  page: number,
  sort: string,
  pageSize = 12,
) {
  const matches = characters
    .filter((c) =>
      c.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        (sort === "az"
          ? a.name.localeCompare(b.name)
          : sort === "za"
            ? b.name.localeCompare(a.name)
            : sort === "oldest"
              ? a.createdAt - b.createdAt
              : sort === "updated"
                ? b.modifiedAt - a.modifiedAt
                : b.createdAt - a.createdAt) || a.name.localeCompare(b.name),
    );
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * pageSize;
  return {
    items: matches.slice(start, start + pageSize),
    total: matches.length,
    pages,
    page: current,
    start,
  };
}

export function characterLibraryPage(
  characters: CharacterSummary[],
  currentId: string,
  query: string,
  page: number,
  sort: string,
  pageSize = 12,
) {
  return {
    current: characters.find((character) => character.id === currentId),
    ...characterPage(
      characters.filter((character) => character.id !== currentId),
      query,
      page,
      sort,
      pageSize,
    ),
  };
}

export const characterSortOptions = [
  { value: "newest", label: "Newest added", icon: "newest" },
  { value: "oldest", label: "Oldest added", icon: "oldest" },
  { value: "updated", label: "Recently updated", icon: "reset" },
  { value: "az", label: "Name: A–Z", icon: "sortAsc" },
  { value: "za", label: "Name: Z–A", icon: "sortDesc" },
];
