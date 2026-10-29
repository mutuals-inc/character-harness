function rows(list: Element) {
  return [...list.querySelectorAll<HTMLElement>(".extension-choice")];
}

function updatePositions(list: Element) {
  rows(list).forEach((row, index) => {
    row.querySelector(".extension-position")!.textContent = String(index + 1);
    const changed = Number(row.dataset.originalPosition) !== index + 1;
    row.classList.toggle("order-changed", changed);
    row.querySelector<HTMLElement>(".extension-order-change")!.hidden =
      !changed;
    row.querySelector<HTMLButtonElement>(
      '[data-move-extension="up"]',
    )!.disabled = index === 0;
    row.querySelector<HTMLButtonElement>(
      '[data-move-extension="down"]',
    )!.disabled = index === list.children.length - 1;
  });
}

function move(row: HTMLElement, before: Element | null) {
  const list = row.parentElement!;
  const from = rows(list).indexOf(row) + 1;
  if (before === row || before === row.nextElementSibling) return;
  const previous = new Map(
    rows(list).map((item) => [item, item.getBoundingClientRect().top]),
  );
  list.insertBefore(row, before);
  updatePositions(list);
  const to = rows(list).indexOf(row) + 1;
  if (from === to) return;
  const name = row.querySelector("strong")!.textContent;
  list
    .closest(".extension-choices")!
    .querySelector(".extension-order-status")!.textContent =
    `${name} moved from position ${from} to ${to}.`;
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
    rows(list).forEach((item) => {
      const offset = previous.get(item)! - item.getBoundingClientRect().top;
      if (offset)
        item.animate(
          [
            { transform: `translateY(${offset}px)` },
            { transform: "translateY(0)" },
          ],
          { duration: 180, easing: "ease-out" },
        );
    });
}

export function moveExtension(row: HTMLElement, direction: string) {
  if (direction === "up" && row.previousElementSibling)
    move(row, row.previousElementSibling);
  if (direction === "down" && row.nextElementSibling)
    move(row, row.nextElementSibling.nextElementSibling);
}

export function installExtensionOrdering() {
  let dragged: HTMLElement | null = null;
  let target: HTMLElement | null = null;
  let after = false;
  const clearTarget = () => {
    target?.classList.remove("drop-before", "drop-after");
    target = null;
  };
  let ghost: HTMLElement | null = null;
  let start = { x: 0, y: 0, pointer: -1 };
  const finish = () => {
    dragged?.classList.remove("is-dragging");
    dragged = null;
    ghost?.remove();
    ghost = null;
    clearTarget();
  };
  document.addEventListener("pointerdown", (event) => {
    const handle = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-drag-extension]",
    );
    if (!handle || event.button !== 0 || !event.isPrimary) return;
    dragged = handle.closest<HTMLElement>(".extension-choice")!;
    start = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
    handle.setPointerCapture(event.pointerId);
  });
  document.addEventListener("pointermove", (event) => {
    if (!dragged || event.pointerId !== start.pointer) return;
    if (
      !ghost &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5
    )
      return;
    event.preventDefault();
    if (!ghost) {
      ghost = document.createElement("div");
      ghost.className = "extension-drag-preview";
      ghost.textContent = dragged.querySelector("strong")!.textContent;
      ghost.setAttribute("aria-hidden", "true");
      document.body.append(ghost);
      dragged.classList.add("is-dragging");
    }
    ghost.style.left = `${event.clientX + 12}px`;
    ghost.style.top = `${event.clientY + 12}px`;
    const row = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(".extension-choice");
    clearTarget();
    if (!row || row.parentElement !== dragged.parentElement || row === dragged)
      return;
    target = row;
    const bounds = row.getBoundingClientRect();
    after = event.clientY >= bounds.top + bounds.height / 2;
    row.classList.add(after ? "drop-after" : "drop-before");
  });
  document.addEventListener("pointerup", (event) => {
    if (!dragged || event.pointerId !== start.pointer) return;
    const row = dragged;
    if (ghost && target) move(row, after ? target.nextElementSibling : target);
    finish();
    row.querySelector<HTMLElement>("[data-drag-extension]")!.focus();
  });
  document.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dragged) finish();
    const handle = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-drag-extension]",
    );
    if (!handle || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    moveExtension(
      handle.closest<HTMLElement>(".extension-choice")!,
      event.key === "ArrowUp" ? "up" : "down",
    );
  });
}
