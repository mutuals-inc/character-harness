#include "app/player_offers.h"
#include "app/player_json.h"

#include "lib/memory.h"
#include "lib/string.h"
#include "lib/thread_context.h"
#include "os/os.h"

#define PLAYER_OFFERS_PATH "/offers"
#define PLAYER_OFFERS_RETRY 2.0f // seconds between connection attempts
#define PLAYER_OFFERS_MSG_MAX 128u

void player_offers_init(PlayerOffers *o, CString session_url) {
  *o = (PlayerOffers){0};
  u32 n = cstr_len(session_url);
  while (n && session_url[n - 1] == '/')
    n--;
  u32 p = cstr_len(PLAYER_OFFERS_PATH);
  if (n + p + 1u > sizeof(o->url)) {
    log_warn("offers: the session URL is too long to add % to; the character "
             "only answers",
             fmt_cstr(PLAYER_OFFERS_PATH));
    return;
  }
  mem_cpy(o->url, session_url, n);
  mem_cpy(o->url + n, PLAYER_OFFERS_PATH, p + 1u);
}

// what the voice is doing, in the protocol's words
hz_internal CString player_offers_voice(const CharacterVoice *vs) {
  if (!character_voice_connected(vs))
    return "offline";
  switch (character_voice_state(vs)) {
  case CHARACTER_VOICE_CAPTURING:
  case CHARACTER_VOICE_TRANSCRIBING:
    return "listening";
  case CHARACTER_VOICE_THINKING:
    return "thinking";
  case CHARACTER_VOICE_SPEAKING:
    return "speaking";
  default:
    break;
  }
  // the tail of a reply can still be heard after the session went idle
  return character_voice_speaking_audio(vs) ? "speaking" : "idle";
}

// appends `s` to `buf` at `*n`, as long as it fits
hz_internal void player_offers_put(char *buf, u32 cap, u32 *n, CString s) {
  u32 len = cstr_len(s);
  if (*n + len >= cap)
    return;
  mem_cpy(buf + *n, s, len);
  *n += len;
}

hz_internal void player_offers_put_u32(char *buf, u32 cap, u32 *n, u32 v) {
  char digits[11];
  u32 at = sizeof(digits) - 1;
  digits[at] = 0;
  do {
    digits[--at] = (char)('0' + v % 10u);
    v /= 10u;
  } while (v);
  player_offers_put(buf, cap, n, digits + at);
}

hz_internal void player_offers_status(PlayerOffers *o, CString voice) {
  char msg[PLAYER_OFFERS_MSG_MAX];
  u32 n = 0;
  player_offers_put(msg, sizeof(msg), &n, "{\"t\":\"status\",\"voice\":\"");
  player_offers_put(msg, sizeof(msg), &n, voice);
  player_offers_put(msg, sizeof(msg), &n, "\",\"epoch\":");
  player_offers_put_u32(msg, sizeof(msg), &n, o->epoch);
  player_offers_put(msg, sizeof(msg), &n, "}");
  if (os_ws_send_text(o->ws, msg, n)) {
    o->sent_voice = voice;
    o->sent_epoch = o->epoch;
  }
}

hz_internal void player_offers_ack(PlayerOffers *o, u32 id, b32 accepted) {
  char msg[PLAYER_OFFERS_MSG_MAX];
  u32 n = 0;
  player_offers_put(msg, sizeof(msg), &n, "{\"t\":\"ack\",\"id\":");
  player_offers_put_u32(msg, sizeof(msg), &n, id);
  CString tail = accepted ? ",\"accepted\":true}" : ",\"accepted\":false}";
  player_offers_put(msg, sizeof(msg), &n, tail);
  os_ws_send_text(o->ws, msg, n);
}

hz_internal void player_offers_take(PlayerOffers *o, CharacterVoice *vs,
                                    const OsWsMessage *msg, Allocator *alloc) {
  if (msg->type != OS_WS_TEXT)
    return;
  PJson *m = pjson_parse((const char *)msg->data, msg->len, alloc);
  if (!m || !cstr_equal(pjson_string(pjson_get(m, "t"), ""), "offer"))
    return;
  f64 id = pjson_number(pjson_get(m, "id"), -1.0);
  f64 epoch = pjson_number(pjson_get(m, "epoch"), -1.0);
  const char *text = pjson_string(pjson_get(m, "text"), "");
  if (id < 0.0 || id > 4294967295.0)
    return;
  o->offers++;
  // checked again here, where it is injected: the status the runtime acted on
  // may be a frame old
  b32 accept = text[0] && epoch == (f64)o->epoch &&
               cstr_equal(player_offers_voice(vs), "idle");
  player_offers_ack(o, (u32)id, accept);
  if (!accept) {
    o->refused++;
    log_info("offers: offer % refused", fmt_u32((u32)id));
    return;
  }
  o->accepted++;
  log_info("offers: offer % taken as a turn", fmt_u32((u32)id));
  character_voice_inject_user_text(vs, text, cstr_len(text));
}

void player_offers_tick(PlayerOffers *o, CharacterVoice *vs, f32 dt) {
  if (!o->url[0])
    return;

  // every time the voice leaves idle, an offer from before can no longer land
  CString voice = player_offers_voice(vs);
  b32 idle = cstr_equal(voice, "idle");
  if (o->was_idle && !idle)
    o->epoch++;
  o->was_idle = idle;

  if (o->ws) {
    OsWsState state = os_ws_state(o->ws);
    if (state == OS_WS_CONNECTING)
      return;
    if (state != OS_WS_OPEN) {
      // there is no os_ws_release beside it, so close is what hands it back
      os_ws_close(o->ws);
      o->ws = NULL;
      if (o->open)
        log_warn("offers: the link to the runtime closed; reconnecting");
      o->open = false;
    } else if (!o->open) {
      o->open = true;
      o->sent_voice = NULL;
      log_info("offers: linked to the runtime");
    }
  }
  if (!o->ws) {
    o->retry_t -= dt;
    if (o->retry_t > 0.0f)
      return;
    o->retry_t = PLAYER_OFFERS_RETRY;
    o->ws = os_ws_connect(&(OsWsConfig){.url = o->url});
    return;
  }

  if (!o->sent_voice || !cstr_equal(o->sent_voice, voice) ||
      o->sent_epoch != o->epoch)
    player_offers_status(o, voice);
  tctx_temp_allocator_scope(ta, NULL) {
    OsWsMessage msg = {0};
    while (os_ws_recv(o->ws, &msg, &ta.allocator))
      player_offers_take(o, vs, &msg, &ta.allocator);
  }
}
