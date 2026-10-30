// the active character: loads a character profile, spawns the character
// entity from it on the stage, and swaps it at runtime. the
// character is never a scene entity (no SceneEntityTag), so scene saves only
// ever write the stage.
#include "app/app_character.h"
#include "app/app.h"
#include "app/app_config.h"
#include "assets/assets.h"
#include "assets/entity_cook.h"
#include "assets/asset_catalog.h"
#include "ecs/ecs.h"
#include "ecs/renderer/ecs_renderer.h"
#include "ecs/transform/ecs_transform.h"
#include "lib/blob_asset.h"
#include "animation/animation.h"
#include "lib/hztext.h"
#include "lib/string.h"
#include "lib/string_builder.h"
#include "lib/thread_context.h"
#include "os/os.h"

// the VRM preset every expression set carries; the face rests on it at spawn
#define APP_CHARACTER_REST_EXPRESSION "neutral"

hz_internal u8 *app_emote_rebase_clips(const EmoteBlobAsset *em, String from,
                                       String to, u32 *out_len,
                                       Allocator *alloc);
hz_internal void app_asset_replace_blob(AssetSystem *s, AssetHandle h, u8 *data,
                                        u32 len);

hz_internal String app_character_clip_dir(const AppCharacterSystem *cs) {
  return (String){(char *)cs->clip_dir, cs->clip_dir_len};
}

// the clip dir emotes currently play from: the active character's, or the
// shared dir before the first character.
hz_internal String app_active_clip_dir(void) {
  AppCharacterSystem *cs = engine_system_lookup(AppCharacterSystem);
  return cs ? app_character_clip_dir(cs) : STR_FROM_CSTR(APP_SHARED_CLIP_DIR);
}

hz_internal void app_character_set_clip_dir(AppCharacterSystem *cs, String dir) {
  assert_msg(dir.len < APP_CHARACTER_PATH_MAX, "clip dir too long: %",
             fmt_str(dir));
  mem_cpy(cs->clip_dir, dir.value, dir.len);
  cs->clip_dir[dir.len] = '\0';
  cs->clip_dir_len = dir.len;
}

hz_internal void app_character_copy_path(char *dst, CString src) {
  u32 n = cstr_len(src);
  assert_msg(n < APP_CHARACTER_PATH_MAX, "profile path too long: %",
             fmt_cstr(src));
  mem_cpy(dst, src, n);
  dst[n] = '\0';
}

// the profile the spawned character came from, NULL before the first one is
// ready.
hz_internal AppCharacterProfileBlobAsset *
app_character_profile(const AppCharacterSystem *cs, const AssetSystem *as) {
  if (!handle_is_valid(cs->active) || !asset_is_ready(as, cs->active))
    return NULL;
  return asset_get(as, cs->active, AppCharacterProfileBlobAsset);
}

hz_internal void app_character_system_init(AppCharacterSystem *cs,
                                           EcsWorld *w, AppMemory *memory) {
  *cs = (AppCharacterSystem){0};
  cs->spawn_query = ecs_query_cached(w, EcsIn(StageCharacterSpawn));
  app_character_set_clip_dir(cs, STR_FROM_CSTR(APP_SHARED_CLIP_DIR));
  // the emote loader (worker lanes) reads clip_dir through the registry
  engine_system_register(memory, AppCharacterSystem, cs);
}

// every BlobAssetRef in a profile, deduped by path in walk order. the deps
// pass and the load pass walk the same blob, so both see the same order.
typedef struct {
  BlobAssetRef **refs;
  u32 count, cap;
} AppProfileRefs;

hz_internal void app_profile_collect_ref(BlobAssetRef *ref, void *ctx) {
  AppProfileRefs *c = ctx;
  if (!ref->path.len)
    return;
  CString path = string_blob_get(&ref->path);
  for (u32 i = 0; i < c->count; i++)
    if (cstr_equal(string_blob_get(&c->refs[i]->path), path))
      return;
  assert_msg(c->count < c->cap, "profile: more than % asset refs",
             fmt_u32(c->cap));
  c->refs[c->count++] = ref;
}

