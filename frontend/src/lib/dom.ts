export const $ = <T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T => {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};
export const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function toast(message: string, error = false) {
  const el = $("#toast");
  (document.querySelector("dialog[open]") ?? document.body).append(el);
  el.textContent = message;
  el.className = error ? "visible error" : "visible";
  clearTimeout(timer);
  timer = setTimeout(() => (el.className = ""), 5000);
}
let timer: ReturnType<typeof setTimeout>;
export async function request<T>(url: string, data?: object): Promise<T> {
  const response = await fetch(
    url,
    data
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }
      : {},
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "The request failed.");
  return result as T;
}
export function download(
  name: string,
  content: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
