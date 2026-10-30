// the character player: the stage scene, one character on it, and the
// engine's voice session talking to the harness runtime. HARNESS_URL picks the
// runtime and HARNESS_CHARACTER the character profile.
#include "character/character.h"
#include "perf_stats.h"
#include "ecs/camera/ecs_camera.h"
#include "ecs/ecs_assets/ecs_assets.h"
#include "ecs/ecs.h"
#include "ecs/input/ecs_input.h"
#include "ecs/transform/ecs_transform.h"
#include "ecs/renderer/ecs_renderer.h"
#include "ecs/ecs_cloth/ecs_cloth.h"
#include "ecs/audio/ecs_audio.h"
#include "lib/thread_context.h"
#include "lib/typedefs.h"
#include "lib/hzmath.h"
#include "lib/memory.h"
#include "lib/string.h"
#include "lib/microphone.h"
#include "os/os.h"
#include "app/app.h"
#include "app/app_config.h"
#include "app/app_character.h"
#include "app/player.h"
#include "app/player_vrm.h"
#include "app/player_offers.h"
#include "rendering/renderer.h"
#include "rendering/material.h"
#include "rendering/camera.h"
#include "assets/assets.h"
#include "scene/scene.h"
#include "audio.h"
#include "hz_engine.h"
#include "animation/animation.h"
#include "generated/shaders/studio_alpha.h"
#if defined(_WIN32)
#include <windows.h>
#elif defined(MACOS)
#include <objc/message.h>
#include <objc/runtime.h>
#endif
#if defined(HZ_PUBLISH) && defined(MACOS)
#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

ECS_COMPONENT_TYPEDEF(AppMemory);

// portrait, the aspect the stage camera is framed for
const HzAppConfig hz_app_config = {.window_title = "Character Player",
                                   .window_width = 414,
                                   .window_height = 900};

// a framing on top of the player's own: fov, and offsets right/up/toward the character
typedef struct {
  f32 fov, x, y, distance;
} PlayerCamMove;

typedef struct AppState {
  EcsWorld *world;
  SceneSystem scene_sys;
  SceneHandle scene;
  AppCharacterSystem character;
  EcsQuery *camera_query;
  EcsQuery *scene_settings_query;
  EcsQuery *model_query;
  AudioSystem audio;
  Microphone mic;
  f32 *mic_buf;
  u32 mic_running;
  u32 mic_busy;
  u32 mic_failed;        // the last start failed; retry after PLAYER_MIC_RETRY_MS
  u64 mic_started_at;    // when the current or last start began
  u64 mic_live_at;       // when capture came up, for the echo-cancellation warm-up
  b32 mic_warned;        // the slow start has been reported
  b32 mic_denied_logged; // a denied permission has been reported
  b32 mic_debug;         // HARNESS_MIC_DEBUG=1
  f32 mic_debug_t;
  f32 mic_debug_peak;    // loudest sample since the last debug line
  u32 mic_debug_frames;
  CharacterVoice vs;
  PlayerOffers offers;
  f32 talk_hold;
  i32 last_talk_want;
  HzHandleT(GestureSetBlobAsset) gesture_asset;
  HzHandleT(CameraMoveSetBlobAsset) camera_moves_asset;
  u32 last_beat_gen;
  // the camera move from the latest beat: eases cam_cur from cam_from to cam_to
  b32 cam_active;
  PlayerCamMove cam_from, cam_to, cam_cur;
  f32 cam_t, cam_dur;
  u32 cam_curve;
  char url[PLAYER_ENV_MAX];
  char character_path[PLAYER_ENV_MAX];
  // an imported character with no clips: it holds its bind pose and beats
  // skip gestures and talking styles
  b32 bind_pose_body;
  PlayerVrm vrm;
  char preview[PLAYER_ENV_MAX]; // HARNESS_PREVIEW
  f32 preview_t;
  char screenshot[PLAYER_ENV_MAX]; // HARNESS_SCREENSHOT
  char studio_url[PLAYER_ENV_MAX];
  // Studio shows frames read back from an offscreen target (desktop), or the
  // canvas a web build draws on, which the page shows itself
  b32 studio_frames;
  OsWebSocket *studio_ws;
  f32 studio_retry, studio_age, studio_mouth;
  b32 studio_talking, studio_frame_pending, studio_frame_ready;
  GpuRenderTarget studio_target, studio_composite;
  GpuPipeline studio_alpha_pipeline;
  GpuTexture studio_scene;
  u8 *studio_pixels;
  f32 studio_frame_time;
  b32 studio_window_hidden;
  u32 studio_width, studio_height, studio_wanted_width, studio_wanted_height;
} AppState;

#if defined(_WIN32)
hz_internal BOOL CALLBACK player_studio_hide_window(HWND hwnd, LPARAM unused) {
  UNUSED(unused);
  DWORD pid=0;
  GetWindowThreadProcessId(hwnd,&pid);
  if (pid==GetCurrentProcessId() && !GetParent(hwnd)) ShowWindow(hwnd,SW_HIDE);
  return TRUE;
}
#endif

hz_internal void player_studio_hide_window_once(AppState *s) {
  if (s->studio_window_hidden) return;
#if defined(_WIN32)
  EnumWindows(player_studio_hide_window,0);
#elif defined(MACOS)
  id app=((id (*)(id,SEL))objc_msgSend)((id)objc_getClass("NSApplication"),sel_registerName("sharedApplication"));
  id windows=((id (*)(id,SEL))objc_msgSend)(app,sel_registerName("windows"));
  unsigned long count=((unsigned long (*)(id,SEL))objc_msgSend)(windows,sel_registerName("count"));
  for (unsigned long i=0;i<count;i++) {
    id window=((id (*)(id,SEL,unsigned long))objc_msgSend)(windows,sel_registerName("objectAtIndex:"),i);
    ((void (*)(id,SEL,id))objc_msgSend)(window,sel_registerName("orderOut:"),(id)0);
  }
  ((void (*)(id,SEL,long))objc_msgSend)(app,sel_registerName("setActivationPolicy:"),1);
#endif
  s->studio_window_hidden=true;
}

// true when `path` ends in `ext` (lowercase, with the dot), in any case
hz_internal b32 player_has_ext(CString path, const char *ext) {
  u32 n = cstr_len(path), m = cstr_len(ext);
  if (n < m)
    return false;
  for (u32 i = 0; i < m; i++) {
    char c = path[n - m + i];
    if ((c >= 'A' && c <= 'Z' ? c + 32 : c) != ext[i])
      return false;
  }
  return true;
}

// `name` from the environment into `out`, or `fallback` when unset
hz_internal void player_env(CString name, CString fallback, char *out) {
  u32 len = os_env_get(name, out, PLAYER_ENV_MAX);
  if (len > 0 && len < PLAYER_ENV_MAX)
    return;
  // os_env_get returns 0 for a value that does not fit; a larger buffer tells
  // that apart from an unset variable
  char probe[PLAYER_ENV_MAX * 8];
  if (len == 0 && os_env_get(name, probe, sizeof(probe)) > 0)
    log_error("player: % is longer than % characters; ignoring it", fmt_cstr(name),
              fmt_u32(PLAYER_ENV_MAX - 1));
  u32 n = cstr_len(fallback);
  mem_cpy(out, fallback, n);
  out[n] = 0;
}

