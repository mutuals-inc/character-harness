import "./styles.css";
import { $, download, request, toast } from "./lib/dom.ts";
import { icon } from "./lib/icons.ts";
import { state, record, saveSettings } from "./store.ts";
import {
  cancelReply,
  endSession,
  microphone,
  output,
  startSession,
  submit,
  sendRecording,
  toggleMicrophone,
} from "./session.ts";
import { CharacterStage } from "./stage/stage.ts";
import { shell, navigation } from "./ui/shell.ts";
import { renderTranscript, showPanel, studio } from "./ui/studio.ts";
import { characterView } from "./ui/character.ts";
import { voiceView } from "./ui/voice.ts";
import { hooksView } from "./ui/hooks.ts";
import { activityView, renderActivity } from "./ui/activity.ts";
import { settingsView } from "./ui/settings.ts";
import { expandStage } from "./ui/expanded-stage.ts";
import type { Bootstrap, CharacterInfo, Settings } from "./types.ts";

let stage: CharacterStage | null = null;
const titles: Record<string, [string, string]> = {
  studio: ["Character Studio", "A place to bring your characters to life."],
  character: [
    "Meet the character",
    "Personality, perspective, and everything that makes them who they are.",
  ],
  voice: ["Find your voice", "Make both sides of the conversation feel right."],
  hooks: [
    "A little behind the scenes",
    "Connect behavior to the moments that matter.",
  ],
  activity: [
    "Follow the conversation",
    "A live view of what happens along the way.",
  ],
  settings: [
    "Make yourself at home",
    "Your connection, your preferences, your little corner of the harness.",
  ],
};

async function boot(id?: string) {
  const data = await request<Bootstrap>(
    `/api/bootstrap${id ? `?character=${encodeURIComponent(id)}` : ""}`,
  );
  stage?.dispose();
  state.bootstrap = data;
  $("#app").innerHTML = shell();
  $("#view-studio").innerHTML = studio();
  renderForms();
  $("#view-activity").innerHTML = activityView();
  renderTranscript();
  renderActivity();
  try {
    stage = new CharacterStage($("#stage-canvas"));
    void stage.load(data.character);
  } catch {
    $("#stage-loading").textContent =
      "WebGL is unavailable. Enable hardware acceleration to use the 3D stage.";
  }
  setView("studio");
  renderSessionState();
  await refreshDevices();
}

function renderForms() {
  $("#view-character").innerHTML = characterView();
  $("#view-voice").innerHTML = voiceView();
  $("#view-hooks").innerHTML = hooksView();
  $("#view-settings").innerHTML = settingsView();
}

