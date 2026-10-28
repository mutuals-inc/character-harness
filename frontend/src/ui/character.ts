import {
  characterLibraryPage,
  characterSortOptions,
} from "../lib/character-library.ts";
import { state } from "../store.ts";
import { escape as e } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { extensionFields, sectionSummary } from "./character-authoring.ts";
import { field } from "./forms.ts";
import { characterAvatar } from "./character-switcher.ts";
import { voiceFields } from "./voice-fields.ts";
import { chatFields, promptField } from "./character-fields.ts";

function characterSettings() {
  const c = state.managedCharacter ?? state.bootstrap!.character;
  return `<form id="character-form" class="settings-layout" novalidate><div class="form-main"><section class="surface"><div class="surface-heading"><h2>Identity</h2></div>${field("Name", "character-name", c.name, "", 'required maxlength="200"')}<label class="field"><span>Description</span><textarea id="character-description" rows="2" maxlength="2000" required>${e(c.description)}</textarea></label></section>
    <section class="surface">${promptField("character", c.prompt)}</section>
    <section class="surface"><div class="surface-heading"><h2>Chat model</h2></div>${chatFields("character", { api: c.api, model: c.model, baseUrl: c.baseUrl, keyName: c.chatKeyName })}</section>
    <div class="form-actions"><span class="subtle">Changes are saved to this character.</span><button type="button" class="button" data-action="reset-character">Discard changes</button><button class="button primary" type="submit">Save character ${icon("check", 17)}</button></div></div></form>`;
}

