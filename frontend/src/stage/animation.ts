import {
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  type AnimationAction,
  type AnimationClip,
  type Object3D,
} from "three";

export class CharacterAnimation {
  private mixer: AnimationMixer;
  private clips: Map<string, AnimationClip>;
  private current: AnimationAction | null = null;
  private idle: string;
  private model: Object3D;
  private holds = new Set<string>();
  private holding = false;

  constructor(
    model: Object3D,
    clips: AnimationClip[],
    metadata?: {
      idle?: number[];
      gestures?: Record<string, { clip: number; hold?: boolean }>;
      talk?: Record<string, number[]>;
    },
  ) {
    this.model = model;
    this.mixer = new AnimationMixer(model);
    this.clips = new Map(clips.map((clip) => [clip.name, clip]));
    this.idle =
      clips[metadata?.idle?.[0] ?? -1]?.name ??
      clips.find((c) => /idle.*breath|idle/i.test(c.name))?.name ??
      "";
    for (const [name, entry] of Object.entries(metadata?.gestures ?? {})) {
      if (clips[entry.clip]) this.clips.set(name, clips[entry.clip]);
      if (entry.hold) this.holds.add(name);
    }
    for (const [name, indices] of Object.entries(metadata?.talk ?? {}))
      if (clips[indices[0]]) this.clips.set(`talk:${name}`, clips[indices[0]]);
    this.mixer.addEventListener("finished", () => {
      if (!this.holding) this.play(this.idle, true);
    });
    this.play(this.idle, true);
  }

  play(name: string, loop = false): boolean {
    const clip = this.clips.get(name);
    if (!clip) return false;
    const action = this.mixer.clipAction(clip);
    if (action === this.current && loop) return true;
    const previous = this.current;
    action.reset().setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = this.holds.has(name);
    this.holding = action.clampWhenFinished;
    if (previous && previous !== action) {
      previous.fadeOut(0.25);
      action.fadeIn(0.25);
    }
    action.play();
    this.current = action;
    return true;
  }

  reset() {
    this.play(this.idle, true);
  }
  update(delta: number) {
    this.mixer.update(delta);
  }
  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
  }
}