function setView(view: string) {
  if (!(view in titles)) return;
  state.view = view;
  for (const section of document.querySelectorAll<HTMLElement>(".view"))
    section.hidden = section.id !== `view-${view}`;
  for (const button of document.querySelectorAll<HTMLElement>(".nav-item")) {
    button.classList.toggle("active", button.dataset.view === view);
    if (button.dataset.view === view)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  $("#page-title").textContent = `${titles[view][0]}.`;
  $("#page-description").textContent = titles[view][1];
  if (view === "activity") renderActivity();
  document.title = `${view === "studio" ? "Character Studio" : (navigation.find(([id]) => id === view)?.[1] ?? "Settings")} · Mutuals`;
}

function renderSessionState() {
  const connected = state.connected;
  $("#session-toggle").innerHTML =
    `${icon(connected ? "stop" : "studio", 17)}<span>${connected ? "End session" : state.connecting ? "Connecting…" : "Start session"}</span>${connected ? "" : icon("arrow", 17)}`;
  $<HTMLButtonElement>("#session-toggle").disabled = state.connecting;
  $("#stage-mode").textContent = connected ? "SESSION LIVE" : "PREVIEW";
  $("#runtime-state").textContent = connected
    ? "Connected"
    : state.connecting
      ? "Connecting"
      : "Ready";
  $("#mic-label").innerHTML =
    `${microphone.running ? "On" : "Off"} ${icon("down", 12)}`;
  $("#mic-toggle").innerHTML = icon(microphone.running ? "mic" : "micOff");
  $("#mic-toggle").setAttribute(
    "aria-label",
    microphone.running ? "Turn off microphone" : "Turn on microphone",
  );
  $("#mic-toggle").classList.toggle("mic-active", microphone.running);
  $("#test-mic-button").innerHTML =
    `${icon(microphone.running ? "stop" : "mic", 16)} ${microphone.running ? "Stop microphone" : "Test microphone"}`;
  $("#speaker-toggle").setAttribute(
    "aria-pressed",
    String(!state.settings.speakReplies),
  );
  $("#speaker-toggle").setAttribute(
    "aria-label",
    state.settings.speakReplies
      ? "Mute character voice"
      : "Unmute character voice",
  );
  $("#extension-count").innerHTML =
    `${state.bootstrap!.character.extensions.filter((e) => !state.settings.disabledExtensions.includes(e.name)).length} enabled ${icon("chevron", 12)}`;
  if (!connected)
    $("#stage-caption").textContent = "Say hello when you’re ready.";
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [kind, selector, selected] of [
    ["audioinput", "#input-device", state.settings.inputDevice],
    ["audiooutput", "#output-device", state.settings.outputDevice],
  ]) {
    const select = $<HTMLSelectElement>(selector);
    select.replaceChildren(new Option("System default", ""));
    devices
      .filter(
        (d) =>
          d.kind === kind &&
          d.deviceId !== "default" &&
          d.deviceId !== "communications",
      )
      .forEach((device, i) =>
        select.add(
          new Option(
            device.label ||
              `${kind === "audioinput" ? "Microphone" : "Output"} ${i + 1}`,
            device.deviceId,
          ),
        ),
      );
    select.value = selected;
    if (!select.value) select.value = "";
  }
}

async function saveCharacter(edits: object) {
  const c = state.bootstrap!.character;
  const updated = await request<CharacterInfo>("/api/character", {
    ...edits,
    id: c.id,
    revision: c.revision,
  });
  state.bootstrap!.character = updated;
  renderForms();
  await refreshDevices();
  $("#breadcrumb-character").textContent = updated.name.toUpperCase();
  $("#stage-character-name").textContent = updated.name;
  $("#intro-name").textContent = updated.name;
  $("#intro-description").textContent = updated.description;
  $<HTMLInputElement>("#chat-input").placeholder =
    `Say something to ${updated.name}…`;
  $("#character-select option:checked").textContent = updated.name;
  toast("Saved to the character. A backup is in .cache/frontend/backups.");
  record("settings", "Character settings saved");
}

const value = (id: string) => $<HTMLInputElement>(`#${id}`).value;
const actions: Record<string, () => void | Promise<void>> = {
  "sample-speech": async () => {
    const response = await fetch("/samples/hello.wav");
    if (!response.ok) throw new Error("The sample greeting is unavailable.");
    await sendRecording(
      new File([await response.blob()], "sample-hello.wav", {
        type: "audio/wav",
      }),
    );
    setView("studio");
    showPanel("conversation");
  },
  mic: async () => {
    await toggleMicrophone();
    renderSessionState();
    await refreshDevices();
  },
  "test-mic": async () => {
    await toggleMicrophone(true);
    renderSessionState();
    await refreshDevices();
  },
  "test-output": () =>
    output.test(state.settings.volume, state.settings.outputDevice),
  "refresh-devices": async () => {
    await refreshDevices();
    toast("Device list refreshed.");
  },
  speaker: () => {
    state.settings.speakReplies = !state.settings.speakReplies;
    if (!state.settings.speakReplies) cancelReply();
    saveSettings();
    $<HTMLInputElement>("#speakReplies").checked = state.settings.speakReplies;
    renderSessionState();
  },
  context: () => $<HTMLDialogElement>("#context-dialog").showModal(),
  "close-dialog": () => $<HTMLDialogElement>("#context-dialog").close(),
  "reset-stage": () => stage?.reset(),
  "stage-image": () => stage?.screenshot(),
  fullscreen: () => expandStage(),
  "reset-character": () => {
    $("#view-character").innerHTML = characterView();
    toast("Unsaved edits discarded.");
  },
  "export-transcript": () =>
    download(
      `${state.bootstrap!.character.id}-conversation.json`,
      JSON.stringify(state.messages, null, 2),
    ),
  "new-conversation": () => {
    endSession();
    state.messages = [];
    renderTranscript();
    toast("A fresh conversation is ready.");
  },
  "export-activity": () =>
    download("mutuals-activity.json", JSON.stringify(state.activity, null, 2)),
  "clear-activity": () => {
    state.activity = [];
    renderActivity();
  },
  "check-config": async () => {
    const data = await request<Bootstrap>(
      `/api/bootstrap?character=${encodeURIComponent(state.bootstrap!.character.id)}`,
    );
    state.bootstrap!.character = data.character;
    $("#view-settings").innerHTML = settingsView();
    toast(
      data.character.errors.length
        ? "The character needs attention. See the checks below."
        : "Character checks complete.",
    );
  },
  "reset-preferences": async () => {
    endSession();
    localStorage.removeItem("mutuals-studio-settings");
    location.reload();
  },
};