// a `listen` value in (0, max), else 0: the engine takes 0 as its default
hz_internal f64 player_listen_value(PJson *listen, const char *key, f64 max) {
  PJson *value = pjson_get(listen, key);
  if (!value)
    return 0;
  if (value->kind != PJSON_NUMBER) {
    log_error("player: % % is not a number; it keeps its default", fmt_cstr(PLAYER_LISTEN_ENV),
              fmt_cstr(key));
    return 0;
  }
  if (value->number > 0 && value->number < max)
    return value->number;
  log_error("player: % % is out of range; it keeps its default", fmt_cstr(PLAYER_LISTEN_ENV),
            fmt_cstr(key));
  return 0;
}

// the character's `listen` settings onto the voice config. The runtime checks
// them against the manifest's ranges; this only keeps a value the engine can
// take, for a player started by hand.
hz_internal void player_listen(CString text, CharacterVoiceDesc *voice, Allocator *alloc) {
  if (!text[0])
    return;
  PJson *listen = pjson_parse(text, cstr_len(text), alloc);
  if (!listen || listen->kind != PJSON_OBJECT) {
    log_error("player: % is not a JSON object; listening keeps its defaults",
              fmt_cstr(PLAYER_LISTEN_ENV));
    return;
  }
  voice->endpoint_silence_ms = (u32)player_listen_value(listen, "end_of_speech_ms", 60000);
  voice->barge_confirm_ms = (u32)player_listen_value(listen, "barge_in_ms", 60000);
  // the two thresholds go together, release below onset, or neither applies
  f32 hi = (f32)player_listen_value(listen, "speech_threshold", 1);
  f32 lo = (f32)player_listen_value(listen, "silence_threshold", 1);
  if (hi > 0 && lo > 0 && lo < hi) {
    voice->vad_hi = hi;
    voice->vad_lo = lo;
  } else if (hi > 0 || lo > 0) {
    log_error("player: % needs speech_threshold and silence_threshold together, silence "
              "below speech; both keep their defaults",
              fmt_cstr(PLAYER_LISTEN_ENV));
  }
  voice->echo_peak_floor = (f32)player_listen_value(listen, "echo_floor", 1);
}

// one-shot per model: finds the face skin and eye materials by the names the
// profile gives and caches them, so the expression channels can drive them
ecs_system(player_face_material_resolve_system, EcsIn(EcsModelInstance),
           EcsIn(EcsModelRef), EcsIn(EcsFace), EcsIn(AppCharacter),
           EcsNot(EcsFaceMaterial), EcsResIn(AssetSystem),
           EcsResInOut(RendererState)) {
  RendererState *r = ecs_sys_get_resource_mut(RendererState);
  const AssetSystem *as = ecs_sys_get_resource(AssetSystem);
  for (i32 i = 0; i < it->count; i++) {
    const EcsModelInstance *mi = ecs_sys_get_component(EcsModelInstance, i);
    const EcsModelRef *mref = ecs_sys_get_component(EcsModelRef, i);
    const EcsFace *face = ecs_sys_get_component(EcsFace, i);
    const AppCharacter *ch = ecs_sys_get_component(AppCharacter, i);
    if (!asset_is_ready(as, ch->profile))
      continue;
    AppCharacterProfileBlobAsset *prof =
        asset_get(as, ch->profile, AppCharacterProfileBlobAsset);
    String skin_name = {string_blob_get(&prof->face_skin_material),
                        prof->face_skin_material.len};
    String eye_name = {string_blob_get(&prof->face_eye_material),
                       prof->face_eye_material.len};
    const RendererModelInstance *ri = renderer_model_instance(r, mi->instance);
    if (!ri || ri->lods.len == 0)
      continue;
    if (!handle_is_valid(mref->model.handle) ||
        !asset_is_ready(as, mref->model.handle))
      continue;
    const RendererModelInstanceLod *lod = &ri->lods.items[0];
    u32 fm = face->bs_mesh_index;
    if (fm >= lod->mesh_instances.len)
      continue;
    ModelBlobAsset *mb = asset_get(
        as, HANDLE_CAST(HzHandleT(ModelBlobAsset), mref->model.handle),
        ModelBlobAsset);
    Array(MeshBlobAsset) meshes = blob_array_get(MeshBlobAsset, &mb->meshes);
    if (fm >= meshes.len)
      continue;
    Array(SubMeshBlobAsset) subs =
        blob_array_get(SubMeshBlobAsset, &meshes.items[fm].submeshes);
    const RendererMeshInstance *rmi = &lod->mesh_instances.items[fm];

    HzHandleT(RendererMaterial) face_mat =
        INVALID_HANDLE_T(HzHandleT(RendererMaterial));
    HzHandleT(RendererMaterial) eye_mat =
        INVALID_HANDLE_T(HzHandleT(RendererMaterial));
    for (u32 s = 0; s < subs.len && s < rmi->children.len; s++) {
      CString sn = subs.items[s].name.len ? string_blob_get(&subs.items[s].name)
                                          : NULL;
      CString mp = subs.items[s].material.path.len
                       ? string_blob_get(&subs.items[s].material.path)
                       : NULL;
      HzHandleT(RendererMaterial) sm =
          renderer_submesh_instance_material(r, rmi->children.items[s]);
      if (!handle_is_valid(HANDLE_CAST(HzHandle, sm)))
        continue;
      String nm = sn ? cstr_to_str(sn) : (mp ? cstr_to_str(mp) : (String){0});
      if (skin_name.len && str_contains_nocase(nm, skin_name))
        face_mat = sm;
      else if (eye_name.len && str_contains_nocase(nm, eye_name))
        eye_mat = sm;
    }
    f32 teary_amp = 0.0f;
    if (handle_is_valid(HANDLE_CAST(HzHandle, face_mat)))
      material_set_vec4(r, face_mat, "blush_params",
                        (vec4){0.0f, 0.0f, 0.0f, 0.0f});
    if (handle_is_valid(HANDLE_CAST(HzHandle, eye_mat))) {
      Material *em = renderer_material_mut(r, eye_mat);
      MaterialProperty *sp =
          em ? material_find_property(em, "star_teary_params") : NULL;
      vec4 stp = {0};
      if (sp)
        renderer_material_read_value(r, eye_mat, sp, &stp, sizeof(vec4));
      teary_amp = stp.w;
      material_set_vec4(r, eye_mat, "star_teary_params",
                        (vec4){0.0f, 0.0f, 0.0f, teary_amp});
    }
    ecs_component_set(it->world, it->entities[i], EcsFaceMaterial,
                      {.mat = HANDLE_CAST(HzHandle, face_mat),
                       .eye_mat = HANDLE_CAST(HzHandle, eye_mat),
                       .teary_amp = teary_amp});
  }
}

