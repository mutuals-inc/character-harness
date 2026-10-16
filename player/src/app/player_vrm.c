// Runtime VRM import: the player imports a model with the engine's glTF
// importer on first load and caches what it writes:
//
//   cooked/vrm/<name>/<name>.hza           the model
//   cooked/vrm/<name>/materials/, textures/ its materials and textures (+ .ktx)
//   cooked/vrm/<name>/clips/               its animation clips
//   cooked/vrm/<name>/emotes/, states.hza, gestures.hza
//                                          how those clips play: idle, talking
//                                          styles and gestures
//   cooked/vrm/<name>/expressions.hza, face_rig.hza
//                                          its face, from its VRM expressions
//   cooked/vrm/<name>/cloth/               its spring bones (hair, skirts) as
//                                          bone cloth, from the harness table
//   cooked/vrm/<name>/<name>_profile.hza   the character profile tying it up
//   cooked/vrm/<name>/encode/              the image encoder's intermediates
//   cooked/vrm/<name>/source.stamp         size + mtime of the file cached, and
//                                          what the import produced
//
// Two importer calls are used: asset_import_glb_v2 returns the model,
// material, texture and animation assets without their file headers, which
// player_vrm_seal fills in, and asset_import_glb encodes the images to the
// GPU formats.
//
// Face: built from the model's own VRM expressions (happy, sad, blink, the
// vowels...), with the richer emotions (assets/mutuals/emotions.hzt) mixed
// from those.
//
// Body: the harness runtime bakes a character's animations into the file and
// lists them in the root extras (`mutualsHarness`: which clip is idle, which
// talking style, which gesture; runtime/src/rig/prepare.ts). Without that
// table the character holds its bind pose.

#include "app/player_vrm.h"
#include "app/player_json.h"
#include "animation/animation.h"
#include "assets/asset_importer.h"
#include "assets/asset_cook_utils.h"
#include "ecs/ecs_cloth/ecs_cloth.h"
#include "rendering/mesh.h"
#include "rendering/material.h"
#include "lib/hztext.h"
#include "lib/reflect.h"
#include "lib/string.h"
#include "lib/string_builder.h"
#include "os/os.h"

// bump to invalidate every cached import when what we write changes
#define PLAYER_VRM_CACHE_VERSION 8
// longest file name (without extension) imported; keeps every cache path
// within PLAYER_VRM_PATH_MAX
#define PLAYER_VRM_MAX_STEM 100
// image formats the encoder writes; the renderer picks one per platform
hz_global const char *player_vrm_ktx_variants[] = {"bc1", "bc3", "bc4", "bc5",
                                                   "bc7", "astc", "etc2", "eac"};
// shared assets every imported character uses
#define PLAYER_VRM_EMOTIONS "mutuals/emotions.hza"
#define PLAYER_VRM_LIPSYNC "mutuals/lipsync_profile.hzt"

// liveness tuning, shared by every imported character; the face and body fields
// are filled per model
#define PLAYER_VRM_PROFILE_LIVENESS                                            \
  "gaze\n"                                                                     \
  "  eye_range_deg 11.25\n  saccade_interval_min 1\n  saccade_interval_max 3\n"\
  "  microsaccade_deg 0.5\n  aversion_chance 0.2\n  aversion_yaw_deg 8\n"      \
  "  aversion_pitch_deg 5\n  head_follow 0.25\n  head_damp_time 0.25\n"       \
  "  yaw_sign 1\n  pitch_sign 1\n  eye_contact 0.35\n"                         \
  "  eye_contact_talking 0.85\n  head_follow_talking 0.5\n"                    \
  "  eye_contact_max_deg 35\n  aversion_chance_talking 0.15\n  eye_lead 0.2\n" \
  "  eye_target 0 0 0\n"                                                       \
  "blink\n"                                                                    \
  "  blinks_per_minute 14\n  rate_variation 0.49\n  close_time 0.08\n"         \
  "  hold_time 0.02\n  reopen_time 0.18\n  double_blink_chance 0.1\n"          \
  "  half_blink_chance 0.12\n  half_blink_amount 0.6\n"                        \
  "micro\n"                                                                    \
  "  interval_min 4\n  interval_max 8\n  amplitude 0.5\n  rise_time 0.5\n"     \
  "  hold_time 1.2\n  fall_time 0.8\n"                                         \
  "mood\n"                                                                     \
  "  interval_min 8\n  interval_max 16\n  transition 1.5\n"                    \
  "eye_life\n"                                                                 \
  "  move_every_min 2\n  move_every_max 4\n  move_amount 0.172222\n"           \
  "  transition_time 0.4\n  hold_min 1.5\n  hold_max 4\n  widen_chance 0.3\n"  \
  "  gaze_follow 0.4\n  speech_squint 0.2\n"                                   \
  "over_hair\n"                                                                \
  "  push 0.07\n  opacity 1\n  fade_start 0.15\n  fade_end 0.45\n"

// ---------------------------------------------------------------------------
// face: VRM expressions -> the engine's expression set and face rig
// ---------------------------------------------------------------------------

// the VRM 1.0 preset expressions, in the order PlayerVrmFace keeps them
typedef enum {
  VRM_AA, VRM_IH, VRM_OU, VRM_EE, VRM_OH,
  VRM_BLINK, VRM_BLINK_LEFT, VRM_BLINK_RIGHT,
  VRM_HAPPY, VRM_ANGRY, VRM_SAD, VRM_RELAXED, VRM_SURPRISED,
  VRM_LOOK_UP, VRM_LOOK_DOWN, VRM_LOOK_LEFT, VRM_LOOK_RIGHT, VRM_NEUTRAL,
  VRM_PRESET_COUNT,
} PlayerVrmPreset;

// VRM 1.0 name, then the VRM 0.x name of the same preset
hz_global const char *player_vrm_preset_names[VRM_PRESET_COUNT][2] = {
    {"aa", "a"},           {"ih", "i"},          {"ou", "u"},
    {"ee", "e"},           {"oh", "o"},          {"blink", "blink"},
    {"blinkLeft", "blink_l"}, {"blinkRight", "blink_r"}, {"happy", "joy"},
    {"angry", "angry"},    {"sad", "sorrow"},    {"relaxed", "fun"},
    {"surprised", "surprised"}, {"lookUp", "lookup"}, {"lookDown", "lookdown"},
    {"lookLeft", "lookleft"}, {"lookRight", "lookright"}, {"neutral", "neutral"},
};

#define PLAYER_VRM_MAX_BINDS 8
// a morph target index past this is malformed
#define PLAYER_VRM_MAX_INDEX 65536

typedef struct {
  const char *morph;
  f32 weight; // 0..1
} PlayerVrmBind;

typedef struct {
  PlayerVrmBind binds[VRM_PRESET_COUNT][PLAYER_VRM_MAX_BINDS];
  u32 count[VRM_PRESET_COUNT];
  u32 presets; // presets with at least one bind
} PlayerVrmFace;

// Every expression the emotions (emotions.hzt), liveness and lip sync ask for by name,
// mixed from the VRM presets. A model with richer expressions than the presets
// is not reached; this is the common ground every VRM has.
typedef struct {
  const char *name;
  const char *tag;
  PlayerVrmPreset preset[3];
  f32 weight[3]; // 0 ends the list
} PlayerVrmExpression;

