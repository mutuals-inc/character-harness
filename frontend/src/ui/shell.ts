import { escape as e } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { state } from "../store.ts";

export const navigation = [
  ["studio", "Studio", "studio"],
  ["character", "Character", "person"],
  ["voice", "Voice & audio", "mic"],
  ["hooks", "Hooks & extensions", "hooks"],
  ["activity", "Activity", "activity"],
] as const;

export function shell() {
  const c = state.bootstrap!.character;
  return `<a href="#main" class="skip-link">Skip to workspace</a>
  <aside class="sidebar">
    <a href="https://mutuals.inc" target="_blank" rel="noreferrer" class="brand" aria-label="Mutuals official website"><span class="wordmark"></span></a>
    <div class="workspace-label">CHARACTER HARNESS <span class="tiny-label">LOCAL</span></div>
    <nav aria-label="Workspace"><p class="nav-label">WORKSPACE</p>${navigation.map(([id, label, glyph]) => `<button class="nav-item ${id === "studio" ? "active" : ""}" data-view="${id}" ${id === "studio" ? 'aria-current="page"' : ""}>${icon(glyph)}<span>${label}</span>${id === "activity" ? '<span class="nav-count" id="activity-count">0</span>' : ""}</button>`).join("")}</nav>
    <div class="character-picker"><p class="nav-label">YOUR CHARACTERS</p><label class="sr-only" for="character-select">Current character</label>
      <div class="character-option"><span class="avatar small">${e(c.name.slice(0, 1))}</span><div><select id="character-select">${state.bootstrap!.characters.map((x) => `<option value="${e(x.id)}" ${x.id === c.id ? "selected" : ""}>${e(x.name)}</option>`).join("")}</select><small>Character loaded <span class="dot"></span></small></div></div>
    </div>
    <div class="sidebar-bottom"><div class="sidebar-note"><img src="/brand/symbol.svg" alt=""/><p>A world of<br/><em>characters.</em></p></div>
      <button class="nav-item" data-view="settings">${icon("settings")}<span>Settings & connection</span></button>
      <div class="sidebar-credit"><span>Made by Mutuals</span><a href="https://github.com/mutuals-inc/character-harness" target="_blank" rel="noreferrer" aria-label="Harness source code">${icon("external", 14)}</a></div>
    </div>
  </aside>
  <main id="main" class="workspace"><header class="workspace-header"><div><div class="breadcrumb">WORKSPACE <span>/</span> <span id="breadcrumb-character">${e(c.name.toUpperCase())}</span></div><h1 id="page-title">Character Studio<span class="title-period">.</span></h1><p id="page-description">A place to bring your characters to life.</p></div>
    <div class="header-actions"><span class="draft-tag">LOCAL DRAFT <span class="dot"></span></span><button class="button primary" id="session-toggle">${icon("studio", 17)}<span>Start session</span>${icon("arrow", 17)}</button></div></header>
    <section id="view-studio" class="view"></section>
    <section id="view-character" class="view" hidden></section>
    <section id="view-voice" class="view" hidden></section>
    <section id="view-hooks" class="view" hidden></section>
    <section id="view-activity" class="view" hidden></section>
    <section id="view-settings" class="view" hidden></section>
    <footer class="workspace-footer"><span><span class="dot"></span> Running on your machine</span><span>Extraordinary characters. A little closer.</span><a href="https://github.com/mutuals-inc/character-harness/blob/main/docs/architecture.md" target="_blank" rel="noreferrer">Harness docs ${icon("external", 12)}</a></footer>
  </main>
  <dialog id="context-dialog" aria-labelledby="context-title"><div class="dialog-header"><h2 id="context-title">Give a little context.</h2><button class="icon-button" data-action="close-dialog" aria-label="Close screen context">${icon("close")}</button></div><p>Describe what’s on your screen. The runtime receives this as a screen input; images and video aren’t sent.</p><form id="context-form"><label for="screen-note">Screen context</label><textarea id="screen-note" placeholder="I’m looking at…" rows="6" maxlength="20000" required></textarea><div class="form-actions"><button class="button primary" type="submit">Send context ${icon("arrow", 16)}</button></div></form></dialog>`;
}
