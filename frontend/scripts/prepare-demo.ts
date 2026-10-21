import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { Quaternion, Euler } from "three";
import {
  addAccessor,
  readGlb,
  writeGlb,
  type Glb,
} from "../../runtime/src/rig/glb.ts";
import { describeCharacter } from "../server/catalog.ts";
import { loadCharacter } from "../../runtime/src/manifest.ts";

const root = path.resolve(import.meta.dirname, "../..");
const baseDirectory = path.join(root, "characters/foxglove");
const cache = path.join(root, ".cache/studio-demo");
const characterDirectory = path.join(root, "characters/foxglove-studio");
const sampleDirectory = path.join(root, "examples/characters/studio-demo");

const boneNames: Record<string, string> = {
  hips: "J_Bip_C_Hips",
  spine: "J_Bip_C_Spine",
  chest: "J_Bip_C_Chest",
  upperChest: "J_Bip_C_UpperChest",
  neck: "J_Bip_C_Neck",
  head: "J_Bip_C_Head",
  leftEye: "J_Adj_L_FaceEye",
  rightEye: "J_Adj_R_FaceEye",
};
for (const [side, prefix] of [
  ["left", "L"],
  ["right", "R"],
]) {
  for (const part of [
    "Shoulder",
    "UpperArm",
    "LowerArm",
    "Hand",
    "UpperLeg",
    "LowerLeg",
    "Foot",
    "Toes",
  ])
    boneNames[`${side}${part}`] = `J_Bip_${prefix}_${part}`;
  for (const finger of ["Index", "Middle", "Ring", "Little"]) {
    for (const [i, segment] of ["Proximal", "Intermediate", "Distal"].entries())
      boneNames[`${side}${finger}${segment}`] =
        `J_Bip_${prefix}_${finger}${i + 1}`;
  }
  for (const [i, segment] of ["Metacarpal", "Proximal", "Distal"].entries())
    boneNames[`${side}Thumb${segment}`] = `J_Bip_${prefix}_Thumb${i + 1}`;
}

// Original choreography, sampled at 30 Hz: lift the right hand, salute, open the
// arm toward the sky, then settle. The skeleton is shared; no motion is copied.
export function createSalute(skeleton: Glb): Glb {
  const clip: Glb = {
    json: {
      asset: {
        version: "2.0",
        generator: "Mutuals comet-salute authoring example",
      },
      nodes: structuredClone(skeleton.json.nodes),
      scenes: skeleton.json.scenes,
      scene: 0,
      extensions: {
        VRMC_vrm_animation: structuredClone(
          skeleton.json.extensions!.VRMC_vrm_animation,
        ),
      },
      extensionsUsed: ["VRMC_vrm_animation"],
      animations: [{ name: "comet-salute", channels: [], samplers: [] }],
    },
    bin: Buffer.alloc(0),
  };
  const bones = (
    clip.json.extensions!.VRMC_vrm_animation as {
      humanoid: { humanBones: Record<string, { node: number }> };
    }
  ).humanoid.humanBones;
  const times = Array.from({ length: 121 }, (_, i) => i / 30);
  const time = addAccessor(clip, new Float32Array(times), "SCALAR");
  const tracks: Record<string, [number, number, number]> = {
    rightUpperArm: [-0.2, -0.3, 0.25],
    rightLowerArm: [0, -0.1, -1.95],
    rightHand: [0, 0.1, -0.2],
    upperChest: [0.03, -0.1, -0.04],
    head: [0.05, 0.12, 0.1],
    leftUpperArm: [0.04, 0, -1.05],
  };
  for (const [name, angles] of Object.entries(tracks)) {
    const node = bones[name]?.node;
    if (node === undefined) throw new Error(`Missing animation bone ${name}`);
    const values = times.flatMap((t) => {
      const enter = Math.min(1, t / 0.7),
        exit = Math.min(1, (4 - t) / 0.8);
      const weight = Math.max(0, Math.min(enter, exit));
      const ease = weight * weight * (3 - 2 * weight);
      const flourish =
        t > 1.5 && t < 2.8 ? Math.sin(((t - 1.5) / 1.3) * Math.PI) : 0;
      const z =
        name === "rightUpperArm"
          ? 1.1 + (angles[2] - 1.1 - flourish) * ease
          : name === "leftUpperArm"
            ? -1.1
            : angles[2] *
              ease *
              (name === "rightLowerArm" ? 1 - flourish * 0.8 : 1);
      return new Quaternion()
        .setFromEuler(new Euler(angles[0] * ease, angles[1] * ease, z, "XYZ"))
        .toArray();
    });
    const animation = clip.json.animations![0];
    animation.channels.push({
      sampler: animation.samplers.length,
      target: { node, path: "rotation" },
    });
    animation.samplers.push({
      input: time,
      output: addAccessor(clip, new Float32Array(values), "VEC4"),
      interpolation: "LINEAR",
    });
  }
  return clip;
}