hz_global const PlayerVrmExpression player_vrm_expressions[] = {
    {"aa", "viseme", {VRM_AA}, {1}},
    {"ih", "viseme", {VRM_IH}, {1}},
    {"ou", "viseme", {VRM_OU}, {1}},
    {"ee", "viseme", {VRM_EE}, {1}},
    {"oh", "viseme", {VRM_OH}, {1}},
    {"blink", "blink", {VRM_BLINK}, {1}},
    {"blinkLeft", "blink", {VRM_BLINK_LEFT}, {1}},
    {"blinkRight", "blink", {VRM_BLINK_RIGHT}, {1}},
    {"lookUp", "lookat", {VRM_LOOK_UP}, {1}},
    {"lookDown", "lookat", {VRM_LOOK_DOWN}, {1}},
    {"lookLeft", "lookat", {VRM_LOOK_LEFT}, {1}},
    {"lookRight", "lookat", {VRM_LOOK_RIGHT}, {1}},
    {"neutral", "mood", {VRM_NEUTRAL}, {1}},
    {"relaxed", "mood", {VRM_RELAXED}, {1}},
    {"content", "mood", {VRM_RELAXED}, {0.5f}},
    {"happy", "emotion", {VRM_HAPPY}, {1}},
    {"angry", "emotion", {VRM_ANGRY}, {1}},
    {"sad", "emotion", {VRM_SAD}, {1}},
    {"surprised", "emotion", {VRM_SURPRISED}, {1}},
    {"warm", "emotion", {VRM_HAPPY, VRM_RELAXED}, {0.4f, 0.4f}},
    {"playful", "emotion", {VRM_HAPPY}, {0.7f}},
    {"thoughtful", "emotion", {VRM_SAD, VRM_RELAXED}, {0.15f, 0.2f}},
    {"confident", "emotion", {VRM_HAPPY, VRM_ANGRY}, {0.3f, 0.15f}},
    {"dreamy", "emotion", {VRM_RELAXED}, {0.9f}},
    {"sympathetic", "emotion", {VRM_SAD}, {0.55f}},
    {"fuming", "emotion", {VRM_ANGRY}, {0.8f}},
    {"irked", "emotion", {VRM_ANGRY}, {0.6f}},
    {"tearful", "emotion", {VRM_SAD}, {1}},
    {"starstruck", "emotion", {VRM_HAPPY, VRM_SURPRISED}, {0.8f, 0.3f}},
    {"dazzled", "emotion", {VRM_HAPPY, VRM_SURPRISED}, {0.9f, 0.4f}},
    {"pleading", "emotion", {VRM_SAD, VRM_SURPRISED}, {0.6f, 0.2f}},
    {"bashful", "emotion", {VRM_HAPPY}, {0.7f}},
    {"micro_brow_raise", "micro", {VRM_SURPRISED}, {0.3f}},
    {"micro_curiosity", "micro", {VRM_SURPRISED}, {0.2f}},
    {"micro_smile", "micro", {VRM_HAPPY}, {0.25f}},
    {"micro_mouth_shift", "micro", {VRM_RELAXED}, {0.2f}},
};

// the lip sync keys and the preset each one opens the mouth with
hz_global const struct {
  const char *key;
  PlayerVrmPreset preset;
  f32 max_weight;
} player_vrm_visemes[] = {
    {"A", VRM_AA, 0.85f}, {"I", VRM_IH, 1}, {"U", VRM_OU, 1},
    {"E", VRM_EE, 1},     {"O", VRM_OH, 0.85f},
};

// a name (morph, joint, gesture, style, file) that can be written into the
// generated text and cache paths: no quote, backslash or control character
// (DEL included), and not made only of dots
hz_internal b32 player_vrm_safe_name(const char *s) {
  if (!s || !s[0])
    return false;
  const char *c = s;
  while (*c == '.')
    c++;
  if (!*c)
    return false;
  for (; *s; s++)
    if (*s == '"' || *s == '\\' || (unsigned char)*s < 0x20 || *s == 0x7f)
      return false;
  return true;
}

// a name the importer took from the model, used in a cache path: a safe name
// with no `..` and no leading `/`, so nothing is written outside the cache
hz_internal b32 player_vrm_safe_part(const char *s) {
  if (!player_vrm_safe_name(s) || s[0] == '/')
    return false;
  for (const char *c = s; *c; c++)
    if (c[0] == '.' && c[1] == '.')
      return false;
  return true;
}

// the name of morph target `index` of glTF mesh `mesh`: its extras.targetNames
// (on the mesh or its first primitive), else what the importer called it
hz_internal const char *player_vrm_morph_name(PJson *gltf, ModelBlobAsset *mb, u32 mesh,
                                              u32 index) {
  PJson *m = pjson_at(pjson_get(gltf, "meshes"), mesh);
  PJson *names = pjson_get(pjson_get(m, "extras"), "targetNames");
  if (!names)
    names = pjson_get(pjson_get(pjson_at(pjson_get(m, "primitives"), 0), "extras"),
                      "targetNames");
  const char *name = pjson_string(pjson_at(names, index), NULL);
  if (name)
    return name;
  const char *mesh_name = pjson_string(pjson_get(m, "name"), NULL);
  Array(MeshBlobAsset) meshes = blob_array_get(MeshBlobAsset, &mb->meshes);
  for (u32 i = 0; i < meshes.len; i++) {
    if (mesh_name && !cstr_equal(string_blob_get(&meshes.items[i].name), mesh_name))
      continue;
    if (!mesh_name && i != mesh)
      continue;
    Array(BlendshapeTarget) shapes =
        blob_array_get(BlendshapeTarget, &meshes.items[i].blendshape_targets);
    return index < shapes.len ? string_blob_get(&shapes.items[index].name) : NULL;
  }
  return NULL;
}

hz_internal void player_vrm_face_add(PlayerVrmFace *face, PlayerVrmPreset p,
                                     const char *morph, f32 weight) {
  // a name that can't be written into the expression set's text is skipped
  if (!player_vrm_safe_name(morph) || weight <= 0.0f || face->count[p] >= PLAYER_VRM_MAX_BINDS)
    return;
  if (!face->count[p])
    face->presets++;
  face->binds[p][face->count[p]++] = (PlayerVrmBind){morph, weight > 1 ? 1 : weight};
}

// the preset expressions of a VRM 1.0 (VRMC_vrm) or 0.x (VRM) model
hz_internal PlayerVrmFace player_vrm_read_face(PJson *gltf, ModelBlobAsset *mb) {
  PlayerVrmFace face = {0};
  PJson *ext = pjson_get(gltf, "extensions");
  PJson *presets = pjson_get(pjson_get(pjson_get(ext, "VRMC_vrm"), "expressions"), "preset");
  if (presets) {
    for (u32 p = 0; p < VRM_PRESET_COUNT; p++) {
      PJson *binds = pjson_get(pjson_get(presets, player_vrm_preset_names[p][0]),
                               "morphTargetBinds");
      for (u32 i = 0; i < pjson_count(binds); i++) {
        PJson *b = pjson_at(binds, i);
        PJson *nodes = pjson_get(gltf, "nodes");
        i32 node = pjson_index(pjson_get(b, "node"), pjson_count(nodes));
        i32 mesh = node < 0 ? -1
                            : pjson_index(pjson_get(pjson_at(nodes, (u32)node), "mesh"),
                                          pjson_count(pjson_get(gltf, "meshes")));
        i32 index = pjson_index(pjson_get(b, "index"), PLAYER_VRM_MAX_INDEX);
        if (mesh < 0 || index < 0)
          continue;
        player_vrm_face_add(&face, p, player_vrm_morph_name(gltf, mb, (u32)mesh, (u32)index),
                            (f32)pjson_number(pjson_get(b, "weight"), 1));
      }
    }
    return face;
  }
  PJson *groups =
      pjson_get(pjson_get(pjson_get(ext, "VRM"), "blendShapeMaster"), "blendShapeGroups");
  for (u32 g = 0; g < pjson_count(groups); g++) {
    PJson *group = pjson_at(groups, g);
    const char *preset = pjson_string(pjson_get(group, "presetName"), "");
    for (u32 p = 0; p < VRM_PRESET_COUNT; p++) {
      if (!cstr_equal(preset, player_vrm_preset_names[p][1]))
        continue;
      PJson *binds = pjson_get(group, "binds");
      for (u32 i = 0; i < pjson_count(binds); i++) {
        PJson *b = pjson_at(binds, i);
        i32 mesh = pjson_index(pjson_get(b, "mesh"), pjson_count(pjson_get(gltf, "meshes")));
        i32 index = pjson_index(pjson_get(b, "index"), PLAYER_VRM_MAX_INDEX);
        if (mesh < 0 || index < 0)
          continue;
        // VRM 0.x weights run 0..100
        player_vrm_face_add(&face, p, player_vrm_morph_name(gltf, mb, (u32)mesh, (u32)index),
                            (f32)pjson_number(pjson_get(b, "weight"), 100) / 100.0f);
      }
    }
  }
  return face;
}

