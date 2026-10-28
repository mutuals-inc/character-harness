import { version } from "../../package.json";
import { icon } from "../lib/icons.ts";
import { audioSetupDialog } from "./studio-audio.ts";
import {
  sidebarCharacterSwitcher,
  characterSwitcherMenu,
} from "./character-switcher.ts";

export function shell() {
  const collapsed = matchMedia("(max-width: 760px)").matches;
  const sections = [
    ["character", "Character"],
    ["hooks", "Extensions"],
    ["settings", "Connection & preferences"],
  ];
  return `<a href="#main" class="skip-link">Skip to conversation</a>
  <div class="workspace-layout ${collapsed ? "sidebar-collapsed" : ""}">
  <aside id="workspace-sidebar" class="sidebar" aria-label="Workspace sidebar">
    <a class="brand" href="https://mutuals.inc" target="_blank" rel="noreferrer" aria-label="Mutuals website"><img class="brand-wordmark" src="/brand/wordmark.svg" alt="Mutuals"/><img class="brand-symbol" src="/brand/symbol.svg" alt="Mutuals"/></a>
    <p class="sidebar-label"><span>CHARACTER HARNESS</span><span class="version-badge" aria-label="Version ${version}">${version}</span></p>
    <nav aria-label="Workspace">
      ${[
        ["studio", "Studio", "studio"],
        ["character", "Character", "person"],
        ["hooks", "Extensions", "hooks"],
        ["settings", "Settings", "settings"],
      ]
        .map(
          ([id, label, glyph]) =>
            `<button class="nav-item" data-view="${id}" aria-label="${label}" title="${label}" ${id === "studio" ? 'aria-current="page"' : ""}>${icon(glyph, 18)}<span>${label}</span></button>`,
        )
        .join("")}
    </nav>
    ${sidebarCharacterSwitcher()}
  </aside>
  <div class="workspace-content">
  <header class="workspace-header">
    <button class="icon-button sidebar-toggle" data-action="toggle-sidebar" aria-label="${collapsed ? "Expand" : "Collapse"} sidebar" aria-expanded="${!collapsed}" aria-controls="workspace-sidebar" title="${collapsed ? "Expand" : "Collapse"} sidebar">${icon("sidebar", 20)}</button>
    <h1 id="page-title" tabindex="-1">Studio</h1>
  </header>
  <main id="main">
    <section id="view-studio" class="page"></section>
    <section id="view-character-detail" class="page" hidden></section>
    <section id="view-character-new" class="page" hidden></section>
    ${sections.map(([id]) => `<section id="view-${id}" class="page" hidden></section>`).join("")}
  </main>
  </div></div>
  ${characterSwitcherMenu()}
  ${audioSetupDialog()}
  <dialog id="delete-character-dialog" aria-labelledby="delete-character-title" aria-describedby="delete-character-description">
    <div class="dialog-header"><h2 id="delete-character-title">Delete character?</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="Cancel deletion">${icon("close")}</button></div>
    <p id="delete-character-description">Remove <strong id="delete-character-name"></strong> from your library? Its files will be kept locally for recovery.</p>
    <p id="delete-active-note" class="subtle" hidden>Studio will switch to FoxGlove and start a fresh conversation.</p>
    <div class="form-actions"><button type="button" class="button" data-action="close-dialog">Cancel</button><button type="button" class="button danger" data-action="confirm-delete-character">Delete character</button></div>
  </dialog>
  <dialog id="context-dialog" aria-labelledby="context-title">
    <div class="dialog-header"><h2 id="context-title">Screen note</h2><button class="icon-button" data-action="close-dialog" aria-label="Close screen note">${icon("close")}</button></div>
    <p>Describe what’s on your screen. Only this text is sent.</p>
    <form id="context-form"><label for="screen-note" class="sr-only">Screen context</label><textarea id="screen-note" rows="6" maxlength="20000" required></textarea><div class="form-actions"><button class="button primary" type="submit">Send note</button></div></form>
  </dialog>`;
}