hz_internal AppProfileRefs app_profile_refs(u8 *blob, Allocator *alloc) {
  AppProfileRefs c = {.cap = 32 + ECS_CLOTH_MAX_PER_MODEL};
  c.refs = ALLOC_ARRAY(alloc, BlobAssetRef *, c.cap);
  scene_walk_asset_refs(&AppCharacterProfileBlobAsset_typeinfo, blob,
                        app_profile_collect_ref, &c);
  return c;
}

// a profile depends on everything it references, so it is READY only once the
// whole character is loaded
hz_internal AssetDepsResult app_profile_deps(u8 *raw, u32 len, b32 stream,
                                             Allocator *alloc) {
  UNUSED(len);
  UNUSED(stream);
  AppProfileRefs c = app_profile_refs(raw, alloc);
  AssetDepEntry *deps = ALLOC_ARRAY(alloc, AssetDepEntry, c.count);
  for (u32 i = 0; i < c.count; i++)
    deps[i] = (AssetDepEntry){.path = string_blob_get(&c.refs[i]->path),
                              .type_id = c.refs[i]->typehash};
  return (AssetDepsResult){.entries = deps, .count = c.count};
}

typedef struct {
  AppProfileRefs unique;
  AssetLoadContext *lc;
} AppProfileBind;

hz_internal void app_profile_bind_ref(BlobAssetRef *ref, void *ctx) {
  AppProfileBind *b = ctx;
  if (!ref->path.len)
    return;
  CString path = string_blob_get(&ref->path);
  for (u32 i = 0; i < b->unique.count; i++)
    if (cstr_equal(string_blob_get(&b->unique.refs[i]->path), path)) {
      assert(i < b->lc->dependency_count);
      ref->handle = HANDLE_CAST(HzHandle, b->lc->dependencies[i]);
      return;
    }
}

// the blob is used in place; its refs get the loaded dependency handles
hz_internal void *app_profile_loader(AssetLoadContext *ctx) {
  tctx_temp_allocator_scope(ta, NULL) {
    AppProfileBind b = {.unique = app_profile_refs(ctx->raw_buffer,
                                                   &ta.allocator),
                        .lc = ctx};
    scene_walk_asset_refs(&AppCharacterProfileBlobAsset_typeinfo,
                          ctx->raw_buffer, app_profile_bind_ref, &b);
  }
  return ctx->raw_buffer;
}

hz_internal void app_character_register_loader(AssetSystem *as) {
  asset_register_loader(as, ASSET_TYPE(AppCharacterProfileBlobAsset),
                        app_profile_loader, app_profile_deps);
}

// requests a character. async: the current one stays until the new profile and
// everything it references are loaded, then app_character_update swaps.
hz_internal void app_character_set(AppCharacterSystem *cs, AssetSystem *as,
                                   CString profile_path) {
  if (handle_is_valid(cs->pending)) {
    if (cstr_equal(cs->pending_path, profile_path))
      return;
    asset_unload(as, HANDLE_CAST(AssetHandle, cs->pending));
    cs->pending = (HzHandleT(AppCharacterProfileBlobAsset)){0};
  }
  if (handle_is_valid(cs->active) && cstr_equal(cs->active_path, profile_path))
    return;
  app_character_copy_path(cs->pending_path, profile_path);
  cs->pending =
      asset_load(AppCharacterProfileBlobAsset, as, .path = profile_path);
  log_info("character: loading %", fmt_cstr(profile_path));
}