// pushes the expression material channels when they change: blush/nervous to
// the face skin, sparkle/tears to the eyes
ecs_system(player_expression_material_system, EcsInOut(EcsFaceMaterial),
           EcsIn(EcsExpressionRuntime), EcsResInOut(RendererState)) {
  RendererState *r = ecs_sys_get_resource_mut(RendererState);
  for (i32 i = 0; i < it->count; i++) {
    EcsFaceMaterial *fm = ecs_sys_get_component_mut(EcsFaceMaterial, i);
    const EcsExpressionRuntime *rt =
        ecs_sys_get_component(EcsExpressionRuntime, i);
    HzHandleT(RendererMaterial) face_mat =
        HANDLE_CAST(HzHandleT(RendererMaterial), fm->mat);
    if (handle_is_valid(HANDLE_CAST(HzHandle, face_mat))) {
      f32 blush = rt->cur_mat[CHARACTER_MAT_CHANNEL_BLUSH];
      f32 nervous = rt->cur_mat[CHARACTER_MAT_CHANNEL_NERVOUS];
      if (blush != fm->last_blush || nervous != fm->last_nervous) {
        material_set_vec4(r, face_mat, "blush_params",
                          (vec4){blush, nervous, 0.0f, 0.0f});
        fm->last_blush = blush;
        fm->last_nervous = nervous;
      }
    }
    HzHandleT(RendererMaterial) eye_mat =
        HANDLE_CAST(HzHandleT(RendererMaterial), fm->eye_mat);
    if (handle_is_valid(HANDLE_CAST(HzHandle, eye_mat))) {
      f32 star = rt->cur_mat[CHARACTER_MAT_CHANNEL_STAR];
      f32 teary = rt->cur_mat[CHARACTER_MAT_CHANNEL_TEARY];
      if (star != fm->last_star || teary != fm->last_teary) {
        material_set_vec4(r, eye_mat, "star_teary_params",
                          (vec4){star, teary > 0.0f ? 1.0f : 0.0f, teary,
                                 fm->teary_amp});
        fm->last_star = star;
        fm->last_teary = teary;
      }
    }
  }
}

// seeds LightAim once from the light's authored direction
ecs_system(light_aim_init_system, EcsIn(WorldTransform),
           EcsIn(EcsDirectionalLight), EcsNot(LightAim)) {
  for (i32 i = 0; i < it->count; i++) {
    const WorldTransform *wt = ecs_sys_get_component(WorldTransform, i);
    v3 dir = quat_rotate(wt->rotation, V3_FORWARD);
    f32 az = m_degrees(m_atan2f(dir.x, dir.z));
    f32 el = m_degrees(m_asinf(m_clampf(-dir.y, -1.0f, 1.0f)));
    ecs_component_set(it->world, it->entities[i], LightAim,
                      {.azimuth_deg = az, .elevation_deg = el});
  }
}

ecs_system(light_aim_apply_system, EcsIn(LightAim), EcsInOut(WorldTransform)) {
  for (i32 i = 0; i < it->count; i++) {
    const LightAim *aim = ecs_sys_get_component(LightAim, i);
    WorldTransform *wt = ecs_sys_get_component_mut(WorldTransform, i);
    wt->rotation =
        quat_mul(quat_axis_angle(V3_UP, m_radians(aim->azimuth_deg)),
                 quat_axis_angle(V3_RIGHT, m_radians(aim->elevation_deg)));
  }
}

// hair and face decals casting shadows onto the face looks wrong, so those
// submeshes are dropped from the shadow pass, once per submesh
ecs_system(player_submesh_shadow_optout_system, EcsIn(EcsSubMesh),
           EcsNot(EcsVisibility)) {
  for (i32 i = 0; i < it->count; i++) {
    const EcsSubMesh *sm = ecs_sys_get_component(EcsSubMesh, i);
    String nm = STR(sm->name.value, sm->name.len);
    b32 no_cast = str_contains_nocase(nm, STR_FROM_CSTR("hair")) ||
                  str_contains_nocase(nm, STR_FROM_CSTR("eye")) ||
                  str_contains_nocase(nm, STR_FROM_CSTR("brow")) ||
                  str_contains_nocase(nm, STR_FROM_CSTR("mouth"));
    ecs_component_set(it->world, it->entities[i], EcsVisibility,
                      {.visible = true, .casts_shadow = !no_cast});
  }
}

// a skinned model with no clip driving it still needs posing, or its joints
// collapse; this marks it for the renderer's procedural pose stage
ecs_system(player_bind_pose_add_system, EcsIn(EcsSkinnedModel), EcsNot(EcsProceduralPose)) {
  for (i32 i = 0; i < it->count; i++)
    ecs_component_set(it->world, it->entities[i], EcsProceduralPose, {0});
}

// holds every skinned model in its bind pose; gaze and the face still layer on top
ecs_system(player_bind_pose_system, EcsInOut(EcsSkinnedModel), EcsIn(EcsModelRef),
           EcsResIn(AssetSystem)) {
  const AssetSystem *as = ecs_sys_get_resource(AssetSystem);
  for (i32 i = 0; i < it->count; i++) {
    EcsSkinnedModel *sk = ecs_sys_get_component_mut(EcsSkinnedModel, i);
    const EcsModelRef *mref = ecs_sys_get_component(EcsModelRef, i);
    if (!sk->joint_poses || !sk->joint_count || !asset_is_ready(as, mref->model.handle))
      continue;
    ModelBlobAsset *model = asset_get(
        as, HANDLE_CAST(HzHandleT(ModelBlobAsset), mref->model.handle), ModelBlobAsset);
    if (model)
      animation_fill_bind_local_pose(model, sk->joint_poses, sk->joint_count);
  }
}

// the CoreAudio bring-up (~1.8 s) runs on a detached thread so no lane stalls
hz_internal void player_mic_start_worker(void *arg) {
  AppState *s = (AppState *)arg;
  log_info("mic: starting capture");
  if (mic_start(&s->mic, &(MicConfig){.target_sample_rate = 16000})) {
    atomic_u32_write_release(&s->mic_running, 1);
  } else {
    log_error("mic: failed to start capture; retrying in % ms",
              fmt_f64(PLAYER_MIC_RETRY_MS));
    atomic_u32_write_release(&s->mic_failed, 1);
  }
  atomic_u32_write_release(&s->mic_busy, 0);
}

hz_internal void player_mic_tick(AppState *s) {
  b32 running = atomic_u32_read_acquire(&s->mic_running) != 0;
  b32 busy = atomic_u32_read_acquire(&s->mic_busy) != 0;
  f64 since_start = s->mic_started_at
                        ? os_ticks_to_ms(os_time_diff(os_time_now(), s->mic_started_at))
                        : 0.0;
  if (!running && !busy) {
    OsMicPermission perm = mic_permission();
    b32 waiting = atomic_u32_read_acquire(&s->mic_failed) &&
                  since_start < PLAYER_MIC_RETRY_MS;
    if (perm == OS_MIC_PERMISSION_GRANTED && !waiting) {
      atomic_u32_write_release(&s->mic_failed, 0);
      atomic_u32_write_release(&s->mic_busy, 1);
      s->mic_started_at = os_time_now();
      s->mic_warned = false;
      os_thread_detach(os_thread_launch(player_mic_start_worker, s));
    } else if (perm == OS_MIC_PERMISSION_DENIED && !s->mic_denied_logged) {
      s->mic_denied_logged = true;
      log_error("mic: permission denied; allow it in System Settings > "
                "Privacy & Security > Microphone");
    }
  } else if (busy && !s->mic_warned && since_start > PLAYER_MIC_START_WARN_MS) {
    s->mic_warned = true;
    log_warn("mic: capture has not started after % ms; the character can't hear you. "
             "Is another app using the microphone?",
             fmt_f64(PLAYER_MIC_START_WARN_MS));
  }
  b32 live = atomic_u32_read_acquire(&s->mic_running) != 0;
  character_voice_set_active(&s->vs, live);
  if (!live)
    return;
  if (!s->mic_live_at)
    s->mic_live_at = os_time_now();
  if (!s->vs.aec_warmed &&
      os_ticks_to_ms(os_time_diff(os_time_now(), s->mic_live_at)) > PLAYER_AEC_WARM_MS) {
    s->vs.aec_warmed = true;
    log_info("mic: echo cancellation settled; the character can be interrupted while speaking");
  }
  for (;;) {
    i32 n = mic_read(&s->mic, s->mic_buf, PLAYER_MIC_SCRATCH);
    if (n <= 0)
      break;
    if (s->mic_debug)
      for (i32 k = 0; k < n; k++) {
        f32 v = s->mic_buf[k] < 0.0f ? -s->mic_buf[k] : s->mic_buf[k];
        if (v > s->mic_debug_peak)
          s->mic_debug_peak = v;
      }
    s->mic_debug_frames += (u32)n;
    character_voice_feed_mic(&s->vs, s->mic_buf, (u32)n);
    if (n < PLAYER_MIC_SCRATCH)
      break;
  }
}

