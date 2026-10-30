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
    if (this.disposed || !this.settle) return;
    clearTimeout(this.timer);
    this.settle.reject(error);
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
  private tick = () => {
    if (this.disposed) return;
    const now = performance.now();
    if (now - this.lastStateAt >= 33) {
      const rect = this.container.getBoundingClientRect();
      this.send({
        t: "state",
        width: rect.width,
        height: rect.height,
        mouth: Math.min(1, output.level() * 5),
        talking: output.playing,
      });
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
