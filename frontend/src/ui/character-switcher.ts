import { state } from "../store.ts";
import { escape as e } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { characterPage } from "../lib/character-library.ts";
import type { CharacterSummary } from "../types.ts";

let query = "";
let page = 1;

export function characterAvatar(
  character: Pick<CharacterSummary, "name" | "portrait">,
) {
  return `<span class="character-avatar">${character.portrait ? `<img src="${e(character.portrait)}" alt=""/>` : icon("person", 23)}</span>`;
}

function current() {
  const data = state.bootstrap!;
  return (
    data.characters.find((character) => character.id === data.character.id) ?? {
      id: data.character.id,
      name: data.character.name,
      portrait: null,
    }
  );
}

function accountLabel() {
  const character = current();
  return `${characterAvatar(character)}<span class="character-account-details"><small>Current character</small><strong>${e(character.name)}</strong></span>`;
}

export function sidebarCharacterSwitcher() {
  return `<div class="sidebar-bottom"><button type="button" id="character-account" class="character-account" data-action="switch-character-menu" aria-label="Switch character. Current: ${e(current().name)}" title="Switch character" aria-expanded="false" aria-controls="character-switcher-menu" aria-haspopup="dialog">${accountLabel()}</button></div>`;
}

export function characterSwitcherMenu() {
  return `<div id="character-switcher-menu" class="character-switcher-menu" role="dialog" aria-label="Switch character" hidden><div class="switcher-heading"><strong>Switch character</strong><button type="button" class="icon-button" data-action="close-character-switcher" aria-label="Close character switcher">${icon("close", 16)}</button></div><label class="switcher-search">${icon("search", 17)}<input type="search" id="switcher-search" placeholder="Search characters…" aria-label="Search available characters" autocomplete="off"/></label><div id="switcher-results" class="switcher-results"></div><div id="switcher-pagination" class="switcher-pagination"></div><p class="switcher-note subtle">Switching starts a new conversation.</p></div>`;
}

export function renderSidebarCharacter() {
  const button = document.getElementById("character-account");
  if (!button) return;
  button.innerHTML = accountLabel();
  button.setAttribute("title", `Switch character · ${current().name}`);
  button.setAttribute(
    "aria-label",
    `Switch character. Current: ${current().name}`,
  );
  if (!document.getElementById("character-switcher-menu")!.hidden)
    renderSwitcherCharacters();
}

export function renderSwitcherCharacters(search = query, requestedPage = page) {
  query = search;
  const result = characterPage(
    state.bootstrap!.characters,
    search,
    requestedPage,
    "az",
    6,
  );
  page = result.page;
  document.getElementById("switcher-results")!.innerHTML =
    result.items
      .map(
        (character) =>
          `<button type="button" class="switcher-option" data-switch-character="${e(character.id)}" aria-pressed="${character.id === state.bootstrap!.character.id}">${characterAvatar(character)}<span>${e(character.name)}</span>${character.id === state.bootstrap!.character.id ? icon("check", 17) : ""}</button>`,
      )
      .join("") ||
    '<p class="switcher-empty subtle" role="status">No matching characters.</p>';
  document.getElementById("switcher-pagination")!.innerHTML =
    `<span class="subtle" role="status">${result.total ? `${result.start + 1}–${result.start + result.items.length} of ${result.total}` : "0 characters"}</span>${result.pages > 1 ? `<button type="button" class="icon-button" data-switcher-page="${page - 1}" aria-label="Previous characters" ${page === 1 ? "disabled" : ""}>${icon("up", 16)}</button><button type="button" class="icon-button" data-switcher-page="${page + 1}" aria-label="Next characters" ${page === result.pages ? "disabled" : ""}>${icon("down", 16)}</button>` : ""}`;
}

function positionMenu() {
  const menu = document.getElementById("character-switcher-menu")!;
  const anchor = document
    .getElementById("character-account")!
    .getBoundingClientRect();
  menu.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - menu.offsetWidth - 12))}px`;
  menu.style.bottom = `${innerHeight - anchor.top + 8}px`;
}

export function closeCharacterSwitcher(focus = false) {
  const menu = document.getElementById("character-switcher-menu");
  if (!menu) return;
  menu.hidden = true;
  document
    .getElementById("character-account")
    ?.setAttribute("aria-expanded", "false");
  if (focus) document.getElementById("character-account")?.focus();
}

export function openCharacterSwitcher() {
  const menu = document.getElementById("character-switcher-menu")!;
  menu.hidden = false;
  document
    .getElementById("character-account")!
    .setAttribute("aria-expanded", "true");
  (document.getElementById("switcher-search") as HTMLInputElement).value = "";
  renderSwitcherCharacters("", 1);
  positionMenu();
  document.getElementById("switcher-search")!.focus();
}

export function switcherKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  const menu = document.getElementById("character-switcher-menu");
  if (
    !menu ||
    menu.hidden ||
    (!menu.contains(target) && target.id !== "character-account")
  )
    return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeCharacterSwitcher(true);
    return;
  }
  const buttons = [
    ...menu.querySelectorAll<HTMLButtonElement>("[data-switch-character]"),
  ];
  const search = target.id === "switcher-search";
  if (search && event.key === "Enter") {
    event.preventDefault();
    buttons[0]?.click();
  }
  if (
    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
    (search && ["Home", "End"].includes(event.key))
  )
    return;
  event.preventDefault();
  const index = buttons.indexOf(target as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : index < 0
          ? event.key === "ArrowUp"
            ? buttons.length - 1
            : 0
          : (index + (event.key === "ArrowUp" ? buttons.length - 1 : 1)) %
            buttons.length;
  buttons[next]?.focus();
}

window.addEventListener("resize", () => {
  const menu = document.getElementById("character-switcher-menu");
  if (menu && !menu.hidden) positionMenu();
});