// one line twice a second: is the mic running and fed, is the session
// listening, and how far a barge-in has got while the character speaks
hz_internal void player_mic_debug_tick(AppState *s, f32 dt) {
  if (!s->mic_debug)
    return;
  s->mic_debug_t += dt;
  if (s->mic_debug_t < PLAYER_MIC_DEBUG_EVERY)
    return;
  s->mic_debug_t = 0.0f;
  CharacterVoiceDebug d = character_voice_debug(&s->vs);
  log_info("mic debug: running=% frames=% peak=% active=% phase=% tts=% "
           "aec_warmed=% speaking=% barge_run=%ms vad_ready=%",
           fmt_u32(atomic_u32_read_acquire(&s->mic_running)),
           fmt_u32(s->mic_debug_frames), fmt_f32_p(s->mic_debug_peak, 3),
           fmt_b32(s->vs.active), fmt_u32((u32)s->vs.phase),
           fmt_u32((u32)d.tts_state), fmt_b32(d.aec_warmed),
           fmt_b32(character_voice_speaking_audio(&s->vs)),
           fmt_f32_p(s->vs.barge_run_ms, 0), fmt_b32(s->vs.vad_ready));
  s->mic_debug_peak = 0.0f;
  s->mic_debug_frames = 0;
}

// the body follows the actual voice audio, the same clock the mouth uses, with a
// hangover so the last gesture settles
hz_internal void player_talk_tick(AppState *s, f32 dt) {
  if (character_voice_speaking_audio(&s->vs))
    s->talk_hold = PLAYER_TALK_HANGOVER;
  else if (s->talk_hold > 0.0f)
    s->talk_hold -= dt;
  i32 want = s->talk_hold > 0.0f ? ACTOR_STATE_TALKING : ACTOR_STATE_IDLE;
  if (want == s->last_talk_want)
    return;
  s->last_talk_want = want;
  for (EcsIter it = ecs_query_iter(s->model_query); ecs_iter_next(&it);)
    for (i32 i = 0; i < it.count; i++)
      character_actor_state_request(s->world, it.entities[i], want);
}

hz_internal GestureBlobEntry *player_gesture(AppState *s, EcsWorld *w,
                                              const char *name) {
  AssetSystem *a = ecs_resource_get_mut(w, AssetSystem);
  if (!asset_is_ready(a, s->gesture_asset))
    return NULL;
  GestureSetBlobAsset *set = asset_get(a, s->gesture_asset, GestureSetBlobAsset);
  Array(GestureBlobEntry) gs = blob_array_get(GestureBlobEntry, &set->gestures);
  for (u32 i = 0; i < gs.len; i++)
    if (cstr_equal(string_blob_get(&gs.items[i].name), name))
      return &gs.items[i];
  return NULL;
}

// starts easing the framing toward the named camera move; unknown names do nothing
hz_internal void player_camera_move(AppState *s, EcsWorld *w, const char *name) {
  AssetSystem *a = ecs_resource_get_mut(w, AssetSystem);
  if (!asset_is_ready(a, s->camera_moves_asset))
    return;
  CameraMoveSetBlobAsset *set =
      asset_get(a, s->camera_moves_asset, CameraMoveSetBlobAsset);
  Array(CameraMoveBlobEntry) ms = blob_array_get(CameraMoveBlobEntry, &set->moves);
  for (u32 i = 0; i < ms.len; i++) {
    CameraMoveBlobEntry *m = &ms.items[i];
    if (!cstr_equal(string_blob_get(&m->name), name))
      continue;
    s->cam_from = s->cam_active ? s->cam_cur
                                : (PlayerCamMove){.fov = PLAYER_CAM_FOV};
    if (!s->cam_active)
      s->cam_cur = s->cam_from;
    s->cam_to = (PlayerCamMove){
        .fov = m->fov > 0.0f ? m->fov * PLAYER_CAM_FOV / PLAYER_STAGE_FOV
                             : PLAYER_CAM_FOV,
        .x = m->x,
        .y = m->y,
        .distance = m->distance};
    s->cam_t = 0.0f;
    s->cam_dur = m->transition > 0.0f ? m->transition : 0.6f;
    s->cam_curve = m->curve;
    s->cam_active = true;
    return;
  }
}

// The body's part of a beat: the talking style switches the body loop, and a
// gesture plays once (or holds until the next beat).
hz_internal void player_body_beat(AppState *s, EcsWorld *w, const char *reg,
                                  const char *gesture) {
  // a body holding its bind pose has no clips to play
  if (s->bind_pose_body)
    return;
  b32 want_gesture = gesture && gesture[0] && !cstr_equal(gesture, "none");
  GestureBlobEntry *g = want_gesture ? player_gesture(s, w, gesture) : NULL;
  if (want_gesture && !g && handle_is_valid(s->gesture_asset) &&
      asset_is_ready(ecs_resource_get(w, AssetSystem), s->gesture_asset))
    log_warn("beat: no gesture named '%'", fmt_cstr(gesture));
  AssetHandle emote = {0};
  if (g)
    emote = asset_load_untyped(ecs_resource_get_mut(w, AssetSystem),
                               (AssetLoadDesc){.type_name = "EmoteBlobAsset",
                                               .path = string_blob_get(&g->emote)});
  for (EcsIter it = ecs_query_iter(s->model_query); ecs_iter_next(&it);)
    for (i32 i = 0; i < it.count; i++) {
      EcsEntity e = it.entities[i];
      if (reg && reg[0])
        character_actor_set_register(w, e, reg);
      if (g) {
        character_emote_play(w, e, emote);
        EcsEmotePlayer *ep = g->hold ? ecs_component_get_mut(w, e, EcsEmotePlayer) : NULL;
        if (ep)
          ep->hold_indef = true;
      } else {
        const EcsEmotePlayer *held = ecs_component_get(w, e, EcsEmotePlayer);
        if (held && held->hold_indef) {
          // no gesture this beat: a held pose lets the talking loop back in
          EcsEmotePlayer *ep = ecs_component_get_mut(w, e, EcsEmotePlayer);
          ep->hold_indef = false;
          ep->active = false;
          ep->started = false;
        }
      }
    }
}

