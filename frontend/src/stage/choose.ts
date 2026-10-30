// Which renderer the Studio stage uses. Electron's native player comes first;
// in a browser the Kaigen web player is used when the server has it for this
// character and the browser has WebGPU, and three.js otherwise. `?stage=three`
// or `?stage=wasm` in the page URL forces one; a forced web player shows its
// error instead of falling back.
export type StageKind = "native" | "web-player" | "three";

export function chooseStage(options: {
  native: boolean;
  webPlayer: string | null;
  webgpu: boolean;
  override: string | null;
}): { kind: StageKind; forced: boolean } {
  if (options.native) return { kind: "native", forced: false };
  if (options.override === "three") return { kind: "three", forced: true };
  if (options.override === "wasm" && options.webPlayer)
    return { kind: "web-player", forced: true };
  if (options.webPlayer && options.webgpu)
    return { kind: "web-player", forced: false };
  return { kind: "three", forced: false };
}