hz_internal CString player_vrm_expressions_text(PlayerVrmFace *face, Allocator *alloc) {
  StringBuilder sb = sb_create(KB(16), alloc);
  sb_append_format(&sb, "type ExpressionSetBlobAsset\nversion 19\n---\nexpressions %\n",
                   fmt_u32(ARRAY_SIZE(player_vrm_expressions)));
  for (u32 e = 0; e < ARRAY_SIZE(player_vrm_expressions); e++) {
    const PlayerVrmExpression *x = &player_vrm_expressions[e];
    // the mix, one weight per morph
    PlayerVrmBind mix[PLAYER_VRM_MAX_BINDS * 3];
    u32 n = 0;
    for (u32 k = 0; k < 3 && x->weight[k] > 0.0f; k++) {
      PlayerVrmPreset p = x->preset[k];
      for (u32 b = 0; b < face->count[p]; b++) {
        PlayerVrmBind bind = face->binds[p][b];
        f32 w = bind.weight * x->weight[k];
        u32 j = 0;
        while (j < n && !cstr_equal(mix[j].morph, bind.morph))
          j++;
        if (j == n)
          mix[n++] = (PlayerVrmBind){bind.morph, 0};
        mix[j].weight = mix[j].weight + w > 1 ? 1 : mix[j].weight + w;
      }
    }
    sb_append_format(&sb,
                     "  name \"%\"\n  tag \"%\"\n  is_binary false\n  override_blink 0\n"
                     "  override_look_at 0\n  override_mouth 0\n  joints 0\n  materials 0\n"
                     "  targets %\n",
                     fmt_cstr(x->name), fmt_cstr(x->tag), fmt_u32(n));
    for (u32 j = 0; j < n; j++)
      sb_append_format(&sb, "    target \"%\"\n    value %\n", fmt_cstr(mix[j].morph),
                       fmt_f32_p(mix[j].weight, 6));
    sb_append(&sb, "\n");
  }
  return sb_get(&sb);
}

hz_internal const char *player_vrm_first_morph(PlayerVrmFace *face, PlayerVrmPreset p) {
  return face->count[p] ? face->binds[p][0].morph : "";
}

hz_internal CString player_vrm_face_rig_text(PlayerVrmFace *face, Allocator *alloc) {
  StringBuilder sb = sb_create(KB(4), alloc);
  const char *blink = player_vrm_first_morph(face, VRM_BLINK);
  sb_append(&sb, "type CharacterFaceRigBlobAsset\nversion 17\n---\n");
  sb_append_format(&sb, "lipsync_profile \"%\"\n", fmt_cstr(PLAYER_VRM_LIPSYNC));
  // eye life narrows with the blink shape; VRM has no standard widen or smile
  sb_append_format(&sb, "blink \"%\"\neye_close \"%\"\neye_wide \"\"\neye_smile \"\"\n",
                   fmt_cstr(blink), fmt_cstr(blink));
  sb_append(&sb, "static_morphs 0\n");
  u32 visemes = 0;
  for (u32 v = 0; v < ARRAY_SIZE(player_vrm_visemes); v++)
    visemes += face->count[player_vrm_visemes[v].preset] ? 1 : 0;
  sb_append_format(&sb, "visemes %\n", fmt_u32(visemes));
  for (u32 v = 0; v < ARRAY_SIZE(player_vrm_visemes); v++) {
    PlayerVrmPreset p = player_vrm_visemes[v].preset;
    if (face->count[p])
      sb_append_format(&sb, "  key \"%\"\n  target \"%\"\n  max_weight %\n",
                       fmt_cstr(player_vrm_visemes[v].key), fmt_cstr(face->binds[p][0].morph),
                       fmt_f32_p(player_vrm_visemes[v].max_weight, 6));
  }
  // the mouth shapes belong to the mouth, the blink shapes to the eyelids
  PlayerVrmPreset mouth[] = {VRM_AA, VRM_IH, VRM_OU, VRM_EE, VRM_OH};
  PlayerVrmPreset lids[] = {VRM_BLINK, VRM_BLINK_LEFT, VRM_BLINK_RIGHT};
  u32 rules = 0;
  for (u32 i = 0; i < ARRAY_SIZE(mouth); i++)
    rules += face->count[mouth[i]];
  for (u32 i = 0; i < ARRAY_SIZE(lids); i++)
    rules += face->count[lids[i]];
  sb_append_format(&sb, "rules %\n", fmt_u32(rules));
  for (u32 i = 0; i < ARRAY_SIZE(mouth); i++)
    for (u32 b = 0; b < face->count[mouth[i]]; b++)
      sb_append_format(&sb,
                       "  pattern \"%\"\n  match CHARACTER_FACE_MATCH_EXACT\n"
                       "  region CHARACTER_FACE_REGION_MOUTH\n",
                       fmt_cstr(face->binds[mouth[i]][b].morph));
  for (u32 i = 0; i < ARRAY_SIZE(lids); i++)
    for (u32 b = 0; b < face->count[lids[i]]; b++)
      sb_append_format(&sb,
                       "  pattern \"%\"\n  match CHARACTER_FACE_MATCH_EXACT\n"
                       "  region CHARACTER_FACE_REGION_EYECLOSE\n",
                       fmt_cstr(face->binds[lids[i]][b].morph));
  return sb_get(&sb);
}

// ---------------------------------------------------------------------------
// body: the clips the runtime baked in -> emotes, character states, gestures
// ---------------------------------------------------------------------------

typedef struct {
  CString path; // cooked asset path; NULL for a clip that didn't import
  f32 length;   // seconds
} PlayerVrmClip;

typedef struct {
  CString dir;
  PlayerVrmClip *clips;
  u32 clip_count;
  Allocator *alloc;
  b32 failed;
} PlayerVrmBody;

// cooks one hzt text and writes it under cooked/
hz_internal b32 player_vrm_cook(CString text, const char *type, CString asset_path,
                                Allocator *alloc);

hz_internal CString player_vrm_emote_text(CString name, PlayerVrmClip clip, b32 loop,
                                          Allocator *alloc) {
  return str_format(alloc,
                    "type EmoteBlobAsset\nversion 16\n---\n"
                    "name \"%\"\nduration %\nloop %\nsuppress_blink false\n"
                    "suppress_gaze false\nanim_tracks 1\n"
                    "  animation \"%\"\n  start_time 0\n  end_time %\n  clip_in 0\n"
                    "  speed 1\n  transition_lead 0\n  transition_trail %\n"
                    "  loop %\n  hold %\n  layer 0\n"
                    "expr_tracks 0\noverrides 0\naudio_tracks 0\ncamera_tracks 0\n"
                    "backdrop_tracks 0\n",
                    fmt_cstr(name), fmt_f32_p(clip.length, 6), fmt_cstr(loop ? "true" : "false"),
                    fmt_cstr(clip.path), fmt_f32_p(clip.length, 6),
                    fmt_cstr(loop ? "0.5" : "0.25"), fmt_cstr(loop ? "true" : "false"),
                    fmt_cstr(loop ? "false" : "true"))
      .value;
}

// the emote that plays clip `index` (looping or once); NULL when there's no such clip
hz_internal CString player_vrm_emote(PlayerVrmBody *b, PJson *index, b32 loop) {
  i32 i = pjson_index(index, b->clip_count);
  if (i < 0 || !b->clips[i].path) {
    log_warn("vrm: the harness table names clip %, which the model doesn't have",
             fmt_f64(pjson_number(index, -1)));
    return NULL;
  }
  const char *kind = loop ? "loop" : "once";
  CString name = str_format(b->alloc, "%_%", fmt_cstr(kind), fmt_u32((u32)i)).value;
  CString path = str_format(b->alloc, "%emotes/%.hza", fmt_cstr(b->dir), fmt_cstr(name)).value;
  if (!player_vrm_cook(player_vrm_emote_text(name, b->clips[(u32)i], loop, b->alloc),
                       "EmoteBlobAsset", path, b->alloc))
    b->failed = true;
  return path;
}

// a list of looping emotes, as character states write one; returns how many
// resolved, and the first one's clip in `first` when it's not NULL
hz_internal u32 player_vrm_loops(PlayerVrmBody *b, StringBuilder *sb, PJson *list, i32 *first) {
  CString emotes[64];
  u32 n = 0;
  for (u32 i = 0; i < pjson_count(list) && n < ARRAY_SIZE(emotes); i++) {
    CString e = player_vrm_emote(b, pjson_at(list, i), true);
    if (!e)
      continue;
    if (!n && first)
      *first = pjson_index(pjson_at(list, i), b->clip_count);
    emotes[n++] = e;
  }
  sb_append_format(sb, "  loops %\n", fmt_u32(n));
  for (u32 i = 0; i < n; i++)
    sb_append_format(sb, "    emote \"%\" EmoteBlobAsset\n    weight 1\n", fmt_cstr(emotes[i]));
  return n;
}