// On each new beat: the body's part, and a camera word starts a move. Emotions
// reach the face inside the engine, through the bound session.
hz_internal void player_beat_tick(AppState *s, EcsWorld *w) {
  u32 gen = character_voice_beat_gen(&s->vs);
  if (gen == s->last_beat_gen)
    return;
  s->last_beat_gen = gen;
  player_body_beat(s, w, character_voice_beat_register(&s->vs),
                   character_voice_beat_gesture(&s->vs));
  const char *camera = character_voice_beat_camera(&s->vs);
  if (camera && camera[0] && !cstr_equal(camera, "none"))
    player_camera_move(s, w, camera);
}

// HARNESS_PREVIEW, for checking a character without a conversation: "talk" or
// "talk:<style>" keeps the body talking, "gesture:<name>" plays the gesture and
// "emotion:<name>" shows the emotion, every few seconds.
hz_internal void player_preview_tick(AppState *s, EcsWorld *w, f32 dt) {
  if (!s->preview[0])
    return;
  b32 talk = str_starts_with(cstr_to_str(s->preview), STR_FROM_CSTR("talk"));
  // the voice session settles idle vs talking every frame, so keep asking
  if (talk)
    for (EcsIter it = ecs_query_iter(s->model_query); ecs_iter_next(&it);)
      for (i32 i = 0; i < it.count; i++)
        character_actor_state_request(w, it.entities[i], ACTOR_STATE_TALKING);
  s->preview_t -= dt;
  if (s->preview_t > 0.0f)
    return;
  s->preview_t = PLAYER_PREVIEW_EVERY;
  const char *colon = s->preview;
  while (*colon && *colon != ':')
    colon++;
  const char *name = *colon ? colon + 1 : "";
  if (talk)
    player_body_beat(s, w, name[0] ? name : NULL, NULL);
  else if (str_starts_with(cstr_to_str(s->preview), STR_FROM_CSTR("gesture:")))
    player_body_beat(s, w, NULL, name);
  else if (str_starts_with(cstr_to_str(s->preview), STR_FROM_CSTR("emotion:")))
    for (EcsIter it = ecs_query_iter(s->model_query); ecs_iter_next(&it);)
      for (i32 i = 0; i < it.count; i++)
        character_director_push_emotion(w, it.entities[i], name);
}

// Studio owns conversation and audio; this link only drives the native performance.
hz_internal void player_studio_resolved(RendererState *r,const RendererPassCtx *ctx,void *user) {
  UNUSED(r);
  ((AppState *)user)->studio_scene=ctx->scene_depth;
}

hz_internal void player_studio_tick(AppState *s, f32 dt) {
  s->studio_age += dt;
  if (s->studio_age > 0.5f) { s->studio_mouth = 0; s->studio_talking = false; }
  if (s->studio_ws && os_ws_state(s->studio_ws) != OS_WS_OPEN && os_ws_state(s->studio_ws) != OS_WS_CONNECTING) {
    os_ws_close(s->studio_ws); s->studio_ws = NULL;
  }
  if (!s->studio_ws) {
    s->studio_retry -= dt;
    if (s->studio_retry <= 0) { s->studio_retry = 1; s->studio_ws = os_ws_connect(&(OsWsConfig){.url=s->studio_url}); s->studio_frame_ready=true; }
  }
  if (s->studio_ws && os_ws_state(s->studio_ws) == OS_WS_OPEN) tctx_temp_allocator_scope(ta, NULL) {
    OsWsMessage msg = {0};
    while (os_ws_recv(s->studio_ws, &msg, &ta.allocator)) {
      if (msg.type != OS_WS_TEXT || msg.len > 8192) continue;
      PJson *m = pjson_parse((const char *)msg.data, msg.len, &ta.allocator);
      const char *type = pjson_string(pjson_get(m, "t"), "");
      if (cstr_equal(type,"frame-ready")) s->studio_frame_ready=true;
      if (cstr_equal(type, "state")) {
        s->studio_age = 0;
        s->studio_wanted_width=(u32)m_clampf((f32)pjson_number(pjson_get(m,"width"),960),240,1280);
        s->studio_wanted_height=(u32)m_clampf((f32)pjson_number(pjson_get(m,"height"),720),240,1280);
        s->studio_mouth = m_clampf((f32)pjson_number(pjson_get(m,"mouth"),0),0,1);
        s->studio_talking = pjson_bool(pjson_get(m,"talking"),false);
        EcsSceneSettings *settings = ecs_query_get_singleton(EcsSceneSettings, s->scene_settings_query);
        // a web canvas is always opaque, so it keeps the stage's background
        if (settings && s->studio_frames) {
          settings->clear_color=(ColorF32){0,0,0,0};
        }
      } else if (cstr_equal(type,"cue")) {
        const char *emotion = pjson_string(pjson_get(m,"emotion"),"");
        if (emotion[0]) for (EcsIter it=ecs_query_iter(s->model_query);ecs_iter_next(&it);)
          for (i32 i=0;i<it.count;i++) character_director_push_emotion(s->world,it.entities[i],emotion);
        player_body_beat(s,s->world,pjson_string(pjson_get(m,"talk"),""),pjson_string(pjson_get(m,"gesture"),""));
        const char *camera = pjson_string(pjson_get(m,"camera"),"");
        if (camera[0]) player_camera_move(s,s->world,camera);
      }
    }
  }
  i32 want = s->studio_talking ? ACTOR_STATE_TALKING : ACTOR_STATE_IDLE;
  if (want != s->last_talk_want) {
    s->last_talk_want = want;
    for (EcsIter it=ecs_query_iter(s->model_query);ecs_iter_next(&it);)
      for (i32 i=0;i<it.count;i++) character_actor_state_request(s->world,it.entities[i],want);
  }
}

hz_internal void player_studio_mouth(AppState *s) {
  if (s->studio_mouth <= 0) return;
  RendererState *r=ecs_resource_get_mut(s->world,RendererState);
  tctx_temp_allocator_scope(ta,NULL) {
    for (EcsIter it=ecs_query_iter(s->model_query);ecs_iter_next(&it);) for(i32 i=0;i<it.count;i++) {
      EcsEntity entity=it.entities[i];
      const EcsFace *face=ecs_component_get(s->world,entity,EcsFace);
      const EcsLipSync *lip=ecs_component_get(s->world,entity,EcsLipSync);
      const EcsModelInstance *inst=ecs_component_get(s->world,entity,EcsModelInstance);
      if (!face || !lip || !inst || !face->weights || lip->vowel_idx[0]<0 || (u32)lip->vowel_idx[0]>=face->bs_target_count) continue;
      f32 *weights=ALLOC_ARRAY(&ta.allocator,f32,face->bs_target_count);
      mem_cpy(weights,face->weights,sizeof(f32)*face->bs_target_count);
      weights[lip->vowel_idx[0]]=m_clampf(s->studio_mouth*lip->max_weight[0],0,1);
      renderer_model_instance_set_blendshape_weights(r,inst->instance,face->bs_mesh_index,weights,face->bs_target_count);
    }
  }
}

