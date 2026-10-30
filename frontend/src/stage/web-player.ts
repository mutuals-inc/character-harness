import { $ } from "../lib/dom.ts";
import { output } from "../session.ts";
import { record } from "../store.ts";
import type { WireMessage } from "../types.ts";

// how long the web player has to download, start and connect back
const START_TIMEOUT_MS = 60000;

// The Kaigen web player in an iframe of its own, cross-origin isolated by the
// server. It gets the same state and cue messages the desktop app sends the
// native player, through the server's /web-stage relay, and draws into its
// own canvas.
export class WebPlayerStage {
  private container: HTMLElement;
  private frame = 0;
  private disposed = false;
  private lastStateAt = 0;
  private id = crypto.randomUUID();
  private socket: WebSocket;
  private iframe = document.createElement("iframe");
  private settle: { resolve(): void; reject(error: Error): void } | null = null;
  private timer = 0;
  private failed = false;
  private sentState = "";
  // called when the player stops after it has started
  onfail: ((error: Error) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.socket = new WebSocket(
      `ws://${location.host}/web-stage?role=page&id=${this.id}`,
    );
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as { t?: string };
      if (message.t === "player") this.started();
    });
    this.socket.addEventListener("close", () =>
      this.fail(new Error("The web player link closed.")),
    );
    this.iframe.title = "Kaigen character renderer";
    this.iframe.setAttribute("allow", "microphone 'none'; camera 'none'");
    this.iframe.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;background:transparent";
    container.replaceChildren(this.iframe);
    container.dataset.renderer = "web-player";
    // its canvas is opaque, with Kaigen's own stage behind her
    container.closest(".stage")?.classList.add("web-player-stage");
    container.setAttribute("role", "img");
    container.setAttribute("aria-label", "Kaigen web character renderer");
    addEventListener("message", this.onMessage);
    document.addEventListener("stage-cue", this.onCue);
  }

  // resolves once the player has started and connected back; rejects with
  // the reason it can't run here
  load(profile: string): Promise<void> {
    $("#stage-loading").hidden = false;
    $("#stage-loading").textContent = "Starting the Kaigen web player…";
    return new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
      this.timer = window.setTimeout(
        () => this.fail(new Error("The web player did not start in time.")),
        START_TIMEOUT_MS,
      );
      const open = () => {
        const settings = new URLSearchParams({
          HARNESS_CHARACTER: profile,
          HARNESS_STUDIO_URL: `/web-stage?role=player&id=${this.id}`,
        });
        this.iframe.src = `/web-player/?${settings}`;
        this.tick();
      };
      if (this.socket.readyState === WebSocket.OPEN) open();
      else this.socket.addEventListener("open", open, { once: true });
    });
  }

  gesture(name: string) {
    this.send({ t: "cue", gesture: name });
    record("preview", `Preview: ${name}`);
  }

  private started() {
    if (!this.settle) return;
    clearTimeout(this.timer);
    $("#stage-loading").hidden = true;
    record("stage", "Character loaded", "Kaigen web player");
    this.settle.resolve();
    this.settle = null;
  }
  private fail(error: Error) {
    if (this.disposed || this.failed) return;
    this.failed = true;
    clearTimeout(this.timer);
    if (this.settle) this.settle.reject(error);
    else this.onfail?.(error);
    this.settle = null;
  }
  private onMessage = (event: MessageEvent) => {
    const data = event.data as { t?: string; error?: string };
    if (event.source !== this.iframe.contentWindow || event.origin !== location.origin) return;
    if (data?.t === "web-player" && data.error) this.fail(new Error(data.error));
  };
  private onCue = (event: Event) => {
    const cue = (event as CustomEvent<WireMessage>).detail;
    this.send({ t: "cue", emotion: cue.emotion, gesture: cue.gesture, camera: cue.camera, talk: cue.talk });
  };
  private send(message: object) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  // the mouth and talking state, when they change and at least every 0.2 s:
  // the player lets them go after 0.5 s without one. It draws at its canvas's
  // size, so the size the desktop app sends isn't needed
  private tick = () => {
    if (this.disposed) return;
    const now = performance.now();
    const state = JSON.stringify({
      t: "state",
      mouth: Math.round(Math.min(1, output.level() * 5) * 100) / 100,
      talking: output.playing,
    });
    if (
      now - this.lastStateAt >= 33 &&
      (state !== this.sentState || now - this.lastStateAt >= 200)
    ) {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(state);
      this.sentState = state;
      this.lastStateAt = now;
    }
    this.frame = requestAnimationFrame(this.tick);
  };
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    removeEventListener("message", this.onMessage);
    document.removeEventListener("stage-cue", this.onCue);
    this.socket.close();
    this.iframe.remove();
    delete this.container.dataset.renderer;
    this.container.closest(".stage")?.classList.remove("web-player-stage");
    this.container.removeAttribute("role");
    this.container.removeAttribute("aria-label");
  }
}
