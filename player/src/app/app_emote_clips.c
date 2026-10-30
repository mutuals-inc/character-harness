// per-character emote clips: an emote can name clips under the shared
// APP_SHARED_CLIP_DIR and play the active character's copy of the same clip (its
// profile clip_dir). the loader rebases on load, and a character swap rebases
// the loaded ones (app_character.c).
#include "character/character.h"
#include "assets/assets.h"
#include "lib/blob_asset.h"
#include "lib/reflect.h"
#include "lib/string.h"
#include "lib/thread_context.h"
#include "app/app_config.h"

// returns `em` rebuilt with every anim track under `from` moved under `to`, in
// `alloc`; NULL when no track is under `from`. the intermediate blobs live in
// the thread's second temp arena: blob_rebuild_* scratch-scopes the first one
// on every call, which would recycle the blob the next rebuild reads from.
// `alloc` must not be that second arena.
hz_internal u8 *app_emote_rebase_clips(const EmoteBlobAsset *em, String from,
                                       String to, u32 *out_len,
                                       Allocator *alloc) {
  const TypeInfo *ti = type_table_get("EmoteBlobAsset");
  if (!ti || str_equal(from, to))
    return NULL;
  u8 *out = NULL;
  tctx_temp_allocator_scope(tmp, tctx_temp_arena(NULL)) {
    u8 *cur = (u8 *)em;
    u32 cur_len = (u32)em->header.asset_size;
    b32 rebased = false;
    b32 failed = false;
    u32 n = blob_array_len(&((EmoteBlobAsset *)cur)->anim_tracks);
    for (u32 i = 0; i < n && !failed; i++) {
      // a rebuild moves every string, so re-resolve the track on the latest blob
      EmoteAnimTrack *tk =
          &blob_array_get(EmoteAnimTrack, &((EmoteBlobAsset *)cur)->anim_tracks)
               .items[i];
      String path = {string_blob_get(&tk->animation), tk->animation.len};
      if (!str_starts_with(path, from))
        continue;
      u32 new_len = to.len + path.len - from.len;
      char *np = ALLOC_ARRAY(&tmp.allocator, char, new_len + 1);
      mem_cpy(np, to.value, to.len);
      mem_cpy(np + to.len, path.value + from.len, path.len - from.len);
      cur = blob_rebuild_set_string(ti, cur, &tk->animation, np, new_len, &cur_len,
                                    &tmp.allocator);
      failed = cur == NULL;
      rebased = true;
    }
    if (rebased && !failed) {
      out = ALLOC_ARRAY_NO_ZERO(alloc, u8, cur_len);
      mem_cpy(out, cur, cur_len);
      *out_len = cur_len;
    }
  }
  return out;
}

// the stock emote loader, plus the rebase onto the active character's clips.
// the rebased blob goes back into the entry's own buffer when it fits (always,
// when the reference dir is the longest); otherwise it is a loader-owned buffer
// released by app_emote_on_unload / app_asset_replace_blob.
hz_internal void *app_emote_loader(AssetLoadContext *ctx) {
  EmoteBlobAsset *em = character_emote_loader(ctx);
  if (!em)
    return NULL;
  void *result = em;
  tctx_temp_allocator_scope(ta, NULL) {
    u32 len = 0;
    u8 *nb = app_emote_rebase_clips(em, STR_FROM_CSTR(APP_SHARED_CLIP_DIR),
                                    app_active_clip_dir(), &len,
                                    &ta.allocator);
    if (nb && len <= ctx->raw_buffer_len) {
      mem_cpy(ctx->raw_buffer, nb, len);
      result = ctx->raw_buffer;
    } else if (nb) {
      u8 *own = ALLOC_ARRAY_NO_ZERO(ctx->allocator, u8, len);
      mem_cpy(own, nb, len);
      result = own;
    }
  }
  return result;
}

hz_internal void app_emote_on_unload(AssetSystem *s, AssetHandle h,
                                     void *user_ctx) {
  UNUSED(user_ctx);
  const AssetEntry *e = asset_get_entry(s, h);
  if (e && e->data && e->data != e->raw_buffer)
    ALLOC_FREE(&s->allocator, e->data);
}

// asset_replace_blob for emotes: also frees a loader-owned rebased emote
// buffer, which the asset system does not own.
hz_internal void app_asset_replace_blob(AssetSystem *s, AssetHandle h, u8 *data,
                                        u32 len) {
  const AssetEntry *e = asset_get_entry(s, h);
  void *owned = (e && e->type_id == ASSET_TYPE(EmoteBlobAsset) && e->data &&
                 e->data != e->raw_buffer)
                    ? e->data
                    : NULL;
  asset_replace_blob(s, h, data, len);
  if (owned && owned != data)
    ALLOC_FREE(&s->allocator, owned);
}

// registers the per-character emote loader (replaces character_emote_loader).
hz_internal void app_emote_clips_register(AssetSystem *assets) {
  asset_register_loader(assets, ASSET_TYPE(EmoteBlobAsset), app_emote_loader,
                        NULL);
  asset_subscribe_unload(assets, ASSET_TYPE(EmoteBlobAsset),
                         app_emote_on_unload, NULL);
}