// moves every loaded emote's clip paths from the current clip dir to `to`. the
// loader applies the current dir to emotes that load later, so after this pass
// every emote, loaded or not, plays the new character's clips.
hz_internal void app_character_rebase_loaded_emotes(AppCharacterSystem *cs,
                                                    AssetSystem *as,
                                                    String to) {
  String from = app_character_clip_dir(cs);
  if (str_equal(from, to))
    return;
  u32 rebased = 0;
  for (u32 i = 0; i < as->entries.count; i++) {
    const AssetEntry *e = &as->entries.items[i];
    if (e->type_id != ASSET_TYPE(EmoteBlobAsset) ||
        e->state != ASSET_STATE_READY || !e->data)
      continue;
    u32 sparse = as->entries.dense_to_sparse[i];
    AssetHandle h = {.idx = sparse, .gen = as->entries.sparse[sparse].gen};
    u32 len = 0;
    u8 *nb = app_emote_rebase_clips((EmoteBlobAsset *)e->data, from, to, &len,
                                    &as->allocator);
    if (!nb)
      continue;
    // replace_blob may move the entries; `e` is not used past this point
    app_asset_replace_blob(as, h, nb, len);
    rebased++;
  }
  app_character_set_clip_dir(cs, to);
  log_info("character: % loaded emotes rebased to %", fmt_u32(rebased),
           fmt_str(to));
}

hz_internal i32 app_character_rest_expression(const AssetSystem *as,
                                              BlobAssetRef *set_ref) {
  ExpressionSetBlobAsset *set =
      blob_asset_ref_get(ExpressionSetBlobAsset, as, set_ref);
  Array(ExpressionBlobAsset) ex =
      blob_array_get(ExpressionBlobAsset, &set->expressions);
  for (u32 i = 0; i < ex.len; i++)
    if (cstr_equal(string_blob_get(&ex.items[i].name),
                   APP_CHARACTER_REST_EXPRESSION))
      return (i32)i;
  log_warn("character: expression set has no \"%\"; resting on index 0",
           fmt_cstr(APP_CHARACTER_REST_EXPRESSION));
  return 0;
}

