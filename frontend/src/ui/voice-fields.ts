import { escape as e } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { findLanguage, searchLanguages } from "../lib/languages.ts";
import { state } from "../store.ts";
import { field } from "./forms.ts";

export function voiceFields(
  voiceIdField: string,
  languageField: string,
  currentVoice?: string,
  language = "en",
) {
  const presets = state.bootstrap!.voicePresets;
  const voice = currentVoice ?? presets[0]?.voiceId ?? "";
  const preset = presets.some((p) => p.voiceId === voice);
  const selected = findLanguage(language);
  return `<div class="two-fields"><div class="voice-choice" data-custom-voice="${e(preset ? "" : voice)}"><label class="field"><span>Voice</span><select data-voice-preset>${presets.map((p) => `<option value="${e(p.voiceId)}" ${voice === p.voiceId ? "selected" : ""}>${e(p.name)}</option>`).join("")}<option value="custom" ${preset ? "" : "selected"}>Custom…</option></select></label><div class="custom-voice" ${preset ? "hidden" : ""}>${field("ElevenLabs voice ID", voiceIdField, voice, "Paste any voice ID from your ElevenLabs account.", "required")}</div></div><div class="language-field"><span class="field-label">Language</span><input type="hidden" id="${languageField}" value="${e(language)}"/><details class="language-picker"><summary aria-label="Language: ${e(selected?.name ?? (language || "Automatic"))}"><span class="language-current">${e(selected?.name ?? (language || "Automatic"))}</span><span class="tag language-code">${e(language)}</span>${icon("down", 14)}</summary><div class="language-menu"><label class="language-search">${icon("search", 16)}<input type="search" placeholder="Search languages…" aria-label="Search languages" autocomplete="off"/></label><div class="language-options" role="listbox" aria-label="Languages">${languageOptions("", language)}</div><p class="subtle">Search by name, native name, code or keyword.</p></div></details></div></div>`;
}

function languageOptions(query: string, selected: string) {
  return (
    searchLanguages(query)
      .map(
        (language) =>
          `<button type="button" role="option" aria-selected="${findLanguage(selected)?.code === language.code}" data-language="${language.code}"><span>${e(language.name)}<small>${e(language.native)}</small></span><span class="tag">${language.code}</span></button>`,
      )
      .join("") ||
    '<p class="subtle language-empty" role="status">No matching languages. Try another name or code.</p>'
  );
}

export function filterLanguageOptions(input: HTMLInputElement) {
  const group = input.closest<HTMLElement>(".language-field")!;
  group.querySelector(".language-options")!.innerHTML = languageOptions(
    input.value,
    group.querySelector<HTMLInputElement>('input[type="hidden"]')!.value,
  );
}

export function chooseLanguage(button: HTMLElement) {
  const group = button.closest<HTMLElement>(".language-field")!;
  const language = findLanguage(button.dataset.language!)!;
  group.querySelector<HTMLInputElement>('input[type="hidden"]')!.value =
    language.code;
  group.querySelector(".language-current")!.textContent = language.name;
  group.querySelector(".language-code")!.textContent = language.code;
  const picker = group.querySelector<HTMLDetailsElement>("details")!;
  picker.open = false;
  picker
    .querySelector("summary")!
    .setAttribute("aria-label", `Language: ${language.name}`);
  picker.querySelector("summary")!.focus();
  const search = group.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "";
  filterLanguageOptions(search);
}

export function changeVoicePreset(select: HTMLSelectElement) {
  const group = select.closest<HTMLElement>(".voice-choice")!;
  const custom = group.querySelector<HTMLElement>(".custom-voice")!;
  const input = custom.querySelector<HTMLInputElement>("input")!;
  if (!custom.hidden) group.dataset.customVoice = input.value;
  custom.hidden = select.value !== "custom";
  input.value = custom.hidden
    ? select.value
    : (group.dataset.customVoice ?? "");
}

export function languageKeydown(event: KeyboardEvent) {
  const picker = (event.target as HTMLElement).closest<HTMLDetailsElement>(
    ".language-picker",
  );
  if (!picker) return;
  if (event.key === "Escape") {
    event.preventDefault();
    picker.open = false;
    picker.querySelector("summary")!.focus();
    return;
  }
  const buttons = [
    ...picker.querySelectorAll<HTMLButtonElement>("[data-language]"),
  ];
  const search = (event.target as HTMLElement).matches('input[type="search"]');
  if (event.key === "Enter" && search) {
    event.preventDefault();
    if (buttons[0]) chooseLanguage(buttons[0]);
  }
  if (
    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
    ((event.key === "Home" || event.key === "End") && search)
  )
    return;
  event.preventDefault();
  picker.open = true;
  const index = buttons.indexOf(event.target as HTMLButtonElement);
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