// advances the camera move and returns the framing to apply this frame
hz_internal PlayerCamMove player_camera_tick(AppState *s, f32 dt) {
  if (!s->cam_active)
    return (PlayerCamMove){.fov = PLAYER_CAM_FOV};
  s->cam_t += dt;
  f32 a = s->cam_dur > 0.0f ? m_clampf(s->cam_t / s->cam_dur, 0.0f, 1.0f) : 1.0f;
  a = character_ease(s->cam_curve, a);
  s->cam_cur = (PlayerCamMove){
      .fov = s->cam_from.fov + (s->cam_to.fov - s->cam_from.fov) * a,
      .x = s->cam_from.x + (s->cam_to.x - s->cam_from.x) * a,
      .y = s->cam_from.y + (s->cam_to.y - s->cam_from.y) * a,
      .distance = s->cam_from.distance +
                  (s->cam_to.distance - s->cam_from.distance) * a};
  return s->cam_cur;
}

#if defined(HZ_PUBLISH) && defined(MACOS)
// A published macOS app runs in ~/Library/Application Support/<bundle id> and
// reads cooked/ there, but its cooked assets ship inside the app, in
// Contents/Resources/cooked. Each one is linked into ./cooked, so the app stays
// as signed and only what the player writes (cooked/vrm, the import cache) is
// kept outside it. Links that point elsewhere, as after the app moved, are
// made again, and links to assets the app no longer has are removed. Only
// links are ever removed, never a file or folder.
hz_internal void player_link_bundled_cooked(void) {
  char exe[1024];
  if (!os_exe_path(exe, sizeof(exe)))
    return;
  // <app>/Contents/MacOS/<exe> -> <app>/Contents/Resources/cooked
  char *slash = strrchr(exe, '/');
  if (!slash)
    return;
  *slash = 0;
  slash = strrchr(exe, '/');
  if (!slash)
    return;
  *slash = 0;
  char bundled[1200];
  if (snprintf(bundled, sizeof(bundled), "%s/Resources/cooked", exe) >=
      (int)sizeof(bundled))
    return;
  DIR *dir = opendir(bundled);
  if (!dir) {
    log_error("player: the app has no cooked assets in %", fmt_cstr(bundled));
    return;
  }
  mkdir("cooked", 0755);
  struct stat cooked_st;
  if (lstat("cooked", &cooked_st) != 0 || !S_ISDIR(cooked_st.st_mode)) {
    log_error("player: cooked/ here is not a folder; remove it");
    closedir(dir);
    return;
  }
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    const char *name = entry->d_name;
    if (name[0] == '.' || strcmp(name, "vrm") == 0)
      continue;
    char target[1500], link_path[600], current[1500];
    if (snprintf(target, sizeof(target), "%s/%s", bundled, name) >=
            (int)sizeof(target) ||
        snprintf(link_path, sizeof(link_path), "cooked/%s", name) >=
            (int)sizeof(link_path))
      continue;
    ssize_t n = readlink(link_path, current, sizeof(current) - 1);
    if (n >= 0) {
      current[n] = 0;
      if (strcmp(current, target) == 0)
        continue;
      unlink(link_path);
    } else {
      struct stat st;
      if (lstat(link_path, &st) == 0) {
        log_error("player: % is not a link to the app's assets; remove it",
                  fmt_cstr(link_path));
        continue;
      }
    }
    if (symlink(target, link_path) != 0)
      log_error("player: could not link % to %", fmt_cstr(link_path),
                fmt_cstr(target));
  }
  closedir(dir);
  // links left from an older app: removed, or pointing at another copy
  size_t prefix = strlen(bundled);
  dir = opendir("cooked");
  if (!dir)
    return;
  while ((entry = readdir(dir))) {
    char link_path[600], current[1500];
    if (entry->d_name[0] == '.' || strcmp(entry->d_name, "vrm") == 0 ||
        snprintf(link_path, sizeof(link_path), "cooked/%s", entry->d_name) >=
            (int)sizeof(link_path))
      continue;
    ssize_t n = readlink(link_path, current, sizeof(current) - 1);
    if (n < 0)
      continue;
    current[n] = 0;
    struct stat st;
    b32 ours = strncmp(current, bundled, prefix) == 0 &&
               current[prefix] == '/' && stat(current, &st) == 0;
    if (!ours)
      unlink(link_path);
  }
  closedir(dir);
}
#endif

// whether the build has this cooked file. A web build fetches its files and
// has no os_file_exists, so there the file is read instead (these are small)
hz_internal b32 player_cooked_exists(const char *path) {
#ifdef WASM
  b32 found = false;
  tctx_temp_allocator_scope(ta, NULL) {
    found = os_read_file(path, &ta.allocator).success;
  }
  return found;
#else
  return os_file_exists(path);
#endif
}