// the character entity for a ready profile: exactly the components the
// character systems key on, and no SceneEntityTag.
hz_internal EcsEntity app_character_spawn(
    EcsWorld *w, AssetSystem *as,
    HzHandleT(AppCharacterProfileBlobAsset) profile_h, WorldTransform at) {
  AppCharacterProfileBlobAsset *p =
      asset_get(as, profile_h, AppCharacterProfileBlobAsset);
  EcsEntity e = ecs_entity_create(w);
  ecs_component_set(w, e, EntityName,
                    {.name = fixedstr64_from_len(string_blob_get(&p->name),
                                                 p->name.len)});
  ecs_component_set(w, e, WorldTransform, at);
  ecs_component_set(w, e, EcsVisibility,
                    {.visible = true, .casts_shadow = true});
  ecs_component_set(
      w, e, EcsModelRef,
      {.model = blob_asset_ref_from_handle(ModelBlobAsset, p->model.handle)});
  // a profile with no clips (FoxGlove, an imported .vrm with none) gets no
  // animation reference: the renderer would wait on it forever
  if (handle_is_valid(p->idle_clip.handle))
    ecs_component_set(w, e, EcsAnimationRef,
                      {.animation = blob_asset_ref_from_handle(
                           AnimationBlobAsset, p->idle_clip.handle)});
  ecs_component_set(w, e, EcsCharacterRigRef,
                    {.rig = blob_asset_ref_from_handle(CharacterRigBlobAsset,
                                                       p->rig.handle)});
  // a profile with no face gets no face components: they would wait on
  // assets that never load
  if (handle_is_valid(p->expressions.handle)) {
    ecs_component_set(w, e, EcsCharacterFaceRigRef,
                      {.face_rig = blob_asset_ref_from_handle(
                           CharacterFaceRigBlobAsset, p->face_rig.handle)});
    ecs_component_set(w, e, EcsExpressionSet,
                      {.set = blob_asset_ref_from_handle(ExpressionSetBlobAsset,
                                                         p->expressions.handle)});
    ecs_component_set(
        w, e, EcsExpression,
        {.expression = {app_character_rest_expression(as, &p->expressions)},
         .transition_duration = p->mood.transition});
    ecs_component_set(w, e, EcsCharacterEmotionSetRef,
                      {.emotions = blob_asset_ref_from_handle(
                           EmotionSetBlobAsset, p->emotions.handle)});
  }
  if (handle_is_valid(p->states.handle))
    ecs_component_set(w, e, EcsCharacterStatesRef,
                      {.states = blob_asset_ref_from_handle(
                           CharacterStatesBlobAsset, p->states.handle)});
  Array(AppCharacterCloth) cloth = blob_array_get(AppCharacterCloth, &p->cloth);
  assert_msg(cloth.len <= ECS_CLOTH_MAX_PER_MODEL, "character: % cloths, max %",
             fmt_u32(cloth.len), fmt_u32(ECS_CLOTH_MAX_PER_MODEL));
  EcsClothRefs refs = {0};
  for (u32 i = 0; i < cloth.len; i++)
    refs.cloths.items[refs.cloths.len++] = (EcsClothEntry){
        .cloth = blob_asset_ref_from_handle(ClothAuthoringBlobAsset,
                                            cloth.items[i].cloth.handle)};
  // the cloth system builds the model of an entity that has cloth refs, and
  // the plain model path skips it, so an empty set would never render
  if (refs.cloths.len)
    ecs_component_set(w, e, EcsClothRefs, refs);
  ecs_component_set(w, e, GazeConfig, p->gaze);
  ecs_component_set(w, e, BlinkConfig, p->blink);
  ecs_component_set(w, e, MicroExpressionConfig, p->micro);
  ecs_component_set(w, e, MoodCycleConfig, p->mood);
  ecs_component_set(w, e, EyeLifeConfig, p->eye_life);
  ecs_component_set(w, e, AppOverHairConfig, p->over_hair);
  ecs_component_set(w, e, AppCharacter, {.profile = profile_h});
  return e;
}

// index of the model joint playing `role` in the rig, or -1.
hz_internal i32 app_character_role_joint(CharacterRigBlobAsset *rig,
                                         ModelBlobAsset *mb, CString role) {
  Array(CharacterJointRole) roles =
      blob_array_get(CharacterJointRole, &rig->roles);
  Array(StringBlob) names = blob_array_get(StringBlob, &mb->joint_names);
  for (u32 r = 0; r < roles.len; r++) {
    if (!cstr_equal(string_blob_get(&roles.items[r].role), role))
      continue;
    CString joint = string_blob_get(&roles.items[r].joint);
    for (u32 j = 0; j < names.len; j++)
      if (cstr_equal(string_blob_get(&names.items[j]), joint))
        return (i32)j;
  }
  return -1;
}

// rest-pose eye midpoint height of a profile's model (model space: the
// bind-local pose through the hierarchy and the armature, as skinning does).
// false when the rig names no eyes on this model.
hz_internal b32 app_character_eye_height(const AssetSystem *as,
                                         AppCharacterProfileBlobAsset *p,
                                         f32 *out_y) {
  ModelBlobAsset *mb = blob_asset_ref_get(ModelBlobAsset, as, &p->model);
  CharacterRigBlobAsset *rig =
      blob_asset_ref_get(CharacterRigBlobAsset, as, &p->rig);
  i32 eye_l = app_character_role_joint(rig, mb, CHARACTER_JOINT_ROLE_EYE_L);
  i32 eye_r = app_character_role_joint(rig, mb, CHARACTER_JOINT_ROLE_EYE_R);
  if (eye_l < 0 || eye_r < 0)
    return false;
  Array(JointBlobAsset) joints = blob_array_get(JointBlobAsset, &mb->joints);
  Array(u32) order = blob_array_get(u32, &mb->joint_order);
  u32 n = joints.len;
  tctx_temp_allocator_scope(ta, NULL) {
    JointPose *local = ALLOC_ARRAY(&ta.allocator, JointPose, n);
    qvs *global = ALLOC_ARRAY(&ta.allocator, qvs, n);
    animation_fill_bind_local_pose(mb, local, n);
    qvs root = qvs_make(mb->armature_translation, mb->armature_rotation,
                        mb->armature_scale);
    for (u32 k = 0; k < order.len; k++) {
      u32 j = order.items[k];
      i32 parent = joints.items[j].parent_index;
      global[j] =
          qvs_mul(parent < 0 ? root : global[parent], joint_pose_to_qvs(local[j]));
    }
    *out_y = 0.5f * (global[eye_l].translation.y + global[eye_r].translation.y);
  }
  return true;
}