let searchQuery = "";
let libraryPage = 1;
let librarySort = "newest";
const PAGE_SIZE = 12;
function sortMenu() {
  const selected = characterSortOptions.find(
    (option) => option.value === librarySort,
  )!;
  return `<details class="library-sort"><summary id="character-sort" aria-haspopup="menu" aria-label="Sort characters: ${selected.label}"><span class="sort-current-icon">${icon(selected.icon, 17)}</span><span class="sort-current-label">${selected.label}</span><span class="sort-chevron">${icon("down", 14)}</span></summary><div class="sort-options" role="menu" aria-label="Sort characters">${characterSortOptions.map((option) => `<button type="button" role="menuitemradio" aria-checked="${option.value === librarySort}" data-character-sort="${option.value}">${icon(option.icon, 17)}<span>${option.label}</span><span class="sort-check" ${option.value === librarySort ? "" : "hidden"}>${icon("check", 15)}</span></button>`).join("")}</div></details>`;
}
export function characterView() {
  return `<div class="character-library"><div id="current-character"></div><h2 class="library-section-title">Other characters</h2><div class="library-toolbar">
    <label class="character-search" for="character-search">${icon("search", 19)}<span class="sr-only">Search characters by name</span><input id="character-search" type="search" value="${e(searchQuery)}" placeholder="Search characters…" autocomplete="off"/></label>
    ${sortMenu()}
    <button class="button primary" data-action="new-character">${icon("personPlus", 18)} New character</button></div>
    <p class="library-count subtle" id="character-count" role="status" aria-live="polite"></p><div id="character-grid" class="character-grid"></div><nav id="character-pagination" class="library-pagination" aria-label="Character library pages"></nav></div>`;
}
export function renderCharacterCards(
  query = searchQuery,
  page = libraryPage,
  sort = librarySort,
) {
  searchQuery = query;
  librarySort = sort;
  const selected = characterSortOptions.find(
    (option) => option.value === sort,
  )!;
  const menu = document.querySelector<HTMLDetailsElement>(".library-sort");
  if (menu) {
    menu.querySelector(".sort-current-label")!.textContent = selected.label;
    menu.querySelector(".sort-current-icon")!.innerHTML = icon(
      selected.icon,
      17,
    );
    menu
      .querySelector("summary")!
      .setAttribute("aria-label", `Sort characters: ${selected.label}`);
    menu
      .querySelectorAll<HTMLButtonElement>("[data-character-sort]")
      .forEach((button) => {
        const active = button.dataset.characterSort === sort;
        button.setAttribute("aria-checked", String(active));
        button.querySelector<HTMLElement>(".sort-check")!.hidden = !active;
      });
  }

  const result = characterLibraryPage(
    state.bootstrap!.characters,
    state.bootstrap!.character.id,
    query,
    page,
    sort,
    PAGE_SIZE,
  );
  const { items: shown, total, pages, start, current } = result;
  const currentPanel = document.getElementById("current-character")!;
  currentPanel.innerHTML = current
    ? `<section class="current-character-card" aria-label="Current character"><button type="button" class="current-character-open" data-character="${e(current.id)}" aria-label="Manage current character ${e(current.name)}">${characterAvatar(current)}<span><small class="current-character-label">${icon("check", 14)} Current character</small><strong>${e(current.name)}</strong><small>Manage character ${icon("arrow", 13)}</small></span></button>${current.protected ? `<span class="character-card-action character-lock" role="img" aria-label="Built-in character. Can be edited, cannot be deleted." title="Built-in character · editable, cannot be deleted">${icon("lock", 16)}</span>` : `<button type="button" class="character-card-action character-delete" data-delete-character="${e(current.id)}" aria-label="Delete ${e(current.name)}" title="Delete character">${icon("trash", 16)}</button>`}</section>`
    : "";
  libraryPage = result.page;
  document.getElementById("character-count")!.textContent = total
    ? `${start + 1}–${start + shown.length} of ${total} ${total === 1 ? "character" : "characters"}`
    : "0 characters";
  document.getElementById("character-grid")!.innerHTML = shown.length
    ? shown
        .map(
          (c) =>
            `<article class="character-card"><button type="button" class="character-open" data-character="${e(c.id)}" aria-label="Manage ${e(c.name)}"><span class="character-art">${c.portrait ? `<img src="${e(c.portrait)}" alt="" loading="lazy"/>` : `<span class="portrait-placeholder">${icon("person", 54)}</span>`}</span><span class="character-card-name">${e(c.name)}</span></button>${c.protected ? `<span class="character-card-action character-lock" role="img" aria-label="Built-in character. Can be edited, cannot be deleted." title="Built-in character · editable, cannot be deleted">${icon("lock", 16)}</span>` : `<button type="button" class="character-card-action character-delete" data-delete-character="${e(c.id)}" aria-label="Delete ${e(c.name)}" title="Delete character">${icon("trash", 16)}</button>`}</article>`,
        )
        .join("")
    : `<div class="character-empty">${icon("search", 28)}<h2>${query ? "No characters found" : "No other characters yet"}</h2><p>${query ? "Try another name." : "Create another character to add to your library."}</p></div>`;
  document.getElementById("character-pagination")!.innerHTML =
    pages > 1
      ? `<button class="button" data-character-page="${libraryPage - 1}" ${libraryPage === 1 ? "disabled" : ""}>Previous</button><span class="subtle">Page ${libraryPage} of ${pages}</span><button class="button" data-character-page="${libraryPage + 1}" ${libraryPage === pages ? "disabled" : ""}>Next</button>`
      : "";
}
export function characterDetail() {
  const c = state.managedCharacter ?? state.bootstrap!.character;
  return `<div class="character-editor"><button class="text-button back-to-characters" data-view="character">${icon("arrow", 16)} All characters</button><div class="management-sections"><details class="authoring-card" name="character-management">${sectionSummary("person", "Identity, personality & chat", "Name, personality and model settings")}${characterSettings()}</details>
    <details class="authoring-card" name="character-management">${sectionSummary("studio", "Body & animations", "Model, portrait, movement and gestures")}<form id="character-assets-form" class="surface"><div class="surface-heading"><h2>Body & animations</h2></div><p class="subtle">Current body: ${e(c.rig)} · ${c.body.gestures.length} gestures · ${c.body.registers.length} talking styles</p><div class="two-fields"><label class="field"><span>Replace VRM model</span><input type="file" name="model" accept=".vrm"/><small>Optional. VRM models up to 100 MB.</small></label><label class="field"><span>Update portrait</span><input type="file" name="portrait" accept=".png,.jpg,.jpeg,.webp"/><small>Up to 10 MB.</small></label></div><label class="toggle-row"><span>Hair & clothing motion</span><input id="managed-springs" type="checkbox" ${c.springs ? "checked" : ""}/></label><div class="animation-assignments"></div><button type="button" class="button" data-action="add-animation">${icon("plus", 16)} Add animation</button><div class="form-actions"><button class="button primary" type="submit">Save body & animations</button></div></form></details>
    <details class="authoring-card" name="character-management">${sectionSummary("mic", "Voice & hearing", "This character’s voice and language")}<form id="character-voice-form" class="surface">${voiceFields("managed-voice-id", "managed-language", c.voice.voice_id, c.stt.language || "en")}<div class="form-actions"><button type="submit" class="button primary">Save voice settings</button></div></form></details>
    <details class="authoring-card" name="character-management">${sectionSummary("hooks", "Extensions", "Behaviors enabled for this character")}<form id="character-extensions-form" class="surface"><div class="surface-heading"><h2>Extensions for ${e(c.name)}</h2></div><p class="subtle">These choices and configurations belong to this character. Drag to set execution order.</p>${extensionFields(state.bootstrap!.availableExtensions, c.extensionSettings)}<div class="form-actions"><button class="button primary" type="submit">Save extensions</button></div></form></details></div></div>`;
}
