# FoxGlove

The reference character: her manifest, personality and director are here, and her body and face are a profile in the player (`player/assets/characters/foxglove.hzt`, with her model and rig in `player/assets/foxglove/`). Her face, emotions, lip sync and hair and cloth physics work.

Her animations are in `animations/`, as VRM Animation (`.vrma`) files that fit any VRM: two idle loops, four idle breaks and seven gestures (wave, nod, cheer, hands on hips, a hand on the waist, surprise, a sheepish hand behind the head), posed by hand. She has no talking loops yet, so while she talks her body stays in its idle loop and the gestures carry the beats. They are baked into her model (`player/assets/foxglove/foxglove.glb`) and played through `player/assets/foxglove/states.hzt`, `emotes/` and `player/assets/mutuals/gestures.hzt`.

Files: `character.yaml`, `system.md`, `director.yaml`, `animations/`.

FoxGlove is Mutuals' own character. Her model, textures and animations are under the repository's Apache License 2.0, like the code.