// the model's Over Hair set: `<model source>.overhair.hzt` beside its source file.
// invalid handle when the catalog has none
hz_internal HzHandleT(AppOverHairSetBlobAsset)
    app_character_load_over_hair_set(AssetSystem *as,
                              const AppCharacterProfileBlobAsset *p) {
  HzHandleT(AppOverHairSetBlobAsset) h = {0};
  AssetCatalogBlob *cat = asset_catalog_get(as);
  if (!cat || !p->model.path.len)
    return h;
  Array(AssetCatalogEntryBlob) e =
      blob_array_get(AssetCatalogEntryBlob, &cat->entries);
  tctx_temp_allocator_scope(ta, NULL) {
    String cooked =
        str_format(&ta.allocator, "cooked/%",
                   fmt_cstr(string_blob_get((StringBlob *)&p->model.path)));
    String src = {0};
    for (u32 i = 0; i < e.len; i++)
      if (str_equal(cstr_to_str(string_blob_get(&e.items[i].path)), cooked)) {
        src = cstr_to_str(string_blob_get(&e.items[i].source_path));
        break;
      }
    i32 dot = str_find_last(src, STR_FROM_CSTR("."));
    if (dot > 0) {
      String stem = {src.value, (u32)dot};
      String set_path =
          str_format(&ta.allocator, "%.overhair.hzt", fmt_str(stem));
      for (u32 i = 0; i < e.len; i++)
        if (e.items[i].type_id == ASSET_TYPE(AppOverHairSetBlobAsset) &&
            str_equal(cstr_to_str(string_blob_get(&e.items[i].source_path)),
                      set_path)) {
          h = asset_load(AppOverHairSetBlobAsset, as,
                         .path = set_path.value);
          break;
        }
    }
  }
  return h;
}

// true when `path`'s file name is the cooked material of glTF material `name`
// (`<name>_...` or `<name>.`), so "M_Face" never matches "M_FaceMask"
hz_internal b32 app_material_path_is(String path, String name) {
  String file = str_path_basename(path);
  if (!str_starts_with(file, name) || file.len == name.len)
    return false;
  char next = file.value[name.len];
  return next == '_' || next == '.';
}

