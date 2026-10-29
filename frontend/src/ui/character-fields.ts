import { marked } from "marked";
import DOMPurify from "dompurify";
import { escape as e } from "../lib/dom.ts";
import { state } from "../store.ts";
import type { ChatPreset } from "../types.ts";
import { field } from "./forms.ts";

export function promptPreview(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "video", "audio", "iframe", "style", "form", "input"],
  });
}

export function promptField(prefix: string, text = "") {
  return `<div class="prompt-field"><div class="prompt-heading"><label for="${prefix}-prompt">Personality</label><div class="prompt-tabs" role="group" aria-label="Personality view"><button type="button" class="text-button" data-prompt-mode="edit" aria-pressed="true">Write</button><button type="button" class="text-button" data-prompt-mode="preview" aria-pressed="false">Preview</button></div></div><textarea id="${prefix}-prompt" rows="9" maxlength="100000" required placeholder="Who is this character? How should they speak and behave?">${e(text)}</textarea><div class="prompt-preview" hidden></div></div>`;
}

export function chatFields(prefix: string, current?: ChatPreset) {
  const presets = state.bootstrap!.chatPresets;
  const selected = current ?? presets[0];
  const index = presets.findIndex(
    (p) =>
      p.model === selected?.model &&
      p.api === selected?.api &&
      p.baseUrl === selected?.baseUrl &&
      p.keyName === selected?.keyName,
  );
  const custom = index < 0;
  return `<div class="chat-fields"><label class="field"><span>Chat model</span><select data-chat-preset>${presets.map((p, i) => `<option value="${i}" ${i === index ? "selected" : ""}>${e(p.model)}</option>`).join("")}<option value="custom" ${custom ? "selected" : ""}>Custom connection…</option></select></label><div class="chat-connection" ${custom ? "" : "hidden"}><div class="two-fields">${field("Model name", `${prefix}-model`, selected?.model ?? "", "", "required")}<label class="field"><span>API format</span><select id="${prefix}-api"><option value="chat_completions" ${selected?.api === "chat_completions" ? "selected" : ""}>Chat Completions</option><option value="responses" ${selected?.api === "responses" ? "selected" : ""}>Responses</option></select></label></div>${field("API endpoint", `${prefix}-base-url`, selected?.baseUrl ?? "", "", 'required type="url"')}${field("API key variable", `${prefix}-key-name`, selected?.keyName ?? "", "The name of a key saved in the harness .env.", 'required pattern="[A-Za-z_][A-Za-z0-9_]*"')}</div></div>`;
}

export function changeChatPreset(select: HTMLSelectElement) {
  const group = select.closest<HTMLElement>(".chat-fields")!;
  const custom = select.value === "custom";
  group.querySelector<HTMLElement>(".chat-connection")!.hidden = !custom;
  if (custom) return;
  const preset = state.bootstrap!.chatPresets[Number(select.value)];
  for (const [suffix, value] of Object.entries({
    model: preset.model,
    api: preset.api,
    "base-url": preset.baseUrl,
    "key-name": preset.keyName,
  }))
    group.querySelector<HTMLInputElement | HTMLSelectElement>(
      `[id$="-${suffix}"]`,
    )!.value = value;
}
