# Bring your own character

Any VRM model (0.x or 1.0) can be a character's body.

1. Make a folder `characters/<id>/` with a `character.yaml` (see `character-manifest.md`), a `system.md` for the personality, and your model.
2. Point `rig.model` at the model and list its animations:

   ```yaml
   rig:
     engine: ">=0.5.8"
     model: model.vrm
     animations:
       idle: idle.vrma
       talk: { regular: talk.vrma }
       gestures: { wave: wave.vrma }
   ```

3. To have the character move and react while it talks, add the extensions and a `director.yaml` with your character's words (copy `characters/foxglove/director.yaml` and keep only the gestures and talking styles your character has, which `npm run check` warns about; the keys are in `extensions.md`):

   ```yaml
   extensions:
     - path: ../../extensions/emotion-tags
       config_file: director.yaml
     - path: ../../extensions/director
       config_file: director.yaml
   ```

   Without them it still talks, in its idle and `regular` talking loops, with no gestures.
4. Run `npm run check -- characters/<id>` to check it without starting anything: the manifest, the keys, the model (prepared as the player will show it) and the words the director may pick against what the character has. It needs no keys or player, and prints every problem at once.
5. Run `npm start -- characters/<id>`. It runs the same checks first and stops on an error. With `HARNESS_PLAYER` in `.env`, the player opens too.

## The body

List the character's animations under `rig.animations` in `character.yaml`: an idle loop, talking loops per style, and gestures. Without them the model stands in its rest pose.

- **`.vrma` files (VRM Animation).** The runtime retargets each one onto your model's skeleton when it starts, through VRM's standard humanoid bones, so a clip made for any VRM fits yours. Make them in Blender (with the VRM add-on) or a motion capture tool, or start from FoxGlove's, in `characters/foxglove/animations/`, which fit any VRM.
- **Clips inside your model.** If your model file already has animations made for it, name them instead of a file: `idle: Breathing`.

The result is cached in `.cache/characters/<id>/` and rebuilt only when the model or a clip changes. On the way, the runtime rewrites what the player can't load as it is: a model with several skins (common in VRMs exported from Unity) gets them merged into one, and a VRM 0.x model is turned to face forward and its MToon materials converted to VRM 1.0's.

Gestures and talking styles are what the director picks between. List the same names in the director's `gestures` and `registers` (`director.yaml`), or it will pick ones your character doesn't have.

## Hair and cloth

Hair, skirts and anything else your model's VRM spring bones describe swing as the character moves. The runtime reads them from the model (VRM 1.0 or 0.x) and the player simulates them with its own cloth, mapping each spring's stiffness, gravity, drag and hit radius, and its colliders, onto it. The two simulations differ, so a spring can come out a little stiffer or looser than in other VRM apps; at most 24 chains per model are simulated, and any more are left out. To keep a model's springs still, set `springs: false` under `rig`; worth trying if something about the model looks wrong only once they swing.

## The face

The player builds the face from the model's own VRM expressions: happy, angry, sad, relaxed, surprised, blinking, and the five vowel mouth shapes for lip sync. The harness's emotions (warm, playful, thoughtful...) are mixed from those.

## Not yet

- A VRM 0.x model whose joint or triangle data is stored sparse (rare; sparse morph targets are fine) isn't turned, so it faces away from the camera.
- Expressions in `.vrma` files are ignored. The face follows the conversation.
