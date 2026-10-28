import { state } from "../store.ts";
import { escape as e } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";

let query = "";
let page = 1;
const pageSize = 9;
export function hooksView() {
  return `<div class="extension-library"><div class="library-toolbar"><label class="extension-search">${icon("search", 18)}<input type="search" id="extension-search" aria-label="Search extensions" placeholder="Search extensions…" value="${e(query)}"/></label><button class="button primary" data-action="upload-extension">${icon("plus", 17)} Upload extension</button></div><p class="subtle">Install once. Each character chooses which extensions run, their order, and their configuration.</p><div class="extension-current surface"><div><strong>Extensions for ${e(state.bootstrap!.character.name)}</strong><p class="subtle">Enable behaviors and edit their configuration in the character.</p></div><button class="button" data-action="configure-extensions">${icon("settings", 17)} Configure character</button></div><div id="extension-results">${extensionCards()}</div></div><dialog id="extension-upload-dialog"><form id="extension-upload-form" class="dialog-form"><div class="surface-heading"><h2>Upload extension</h2><button type="button" class="icon-button" data-action="close-extension-upload" aria-label="Close upload">${icon("close")}</button></div><p class="subtle">Choose a ZIP containing extension.yaml, its handler, and optional defaults.yaml. Maximum 20 MB. Installed packages are shared; nothing is enabled automatically.</p><label>Extension package<input type="file" name="package" accept=".zip,application/zip" required/></label><label class="extension-trust"><input type="checkbox" name="trusted" required/><span>I trust this package. Extensions can run local code with access to files, network and provider keys.</span></label><p id="extension-upload-error" class="form-error" role="alert"></p><div class="form-actions"><button type="button" class="button" data-action="close-extension-upload">Cancel</button><button type="submit" class="button primary">${icon("plus", 17)} Install extension</button></div></form></dialog>`;
}
function extensionCards() {
  const all = state.bootstrap!.availableExtensions;
  const matching = all.filter((ext) =>
    `${ext.name} ${ext.description ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase().trim()),
  );
  const pages = Math.max(1, Math.ceil(matching.length / pageSize));
  page = Math.min(page, pages);
  return `<p class="subtle extension-count">${matching.length} ${matching.length === 1 ? "extension" : "extensions"}</p><div class="extension-library-grid">${
    matching
      .slice((page - 1) * pageSize, page * pageSize)
      .map(
        (ext) =>
          `<article class="surface installed-extension"><span class="extension-symbol">${icon("hooks", 22)}</span><h2>${e(ext.name)}</h2><p class="subtle">${e(ext.description || "Adds behavior at specific points in a conversation.")}</p><details class="extension-capabilities"><summary>${ext.service ? "Native player service · " : ""}${ext.hooks.length} lifecycle ${ext.hooks.length === 1 ? "hook" : "hooks"}${icon("down", 15)}</summary><ul>${ext.hooks.map((hook) => `<li>${e(hook.replace(/_/g, " "))}</li>`).join("")}</ul></details></article>`,
      )
      .join("") || '<p class="empty-state">No extensions match your search.</p>'
  }</div>${pages > 1 ? `<nav class="extension-pagination" aria-label="Extension pages"><button class="button" data-extension-page="${page - 1}" ${page === 1 ? "disabled" : ""}>Previous</button><span>${page} / ${pages}</span><button class="button" data-extension-page="${page + 1}" ${page === pages ? "disabled" : ""}>Next</button></nav>` : ""}`;
}
export function renderExtensionCards(search = query, nextPage = 1) {
  query = search;
  page = nextPage;
  document.getElementById("extension-results")!.innerHTML = extensionCards();
}