// once per spawn, when the model instance is live: resolve every submesh whose
// material the Over Hair set lists and set its uv rect; then, every
// frame, push the entity's AppOverHairConfig to those materials whenever it
// changes. a material the app never configures keeps over_hair_params = 0, so
// its pass draws nothing.
// main thread only: touches renderer state.
hz_internal void app_character_over_hair_resolve(AppCharacterSystem *cs,
                                                 EcsWorld *w) {
  AssetSystem *as = ecs_resource_get_mut(w, AssetSystem);
  if (!handle_is_valid(cs->over_hair_set)) {
    cs->over_hair_ready = true;
    return;
  }
  AssetState st = asset_get_state(as, HANDLE_CAST(AssetHandle, cs->over_hair_set));
  if (st == ASSET_STATE_FAILED) {
    log_warn("character: Over Hair set failed to load; Over Hair off");
    cs->over_hair_ready = true;
    return;
  }
  if (st != ASSET_STATE_READY)
    return;
  const EcsModelInstance *mi = ecs_component_get(w, cs->entity, EcsModelInstance);
  const EcsModelRef *mref = ecs_component_get(w, cs->entity, EcsModelRef);
  RendererState *r = ecs_resource_get_mut(w, RendererState);
  const RendererModelInstance *ri = mi ? renderer_model_instance(r, mi->instance) : NULL;
  if (!ri || ri->lods.len == 0 || !mref ||
      !asset_is_ready(as, mref->model.handle))
    return;
  AppOverHairSetBlobAsset *rep =
      asset_get(as, cs->over_hair_set, AppOverHairSetBlobAsset);
  Array(AppCharacterOverHair) oh = blob_array_get(AppCharacterOverHair, &rep->over_hair);
  ModelBlobAsset *mb = asset_get(
      as, HANDLE_CAST(HzHandleT(ModelBlobAsset), mref->model.handle), ModelBlobAsset);
  Array(MeshBlobAsset) meshes = blob_array_get(MeshBlobAsset, &mb->meshes);
  const RendererModelInstanceLod *lod = &ri->lods.items[0];
  cs->over_hair_count = 0;
  for (u32 o = 0; o < oh.len; o++) {
    String name = cstr_to_str(string_blob_get(&oh.items[o].material));
    u32 hits = 0;
    for (u32 m = 0; m < meshes.len && m < lod->mesh_instances.len; m++) {
      Array(SubMeshBlobAsset) subs =
          blob_array_get(SubMeshBlobAsset, &meshes.items[m].submeshes);
      const RendererMeshInstance *rmi = &lod->mesh_instances.items[m];
      for (u32 s = 0; s < subs.len && s < rmi->children.len; s++) {
        if (!app_material_path_is(
                cstr_to_str(string_blob_get(&subs.items[s].material.path)), name))
          continue;
        HzHandleT(RendererMaterial) sm =
            renderer_submesh_instance_material(r, rmi->children.items[s]);
        if (!handle_is_valid(HANDLE_CAST(HzHandle, sm)))
          continue;
        if (cs->over_hair_count == APP_OVER_HAIR_MAX) {
          log_warn("character: more than % Over Hair materials; the rest are off",
                   fmt_u32(APP_OVER_HAIR_MAX));
          continue;
        }
        material_set_vec4(r, sm, "over_hair_rect", oh.items[o].uv_rect);
        cs->over_hair_mats[cs->over_hair_count++] = HANDLE_CAST(HzHandle, sm);
        hits++;
      }
    }
    if (hits == 0)
      log_warn("character: Over Hair material \"%\" is not on the model",
               fmt_str(name));
    else
      log_info("character: Over Hair on \"%\"", fmt_str(name));
  }
  // force the first push
  cs->over_hair_pushed = (AppOverHairConfig){-1.0f, -1.0f, -1.0f, -1.0f};
  cs->over_hair_ready = true;
}

hz_internal void app_character_over_hair_update(AppCharacterSystem *cs,
                                                EcsWorld *w) {
  if (!cs->entity)
    return;
  if (!cs->over_hair_ready)
    app_character_over_hair_resolve(cs, w);
  if (!cs->over_hair_ready || cs->over_hair_count == 0)
    return;
  const AppOverHairConfig *c = ecs_component_get(w, cs->entity, AppOverHairConfig);
  if (!c || memcmp(c, &cs->over_hair_pushed, sizeof(*c)) == 0)
    return;
  RendererState *r = ecs_resource_get_mut(w, RendererState);
  vec4 params = {c->push, c->opacity, c->fade_start, c->fade_end};
  for (u32 i = 0; i < cs->over_hair_count; i++)
    material_set_vec4(r, HANDLE_CAST(HzHandleT(RendererMaterial), cs->over_hair_mats[i]),
                      "over_hair_params", params);
  cs->over_hair_pushed = *c;
}