export async function prepareDemo() {
  mkdirSync(cache, { recursive: true });
  mkdirSync(characterDirectory, { recursive: true });
  mkdirSync(sampleDirectory, { recursive: true });
  const base = loadCharacter(baseDirectory);
  const info = await describeCharacter(base);
  const model = readGlb(path.join(root, "player/assets/foxglove/foxglove.glb"));
  const humanBones = Object.fromEntries(
    Object.entries(boneNames).flatMap(([bone, name]) => {
      const node = model.json.nodes!.findIndex((n) => n.name === name);
      return node < 0 ? [] : [[bone, { node }]];
    }),
  );
  const meshes = model.json.meshes as { extras?: { targetNames?: string[] } }[];
  const expression = (weights: Record<string, number>) => ({
    morphTargetBinds: model.json.nodes!.flatMap((node, index) =>
      node.mesh === undefined
        ? []
        : Object.entries(weights).flatMap(([name, weight]) => {
            const target =
              meshes[node.mesh!]?.extras?.targetNames?.indexOf(name) ?? -1;
            return target < 0 ? [] : [{ node: index, index: target, weight }];
          }),
    ),
    overrideBlink: "none",
    overrideLookAt: "none",
    overrideMouth: "none",
    isBinary: false,
  });
  const presetNames = new Set([
    "happy",
    "angry",
    "sad",
    "relaxed",
    "surprised",
    "blink",
    "blinkLeft",
    "blinkRight",
    "aa",
    "ih",
    "ou",
    "ee",
    "oh",
    "lookUp",
    "lookDown",
    "lookLeft",
    "lookRight",
    "neutral",
  ]);
  const palettes = {
    ...info.expressions,
    relaxed: info.expressions.warm ?? {},
  };
  const preset = Object.fromEntries(
    Object.entries(palettes)
      .filter(([name]) => presetNames.has(name))
      .map(([name, weights]) => [name, expression(weights)]),
  );
  const custom = Object.fromEntries(
    Object.entries(palettes)
      .filter(([name]) => !presetNames.has(name))
      .map(([name, weights]) => [name, expression(weights)]),
  );
  model.json.extensions ??= {};
  model.json.extensions.VRMC_vrm = {
    specVersion: "1.0",
    meta: {
      name: "FoxGlove Studio",
      version: "1.0",
      authors: ["Mutuals"],
      licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
      avatarPermission: "everyone",
      commercialUsage: "corporation",
      creditNotation: "required",
      allowRedistribution: true,
      modification: "allowModificationRedistribution",
    },
    humanoid: { humanBones },
    expressions: { preset, custom },
  };
  model.json.extensionsUsed = [
    ...new Set([...(model.json.extensionsUsed ?? []), "VRMC_vrm"]),
  ];
  for (const node of model.json.nodes!)
    if (info.hiddenJoints.includes(node.name ?? "")) node.scale = [0, 0, 0];
  writeFileSync(path.join(cache, "foxglove-studio.vrm"), writeGlb(model));
  const salute = createSalute(
    readGlb(path.join(baseDirectory, "animations/wave.vrma")),
  );
  writeFileSync(
    path.join(sampleDirectory, "comet-salute.vrma"),
    writeGlb(salute),
  );
  const manifest = parse(
    readFileSync(path.join(baseDirectory, "character.yaml"), "utf8"),
  );
  manifest.id = "foxglove-studio";
  manifest.name = "FoxGlove Studio";
  manifest.description =
    "A studio rehearsal character with an original comet salute and a small extension you can switch on and off.";
  manifest.rig = {
    engine: ">=0.5.8",
    model: "../../.cache/studio-demo/foxglove-studio.vrm",
    animations: {
      idle: ["idle_breathing", "idle_listening"],
      gestures: Object.fromEntries([
        ...info.body.gestures.map((name) => [name, name]),
        [
          "comet-salute",
          "../../examples/characters/studio-demo/comet-salute.vrma",
        ],
      ]),
    },
  };
  manifest.extensions.splice(1, 0, {
    path: "../../examples/extensions/comet-cues",
    config: { phrase: "comet salute", gesture: "comet-salute" },
  });
  const director = parse(
    readFileSync(path.join(baseDirectory, "director.yaml"), "utf8"),
  );
  director.gestures.push("comet-salute");
  writeFileSync(
    path.join(characterDirectory, "director.yaml"),
    stringify(director),
  );
  writeFileSync(
    path.join(characterDirectory, "character.yaml"),
    stringify(manifest),
  );
  writeFileSync(
    path.join(characterDirectory, "system.md"),
    `${base.prompt}\n\nFor this studio rehearsal, keep replies to one short sentence unless asked otherwise.\n`,
  );
  console.log(
    "Prepared FoxGlove Studio, comet-salute.vrma and comet-cues. The original character is unchanged.",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await prepareDemo();