HZ_APP_API void app_init(AppMemory *memory) {
  if (!is_main_thread())
    return;
#if defined(HZ_PUBLISH) && defined(MACOS)
  player_link_bundled_cooked();
#endif
  AppState *state = memory->state;
  player_env(PLAYER_URL_ENV, PLAYER_URL_DEFAULT, state->url);
  player_env(PLAYER_CHARACTER_ENV, "",
             state->character_path);
  char flag[PLAYER_ENV_MAX];
  player_env(PLAYER_MIC_DEBUG_ENV, "0", flag);
  state->mic_debug = flag[0] == '1';
  player_env(PLAYER_PREVIEW_ENV, "", state->preview);
  state->preview_t = PLAYER_PREVIEW_START;
  player_env("HARNESS_STUDIO_URL", "", state->studio_url);
#ifndef WASM
  state->studio_frames = state->studio_url[0] != 0;
#endif
  // the engine keeps the path until the frame is captured
  player_env(PLAYER_SCREENSHOT_ENV, "", state->screenshot);
  if (state->screenshot[0]) {
    player_env(PLAYER_SCREENSHOT_FRAME_ENV, "240", flag);
    u32 frame = 0;
    for (const char *c = flag; *c >= '0' && *c <= '9' && frame < 1000000; c++)
      frame = frame * 10 + (u32)(*c - '0');
    hz_set_screenshot_mode(state->screenshot, frame);
  }


  EcsWorld *w = ecs_world_create();
  state->world = w;
  ecs_resource_set_ref(w, AppMemory, memory);
  ecs_input_init(w);
  if (state->studio_frames) {
    state->studio_width=state->studio_wanted_width=960;
    state->studio_height=state->studio_wanted_height=720;
    state->studio_target = gpu_make_render_target(&(GpuRenderTargetDesc){
      .name="Studio preview", .width=960, .height=720,
      .formats={GPU_TEXTURE_FORMAT_RGBA8_SRGB}, .sample_count=1,
    });
  }
  if (state->studio_frames) {
    state->studio_composite=gpu_make_render_target(&(GpuRenderTargetDesc){
      .name="Studio transparent preview",.width=960,.height=720,
      .formats={GPU_TEXTURE_FORMAT_RGBA8_SRGB},.sample_count=1,
    });
    GpuPipelineDesc desc=*shader_studio_alpha_pipeline_desc();
    desc.depth_test=false; desc.depth_write=false; desc.cull_mode=GPU_CULL_NONE;
    desc.color_formats[0]=GPU_TEXTURE_FORMAT_RGBA8_SRGB;
    state->studio_alpha_pipeline=gpu_make_pipeline(&desc);
  }
  ecs_renderer_init(w, &(RendererInitDesc){
                           .output_target = state->studio_target,
                           .output_width = state->studio_frames ? 960 : 0,
                           .output_height = state->studio_frames ? 720 : 0,
                           .sample_count = 4,
                           .vertex_buffer_size = MB(8),
                           .index_buffer_size = MB(4),
                           .max_batches = 256,
                           // base + outline + Over Hair
                           .max_passes_per_instance = 3,
                           .bloom_enabled = true,
                           .shadows_enabled = true,
                           .shadow = {.cascade_count = 4,
                                      .cascade_size = 4096,
                                      .max_distance = 5.0f},
                       });
  if (state->studio_frames) renderer_add_feature(ecs_resource_get_mut(w,RendererState),&(RendererFeatureDesc){
    .name="Studio alpha",.reads=RENDERER_RESOURCE_DEPTH,.user=state,
    .record={[RENDERER_PHASE_AFTER_RESOLVE]=player_studio_resolved},
  });
  ecs_transform_init(w, NULL);
#ifdef WASM
  ecs_assets_init(w, NULL);
#else
  // A native publish build reads textures from their .zst siblings into the
  // asset system's heap, and FoxGlove's alone come close to its default 64 MB.
  // The reserve is a hard cap (a publish build crashes past it instead of
  // asserting) but only address space until used, so it leaves room for
  // imported models.
  ecs_assets_init(w, &(AssetSystemCreateDesc){.reserve_size = GB(1)});
#endif
  ecs_cloth_init(w, NULL);
  character_init(w, ecs_resource_get_mut(w, AssetSystem));
  AssetSystem *assets = ecs_resource_get_mut(w, AssetSystem);
  app_emote_clips_register(assets);
  app_character_register_loader(assets);
  asset_register_loader(assets, ASSET_TYPE(CharacterStatesBlobAsset),
                        character_states_loader, NULL);
  asset_register_loader(assets, ASSET_TYPE(JointMaskBlobAsset),
                        character_joint_mask_loader, NULL);
  asset_register_loader(assets, ASSET_TYPE(GestureSetBlobAsset),
                        character_gesture_loader, NULL);
  asset_register_loader(assets, ASSET_TYPE(CameraMoveSetBlobAsset),
                        character_camera_moves_loader, NULL);
  state->camera_moves_asset =
      asset_load(CameraMoveSetBlobAsset, assets, .path = PLAYER_CAMERA_MOVES);

  if (state->studio_frames) state->studio_pixels = ALLOC_ARRAY(&assets->allocator,u8,1280*1280*4+8);
  state->audio = audio_system_init(&assets->allocator, NULL);
  // lip sync reads the VOICE bus only
  audio_bus_set_tap(&state->audio, AUDIO_BUS_VOICE, true);
  ecs_audio_init(&state->audio, w);

  if (!state->studio_url[0]) {
  state->mic_buf = ALLOC_ARRAY(&assets->allocator, f32, PLAYER_MIC_SCRATCH);
  mic_init(&state->mic);
  if (mic_permission() != OS_MIC_PERMISSION_GRANTED)
    mic_request_permission();

  PlatformFileData vad = os_read_file(PLAYER_VAD_MODEL, &assets->allocator);
  if (!vad.success)
    log_error("voice: % is missing; run a cook", fmt_cstr(PLAYER_VAD_MODEL));
  CharacterVoiceDesc voice = {
      .session_url = state->url,
      .audio = &state->audio,
      .assets = assets,
      .alloc = &assets->allocator,
      .vad_model = vad.success ? vad.buffer : 0,
      .vad_model_len = vad.success ? vad.buffer_len : 0,
  };
  char listen[PLAYER_ENV_MAX];
  player_env(PLAYER_LISTEN_ENV, "", listen);
  player_listen(listen, &voice, &assets->allocator);
  character_voice_init(&state->vs, &voice);
  // the engine's built-in greeting stays shut: the character speaks first only
  // when an extension offers it a turn, over the offers link
  character_voice_hold_greeting(&state->vs, true);
  player_offers_init(&state->offers, state->url);

  }

  scene_system_create(&state->scene_sys, w, assets, &assets->allocator);
  state->scene = scene_load_file(&state->scene_sys, APP_STAGE_SCENE);
  app_character_system_init(&state->character, w, memory);
  CString character = state->character_path;
  // a bare name is a profile cooked into the build
  char profile[PLAYER_ENV_MAX];
  b32 bare = true;
  for (const char *c = character; *c; c++)
    bare = bare && *c != '/' && *c != '.';
  u32 name_len = cstr_len(character);
  if (bare && name_len && name_len + sizeof("characters/.hzt") <= sizeof(profile)) {
    mem_cpy(profile, "characters/", 11);
    mem_cpy(profile + 11, character, name_len);
    mem_cpy(profile + 11 + name_len, ".hzt", 5);
    character = profile;
    char cooked[PLAYER_ENV_MAX + 16];
    u32 len = cstr_len(profile);
    mem_cpy(cooked, "cooked/", 7);
    mem_cpy(cooked + 7, profile, len - 4);
    mem_cpy(cooked + 7 + len - 4, ".hza", 5);
    if (!player_cooked_exists(cooked)) {
      log_error("player: this build has no profile named \"%\"; give a .vrm instead",
                fmt_cstr(state->character_path));
      character = NULL;
    }
  }
  CString gestures = player_cooked_exists(PLAYER_GESTURES_COOKED) ? PLAYER_GESTURES : NULL;
  if (!character) {
    // the missing profile was reported above
  } else if (!character[0]) {
    log_error("player: no character; set % to a .vrm (the harness runtime does)",
              fmt_cstr(PLAYER_CHARACTER_ENV));
    character = NULL;
  } else if (player_has_ext(character, ".vrm") || player_has_ext(character, ".glb")) {
    PlayerVrm *vrm = &state->vrm;
    if (player_vrm_load(character, vrm)) {
      character = vrm->profile;
      // an imported character's gestures are its own
      gestures = vrm->gestures[0] ? vrm->gestures : NULL;
      state->bind_pose_body = !vrm->animated;
    } else {
      log_error("player: could not load %; the stage stays empty", fmt_cstr(character));
      character = NULL;
    }
  }
  if (gestures)
    state->gesture_asset = asset_load(GestureSetBlobAsset, assets, .path = gestures);
  if (character && cstr_len(character) >= APP_CHARACTER_PATH_MAX) {
    log_error("player: the character path is longer than % characters",
              fmt_u32(APP_CHARACTER_PATH_MAX - 1));
    character = NULL;
  }
  if (character)
    app_character_set(&state->character, assets, character);
  state->camera_query = ecs_query_cached(w, EcsIn(Camera));
  state->scene_settings_query = ecs_query_cached(w, EcsIn(EcsSceneSettings));
  state->model_query = ecs_query_cached(w, EcsIn(EcsModelRef));
  state->last_talk_want = -1;
  log_info("player: % on %", fmt_cstr(state->character_path),
           fmt_cstr(state->url));
}