// writes states.hza (idle and talking loops, talking styles) and gestures.hza
// from the harness table; returns the idle clip, or -1 when there is no idle
// loop to stand on
hz_internal i32 player_vrm_body(PlayerVrmBody *b, PJson *table, CString *out_gestures) {
  PJson *idle = pjson_get(table, "idle");
  // styles and gestures are named, so they must be objects
  PJson *talk = pjson_get(table, "talk");
  if (talk && talk->kind != PJSON_OBJECT)
    talk = NULL;
  PJson *gestures = pjson_get(table, "gestures");
  if (gestures && gestures->kind != PJSON_OBJECT)
    gestures = NULL;

  i32 idle_clip = -1;
  StringBuilder sb = sb_create(KB(4), b->alloc);
  sb_append(&sb, "type CharacterStatesBlobAsset\nversion 16\n---\nidle\n");
  if (!player_vrm_loops(b, &sb, idle, &idle_clip))
    return -1;
  sb_append(&sb, "  breaks 0\n  swap_min 14\n  swap_max 26\n  break_min 20\n"
                 "  break_max 30\n  transition_time 0.3\n");
  // talking: the "regular" style, else the first style, else idle
  PJson *talking = pjson_get(talk, "regular");
  if (!talking)
    talking = pjson_count(talk) ? &talk->items[0] : idle;
  sb_append(&sb, "talking\n");
  player_vrm_loops(b, &sb, talking, NULL);
  sb_append(&sb, "  breaks 0\n  swap_min 6\n  swap_max 12\n  break_min 0\n  break_max 0\n"
                 "  transition_time 0.3\n");
  u32 styles = 0;
  for (u32 i = 0; i < pjson_count(talk); i++)
    styles += player_vrm_safe_name(pjson_key(talk, i)) ? 1 : 0;
  sb_append_format(&sb, "registers %\n", fmt_u32(styles));
  for (u32 i = 0; i < pjson_count(talk); i++) {
    if (!player_vrm_safe_name(pjson_key(talk, i)))
      continue;
    sb_append_format(&sb, "  name \"%\"\n", fmt_cstr(pjson_key(talk, i)));
    player_vrm_loops(b, &sb, &talk->items[i], NULL);
    sb_append(&sb, "  hold false\n");
  }
  if (!player_vrm_cook(sb_get(&sb), "CharacterStatesBlobAsset",
                       str_format(b->alloc, "%states.hza", fmt_cstr(b->dir)).value, b->alloc))
    return -1;

  StringBuilder entries = sb_create(KB(4), b->alloc);
  u32 n = 0;
  for (u32 i = 0; i < pjson_count(gestures); i++) {
    PJson *g = &gestures->items[i];
    if (!player_vrm_safe_name(pjson_key(gestures, i)))
      continue;
    CString emote = player_vrm_emote(b, pjson_get(g, "clip"), false);
    if (!emote)
      continue;
    sb_append_format(&entries, "  name \"%\"\n  emote \"%\"\n  hold %\n",
                     fmt_cstr(pjson_key(gestures, i)), fmt_cstr(emote),
                     fmt_cstr(pjson_bool(pjson_get(g, "hold"), false) ? "true" : "false"));
    n++;
  }
  if (!n)
    return idle_clip;
  CString text = str_format(b->alloc, "type GestureSetBlobAsset\nversion 16\n---\ngestures %\n%",
                            fmt_u32(n), fmt_cstr(sb_get(&entries))).value;
  CString path = str_format(b->alloc, "%gestures.hza", fmt_cstr(b->dir)).value;
  if (player_vrm_cook(text, "GestureSetBlobAsset", path, b->alloc))
    *out_gestures = path;
  return idle_clip;
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

// the file name without its directory or extension
hz_internal String player_vrm_stem(String path) {
  u32 start = 0, end = path.len;
  for (u32 i = 0; i < path.len; i++) {
    if (path.value[i] == '/')
      start = i + 1;
    if (path.value[i] == '.')
      end = i;
  }
  if (end <= start)
    end = path.len;
  return (String){path.value + start, end - start};
}

// A published build may read some asset types from a zstd-compressed sibling
// (<file>.zst) that its cook made. What the import writes gets one too: a zstd
// frame of raw (stored) blocks, which any zstd decoder reads. (A published
// macOS app runs in ~/Library/Application Support/<bundle id>, so the cache
// is written there, outside the signed app.)
#ifndef PLAYER_VRM_ZST
#ifdef HZ_PUBLISH
#define PLAYER_VRM_ZST 1
#else
#define PLAYER_VRM_ZST 0
#endif
#endif
#define PLAYER_ZST_BLOCK (128u * 1024u)

hz_internal b32 player_vrm_write_zst(CString path, const u8 *data, u32 len, Allocator *alloc) {
  // the frame must fit a u32 too; no cached asset comes near that
  if (len > 0xF0000000u)
    return false;
  u32 blocks = len ? (len + PLAYER_ZST_BLOCK - 1) / PLAYER_ZST_BLOCK : 1;
  u32 size = 4 + 1 + 8 + blocks * 3 + len;
  u8 *out = ALLOC_ARRAY(alloc, u8, size);
  u8 *at = out;
  const u8 magic[4] = {0x28, 0xB5, 0x2F, 0xFD};
  mem_cpy(at, magic, 4);
  at += 4;
  // descriptor: 8-byte content size, single segment, no checksum, no dictionary
  *at++ = 0xE0;
  for (u32 i = 0; i < 8; i++)
    *at++ = i < 4 ? (u8)(len >> (8 * i)) : 0;
  for (u32 b = 0; b < blocks; b++) {
    u32 n = len - b * PLAYER_ZST_BLOCK < PLAYER_ZST_BLOCK ? len - b * PLAYER_ZST_BLOCK : PLAYER_ZST_BLOCK;
    // block header: last flag, raw type (0), size
    u32 header = (n << 3) | (b + 1 == blocks ? 1u : 0u);
    *at++ = (u8)header;
    *at++ = (u8)(header >> 8);
    *at++ = (u8)(header >> 16);
    if (n)
      mem_cpy(at, data + b * PLAYER_ZST_BLOCK, n);
    at += n;
  }
  return os_write_file(str_format(alloc, "%.zst", fmt_cstr(path)).value, out, size);
}

hz_internal b32 player_vrm_write(CString path, void *data, u32 len, Allocator *alloc) {
  cook_ensure_parent_dir(path, alloc);
  if (!os_write_file(path, (u8 *)data, len))
    return false;
  return !PLAYER_VRM_ZST || player_vrm_write_zst(path, (const u8 *)data, len, alloc);
}

hz_internal b32 player_vrm_cook(CString text, const char *type, CString asset_path,
                                Allocator *alloc) {
  u32 len = 0;
  u8 *blob = hzt_cook_blob(cstr_to_str(text), type_table_get(type), &len, alloc);
  if (!blob) {
    log_error("vrm: could not build % (%)", fmt_cstr(asset_path), fmt_cstr(type));
    return false;
  }
  return player_vrm_write(str_format(alloc, "cooked/%", fmt_cstr(asset_path)).value, blob,
                          len, alloc);
}

// asset_import_glb_v2 returns assets without their file header
hz_internal void player_vrm_seal(void *blob, u32 size, u64 type_hash) {
  BlobAssetHeader *h = blob;
  h->magic = ASSET_MAGIC;
  h->asset_size = size;
  h->asset_type_hash = type_hash;
  h->version = ASSET_VERSION;
}

// what the cache depends on: this code's and the engine's asset versions, and
// the file's path, size and time
hz_internal CString player_vrm_stamp_text(CString path, OsFileInfo info, Allocator *alloc) {
  return str_format(alloc, "v% asset% % % %\n", fmt_u32(PLAYER_VRM_CACHE_VERSION),
                    fmt_u32(ASSET_VERSION), fmt_u64(info.file_size),
                    fmt_i64(info.modification_time), fmt_cstr(path))
      .value;
}

// the glTF JSON of a .vrm / .glb, parsed
hz_internal PJson *player_vrm_read_json(CString path, Allocator *alloc) {
  PlatformFileData f = os_read_file(path, alloc);
  if (!f.success || f.buffer_len < 20)
    return NULL;
  u8 *b = (u8 *)f.buffer;
  u32 json_len = (u32)b[12] | (u32)b[13] << 8 | (u32)b[14] << 16 | (u32)b[15] << 24;
  if (mem_cmp(b, "glTF", 4) != 0 || 20 + (u64)json_len > f.buffer_len)
    return NULL;
  return pjson_parse((const char *)b + 20, json_len, alloc);
}

// the node a humanoid bone is on (VRM 1.0 or 0.x), or -1
hz_internal i32 player_vrm_bone_node(PJson *gltf, const char *bone) {
  u32 nodes = pjson_count(pjson_get(gltf, "nodes"));
  PJson *ext = pjson_get(gltf, "extensions");
  PJson *v1 = pjson_get(pjson_get(pjson_get(ext, "VRMC_vrm"), "humanoid"), "humanBones");
  if (v1)
    return pjson_index(pjson_get(pjson_get(v1, bone), "node"), nodes);
  PJson *v0 = pjson_get(pjson_get(pjson_get(ext, "VRM"), "humanoid"), "humanBones");
  for (u32 i = 0; i < pjson_count(v0); i++)
    if (cstr_equal(pjson_string(pjson_get(pjson_at(v0, i), "bone"), ""), bone))
      return pjson_index(pjson_get(pjson_at(v0, i), "node"), nodes);
  return -1;
}

// the rig roles (head, neck, eyes, chest) on this model's own joints, from its
// VRM humanoid; no roles when it has no humanoid head
hz_internal CString player_vrm_rig_text(PJson *gltf, Allocator *alloc) {
  static const char *roles[][3] = {
      // role, bone, fallback bone
      {"eye_l", "leftEye", NULL}, {"eye_r", "rightEye", NULL}, {"head", "head", NULL},
      {"neck", "neck", NULL},     {"chest", "upperChest", "chest"},
  };
  const char *joints[ARRAY_SIZE(roles)];
  u32 n = 0;
  for (u32 r = 0; r < ARRAY_SIZE(roles); r++) {
    i32 node = player_vrm_bone_node(gltf, roles[r][1]);
    if (node < 0 && roles[r][2])
      node = player_vrm_bone_node(gltf, roles[r][2]);
    joints[r] = node < 0 ? NULL
                         : pjson_string(pjson_get(pjson_at(pjson_get(gltf, "nodes"), (u32)node),
                                                  "name"), NULL);
    if (joints[r] && !player_vrm_safe_name(joints[r]))
      joints[r] = NULL;
    n += joints[r] ? 1 : 0;
  }
  if (!joints[2]) {
    n = 0;
    for (u32 r = 0; r < ARRAY_SIZE(roles); r++)
      joints[r] = NULL;
  }
  StringBuilder sb = sb_create(KB(1), alloc);
  sb_append_format(&sb, "type CharacterRigBlobAsset\nversion 17\n---\nhidden 0\nroles %\n",
                   fmt_u32(n));
  for (u32 r = 0; r < ARRAY_SIZE(roles); r++)
    if (joints[r])
      sb_append_format(&sb, "  role \"%\"\n  joint \"%\"\n", fmt_cstr(roles[r][0]),
                       fmt_cstr(joints[r]));
  return sb_get(&sb);
}

// ---------------------------------------------------------------------------
// springs: the VRM's spring bones -> the engine's bone cloth
// ---------------------------------------------------------------------------

// the runtime writes a model's springs in the harness table (springs, in
// runtime/src/rig/springs.ts): bones, roots, stiffness, gravity, gravity_dir,
// drag, radius and colliders, VRM's own values. Each becomes one bone cloth.
// the engine simulates this many cloths per model
#define PLAYER_VRM_MAX_SPRINGS ECS_CLOTH_MAX_PER_MODEL
// colliders one model may use in all
#define PLAYER_VRM_MAX_SPRING_COLLIDERS 256
// what one spring may hold, and how many entries are looked at, whatever the
// file says
#define PLAYER_VRM_MAX_SPRING_BONES 256
#define PLAYER_VRM_MAX_SPRING_SCAN 64
#define PLAYER_VRM_MAX_BONE_NAME 255

hz_internal f32 player_vrm_clampf(f32 v, f32 lo, f32 hi) { return v < lo ? lo : v > hi ? hi : v; }

// a curve of 16 samples from the root of a chain to its tip, `from` to `to`
hz_internal void player_vrm_ramp(StringBuilder *sb, const char *name, f32 from, f32 to) {
  sb_append_format(sb, "  %\n    s 16", fmt_cstr(name));
  for (u32 i = 0; i < 16; i++)
    sb_append_format(sb, " %", fmt_f32_p(from + (to - from) * (f32)i / 15, 6));
  sb_append(sb, "\n");
}

// a curve of 16 samples, all the same
hz_internal void player_vrm_curve(StringBuilder *sb, const char *name, f32 v) {
  player_vrm_ramp(sb, name, v, v);
}

hz_internal void player_vrm_v3(StringBuilder *sb, const char *indent, const char *name, f32 x,
                               f32 y, f32 z) {
  sb_append_format(sb, "%%\n%  x %\n%  y %\n%  z %\n", fmt_cstr(indent), fmt_cstr(name),
                   fmt_cstr(indent), fmt_f32_p(x, 6), fmt_cstr(indent), fmt_f32_p(y, 6),
                   fmt_cstr(indent), fmt_f32_p(z, 6));
}

hz_internal f32 player_vrm_num(PJson *v, f32 fallback, f32 lo, f32 hi) {
  f64 n = pjson_number(v, fallback);
  if (n != n) // NaN
    return fallback;
  // clamped as a double, so the conversion to f32 is always in range
  return (f32)(n < lo ? lo : n > hi ? hi : n);
}

// is `name` exactly one of the model's joints? The cloth finds its bones by
// name, so a name two joints share could move the wrong one.
hz_internal b32 player_vrm_has_joint(ModelBlobAsset *mb, const char *name) {
  Array(StringBlob) joints = blob_array_get(StringBlob, &mb->joint_names);
  u32 found = 0;
  for (u32 i = 0; i < joints.len && found < 2; i++)
    found += cstr_equal(string_blob_get(&joints.items[i]), name) ? 1 : 0;
  return found == 1;
}

// the name of node `i`, when the cloth can use it
hz_internal const char *player_vrm_spring_node(PJson *gltf, ModelBlobAsset *mb, PJson *i) {
  PJson *nodes = pjson_get(gltf, "nodes");
  i32 node = pjson_index(i, pjson_count(nodes));
  const char *name = node < 0 ? NULL : pjson_string(pjson_get(pjson_at(nodes, (u32)node), "name"), NULL);
  u32 len = 0;
  while (name && name[len] && len <= PLAYER_VRM_MAX_BONE_NAME)
    len++;
  return name && len <= PLAYER_VRM_MAX_BONE_NAME && player_vrm_safe_name(name) &&
                 player_vrm_has_joint(mb, name)
             ? name
             : NULL;
}

// one collider: a sphere, or a capsule from offset to tail, on its node
hz_internal b32 player_vrm_collider(StringBuilder *sb, PJson *gltf, ModelBlobAsset *mb, PJson *c) {
  const char *bone = player_vrm_spring_node(gltf, mb, pjson_get(c, "node"));
  PJson *off = pjson_get(c, "offset");
  PJson *tail = pjson_get(c, "tail");
  f32 r = player_vrm_num(pjson_get(c, "radius"), 0, 0, 10);
  if (!bone || pjson_count(off) != 3 || r <= 0)
    return false;
  f32 a[3], b[3];
  for (u32 k = 0; k < 3; k++) {
    a[k] = player_vrm_num(pjson_at(off, k), 0, -1000, 1000);
    b[k] = pjson_count(tail) == 3 ? player_vrm_num(pjson_at(tail, k), a[k], -1000, 1000) : a[k];
  }
  f32 d[3] = {b[0] - a[0], b[1] - a[1], b[2] - a[2]};
  f32 len = m_sqrtf(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  b32 capsule = len > 1e-5f;
  // a capsule runs along its local X (direction 0): turn X onto the segment
  f32 q[4] = {0, 0, 0, 1};
  if (capsule) {
    f32 u[3] = {d[0] / len, d[1] / len, d[2] / len};
    f32 w = 1 + u[0]; // cos of the angle from X, plus one
    if (w < 1e-6f) {
      q[0] = 0, q[1] = 0, q[2] = 1, q[3] = 0; // opposite X: half a turn about Z
    } else {
      // the shortest arc from X: axis X cross u, normalised with w
      f32 n = m_sqrtf(w * w + u[2] * u[2] + u[1] * u[1]);
      q[0] = 0, q[1] = -u[2] / n, q[2] = u[1] / n, q[3] = w / n;
    }
  }
  sb_append_format(sb, "  type %\n  bone_name \"%\"\n", fmt_u32(capsule ? 2 : 1), fmt_cstr(bone));
  player_vrm_v3(sb, "  ", "local_pos", (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  sb_append_format(sb, "  local_rot\n    x %\n    y %\n    z %\n    w %\n", fmt_f32_p(q[0], 6),
                   fmt_f32_p(q[1], 6), fmt_f32_p(q[2], 6), fmt_f32_p(q[3], 6));
  sb_append(sb, "  direction 0\n");
  // a sphere's size is its radius; a capsule's, its end radii and full length
  player_vrm_v3(sb, "  ", "size", r, capsule ? r : 0, capsule ? len + 2 * r : 0);
  sb_append_format(sb, "  aligned_center %\n\n", fmt_cstr(capsule ? "true" : "false"));
  return true;
}

// The bone cloth of one spring, or NULL when none of its bones can swing.
// VRM's spring model and the engine's cloth differ; these mappings keep a
// spring's character: stiffer springs hold their shape, heavier ones hang,
// draggier ones settle sooner.
hz_internal CString player_vrm_spring_text(PJson *gltf, ModelBlobAsset *mb, PJson *spring,
                                           u32 *collider_budget, Allocator *alloc) {
  PJson *bones = pjson_get(spring, "bones");
  PJson *roots = pjson_get(spring, "roots");
  if (pjson_count(bones) < 2 || pjson_count(roots) == 0)
    return NULL;
  u32 nroots = MIN(pjson_count(roots), PLAYER_VRM_MAX_SPRING_BONES);
  StringBuilder names = sb_create(KB(4), alloc);
  StringBuilder attrs = sb_create(KB(1), alloc);
  u32 n = 0, moving = 0, fixed = 0;
  for (u32 i = 0; i < pjson_count(bones) && i < PLAYER_VRM_MAX_SPRING_BONES; i++) {
    const char *bone = player_vrm_spring_node(gltf, mb, pjson_at(bones, i));
    if (!bone)
      continue;
    b32 root = false;
    f64 node = pjson_number(pjson_at(bones, i), -2);
    for (u32 r = 0; r < nroots && !root; r++)
      root = pjson_number(pjson_at(roots, r), -1) == node;
    sb_append_format(&names, " \"%\"", fmt_cstr(bone));
    sb_append_format(&attrs, " %", fmt_u32(root ? 1 : 2));
    moving += root ? 0 : 1;
    fixed += root ? 1 : 0;
    n++;
  }
  // a chain needs something attached to the body and something to swing
  if (!moving || !fixed)
    return NULL;

  f32 stiffness = player_vrm_num(pjson_get(spring, "stiffness"), 1, 0, 4);
  f32 gravity = player_vrm_num(pjson_get(spring, "gravity"), 0, 0, 2);
  f32 drag = player_vrm_num(pjson_get(spring, "drag"), 0.5f, 0, 1);
  f32 radius = player_vrm_num(pjson_get(spring, "radius"), 0, 0, 1);
  PJson *gd = pjson_get(spring, "gravity_dir");
  f32 g[3] = {0, -1, 0};
  if (pjson_count(gd) == 3) {
    f32 v[3];
    for (u32 k = 0; k < 3; k++)
      v[k] = player_vrm_num(pjson_at(gd, k), 0, -1, 1);
    f32 len = m_sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    // a direction, so a longer one doesn't pull harder; none at all means down
    if (len > 1e-4f)
      for (u32 k = 0; k < 3; k++)
        g[k] = v[k] / len;
  }

  StringBuilder sb = sb_create(KB(16), alloc);
  sb_append(&sb, "type ClothAuthoringBlobAsset\nversion 3\n---\ncloth_type 1\ntarget_mesh_name \"\"\nparams\n");
  player_vrm_v3(&sb, "  ", "gravity_dir", g[0], g[1], g[2]);
  sb_append_format(&sb, "  gravity %\n  gravity_falloff 0\n", fmt_f32_p(gravity * 9.8f, 6));
  f32 damping = player_vrm_clampf(0.05f + 0.25f * drag, 0.03f, 0.5f);
  sb_append_format(&sb, "  damping %\n  use_damping_curve false\n", fmt_f32_p(damping, 6));
  player_vrm_curve(&sb, "damping_curve", damping);
  sb_append(&sb, "  stabilization_time 0.1\n  animation_pose_ratio 0\n  distance_stiffness 1\n"
                 "  use_distance_curve false\n");
  player_vrm_curve(&sb, "distance_stiffness_curve", 1);
  sb_append(&sb, "  distance_iterations 0\n  distance_velocity_attenuation 0.3\n"
                 "  tether_compression 0.8\n  use_angle_restoration true\n");
  // held firmly at the root and loosely at the tip, as a strand of hair is
  f32 restore = player_vrm_clampf(0.08f + 0.12f * stiffness, 0.08f, 0.6f);
  sb_append_format(&sb, "  angle_restoration_stiffness %\n  use_angle_restoration_curve true\n",
                   fmt_f32_p(restore, 6));
  player_vrm_ramp(&sb, "angle_restoration_curve", restore, restore * 0.15f);
  sb_append(&sb, "  angle_restoration_velocity_attenuation 0.8\n"
                 "  angle_restoration_gravity_falloff 0\n  use_angle_limit true\n"
                 "  angle_limit_deg 75\n  angle_limit_stiffness 0.9\n  use_angle_limit_curve false\n");
  player_vrm_curve(&sb, "angle_limit_curve", 75);
  sb_append(&sb, "  use_max_distance false\n  max_distance 0.3\n  use_max_distance_curve false\n");
  player_vrm_curve(&sb, "max_distance_curve", 0.3f);
  sb_append(&sb, "  motion_stiffness 1\n  use_backstop false\n  backstop_radius 10\n"
                 "  backstop_distance 0\n  use_backstop_distance_curve false\n");
  player_vrm_curve(&sb, "backstop_distance_curve", 0);
  sb_append(&sb, "  normal_axis 0\n  is_spring false\n  spring_power 0.04\n"
                 "  spring_limit_distance 0.1\n  spring_normal_limit_ratio 1\n  spring_noise 0\n");
  f32 r = player_vrm_clampf(radius, 0.005f, 0.2f);
  sb_append_format(&sb, "  radius %\n  use_radius_curve false\n", fmt_f32_p(r, 6));
  player_vrm_curve(&sb, "radius_curve", r);
  sb_append(&sb, "  use_collision true\n  collision_friction 0.1\n  use_self_collision false\n"
                 "  self_collision_thickness 0.005\n  use_self_thickness_curve false\n");
  player_vrm_curve(&sb, "self_thickness_curve", 0.005f);
  sb_append(&sb, "  self_collision_cloth_mass 0\n  world_inertia 1\n  depth_inertia 0\n"
                 "  movement_inertia_smoothing 0.4\n  movement_speed_limit 3\n"
                 "  rotation_speed_limit 720\n  local_inertia 1\n  local_movement_speed_limit 0\n"
                 "  local_rotation_speed_limit 0\n  particle_speed_limit 3\n"
                 "  centrifugal_acceleration 0\n  teleport_mode 1\n  teleport_distance 0.5\n"
                 "  wind_mode 0\n");
  player_vrm_v3(&sb, "  ", "wind_dir", 0, 0, 0);
  sb_append(&sb, "  wind_main 0\n  wind_influence 1\n  wind_turbulence 1\n  wind_depth_weight 0\n"
                 "  wind_frequency 1\n  wind_blend 0.4\n  wind_synchronization 0.35\n");
  player_vrm_v3(&sb, "  ", "wind_zone_center", 0, 0, 0);
  sb_append(&sb, "  wind_zone_radius 0\n  use_bending false\n  bending_stiffness 0.5\n"
                 "  blend_weight 1\n  rotational_interpolation 0.5\n  root_rotation 0.5\n"
                 "reduction\n  simple_distance 0\n  shape_distance 0\n"
                 "selection_max_connection_distance 0\nnormal_alignment_mode 0\n");
  player_vrm_v3(&sb, "", "normal_alignment_pos", 0, 0, 0);
  sb_append(&sb, "target_vertex_count 0\nselection_positions 0\nselection_attributes 0\n");

  PJson *colliders = pjson_get(spring, "colliders");
  StringBuilder cs = sb_create(KB(4), alloc);
  u32 nc = 0;
  for (u32 i = 0; i < pjson_count(colliders) && i < 64; i++) {
    if (!*collider_budget) {
      log_warn("vrm: the model's springs name more than % colliders; the rest are left out",
               fmt_u32(PLAYER_VRM_MAX_SPRING_COLLIDERS));
      break;
    }
    if (player_vrm_collider(&cs, gltf, mb, pjson_at(colliders, i))) {
      nc++;
      (*collider_budget)--;
    }
  }
  sb_append_format(&sb, "colliders %\n%", fmt_u32(nc), fmt_cstr(sb_get(&cs)));
  sb_append_format(&sb, "bone_names %%\nbone_attributes %%\n", fmt_u32(n), fmt_cstr(sb_get(&names)),
                   fmt_u32(n), fmt_cstr(sb_get(&attrs)));
  return sb_get(&sb);
}

// cooks each spring of the harness table into cloth/spring_<i>.hza; returns
// how many, with their paths in `out`
hz_internal u32 player_vrm_springs(PJson *gltf, ModelBlobAsset *mb, PJson *table, CString dir,
                                   CString *out, Allocator *alloc) {
  PJson *springs = pjson_get(table, "springs");
  u32 n = 0;
  u32 colliders = PLAYER_VRM_MAX_SPRING_COLLIDERS;
  for (u32 i = 0; i < pjson_count(springs) && i < PLAYER_VRM_MAX_SPRING_SCAN &&
                  n < PLAYER_VRM_MAX_SPRINGS;
       i++) {
    CString text = player_vrm_spring_text(gltf, mb, pjson_at(springs, i), &colliders, alloc);
    if (!text)
      continue;
    CString path = str_format(alloc, "%cloth/spring_%.hza", fmt_cstr(dir), fmt_u32(n)).value;
    if (player_vrm_cook(text, "ClothAuthoringBlobAsset", path, alloc))
      out[n++] = path;
  }
  return n;
}

// fields in the order AppCharacterProfileBlobAsset declares them, which the
// text format requires
hz_internal CString player_vrm_profile_text(String stem, CString model_ref, CString dir,
                                            b32 face, CString idle_clip, CString *cloth,
                                            u32 cloth_count, Allocator *alloc) {
  StringBuilder sb = sb_create(KB(8), alloc);
  sb_append(&sb, "type AppCharacterProfileBlobAsset\nversion 19\n---\n");
  sb_append_format(&sb, "name \"%\"\n", fmt_str(stem));
  sb_append_format(&sb, "model \"%\" ModelBlobAsset\n", fmt_cstr(model_ref));
  if (idle_clip) {
    sb_append_format(&sb, "clip_dir \"%clips/\"\n", fmt_cstr(dir));
    sb_append_format(&sb, "idle_clip \"%\" AnimationBlobAsset\n", fmt_cstr(idle_clip));
  }
  sb_append_format(&sb, "rig \"%rig.hza\" CharacterRigBlobAsset\n", fmt_cstr(dir));
  if (face)
    sb_append_format(&sb,
                     "face_rig \"%face_rig.hza\" CharacterFaceRigBlobAsset\n"
                     "expressions \"%expressions.hza\" ExpressionSetBlobAsset\n"
                     "emotions \"" PLAYER_VRM_EMOTIONS "\" EmotionSetBlobAsset\n",
                     fmt_cstr(dir), fmt_cstr(dir));
  if (idle_clip)
    sb_append_format(&sb, "states \"%states.hza\" CharacterStatesBlobAsset\n", fmt_cstr(dir));
  sb_append(&sb, PLAYER_VRM_PROFILE_LIVENESS);
  if (cloth_count) {
    sb_append_format(&sb, "cloth %\n", fmt_u32(cloth_count));
    for (u32 i = 0; i < cloth_count; i++)
      sb_append_format(&sb, "  cloth \"%\" ClothAuthoringBlobAsset\n\n", fmt_cstr(cloth[i]));
  }
  return sb_get(&sb);
}

hz_internal void player_vrm_copy(char *dst, CString src) {
  u32 n = src ? MIN(cstr_len(src), PLAYER_VRM_PATH_MAX - 1) : 0;
  mem_cpy(dst, src, n);
  dst[n] = 0;
}

// imports the file into the cache; fills `out` (paths relative to cooked/)
hz_internal b32 player_vrm_import(CString vrm_path, String stem, CString dir,
                                  PlayerVrm *out, Allocator *alloc) {
  u64 t0 = os_time_now();
  CString tex_dir = str_format(alloc, "%textures/", fmt_cstr(dir)).value;
  CString mat_dir = str_format(alloc, "%materials/", fmt_cstr(dir)).value;

  GlbImport *imp = asset_import_glb_v2(vrm_path, tex_dir, mat_dir, NULL, NULL, alloc);
  if (!imp->ok || !imp->model.blob.data) {
    log_error("vrm: could not import %", fmt_cstr(vrm_path));
    return false;
  }

  // a write that fails leaves the import unfinished, so no stamp is written
  // and the next load imports again
  b32 wrote = true;
  for (u32 i = 0; i < imp->textures.len; i++)
    if (imp->textures.items[i].blob.data && !player_vrm_safe_part(imp->textures.items[i].name)) {
      log_error("vrm: % has a texture whose name can't be used in a path",
                fmt_cstr(vrm_path));
      return false;
    }
  for (u32 i = 0; i < imp->materials.len; i++)
    if (imp->materials.items[i].blob.data && !player_vrm_safe_part(imp->materials.items[i].name)) {
      log_error("vrm: % has a material whose name can't be used in a path",
                fmt_cstr(vrm_path));
      return false;
    }

  // the images are encoded only once every name is known to be safe, since the
  // encoder names its files after the textures. It writes under
  // assets/<output_dir>; this output_dir steers what it writes into the cache
  os_create_dir("assets");
  CString encode_dir = str_format(alloc, "../cooked/%encode/", fmt_cstr(dir)).value;
  if (!asset_import_glb(vrm_path, encode_dir, NULL, NULL, "assets/")) {
    log_error("vrm: could not encode the images of %", fmt_cstr(vrm_path));
    return false;
  }

  u32 images = 0;
  for (u32 i = 0; i < imp->textures.len; i++) {
    ImportTexture *t = &imp->textures.items[i];
    if (!t->blob.data)
      continue;
    player_vrm_seal(t->blob.data, t->blob.size, TYPE_HASH(TextureBlobAsset));
    wrote &= player_vrm_write(str_format(alloc, "cooked/%%.hza", fmt_cstr(tex_dir),
                                         fmt_cstr(t->name)).value,
                              t->blob.data, t->blob.size, alloc);
    for (u32 v = 0; v < ARRAY_SIZE(player_vrm_ktx_variants); v++) {
      const char *variant = player_vrm_ktx_variants[v];
      PlatformFileData ktx = os_read_file(
          str_format(alloc, "cooked/%encode/%/%_%.ktx", fmt_cstr(dir), fmt_str(stem),
                     fmt_cstr(t->name), fmt_cstr(variant)).value,
          alloc);
      if (!ktx.success)
        continue;
      images += player_vrm_write(str_format(alloc, "cooked/%%_%.ktx", fmt_cstr(tex_dir),
                                            fmt_cstr(t->name), fmt_cstr(variant)).value,
                                 ktx.buffer, (u32)ktx.buffer_len, alloc) ? 1 : 0;
    }
  }
  // the model refers to each material as <name>_mat
  for (u32 i = 0; i < imp->materials.len; i++) {
    ImportMaterial *m = &imp->materials.items[i];
    if (!m->blob.data)
      continue;
    player_vrm_seal(m->blob.data, m->blob.size, TYPE_HASH(MaterialBlobAsset));
    wrote &= player_vrm_write(str_format(alloc, "cooked/%%_mat.hza", fmt_cstr(mat_dir),
                                         fmt_cstr(m->name)).value,
                              m->blob.data, m->blob.size, alloc);
  }
  CString model_ref = str_format(alloc, "%%.hza", fmt_cstr(dir), fmt_str(stem)).value;
  wrote &= player_vrm_write(str_format(alloc, "cooked/%", fmt_cstr(model_ref)).value,
                            imp->model.blob.data, imp->model.blob.size, alloc);
  ModelBlobAsset *mb = imp->model.blob.data;

  // clips, in the file's animation order
  PJson *gltf = player_vrm_read_json(vrm_path, alloc);
  if (!gltf)
    log_warn("vrm: could not read the glTF JSON of %; no face or clips", fmt_cstr(vrm_path));
  PlayerVrmBody body = {.dir = dir, .alloc = alloc, .clip_count = imp->animations.len};
  body.clips = ALLOC_ARRAY(alloc, PlayerVrmClip, body.clip_count ? body.clip_count : 1);
  for (u32 i = 0; i < imp->animations.len; i++) {
    ImportAnimation *a = &imp->animations.items[i];
    if (!a->blob.data)
      continue;
    player_vrm_seal(a->blob.data, a->blob.size, TYPE_HASH(AnimationBlobAsset));
    body.clips[i].path = str_format(alloc, "%clips/clip_%.hza", fmt_cstr(dir), fmt_u32(i)).value;
    body.clips[i].length = a->blob.data->length;
    wrote &= player_vrm_write(str_format(alloc, "cooked/%", fmt_cstr(body.clips[i].path)).value,
                              a->blob.data, a->blob.size, alloc);
  }
  u32 declared = pjson_count(pjson_get(gltf, "animations"));
  if (gltf && declared != imp->animations.len)
    log_warn("vrm: % declares % animations but % were imported; clips may not line up",
             fmt_cstr(vrm_path), fmt_u32(declared), fmt_u32(imp->animations.len));
  PJson *table = pjson_get(pjson_get(gltf, "extras"), "mutualsHarness");
  CString gestures = NULL;
  CString idle_clip = NULL;
  i32 idle = table ? player_vrm_body(&body, table, &gestures) : -1;
  if (idle >= 0 && !body.failed)
    idle_clip = body.clips[idle].path;

  if (!wrote) {
    log_error("vrm: could not write the import of % to cooked/%", fmt_cstr(vrm_path),
              fmt_cstr(dir));
    return false;
  }

  // face; one with no usable expressions is still written, with no targets,
  // so the character spawns with a still face
  PlayerVrmFace presets = gltf ? player_vrm_read_face(gltf, mb) : (PlayerVrmFace){0};
  b32 face = player_vrm_cook(player_vrm_expressions_text(&presets, alloc), "ExpressionSetBlobAsset",
                           str_format(alloc, "%expressions.hza", fmt_cstr(dir)).value, alloc) &&
           player_vrm_cook(player_vrm_face_rig_text(&presets, alloc), "CharacterFaceRigBlobAsset",
                           str_format(alloc, "%face_rig.hza", fmt_cstr(dir)).value, alloc);

  // the body's roles on its own joints
  if (!player_vrm_cook(player_vrm_rig_text(gltf, alloc), "CharacterRigBlobAsset",
                       str_format(alloc, "%rig.hza", fmt_cstr(dir)).value, alloc)) {
    log_error("vrm: could not build a rig for %", fmt_cstr(vrm_path));
    return false;
  }

  // hair, skirts and the like swing as bone cloth
  CString cloth[PLAYER_VRM_MAX_SPRINGS];
  u32 cloth_count = table ? player_vrm_springs(gltf, mb, table, dir, cloth, alloc) : 0;

  CString profile_ref = str_format(alloc, "%%_profile.hza", fmt_cstr(dir), fmt_str(stem)).value;
  if (!player_vrm_cook(player_vrm_profile_text(stem, model_ref, dir, face, idle_clip, cloth,
                                               cloth_count, alloc),
                       "AppCharacterProfileBlobAsset", profile_ref, alloc)) {
    log_error("vrm: could not build a character profile for %", fmt_cstr(vrm_path));
    return false;
  }

  log_info("vrm: imported % in % ms: % textures (% encoded images), % materials, "
           "% joints, % clips, % springs; face %; body %",
           fmt_str(stem), fmt_f64(os_ticks_to_ms(os_time_diff(os_time_now(), t0))),
           fmt_u32(imp->textures.len), fmt_u32(images), fmt_u32(imp->materials.len),
           fmt_u32(blob_array_get(StringBlob, &mb->joint_names).len),
           fmt_u32(imp->animations.len), fmt_u32(cloth_count), fmt_cstr(!face ? "none" : presets.presets ? "from its VRM expressions" : "still (no VRM expressions)"),
           fmt_cstr(idle_clip ? (gestures ? "animated, with gestures" : "animated")
                              : "bind pose (no harness clips)"));
  player_vrm_copy(out->profile, profile_ref);
  player_vrm_copy(out->gestures, gestures);
  out->animated = idle_clip != NULL;
  return true;
}

// what an import produced, as the stamp records it after the source line:
// "<profile>\n<gestures or ->\n<animated 0|1>\n"
hz_internal b32 player_vrm_read_record(String rest, PlayerVrm *out) {
  u32 field = 0, start = 0;
  for (u32 i = 0; i < rest.len; i++) {
    if (rest.value[i] != '\n')
      continue;
    String v = {rest.value + start, i - start};
    char *dst = field == 0 ? out->profile : field == 1 ? out->gestures : NULL;
    if (dst && !(field == 1 && str_equal(v, STR_FROM_CSTR("-")))) {
      u32 n = MIN(v.len, PLAYER_VRM_PATH_MAX - 1);
      mem_cpy(dst, v.value, n);
      dst[n] = 0;
    }
    if (field == 2)
      out->animated = v.len && v.value[0] == '1';
    field++;
    start = i + 1;
  }
  return field == 3 && out->profile[0];
}

b32 player_vrm_load(CString vrm_path, PlayerVrm *out) {
  mem_set(out, 0, sizeof(*out));
  OsFileInfo info = os_file_info(vrm_path);
  if (!info.exists) {
    log_error("vrm: % does not exist", fmt_cstr(vrm_path));
    return false;
  }
  ArenaAllocator *arena = arena_create(MB(1024), MB(16));
  Allocator alloc = make_arena_allocator(arena);
  // the name is written into generated text and cache paths
  String stem = player_vrm_stem(cstr_to_str(vrm_path));
  CString stem_text = str_format(&alloc, "%", fmt_str(stem)).value;
  if (!player_vrm_safe_name(stem_text) || stem.len > PLAYER_VRM_MAX_STEM) {
    log_error("vrm: % can't be loaded: its file name is longer than % characters or "
              "has a quote, backslash or control character, or is only dots",
              fmt_cstr(vrm_path), fmt_u32(PLAYER_VRM_MAX_STEM));
    arena_destroy(arena);
    return false;
  }
  CString dir = str_format(&alloc, "vrm/%/", fmt_cstr(stem_text)).value;
  CString stamp_path = str_format(&alloc, "cooked/%source.stamp", fmt_cstr(dir)).value;
  CString stamp = player_vrm_stamp_text(vrm_path, info, &alloc);

  b32 ok = false;
  PlatformFileData cached = os_read_file(stamp_path, &alloc);
  String text = cached.success ? STR(cached.buffer, (u32)cached.buffer_len) : (String){0};
  if (str_starts_with(text, cstr_to_str(stamp)) &&
      player_vrm_read_record((String){text.value + cstr_len(stamp), text.len - cstr_len(stamp)},
                             out) &&
      os_file_exists(str_format(&alloc, "cooked/%", fmt_cstr(out->profile)).value) &&
      (!out->gestures[0] ||
       os_file_exists(str_format(&alloc, "cooked/%", fmt_cstr(out->gestures)).value)) &&
      (!out->animated ||
       os_file_exists(str_format(&alloc, "cooked/%states.hza", fmt_cstr(dir)).value))) {
    log_info("vrm: % is cached", fmt_str(stem));
    ok = true;
  } else {
    mem_set(out, 0, sizeof(*out));
    ok = player_vrm_import(vrm_path, stem, dir, out, &alloc);
    if (ok) {
      CString record = str_format(&alloc, "%%\n%\n%\n", fmt_cstr(stamp), fmt_cstr(out->profile),
                                  fmt_cstr(out->gestures[0] ? out->gestures : "-"),
                                  fmt_cstr(out->animated ? "1" : "0")).value;
      // the stamp is the player's own record, never loaded as an asset
      os_write_file(stamp_path, (u8 *)record, cstr_len(record));
    }
  }
  arena_destroy(arena);
  return ok;
}