// main thread, once per frame: finishes a requested swap, spawns the character
// once the stage is loaded, and resolves the camera eye offset.
hz_internal void app_character_update(AppCharacterSystem *cs, EcsWorld *w) {
  AssetSystem *as = ecs_resource_get_mut(w, AssetSystem);
  if (handle_is_valid(cs->pending)) {
    AssetState st = asset_get_state(as, HANDLE_CAST(AssetHandle, cs->pending));
    if (st == ASSET_STATE_FAILED) {
      log_error("character: profile % failed to load; keeping the current one",
                fmt_cstr(cs->pending_path));
      asset_unload(as, HANDLE_CAST(AssetHandle, cs->pending));
      cs->pending = (HzHandleT(AppCharacterProfileBlobAsset)){0};
    } else if (st == ASSET_STATE_READY) {
      if (cs->entity && ecs_entity_is_alive(w, cs->entity))
        ecs_entity_destroy(w, cs->entity);
      cs->entity = 0;
      cs->cam_offset_ready = false;
      // unload after the new one is ready so shared dependencies never drop
      if (handle_is_valid(cs->active))
        asset_unload(as, HANDLE_CAST(AssetHandle, cs->active));
      cs->active = cs->pending;
      app_character_copy_path(cs->active_path, cs->pending_path);
      cs->pending = (HzHandleT(AppCharacterProfileBlobAsset)){0};
      // a profile with no clip folder (an imported model) has nothing to rebase
      AppCharacterProfileBlobAsset *p = app_character_profile(cs, as);
      if (p && p->clip_dir.len)
        app_character_rebase_loaded_emotes(
            cs, as, (String){string_blob_get(&p->clip_dir), p->clip_dir.len});
    }
  }

  if (!cs->entity && handle_is_valid(cs->active) &&
      asset_is_ready(as, cs->active)) {
    EcsIter it = ecs_query_iter(cs->spawn_query);
    if (ecs_iter_next(&it) && it.count > 0) {
      const WorldTransform *wt =
          ecs_component_get(w, it.entities[0], WorldTransform);
      WorldTransform at = wt ? *wt
                             : (WorldTransform){.rotation = quat_identity(),
                                                .scale = {1.0f, 1.0f, 1.0f}};
      cs->entity = app_character_spawn(w, as, cs->active, at);
      cs->spawn_count++;
      AppCharacterProfileBlobAsset *p = app_character_profile(cs, as);
      if (handle_is_valid(cs->over_hair_set))
        asset_unload(as, HANDLE_CAST(AssetHandle, cs->over_hair_set));
      cs->over_hair_set = app_character_load_over_hair_set(as, p);
      cs->over_hair_ready = false;
      cs->over_hair_count = 0;
      log_info("character: spawned % (%)", fmt_cstr(string_blob_get(&p->name)),
               fmt_cstr(cs->active_path));
    }
  }

  if (cs->entity && !cs->cam_offset_ready) {
    EcsIter it = ecs_query_iter(cs->spawn_query);
    const StageCharacterSpawn *sp = NULL;
    if (ecs_iter_next(&it) && it.count > 0)
      sp = ecs_component_get(w, it.entities[0], StageCharacterSpawn);
    AppCharacterProfileBlobAsset *p = app_character_profile(cs, as);
    f32 eye_y = 0.0f;
    if (sp && p && app_character_eye_height(as, p, &eye_y)) {
      cs->cam_offset_y = eye_y - sp->framed_eye_height;
      log_info("character: eye height % m, camera offset % m",
               fmt_f32_p(eye_y, 6), fmt_f32_p(cs->cam_offset_y, 6));
    } else {
      cs->cam_offset_y = 0.0f;
      log_warn("character: rig names no eye joints on this model; camera "
               "not adjusted for its height");
    }
    cs->cam_offset_ready = true;
  }
}
