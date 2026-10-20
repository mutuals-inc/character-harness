import { escape as e } from "../lib/dom.ts";
export function field(
  label: string,
  name: string,
  value: unknown,
  help = "",
  attributes = "",
) {
  return `<div class="field"><label for="${name}">${e(label)}</label><input id="${name}" name="${name}" value="${e(value)}" ${attributes}/>${help ? `<small>${e(help)}</small>` : ""}</div>`;
}
export function slider(
  label: string,
  name: string,
  value: number,
  min: number,
  max: number,
  step: number,
  help = "",
  display?: string,
) {
  return `<div class="field slider-field"><label for="${name}">${e(label)}<output for="${name}" id="${name}-value">${display ?? value}</output></label><input type="range" id="${name}" name="${name}" min="${min}" max="${max}" step="${step}" value="${value}"/>${help ? `<small>${e(help)}</small>` : ""}</div>`;
}
export function toggle(label: string, name: string, value: boolean, help = "") {
  return `<label class="toggle-row" for="${name}"><span>${e(label)}${help ? `<small>${e(help)}</small>` : ""}</span><input role="switch" type="checkbox" id="${name}" name="${name}" ${value ? "checked" : ""}/><span class="toggle" aria-hidden="true"></span></label>`;
}
