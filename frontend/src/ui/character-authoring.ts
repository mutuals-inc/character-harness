import { escape as e } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { field } from "./forms.ts";
import { voiceFields } from "./voice-fields.ts";
import { chatFields, promptField } from "./character-fields.ts";
import { state } from "../store.ts";
import type { AvailableExtension, ExtensionSelection } from "../types.ts";

let animationIndex = 0;
export function animationRow() {
  const index = animationIndex++;
  return `<div class="animation-row"><label>Use as<select class="animation-kind"><option value="idle">Idle loop</option><option value="talk">Talking style</option><option value="gesture">Gesture / pose</option></select></label><label>Name / style<input class="animation-name" maxlength="64" placeholder="Not needed for idle"/></label><label>Animation file<input type="file" name="animation-${index}" class="animation-file" accept=".vrma" required/></label><label class="animation-hold" hidden><input type="checkbox"/> Hold pose</label><button type="button" class="icon-button" data-action="remove-animation" aria-label="Remove animation">${icon("close", 16)}</button></div>`;
}
export function animationAssignments(form: HTMLFormElement) {
  return [...form.querySelectorAll<HTMLElement>(".animation-row")].map(
    (row) => ({
      kind: row.querySelector<HTMLSelectElement>(".animation-kind")!.value,
      name: row.querySelector<HTMLInputElement>(".animation-name")!.value,
      file: row.querySelector<HTMLInputElement>(".animation-file")!.name,
      hold: row.querySelector<HTMLInputElement>(".animation-hold input")!
        .checked,
    }),
  );
}
export function extensionFields(
  options: AvailableExtension[],
  selected: ExtensionSelection[] = [],
) {
  // Keep each character's configured order, then append other installed extensions.
  const ordered = [
    ...selected
      .map((s) => options.find((o) => o.id === s.id))
      .filter((x): x is AvailableExtension => !!x),
    ...options.filter((o) => !selected.some((s) => s.id === o.id)),
  ];
  return `<div class="extension-choices"><p class="extension-order-status subtle" role="status" aria-live="polite">Drag to reorder, or use the arrows. Runs from top to bottom.</p><div class="extension-list">${
    ordered
      .map((option, index) => {
        const value = selected.find((x) => x.id === option.id);
        return `<article class="extension-choice" data-extension-id="${e(option.id)}" data-original-position="${index + 1}"><div class="extension-choice-header"><button type="button" class="extension-drag icon-button" data-drag-extension aria-label="Reorder ${e(option.name)}" title="Drag to reorder, or press the up and down arrow keys">${icon("grip", 17)}</button><span class="extension-position" aria-label="Position">${index + 1}</span><label><input type="checkbox" class="extension-enabled" ${value?.enabled ? "checked" : ""}/><strong>${e(option.name)}</strong></label><small class="extension-order-change" hidden>Was #${index + 1}</small><div class="extension-move-buttons"><button type="button" class="icon-button" data-move-extension="up" aria-label="Move ${e(option.name)} earlier" ${index === 0 ? "disabled" : ""}>${icon("up", 14)}</button><button type="button" class="icon-button" data-move-extension="down" aria-label="Move ${e(option.name)} later" ${index === ordered.length - 1 ? "disabled" : ""}>${icon("down", 14)}</button></div></div><p class="subtle extension-hooks">${option.hooks.map(e).join(" · ")}</p><details class="extension-settings"><summary>${icon("settings", 16)}<span>Configuration</span><small>Optional</small><span class="configuration-chevron">${icon("chevron", 16)}</span></summary><div class="extension-config-body"><label class="field"><span>${e(option.name)} configuration <small>YAML</small></span><textarea class="extension-config" rows="7" spellcheck="false">${e(value?.config ?? option.defaultConfig)}</textarea></label></div></details></article>`;
      })
      .join("") || '<p class="subtle">No extensions installed.</p>'
  }</div></div>`;
}
export function selectedExtensions(
  form: HTMLFormElement,
): ExtensionSelection[] {
  return [...form.querySelectorAll<HTMLElement>(".extension-choice")].map(
    (row) => ({
      id: row.dataset.extensionId!,
      enabled:
        row.querySelector<HTMLInputElement>(".extension-enabled")!.checked,
      config:
        row.querySelector<HTMLTextAreaElement>(".extension-config")!.value,
    }),
  );
}
export function sectionSummary(glyph: string, title: string, hint: string) {
  return `<summary><span class="section-glyph">${icon(glyph, 20)}</span><span class="section-title">${title}<small>${hint}</small></span><span class="section-chevron">${icon("chevron", 17)}</span></summary>`;
}
export function revealInvalidCreationField(form: HTMLFormElement): boolean {
  const first = form.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >("input:invalid,select:invalid,textarea:invalid");
  if (!first) return false;
  const prompt = first.closest<HTMLElement>(".prompt-field");
  if (prompt) {
    first.hidden = false;
    prompt.querySelector<HTMLElement>(".prompt-preview")!.hidden = true;
    prompt
      .querySelectorAll<HTMLButtonElement>("[data-prompt-mode]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.promptMode === "edit"),
        ),
      );
  }
  for (
    let parent = first.parentElement;
    parent && parent !== form;
    parent = parent.parentElement
  )
    if (parent.tagName === "DETAILS")
      (parent as HTMLDetailsElement).open = true;
  first.reportValidity();
  return true;
}
export function createCharacterView() {
  return `<div class="character-editor"><button class="text-button back-to-characters" data-view="character">${icon("arrow", 16)} All characters</button>
  <p class="authoring-intro">Define a new character. Add its body, personality, voice and behaviors.</p>
  <form id="create-character-form" class="character-creation" novalidate>
  <div class="creation-panels">
  <details class="authoring-card" name="new-character-sections">${sectionSummary("person", "Identity & personality", "Name, description and personality")}<section class="surface create-panel" id="create-step-identity">${field("Name", "create-name", "", "", 'required maxlength="200"')}${field("Description", "create-description", "", "A short introduction to this character.", 'required maxlength="2000"')}${promptField("create")}</section></details>
  <details class="authoring-card" name="new-character-sections">${sectionSummary("studio", "Body & animations", "Model, portrait, movement and gestures")}<section class="surface create-panel" id="create-step-body"><div class="surface-heading"><h2>Body & animations</h2></div><div class="two-fields"><label class="field"><span>VRM model</span><input type="file" name="model" accept=".vrm" required/><small>VRM 0.x or 1.0, up to 100 MB.</small></label><label class="field"><span>Portrait (optional)</span><input type="file" name="portrait" accept=".png,.jpg,.jpeg,.webp"/><small>Shown on the character card. Up to 10 MB.</small></label></div><div class="animation-assignments"></div><button type="button" class="button" data-action="add-animation">${icon("plus", 16)} Add animation</button><p class="subtle">Add .vrma files as idle loops, talking styles or gestures. Animations are optional.</p></section></details>
  <details class="authoring-card" name="new-character-sections">${sectionSummary("chat", "Chat model", "Choose a saved connection or add your own")}<section class="surface create-panel" id="create-step-chat">${chatFields("create")}</section></details>
  <details class="authoring-card" name="new-character-sections">${sectionSummary("mic", "Voice", "Voice and language")}<section class="surface create-panel" id="create-step-voice">${voiceFields("create-voice-id", "create-language")}</section></details>
  <details class="authoring-card" name="new-character-sections">${sectionSummary("hooks", "Extensions", "Behaviors enabled for this character")}<section class="surface create-panel" id="create-step-extensions"><div class="surface-heading"><h2>Extensions</h2></div><p class="subtle">Enable behaviors for this character only. Drag extensions into the order you want.</p>${extensionFields(state.bootstrap!.availableExtensions)}</section></details>
  </div><div class="creation-footer"><p id="create-character-error" class="error-text" role="alert"></p><div class="form-actions authoring-actions"><span class="subtle">Complete the sections above to create your character.</span><button class="button" type="button" data-view="character">Cancel</button><button class="button primary" type="submit">${icon("personPlus", 18)} Create character</button></div></div>
  </form></div>`;
}
export function creationDefinition(form: HTMLFormElement) {
  const value = (id: string) =>
    (form.querySelector(`#create-${id}`) as HTMLInputElement).value;
  return {
    name: value("name"),
    description: value("description"),
    prompt: value("prompt"),
    api: value("api"),
    model: value("model"),
    baseUrl: value("base-url"),
    keyName: value("key-name"),
    temperature: 0.8,
    voiceId: value("voice-id"),
    voiceModel: "eleven_v4_turbo",
    stability: 0.5,
    similarity: 0.75,
    sttModel: "scribe_v2_realtime",
    language: value("language"),
    springs: true,
    animations: animationAssignments(form),
    extensions: selectedExtensions(form),
  };
}