document.addEventListener("click", (event) => {
  const element = (event.target as HTMLElement).closest<HTMLElement>(
    "button, [data-view]",
  );
  if (!element) return;
  void (async () => {
    if (element.dataset.view) setView(element.dataset.view);
    if (element.dataset.panel) showPanel(element.dataset.panel);
    if (element.dataset.gesture) stage?.gesture(element.dataset.gesture);
    if (element.dataset.hook)
      $("#view-hooks").innerHTML = hooksView(element.dataset.hook);
    if (element.dataset.background) {
      state.settings.background = element.dataset
        .background as Settings["background"];
      $("#character-stage").classList.remove("sky", "paper", "blue");
      $("#character-stage").classList.add(state.settings.background);
      document
        .querySelectorAll<HTMLElement>("[data-background]")
        .forEach((el) =>
          el.setAttribute(
            "aria-pressed",
            String(el.dataset.background === state.settings.background),
          ),
        );
      saveSettings();
    }
    if (element.id === "session-toggle") {
      if (state.connected) endSession();
      else await startSession();
    }
    if (element.dataset.action) await actions[element.dataset.action]?.();
  })().catch((error) => {
    toast(error.message, true);
    renderSessionState();
  });
});

document.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  event.preventDefault();
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button) button.disabled = true;
  void (async () => {
    if (form.id === "chat-form") {
      const input = $<HTMLInputElement>("#chat-input");
      if (!input.value.trim()) return;
      await submit(input.value);
      input.value = "";
      showPanel("conversation");
    } else if (form.id === "context-form") {
      await submit(value("screen-note"), "screen");
      $<HTMLTextAreaElement>("#screen-note").value = "";
      $<HTMLDialogElement>("#context-dialog").close();
      setView("studio");
      showPanel("conversation");
    } else if (form.id === "character-form") {
      await saveCharacter({
        name: value("character-name"),
        description: value("character-description"),
        prompt: value("character-prompt"),
        model: value("character-model"),
        temperature: Number(value("character-temperature")),
      });
    } else if (form.id === "voice-form") {
      await saveCharacter({
        voiceId: value("voice-id"),
        voiceModel: value("voice-model"),
        stability: Number(value("voice-stability")),
        similarity: Number(value("voice-similarity")),
        sttModel: value("stt-model"),
        language: value("stt-language"),
        keyterms: value("stt-keyterms")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      });
    }
  })()
    .catch((error) => toast(error.message, true))
    .finally(() => {
      if (button) button.disabled = false;
    });
});

const numericSettings = new Set(["gain", "volume", "threshold", "silenceMs"]);
const booleanSettings = new Set([
  "echoCancellation",
  "noiseSuppression",
  "speakReplies",
  "captions",
  "paused",
]);
document.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.type === "range") {
    const label = document.getElementById(`${input.id}-value`);
    if (label)
      label.textContent = `${input.value}${input.id === "silenceMs" ? " ms" : ""}`;
  }
  if (numericSettings.has(input.id)) {
    Object.assign(state.settings, { [input.id]: Number(input.value) });
    saveSettings();
    if (input.id === "volume") output.volume(Number(input.value));
  }
});

