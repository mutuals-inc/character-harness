#pragma once
#include "ecs/ecs.h"
#include "lib/reflect.h"
#include "lib/typedefs.h"
#include "lib/blob_asset.h"
#include "assets/assets.h"
#include "assets/expression_asset.h"
#include "character/character.h"
#include "ecs/ecs_cloth/ecs_cloth.h"

// one cloth simulation on the character
HZ_STRUCT_TYPEDEF(AppCharacterCloth) {
  BlobAssetRef(ClothAuthoringBlobAsset) cloth;
};

// how the Over Hair pass (MTOON_OVER_HAIR in mtoon.glsl) draws this
// character's brows/lashes over the bangs: depth-tested as if `push` meters
// nearer the camera (screen position unchanged), blended at `opacity` (1 =
// their own color, lower lets the hair tint them), faded out between facing
// dot(N, V) `fade_end` (full) and `fade_start` (gone) as the head turns away.
// on the character entity
HZ_REFLECT()
ECS_COMPONENT(AppOverHairConfig) {
  f32 push;
  f32 opacity;
  f32 fade_start;
  f32 fade_end;
};

// everything that makes one character, as data: generated for an imported
// model (player_vrm.c) or written by hand. the app spawns the character from
// this, never from the scene, so swapping one is app_character_set.
HZ_STRUCT_TYPEDEF(AppCharacterProfileBlobAsset) {
  BlobAssetHeader header;
  StringBlob name; // display name (picker, logs)
  BlobAssetRef(ModelBlobAsset) model;
  // where this character's clips are: emote clip paths written under
  // APP_SHARED_CLIP_DIR are rebased here at emote load
  StringBlob clip_dir;
  BlobAssetRef(AnimationBlobAsset) idle_clip;
  BlobAssetRef(CharacterRigBlobAsset) rig;
  BlobAssetRef(CharacterFaceRigBlobAsset) face_rig;
  // shared sets by default; a character overrides one by pointing at its own
  BlobAssetRef(ExpressionSetBlobAsset) expressions;
  BlobAssetRef(EmotionSetBlobAsset) emotions;
  BlobAssetRef(CharacterStatesBlobAsset) states;
  // face-mesh submesh/material names carrying the expression material
  // channels (skin: blush/nervous, eye: sparkle/tears); substring, no case
  StringBlob face_skin_material;
  StringBlob face_eye_material;
  // liveness tuning
  GazeConfig gaze;
  BlinkConfig blink;
  MicroExpressionConfig micro;
  MoodCycleConfig mood;
  EyeLifeConfig eye_life;
  AppOverHairConfig over_hair;
  BlobArray(AppCharacterCloth) cloth;
};

// a material drawn over the hair (the MTOON_OVER_HAIR pass); the app sets the
// pass's rect at spawn
HZ_STRUCT_TYPEDEF(AppCharacterOverHair) {
  StringBlob material; // glTF material name
  vec4 uv_rect;        // xy = uv min, zw = uv max
};

// which of a model's materials draw over the hair: an optional hand-written
// <model>.overhair.hzt beside the model's source file, read at spawn
HZ_STRUCT_TYPEDEF(AppOverHairSetBlobAsset) {
  BlobAssetHeader header;
  BlobArray(AppCharacterOverHair) over_hair;
};

// on the spawned character entity: the profile it came from
HZ_REFLECT()
ECS_COMPONENT(AppCharacter) {
  HzHandleT(AppCharacterProfileBlobAsset) profile;
};

// where the stage puts the character. framed_eye_height is the rest-pose eye
// height (meters) the stage camera was authored for; a character with other
// proportions shifts the camera by the difference.
HZ_REFLECT()
ECS_COMPONENT(StageCharacterSpawn) {
  f32 framed_eye_height;
};

#define APP_CHARACTER_PATH_MAX 256
#define APP_OVER_HAIR_MAX 16 // Over Hair submesh materials per character

// the active character and a pending swap (app_character.c)
typedef struct AppCharacterSystem {
  // the spawned (or about to spawn) profile, and a requested one still loading
  HzHandleT(AppCharacterProfileBlobAsset) active;
  HzHandleT(AppCharacterProfileBlobAsset) pending;
  char active_path[APP_CHARACTER_PATH_MAX];
  char pending_path[APP_CHARACTER_PATH_MAX];
  EcsEntity entity; // 0 until spawned
  u32 spawn_count;  // bumps on every spawn; consumers compare to rebind
  EcsQuery *spawn_query;
  // every loaded emote's anim tracks point into this dir. starts as
  // APP_SHARED_CLIP_DIR; follows the active profile's clip_dir.
  char clip_dir[APP_CHARACTER_PATH_MAX];
  u32 clip_dir_len;
  // camera height shift for this character's eye height vs the stage framing
  f32 cam_offset_y;
  b32 cam_offset_ready;
  // the spawned model's Over Hair set (0: none), its materials once
  // resolved, and the config last pushed to them
  HzHandleT(AppOverHairSetBlobAsset) over_hair_set;
  b32 over_hair_ready;
  u32 over_hair_count;
  HzHandle over_hair_mats[APP_OVER_HAIR_MAX];
  AppOverHairConfig over_hair_pushed;
} AppCharacterSystem;
