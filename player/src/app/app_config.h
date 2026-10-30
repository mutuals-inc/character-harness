#ifndef H_APP_CONFIG
#define H_APP_CONFIG

// emotes can name clips under this shared dir; at load they are rebased to the
// active profile's clip_dir, so one emote serves every character that has the
// same clips. Imported characters' emotes name their own clips directly.
#define APP_SHARED_CLIP_DIR "characters/shared/clips/"

// the stage (camera, light, character spawn point). never holds a character.
#define APP_STAGE_SCENE "assets/mutuals/main_scene.hzt"

// launch settings, read once from the environment; unset means the default
#define PLAYER_URL_ENV "HARNESS_URL"
#define PLAYER_URL_DEFAULT "ws://127.0.0.1:8788/session"
// a path to a .vrm / .glb, imported on first load (player_vrm.c), or the name
// or path of a profile cooked into the build (characters/<name>.hzt, like
// foxglove). The harness runtime always sets it; there is no default.
#define PLAYER_CHARACTER_ENV "HARNESS_CHARACTER"
#define PLAYER_ENV_MAX 512
// the character's `listen` settings as JSON, like {"end_of_speech_ms":900};
// a key left out keeps the engine's default (player_listen in player.c)
#define PLAYER_LISTEN_ENV "HARNESS_LISTEN"

// the cooked VAD plan; character_voice_init copies the bytes
#define PLAYER_VAD_MODEL "cooked/vad/silero_vad_16k.hza"

#define PLAYER_MIC_SCRATCH 8192
// a mic start that has not finished by then is reported, and a failed one is
// retried after the pause
#define PLAYER_MIC_START_WARN_MS 5000.0
#define PLAYER_MIC_RETRY_MS 2000.0
// a barge-in while the voice is still being generated needs echo cancellation
// marked as settled (aec_warmed); the player marks it after this much live
// capture
#define PLAYER_AEC_WARM_MS 3000.0
// HARNESS_MIC_DEBUG=1 logs what the mic hears, twice a second
#define PLAYER_MIC_DEBUG_ENV "HARNESS_MIC_DEBUG"
#define PLAYER_MIC_DEBUG_EVERY 0.5f

// for checking a character without a conversation: HARNESS_PREVIEW="talk",
// "talk:<style>", "gesture:<name>" or "emotion:<name>" (player_preview_tick), and
// HARNESS_SCREENSHOT=<file.png> saves frame HARNESS_SCREENSHOT_FRAME and quits
#define PLAYER_PREVIEW_ENV "HARNESS_PREVIEW"
#define PLAYER_PREVIEW_START 1.0f
#define PLAYER_PREVIEW_EVERY 5.0f
#define PLAYER_SCREENSHOT_ENV "HARNESS_SCREENSHOT"
#define PLAYER_SCREENSHOT_FRAME_ENV "HARNESS_SCREENSHOT_FRAME"

// seconds the body stays TALKING after the voice stops, so the last gesture
// settles instead of snapping to idle
#define PLAYER_TALK_HANGOVER 0.8f

// the stage camera is framed for a portrait view; the player keeps its
// position and aims at the upper body instead.
// AIM_Y is in meters for the stage's reference eye height (1.585 m).
#define PLAYER_CAM_FOV 26.0f
#define PLAYER_CAM_AIM_Y 1.30f
// the fov the camera moves were authored against; a move's fov is scaled from
// it to the player's
#define PLAYER_STAGE_FOV 20.0f

// the beat vocabulary: gesture word -> emote, camera word -> framing preset.
// A cooked-in profile's gestures are this set (FoxGlove's); an imported
// character brings its own.
#define PLAYER_GESTURES "mutuals/gestures.hzt"
#define PLAYER_GESTURES_COOKED "cooked/mutuals/gestures.hza"
#define PLAYER_CAMERA_MOVES "mutuals/camera_moves.hzt"

#endif