document.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  void (async () => {
    if (input.id === "character-select") {
      endSession();
      state.messages = [];
      await boot(input.value);
    }
    if (input.id === "emotion-select") stage?.emotion(input.value);
    if (input.id === "camera-select") stage?.frameCamera(input.value);
    if (input.id === "gesture-select" && input.value) {
      stage?.gesture(input.value);
      input.value = "";
    }
    if (input.id === "activity-filter") renderActivity();
    if (input.id === "speech-recording" && input.files?.[0]) {
      await sendRecording(input.files[0]);
      input.value = "";
      setView("studio");
      showPanel("conversation");
    }
    if (booleanSettings.has(input.id)) {
      Object.assign(state.settings, { [input.id]: input.checked });
      saveSettings();
      renderSessionState();
      if (input.id === "speakReplies" && !input.checked) cancelReply();
      if (
        ["echoCancellation", "noiseSuppression"].includes(input.id) &&
        microphone.running
      ) {
        const test = !state.connected;
        await toggleMicrophone(test);
        await toggleMicrophone(test);
      }
    }
    if (input.id === "input-device") {
      state.settings.inputDevice = input.value;
      saveSettings();
      if (microphone.running) {
        const test = !state.connected;
        await toggleMicrophone(test);
        await toggleMicrophone(test);
      }
    }
    if (input.id === "output-device") {
      await output.device(input.value);
      state.settings.outputDevice = input.value;
      saveSettings();
    }
    if (input.id.startsWith("ext-")) {
      const name = input.id.slice(4);
      state.settings.disabledExtensions = input.checked
        ? state.settings.disabledExtensions.filter((x) => x !== name)
        : [...new Set([...state.settings.disabledExtensions, name])];
      saveSettings();
      const selectedHook = document.querySelector<HTMLElement>(
        ".hook-step.selected",
      )?.dataset.hook;
      $("#view-hooks").innerHTML = hooksView(selectedHook);
      renderSessionState();
      toast(
        state.connected
          ? "Extension selection saved for the next session."
          : "Extension selection updated.",
      );
    }
  })().catch((error) => toast(error.message, true));
});

document.addEventListener("transcript", () => {
  renderTranscript();
  const last = state.messages
    .filter((m) => m.role === "assistant")
    .at(-1)
    ?.content.replace(/\[[^\]]+\]/g, "")
    .trim();
  if (state.settings.captions && last)
    $("#stage-caption").textContent = last.slice(-180);
});
document.addEventListener("session-state", () => {
  if (state.bootstrap) renderSessionState();
});
document.addEventListener("activity", () => {
  if (state.bootstrap) renderActivity();
});
navigator.mediaDevices?.addEventListener("devicechange", () => {
  if (state.bootstrap) void refreshDevices();
});

function updateMeters() {
  requestAnimationFrame(updateMeters);
  if (!state.bootstrap) return;
  const level = Math.min(1, microphone.level * 8);
  const meter = document.getElementById("input-level");
  if (meter) {
    meter.style.width = `${Math.round(level * 100)}%`;
    meter.parentElement?.setAttribute(
      "aria-valuenow",
      String(Math.round(level * 100)),
    );
  }
  document.querySelectorAll<HTMLElement>(".audio-bars i").forEach((bar, i) => {
    const energy = microphone.running ? level : output.level() * 5;
    bar.style.height = `${4 + Math.min(1, energy) * (10 + Math.sin(i * 1.7 + performance.now() / 100) * 9)}px`;
  });
  const caption = document.getElementById("stage-caption");
  if (caption)
    caption.style.visibility = state.settings.captions ? "visible" : "hidden";
}

void boot()
  .then(updateMeters)
  .catch((error) => {
    $("#app").innerHTML =
      `<div class="boot-error"><h1>The studio couldn’t open.</h1><p>Check that the frontend server is running and the character manifest is valid.</p><button class="button" id="reload-studio">Try again</button></div>`;
    $("#reload-studio").addEventListener("click", () => location.reload());
    console.error(error);
  });
