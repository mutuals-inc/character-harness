#pragma once
#include "character/character.h"
#include "lib/typedefs.h"
#include "os/os.h"
#include "app/app_config.h"

// The player's end of the offers link (docs/protocol.md, "The offers link"): a
// second socket to the runtime, beside the engine's session socket, at
// HARNESS_URL + "/offers". The player says what its voice is doing, the runtime
// offers a line of input when the voice is free, and the player either takes
// it as the user's next turn or refuses it.
//
// The player decides, because only it knows whether anyone is speaking. Every
// time the voice leaves idle the epoch moves on, and an offer carrying an older
// one is refused: it was decided before someone spoke.

typedef struct {
  OsWebSocket *ws;
  b32 open;
  f32 retry_t;
  char url[PLAYER_ENV_MAX + 8];

  u32 epoch;
  b32 was_idle;
  CString sent_voice; // the last status sent on this connection; NULL after a reconnect
  u32 sent_epoch;

  u32 offers, accepted, refused;
} PlayerOffers;

// main thread, once, with the session socket's URL
void player_offers_init(PlayerOffers *o, CString session_url);
// main thread, every frame after character_voice_tick: the link, a status when
// the voice changed, and any offers waiting
void player_offers_tick(PlayerOffers *o, CharacterVoice *vs, f32 dt);
