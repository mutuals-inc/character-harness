import { Mesh, type Object3D } from "three";
import type { VRM } from "@pixiv/three-vrm";

export class CharacterFace {
  private meshes: Mesh[] = [];
  private palette: Record<string, Record<string, number>>;
  private owned: Set<string>;
  private vrm?: VRM;
  private emotion = "neutral";
  private amount = 0;

  constructor(
    model: Object3D,
    palette: Record<string, Record<string, number>>,
    vrm?: VRM,
  ) {
    this.palette = palette;
    this.vrm = vrm;
    this.owned = new Set(
      Object.values(palette).flatMap((expression) => Object.keys(expression)),
    );
    model.traverse((object) => {
      if (object instanceof Mesh && object.morphTargetDictionary)
        this.meshes.push(object);
    });
  }

  set(name: string) {
    this.emotion = name;
    this.amount = 0;
  }

  update(delta: number, time: number, mouth: number) {
    this.amount = Math.min(1, this.amount + delta * 4);
    const phase = time % 4.1;
    const blink = phase < 0.22 ? Math.sin((phase / 0.22) * Math.PI) : 0;
    if (this.vrm?.expressionManager) {
      const manager = this.vrm.expressionManager;
      const name = manager.getExpression(this.emotion)
        ? this.emotion
        : ((
            {
              warm: "relaxed",
              playful: "happy",
              thoughtful: "relaxed",
              confident: "happy",
              shy: "relaxed",
              grumpy: "angry",
              sympathetic: "sad",
              dreamy: "relaxed",
            } as Record<string, string>
          )[this.emotion] ?? this.emotion);
      manager.resetValues();
      manager.setValue(name, 0.65 * this.amount);
      manager.setValue("blink", blink);
      manager.setValue("aa", mouth);
      return;
    }
    const weights = { ...(this.palette[this.emotion] ?? {}) };
    for (const [name, value] of Object.entries(this.palette.blink ?? {}))
      weights[name] = value * blink;
    for (const [name, value] of Object.entries(this.palette.aa ?? {}))
      weights[name] = value * mouth;
    for (const mesh of this.meshes) {
      for (const name of this.owned) {
        const index = mesh.morphTargetDictionary?.[name];
        if (index !== undefined && mesh.morphTargetInfluences)
          mesh.morphTargetInfluences[index] =
            (weights[name] ?? 0) * this.amount;
      }
    }
  }
}
