import { $ } from "../lib/dom.ts";

let previousOverflow = "";

export function expandStage(expanded?: boolean) {
  const stage = $("#character-stage");
  const next = expanded ?? !stage.classList.contains("expanded");
  if (next === stage.classList.contains("expanded")) return;
  stage.classList.toggle("expanded", next);
  const button = stage.querySelector<HTMLButtonElement>(
    '[data-action="fullscreen"]',
  )!;
  button.setAttribute("aria-expanded", String(next));
  button.setAttribute(
    "aria-label",
    next ? "Restore character stage" : "Expand character stage",
  );
  button.title = next ? "Restore stage (Esc)" : "Expand stage";
  if (next) previousOverflow = document.body.style.overflow;
  document.body.style.overflow = next ? "hidden" : previousOverflow;
  button.focus();
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.querySelector(".stage.expanded"))
    expandStage(false);
});
