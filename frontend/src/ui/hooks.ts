import { state } from "../store.ts";
import { escape as e } from "../lib/dom.ts";
import { icon } from "../lib/icons.ts";
import { toggle } from "./forms.ts";

const descriptions: Record<string, string> = {
  on_session_start: "A session opens. Prepare memories or connect a service.",
  before_reply:
    "Decide whether to reply. Runs alongside prompt building and the model.",
  before_llm: "Build the prompt. Recall memories and add useful context.",
  after_llm: "The complete reply is ready. Observe or log the response.",
  on_sentence:
    "A sentence is voiced. Stage emotions, gestures and camera moves.",
  on_speak: "Audio and word timing are ready. Synchronize the performance.",
  after_turn: "The turn closes. Store memories, metrics or rewards.",
  on_session_end: "The session closes. Consolidate memories and clean up.",
};

export function hooksView(selected = "on_sentence") {
  const { character: c, hooks } = state.bootstrap!;
  return `<div class="hooks-intro"><p>Small pieces of behavior, connected at the right moment.</p><span class="tag">${hooks.length} lifecycle hooks</span></div><div class="hooks-layout"><section class="surface hook-pipeline"><div class="surface-heading"><div><span class="eyebrow">THE LIFE OF A CONVERSATION</span><h2>Every moment has a hook.</h2></div></div><div class="hook-list" role="list">${hooks
    .map((name, i) => {
      const count = c.extensions.filter(
        (x) =>
          name in x.hooks &&
          !state.settings.disabledExtensions.includes(x.name),
      ).length;
      return `<button class="hook-step ${name === selected ? "selected" : ""}" data-hook="${e(name)}" aria-pressed="${name === selected}"><span class="step-number">${String(i + 1).padStart(2, "0")}</span><span><code>${e(name)}</code><small>${e(descriptions[name])}</small></span><span class="hook-count">${count || "—"}</span>${icon("chevron", 15)}</button>`;
    })
    .join(
      "",
    )}</div><p class="pipeline-note">${icon("hooks", 16)} <code>before_reply</code> runs in parallel with prompt building. Every other hook follows the turn lifecycle.</p></section><div class="hook-details"><section class="surface"><span class="eyebrow">SELECTED HOOK</span><h2 class="code-heading">${e(selected)}</h2><p class="hook-description">${e(descriptions[selected])}</p><div class="hook-binding-list">${
    c.extensions
      .filter((ext) => selected in ext.hooks)
      .map(
        (ext) =>
          `<div class="binding"><span class="dot"></span><strong>${e(ext.name)}</strong><span>${ext.hooks[selected].blocking ? `${ext.hooks[selected].timeout_ms} ms · blocking` : "Non-blocking"}</span></div>`,
      )
      .join("") ||
    '<p class="empty-inline">No extension is bound here. The runtime supports this hook whenever a character needs it.</p>'
  }</div></section>
    <section class="surface extensions"><div class="surface-heading"><div><span class="eyebrow">CHARACTER EXTENSIONS</span><h2>Behind the personality.</h2></div></div><p class="subtle">Switches apply to the next studio session. Shared extension files stay unchanged.</p>${c.extensions
      .map(
        (ext) =>
          `<article class="extension-card">${toggle(ext.name, `ext-${ext.name}`, !state.settings.disabledExtensions.includes(ext.name))}<code class="extension-handler">${e(ext.handler)}</code><div class="hook-tags">${Object.keys(
            ext.hooks,
          )
            .map(
              (h) =>
                `<button class="code-tag" data-hook="${e(h)}">${e(h)}</button>`,
            )
            .join(
              "",
            )}</div><details><summary>Hook settings & requirements</summary><dl>${Object.entries(
            ext.hooks,
          )
            .map(
              ([hook, opts]) =>
                `<dt><code>${e(hook)}</code></dt><dd>${opts.blocking ? `Blocking · ${opts.timeout_ms} ms timeout` : "Non-blocking · returned state is discarded"}</dd>`,
            )
            .join(
              "",
            )}</dl><p class="subtle">Requires: ${e(ext.keys.join(", ") || "No provider keys")}. Hook timing and handler configuration are defined in the extension manifest.</p></details></article>`,
      )
      .join(
        "",
      )}</section><div class="info-note">${icon("file", 18)}<p>Add behavior as an extension in the harness. The studio reads each character’s manifest, so new extensions appear here automatically after reloading.</p></div></div></div>`;
}
