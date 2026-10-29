import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Clock,
  DirectionalLight,
  Group,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  VRMLoaderPlugin,
  VRMMetaLoaderPlugin,
  VRMUtils,
  type VRM,
} from "@pixiv/three-vrm";
import type { CharacterInfo, WireMessage } from "../types.ts";
import { CharacterAnimation } from "./animation.ts";
import { CharacterFace } from "./expressions.ts";
import { output } from "../session.ts";
import { state, record } from "../store.ts";
import { $, toast } from "../lib/dom.ts";

export class CharacterStage {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(31, 1, 0.01, 100);
  private controls: OrbitControls;
  private model: Group | null = null;
  private animation: CharacterAnimation | null = null;
  private face: CharacterFace | null = null;
  private vrm: VRM | undefined;
  private clock = new Clock();
  private time = 0;
  private frame = 0;
  private observer: ResizeObserver;
  private center = new Vector3(0, 1.25, 0);
  private height = 1.8;
  private generation = 0;
  private container: HTMLElement;
  private targetDistance = 2.8;
  private cameraTween = false;
  private hiddenJoints: Object3D[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D character. Drag to rotate; scroll to zoom.",
    );
    this.renderer.domElement.setAttribute("role", "img");
    container.append(this.renderer.domElement);
    this.scene.add(new AmbientLight(0xffffff, 0.8));
    const key = new DirectionalLight(0xfff8ee, 2.0);
    key.position.set(1.5, 3, 4);
    this.scene.add(key);
    const fill = new DirectionalLight(0xd6e8ff, 0.6);
    fill.position.set(-2, 2, -2);
    this.scene.add(fill);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.7;
    this.controls.maxDistance = 5;
    this.controls.minPolarAngle = Math.PI * 0.25;
    this.controls.maxPolarAngle = Math.PI * 0.65;
    this.controls.addEventListener("start", () => {
      this.cameraTween = false;
    });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    document.addEventListener("stage-cue", this.onCue);
    this.draw();
  }

  async load(character: CharacterInfo) {
    const generation = ++this.generation;
    this.enableControls(false);
    $("#stage-loading").hidden = false;
    $("#stage-loading").textContent = "Getting the stage ready…";
    this.clearModel();
    try {
      const loader = new GLTFLoader();
      loader.register(
        (parser) =>
          new VRMLoaderPlugin(parser, {
            metaPlugin: new VRMMetaLoaderPlugin(parser, {
              acceptLicenseUrls: [
                "https://vrm.dev/licenses/1.0/",
                "https://www.apache.org/licenses/LICENSE-2.0",
              ],
            }),
          }),
      );
      const gltf = await loader.loadAsync(
        `/api/model?character=${encodeURIComponent(character.id)}&revision=${character.revision}`,
      );
      if (generation !== this.generation) {
        this.disposeObject(gltf.scene);
        return;
      }
      this.model = gltf.scene;
      this.vrm = gltf.userData.vrm as VRM | undefined;
      if (this.vrm) VRMUtils.rotateVRM0(this.vrm);
      // The harness prepares clips against the model's raw skeleton. Copying the
      // untouched normalized skeleton back each frame would overwrite those poses.
      if (this.vrm) this.vrm.humanoid.autoUpdateHumanBones = false;
      // Imported tangents can disagree with MToon's shader varyings. Its derivative
      // tangent frame retains the normal map without depending on that attribute.
      gltf.scene.traverse((object) => {
        if (object instanceof Mesh) object.geometry.deleteAttribute("tangent");
      });
      this.hiddenJoints = character.hiddenJoints
        .map((name) => gltf.scene.getObjectByName(name))
        .filter((joint): joint is Object3D => Boolean(joint));
      this.hiddenJoints.forEach((joint) => joint.scale.setScalar(0));
      gltf.scene.updateMatrixWorld(true);
      this.scene.add(gltf.scene);
      const bounds = new Box3().setFromObject(gltf.scene);
      this.height = bounds.max.y - bounds.min.y;
      this.center.set(
        (bounds.max.x + bounds.min.x) / 2,
        bounds.min.y + this.height * 0.78,
        0,
      );
      this.animation = new CharacterAnimation(
        gltf.scene,
        gltf.animations,
        gltf.userData.mutualsHarness,
      );
      this.face = new CharacterFace(
        gltf.scene,
        character.expressions,
        this.vrm,
      );
      this.frameCamera("portrait", true);
      $("#stage-loading").hidden = true;
      this.enableControls(true);
      record(
        "stage",
        "Character loaded",
        `${gltf.animations.length} animation clips · embedded browser renderer`,
      );
    } catch (error) {
      console.error("Character model loading failed", error);
      $("#stage-loading").textContent =
        "The model could not load. Check the character’s rig and reload.";
      toast("Could not load the character model.", true);
      record("error", "Model failed to load");
    }
  }

  private onCue = (event: Event) => {
    const cue = (event as CustomEvent<WireMessage>).detail;
    if (cue.emotion) this.emotion(cue.emotion);
    if (cue.gesture && cue.gesture !== "none") this.gesture(cue.gesture);
    if (cue.talk && cue.talk !== "regular" && cue.talk !== "none")
      this.animation?.play(`talk:${cue.talk}`, true);
    if (cue.camera && cue.camera !== "hold") this.frameCamera(cue.camera);
  };

  private enableControls(enabled: boolean) {
    document
      .querySelectorAll<HTMLButtonElement | HTMLSelectElement>("[data-gesture]")
      .forEach((control) => {
        control.disabled = !enabled;
      });
  }

  emotion(name: string) {
    this.face?.set(name);
  }
  gesture(name: string) {
    if (!this.animation?.play(name))
      toast(`“${name}” has no animation clip in this rig.`, true);
    else record("preview", `Preview: ${name}`);
  }
  frameCamera(name: string, immediate = false) {
    const factors: Record<string, number> = {
      portrait: 1.05,
      "push-in": 0.9,
      "close-up": 0.75,
      "pull-back": 2.1,
      wide: 2.1,
    };
    const distance = this.height * (factors[name] ?? factors.portrait);
    this.controls.target.copy(this.center);
    if (name === "close-up") this.controls.target.y = this.height * 0.86;
    if (name === "wide" || name === "pull-back")
      this.controls.target.y = this.height * 0.51;
    this.targetDistance = distance;
    if (immediate || matchMedia("(prefers-reduced-motion: reduce)").matches)
      this.camera.position.set(this.center.x, this.controls.target.y, distance);
    else this.cameraTween = true;
    this.controls.update();
  }
  reset() {
    this.animation?.reset();
    this.emotion("neutral");
    this.frameCamera("portrait", true);
  }
  async screenshot() {
    this.renderer.render(this.scene, this.camera);
    const link = document.createElement("a");
    link.download = `${state.bootstrap!.character.id}-stage.png`;
    link.href = this.renderer.domElement.toDataURL("image/png");
    link.click();
  }
  private resize() {
    const { width, height } = this.container.getBoundingClientRect();
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
  private draw = () => {
    this.frame = requestAnimationFrame(this.draw);
    const delta = Math.min(this.clock.getDelta(), 0.05);
    if (document.hidden || this.container.offsetParent === null) return;
    if (!state.settings.paused) {
      this.time += delta;
      this.animation?.update(delta);
      this.hiddenJoints.forEach((joint) => joint.scale.setScalar(0));
      this.face?.update(delta, this.time, Math.min(0.9, output.level() * 5));
      this.vrm?.update(delta);
    }
    if (this.cameraTween) {
      const direction = this.camera.position
        .clone()
        .sub(this.controls.target)
        .normalize();
      const target = direction
        .multiplyScalar(this.targetDistance)
        .add(this.controls.target);
      this.camera.position.lerp(target, Math.min(1, delta * 4));
      if (this.camera.position.distanceTo(target) < 0.005)
        this.cameraTween = false;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
  private disposeObject(model: Group) {
    model.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          for (const value of Object.values(material))
            if (value instanceof Texture) value.dispose();
          material.dispose();
        }
      }
    });
  }
  private clearModel() {
    this.animation?.dispose();
    this.animation = null;
    this.face = null;
    this.vrm = undefined;
    this.hiddenJoints = [];
    if (this.model) {
      this.scene.remove(this.model);
      this.disposeObject(this.model);
      this.model = null;
    }
  }
  dispose() {
    this.generation++;
    cancelAnimationFrame(this.frame);
    this.clearModel();
    this.observer.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    document.removeEventListener("stage-cue", this.onCue);
  }
}
