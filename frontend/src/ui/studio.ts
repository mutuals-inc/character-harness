import { state } from "../store.ts";
import { $, escape as e } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";

export function studio() {
  const volume = state.settings.volume;
  return `<div class="studio-grid"><div class="studio-stage-column">
    <section class="stage ${e(state.settings.background)}" id="character-stage" aria-label="Character preview"><div id="stage-canvas"></div><p id="stage-loading" role="status">Loading character…</p><label class="studio-background stage-background"><span class="sr-only">Background</span><select id="background-select" aria-label="Background"><option value="sky" ${state.settings.background === "sky" ? "selected" : ""}>Clouds</option><option value="paper" ${state.settings.background === "paper" ? "selected" : ""}>Plain</option><option value="blue" ${state.settings.background === "blue" ? "selected" : ""}>Blue</option></select></label><button class="stage-expand icon-button" data-action="fullscreen" aria-label="Expand character stage" title="Expand stage" aria-expanded="false">${icon("expand")}</button><p class="stage-caption" id="stage-caption"></p></section>
    <section class="studio-live surface" aria-labelledby="studio-live-title"><div class="studio-live-heading"><h2 id="studio-live-title">Live character</h2><span class="tag" id="character-presence">Offline</span></div><div class="studio-state-grid"><div><small>Emotion</small><strong id="live-emotion">Neutral</strong></div><div><small>Last reaction</small><strong id="live-reaction">None yet</strong></div></div><div class="live-extension-heading"><small>Extensions</small><span id="live-extension-count" class="subtle"></span></div><div id="live-extensions" class="live-extension-list"></div></section></div>
    <section class="conversation" aria-labelledby="conversation-title"><div class="conversation-header"><h2 id="conversation-title">Conversation</h2><div class="toolbar"><button class="text-button" data-action="export-transcript">${icon("download", 16)} Export</button><button class="text-button" data-action="new-conversation" title="End the session and clear the conversation">${icon("plus", 16)} New conversation</button></div></div><div id="transcript" role="log" aria-live="polite" aria-relevant="additions text"></div><div class="studio-listening" id="studio-listening" role="status" data-state="idle"><span class="presence-dot"></span><span id="listening-state">Microphone off · session not started</span><span class="studio-input-meter" role="meter" aria-label="Live microphone level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span data-input-level></span></span></div><p id="live-transcript" class="live-transcript" hidden></p><form id="chat-form" class="chat-composer"><label for="chat-input" class="sr-only">Message</label><input id="chat-input" name="message" placeholder="Type a message…" autocomplete="off" maxlength="20000" required/><button type="submit" class="button primary">Send</button></form>
    <div class="conversation-controls studio-audio-controls"><button class="button primary" id="session-toggle">Start session</button><button type="button" class="button mic-off" data-action="mic" id="mic-toggle" aria-label="Turn on microphone" aria-pressed="false">${icon("micOff", 16)} Microphone off</button><details class="studio-volume-menu"><summary class="icon-button" id="volume-toggle" aria-label="Character volume" title="Character volume">${icon("volume", 18)}</summary><div class="volume-popover"><div class="volume-heading"><strong>Character volume</strong><output id="volume-value" for="volume">${Math.round(volume * 100)}%</output></div><input type="range" id="volume" min="0" max="1" step="0.01" value="${volume}" aria-label="Character volume"/><button type="button" class="text-button" data-action="speaker" id="speaker-toggle">${icon("volume", 16)} Sound on</button></div></details><button type="button" class="icon-button" data-action="audio-setup" aria-label="Audio setup" title="Audio setup">${icon("gear", 18)}</button><button type="button" class="icon-button" data-action="context" aria-label="Send a screen note" title="Send a screen note">${icon("screen", 18)}</button></div></section></div>`;
}

const hookLabels: Record<string, string> = {
  on_session_start: "Session started",
  before_reply: "Deciding to reply",
  before_llm: "Preparing reply",
  on_tool_call: "Running a tool",
  after_llm: "Reply generated",
  on_sentence: "Shaping speech",
  on_speak: "Speaking",
  after_turn: "Turn completed",
  on_session_end: "Session ended",
};
export function renderStudioLive() {
  const live = state.live;
  $("#live-emotion").textContent = live.emotion
    .replace(/[-_]/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
  $("#live-reaction").textContent = live.reaction;
  const enabled = state.bootstrap!.character.extensions.filter(
    (extension) => extension.enabled,
  );
  $("#live-extension-count").textContent = `${enabled.length} enabled`;
  const ordered = [...enabled].sort(
    (a, b) =>
      (live.extensions[b.name]?.at ?? 0) - (live.extensions[a.name]?.at ?? 0),
  );
  $("#live-extensions").innerHTML =
    ordered
      .slice(0, 4)
      .map((extension) => {
        const event = live.extensions[extension.name];
        const label = event
          ? `${hookLabels[event.event] ?? event.event}${event.running ? " · working" : ` · ${event.duration ?? 0} ms`}`
          : "Ready";
        return `<div class="live-extension ${event?.running ? "running" : ""}"><span>${e(extension.name)}</span><small>${e(label)}</small></div>`;
      })
      .join("") ||
    '<p class="subtle">No extensions enabled for this character.</p>';
  if (enabled.length > 4)
    $("#live-extensions").insertAdjacentHTML(
      "beforeend",
      `<p class="subtle">${enabled.length - 4} more enabled · recent activity appears first</p>`,
    );
}

export function renderTranscript() {
  const el = $("#transcript");
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const messages = state.messages;
  if (!messages.length) {
    el.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Type a message or turn on your microphone to begin.";
    el.append(empty);
    return;
  }
  el.querySelector(".empty-state")?.remove();
  // Keep existing message nodes while streaming; update only changed text.
  messages.forEach((message, index) => {
    let article = el.children[index] as HTMLElement | undefined;
    if (!article) {
      article = document.createElement("article");
      article.append(
        document.createElement("strong"),
        document.createElement("p"),
      );
      el.append(article);
    }
    article.className = `transcript-message ${message.role}`;
    const label = `${message.role === "user" ? "You" : state.bootstrap!.character.name}${message.source === "screen" ? " · Screen note" : ""}`;
    const content =
      message.content.replace(/\[[^\]]+\]/g, "").trim() || "Thinking…";
    if (article.children[0].textContent !== label)
      article.children[0].textContent = label;
    if (article.children[1].textContent !== content)
      article.children[1].textContent = content;
  });
  while (el.children.length > messages.length) el.lastElementChild?.remove();
  if (atBottom) el.scrollTop = el.scrollHeight;
}
