import { state } from "../store.ts";
import { $, escape as e } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";

export function studio() {
  const c = state.bootstrap!.character;
  return `<div class="studio-grid"><div class="stage-column">
    <div class="stage ${e(state.settings.background)}" id="character-stage">
      <div id="stage-canvas"></div><div id="stage-loading" role="status">Getting the stage ready…</div>
      <div class="stage-top"><span class="stage-badge"><span class="dot"></span><span id="stage-mode">PREVIEW</span></span><div class="stage-top-right"><span class="emotion-label">${icon("spark", 14)}<span id="current-emotion">Neutral</span></span><button class="stage-icon" data-action="fullscreen" aria-label="Expand character stage" title="Expand stage">${icon("expand", 16)}</button></div></div>
      <div class="stage-signature"><span class="eyebrow">A LITTLE MORE ALIVE</span><h2 id="stage-character-name">${e(c.name)}</h2></div>
      <div class="stage-bottom"><p class="stage-caption" id="stage-caption">Say hello when you’re ready.</p><div class="stage-controls"><button class="icon-button" data-action="mic" id="mic-toggle" aria-label="Turn on microphone" title="Microphone">${icon("micOff")}</button><span class="control-divider"></span><span class="audio-bars" aria-hidden="true">${"<i></i>".repeat(13)}</span><span class="control-divider"></span><button class="icon-button" data-action="speaker" id="speaker-toggle" aria-label="Mute character voice" title="Character voice">${icon("volume")}</button><button class="icon-button" data-action="context" aria-label="Add screen context" title="Screen context">${icon("screen")}</button><button class="icon-button" data-action="reset-stage" aria-label="Reset camera and pose" title="Reset stage">${icon("reset", 18)}</button></div></div>
      <span class="stage-renderer" id="stage-renderer">Loading 3D player</span>
    </div>
    <form id="chat-form" class="chat-composer"><label for="chat-input" class="sr-only">Message the character</label><span class="composer-mark">${icon("spark", 19)}</span><input id="chat-input" name="message" placeholder="Say something to ${e(c.name)}…" autocomplete="off" maxlength="20000"/><kbd>↵</kbd><button type="submit" aria-label="Send message" class="send-button">${icon("up", 19)}</button></form>
    <div class="performance-rack"><div><span class="eyebrow">TRY A LITTLE EXPRESSION</span><p>No session needed. Just a little personality.</p></div><div class="gesture-buttons">${c.body.gestures
      .slice(0, 3)
      .map(
        (name) =>
          `<button class="button gesture" data-gesture="${e(name)}">${icon(name === "wave" ? "wave" : name === "cheer" ? "spark" : "person", 16)}${e(name.charAt(0).toUpperCase() + name.slice(1))}</button>`,
      )
      .join(
        "",
      )}<label class="sr-only" for="gesture-select">More gestures</label><select id="gesture-select" aria-label="More gestures"><option value="">More…</option>${c.body.gestures
      .slice(3)
      .map((name) => `<option>${e(name)}</option>`)
      .join("")}</select></div></div>
  </div><aside class="inspector"><div class="inspector-tabs" role="tablist" aria-label="Session panel"><button role="tab" id="tab-overview" aria-selected="true" aria-controls="panel-overview" data-panel="overview">Overview</button><button role="tab" id="tab-conversation" aria-selected="false" aria-controls="panel-conversation" data-panel="conversation">Conversation <span id="message-count">0</span></button></div>
    <div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview"><div class="character-intro"><span class="avatar">${e(c.name.slice(0, 1))}<span class="avatar-star">✦</span></span><span class="eyebrow">YOUR CHARACTER</span><h2>Meet <span id="intro-name">${e(c.name)}</span>.</h2><p id="intro-description">${e(c.description)}</p><button class="text-button" data-view="character">Get to know the character ${icon("arrow", 15)}</button></div>
    <div class="inspector-section"><div class="section-heading"><h3>In the room</h3><span class="subtle">SESSION</span></div><div class="info-row"><span>${icon("activity", 16)} Runtime</span><span class="connection-state"><span class="dot"></span><span id="runtime-state">Ready</span></span></div><div class="info-row"><span>${icon("mic", 16)} Microphone</span><button class="plain-button" data-action="mic" id="mic-label">Off ${icon("down", 12)}</button></div><div class="info-row"><span>${icon("headphones", 16)} Character voice</span><span>${e(c.voice.provider === "elevenlabs" ? "ElevenLabs" : c.voice.provider)}</span></div><div class="info-row"><span>${icon("hooks", 16)} Extensions</span><button class="plain-button" data-view="hooks" id="extension-count">${c.extensions.length} enabled ${icon("chevron", 12)}</button></div></div>
    <div class="inspector-section"><div class="section-heading"><h3>Set the scene</h3></div><div class="scene-options"><label for="emotion-select">Expression</label><select id="emotion-select"><option value="neutral">Neutral</option>${c.body.emotions
      .filter((x) => x !== "neutral")
      .map(
        (name) =>
          `<option value="${e(name)}">${e(name.charAt(0).toUpperCase() + name.slice(1))}</option>`,
      )
      .join(
        "",
      )}</select><label for="camera-select">Framing</label><select id="camera-select"><option value="portrait">Portrait</option><option value="close-up">Close-up</option><option value="wide">Full character</option></select></div><div class="background-label"><span>Backdrop</span><div class="swatches" role="group" aria-label="Stage backdrop">${(["sky", "paper", "blue"] as const).map((bg) => `<button class="swatch ${bg}" data-background="${bg}" aria-label="${bg} backdrop" aria-pressed="${state.settings.background === bg}" title="${bg}"></button>`).join("")}</div></div></div>
    <div class="inspector-footnote">${icon("spark", 20)}<p>Start with a hello.<br/><span>The rest is character.</span></p><button class="icon-button" data-action="stage-image" aria-label="Save a transparent stage image" title="Save stage image">${icon("camera", 16)}</button></div></div>
    <div id="panel-conversation" role="tabpanel" aria-labelledby="tab-conversation" hidden><div class="transcript-tools"><span class="eyebrow">THIS SESSION</span><button class="text-button" data-action="export-transcript">Export ${icon("external", 12)}</button></div><div id="transcript" aria-live="polite" aria-relevant="additions text"></div><button class="button full" data-action="new-conversation">New conversation ${icon("reset", 15)}</button></div>
  </aside></div>`;
}

export function renderTranscript() {
  const el = document.querySelector("#transcript");
  if (!el) return;
  $("#message-count").textContent = String(
    state.messages.filter((m) => m.content).length,
  );
  el.innerHTML = state.messages.length
    ? state.messages
        .map(
          (m) =>
            `<article class="transcript-message ${m.role}"><span>${m.role === "user" ? "YOU" : e(state.bootstrap!.character.name.toUpperCase())}${m.source === "screen" ? " · SCREEN CONTEXT" : ""}</span><p>${e(m.content.replace(/\[[^\]]+\]/g, "").trim()) || '<span class="thinking">Thinking…</span>'}</p></article>`,
        )
        .join("")
    : `<div class="empty-transcript">${icon("wave", 32)}<h3>A conversation starts here.</h3><p>Type a message or turn on your microphone. Your transcript stays here for this visit.</p></div>`;
  el.scrollTop = el.scrollHeight;
}

export function showPanel(name: string) {
  for (const panel of ["overview", "conversation"]) {
    $(`#panel-${panel}`).hidden = panel !== name;
    $(`#tab-${panel}`).setAttribute("aria-selected", String(panel === name));
  }
}
