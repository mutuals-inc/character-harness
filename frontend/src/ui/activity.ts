import { state } from "../store.ts";
import { $, escape as e } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";

export function activityView() {
  return `<section class="surface activity-surface"><div class="surface-heading"><div><span class="eyebrow">A LOOK UNDER THE HOOD</span><h2>See the character come to life.</h2><p>Real session events, extension timings and animation cues.</p></div><div class="toolbar"><button class="button" data-action="export-activity">Export ${icon("external", 15)}</button><button class="button" data-action="clear-activity">Clear</button></div></div><div class="activity-toolbar"><label for="activity-filter">Show</label><select id="activity-filter"><option value="all">All events</option><option value="hook">Hooks</option><option value="animation">Animation cues</option><option value="preview">Preview actions</option><option value="input">Input</option><option value="error">Errors</option></select><span class="subtle" id="event-total"></span></div><div id="activity-events" aria-live="polite"></div></section>`;
}

export function renderActivity() {
  $("#activity-count").textContent = String(state.activity.length);
  const target = document.querySelector("#activity-events");
  if (!target) return;
  const filter = $<HTMLSelectElement>("#activity-filter").value;
  const events = state.activity.filter(
    (event) => filter === "all" || event.kind === filter,
  );
  $("#event-total").textContent = `${events.length} events · this visit`;
  target.innerHTML = events.length
    ? `<div class="event-table"><div class="event-table-header"><span>TIME</span><span>EVENT</span><span>DETAIL</span></div>${events.map((event) => `<div class="event-row ${e(event.kind)}"><time>${new Date(event.time).toLocaleTimeString([], { hour12: false })}</time><span><i class="dot"></i>${e(event.title)}</span><span>${e(event.detail)}</span></div>`).join("")}</div>`
    : `<div class="empty-state">${icon("activity", 38)}<h3>Nothing happening just yet.</h3><p>Start a session or preview a gesture. Events will appear here as they happen.</p><button class="button" data-view="studio">Back to the studio ${icon("arrow", 15)}</button></div>`;
}