HZ_APP_API void app_update_and_render(AppMemory *memory) {
  AppState *state = memory->state;
  EcsWorld *w = state->world;
  perf_stats_begin_frame();

  if (is_main_thread()) {
    app_character_update(&state->character, w);
    app_character_over_hair_update(&state->character, w);
    if (state->studio_url[0]) {
      player_studio_tick(state, memory->dt);
      if (state->studio_frames && !state->studio_frame_pending && (state->studio_width!=state->studio_wanted_width || state->studio_height!=state->studio_wanted_height)) {
        state->studio_width=state->studio_wanted_width;
        state->studio_height=state->studio_wanted_height;
        gpu_resize_render_target(state->studio_target,state->studio_width,state->studio_height);
        gpu_resize_render_target(state->studio_composite,state->studio_width,state->studio_height);
        renderer_set_output_target(ecs_resource_get_mut(w,RendererState),state->studio_target,state->studio_width,state->studio_height);
      }
    }
    else {
      player_mic_tick(state);
      character_voice_tick(&state->vs, memory->dt);
      player_offers_tick(&state->offers, &state->vs, memory->dt);
      player_talk_tick(state, memory->dt);
      player_mic_debug_tick(state, memory->dt);
    }
  }

  ecs_input_schedule(w);
  ecs_assets_schedule(w);
  ecs_audio_schedule(w);
  ecs_transform_schedule(w);
  ecs_camera_schedule(w, NULL);
  ecs_cloth_resolve_schedule(w);
  ecs_flush(w, memory->dt);

  ecs_renderer_schedule_pose(w);
  // before the character's own pose stage, so gaze and the face land on top
  if (state->bind_pose_body) {
    ecs_schedule_single(w, player_bind_pose_add_system);
    ecs_schedule(w, player_bind_pose_system);
  }
  ecs_schedule_single(w, player_submesh_shadow_optout_system);
  ecs_schedule_single(w, player_face_material_resolve_system);
  // the upper-body mask is empty, so the overlay pass changes nothing; skipping
  // it avoids 0.6.3's resolve_anim_overlay_system world-arena assert. Turn it
  // back on once the engine fixes that, before giving the mask any weight
  CharacterScheduleDesc csd = {.no_overlays = true};
  character_schedule_pose(w, &csd);
  ecs_schedule_single(w, light_aim_init_system);
  ecs_schedule_single(w, light_aim_apply_system);
  ecs_renderer_schedule_skin(w);
  character_schedule_face(w, &csd);
  ecs_schedule_single(w, player_expression_material_system);
  ecs_cloth_schedule_base(w);
  ecs_flush(w, memory->dt);
  ecs_cloth_schedule_solve(w);
  ecs_flush(w, memory->dt);

  if (is_main_thread() && state->studio_url[0]) player_studio_mouth(state);
  Camera *cam = ecs_query_get_singleton(Camera, state->camera_query);
  if (cam) {
    if (is_main_thread()) {
      cam->pos.y += state->character.cam_offset_y; // this character's height
      camera_look_at(cam, (vec3){0.0f,
                                 PLAYER_CAM_AIM_Y + state->character.cam_offset_y,
                                 0.0f});
      PlayerCamMove move = player_camera_tick(state, memory->dt);
      cam->fov = move.fov;
      cam->pos = v3_add(cam->pos, v3_scale(quat_rotate(cam->rot, V3_RIGHT), move.x));
      cam->pos = v3_add(cam->pos, v3_scale(quat_rotate(cam->rot, V3_UP), move.y));
      cam->pos = v3_add(cam->pos,
                        v3_scale(quat_rotate(cam->rot, V3_BACK), move.distance));
      camera_update(cam, state->studio_frames ? state->studio_width : memory->canvas_width,
                    state->studio_frames ? state->studio_height : memory->canvas_height);
    }
    EcsSceneSettings *settings =
        ecs_query_get_singleton(EcsSceneSettings, state->scene_settings_query);
    renderer_update(ecs_resource_get_mut(w, RendererState),
                    &(RendererBeginFrameDesc){
                        .camera = cam,
                        .clear_color = settings ? settings->clear_color
                                                : (ColorF32){0.15f, 0.15f, 0.2f, 1.0f},
                        .time = memory->total_time,
                    });
  }

  lane_sync();
  if (is_main_thread()) {
    // a profile with no clips holds its bind pose, whether imported or cooked
    // in. Decided here, after every lane has scheduled this frame, so all of
    // them read the same value the next one.
    AppCharacterProfileBlobAsset *profile =
        app_character_profile(&state->character, ecs_resource_get(w, AssetSystem));
    if (profile)
      state->bind_pose_body = !handle_is_valid(profile->idle_clip.handle);
    // plays emotes and loads assets, so only after every lane has synced
    if (!state->studio_url[0]) player_beat_tick(state, w);
    player_preview_tick(state, w, memory->dt);
    // the session speaks through the character; bound every frame so it
    // survives a character swap
    if (!state->studio_url[0]) for (EcsIter it = ecs_query_iter(state->model_query); ecs_iter_next(&it);)
      if (it.count > 0) {
        character_voice_bind(&state->vs, w, it.entities[0]);
        break;
      }
    EcsEntity cam_ent = ecs_query_get_singleton_entity(state->camera_query);
    const WorldTransform *cwt =
        cam_ent ? ecs_component_get(w, cam_ent, WorldTransform) : NULL;
    for (EcsIter it = ecs_query_iter(state->model_query); ecs_iter_next(&it);)
      for (i32 i = 0; i < it.count; i++) {
        if (cwt || cam)
          character_set_gaze_target(w, it.entities[i],
                                    cwt ? cwt->position : cam->pos);
        else
          character_clear_gaze_target(w, it.entities[i]);
      }
  }
  if (is_main_thread() && state->studio_frames) {
    player_studio_hide_window_once(state);
    state->studio_frame_time += memory->dt;
    if (state->studio_frame_pending) {
      u32 width=0, height=0;
      if (gpu_read_render_target(state->studio_composite,state->studio_pixels+8,&width,&height)) {
        state->studio_frame_pending=false;
        if (width<=1280 && height<=1280 && state->studio_ws &&
            os_ws_state(state->studio_ws)==OS_WS_OPEN) {
          for (u32 i=0;i<4;i++) {
            state->studio_pixels[i]=(u8)(width>>(8*i));
            state->studio_pixels[4+i]=(u8)(height>>(8*i));
          }
          os_ws_send_binary(state->studio_ws,state->studio_pixels,8+width*height*4);
        }
      }
    }
    if (!state->studio_frame_pending && state->studio_frame_ready && state->studio_frame_time>=1.0f/30.0f) {
      gpu_texture_access(gpu_get_render_target_attachment(state->studio_target,0),GPU_ACCESS_SHADER_READ);
      gpu_texture_access(state->studio_scene,GPU_ACCESS_SHADER_READ);
      gpu_begin_pass(&(GpuPassDesc){.render_target=state->studio_composite});
      gpu_apply_pipeline(state->studio_alpha_pipeline);
      shader_studio_alpha_apply_bindings((ShaderStudioAlphaBindings){
        .displayTexture=gpu_get_render_target_attachment(state->studio_target,0),
        .sceneTexture=state->studio_scene,
      });
      gpu_draw(3,1);
      gpu_end_pass();
      gpu_queue_render_target_read(state->studio_composite,&(GpuReadRenderTargetDesc){0});
      state->studio_frame_pending=true;
      state->studio_frame_ready=false;
      state->studio_frame_time=0;
    }
  }
  perf_stats_end_frame();
}

HZ_APP_API void app_on_reload(AppMemory *memory) { UNUSED(memory); }
HZ_APP_API size_t app_state_size(void) { return sizeof(AppState); }
