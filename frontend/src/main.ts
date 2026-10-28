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
  stopCharacterSpeech,
  toggleMicrophone,
} from "./session.ts";
import { CharacterStage } from "./stage/stage.ts";
import { shell } from "./ui/shell.ts";
import { renderTranscript, studio, renderStudioLive } from "./ui/studio.ts";
import {
  characterView,
  characterDetail,
  renderCharacterCards,
} from "./ui/character.ts";
import {
  createCharacterView,
  revealInvalidCreationField,
  creationDefinition,
  animationRow,
  animationAssignments,
  selectedExtensions,
} from "./ui/character-authoring.ts";
import { changeChatPreset, promptPreview } from "./ui/character-fields.ts";
import {
  changeVoicePreset,
  filterLanguageOptions,
  chooseLanguage,
  languageKeydown,
} from "./ui/voice-fields.ts";
import {
  installExtensionOrdering,
  moveExtension,
} from "./ui/extension-order.ts";
import {
  renderSidebarCharacter,
  openCharacterSwitcher,
  closeCharacterSwitcher,
  renderSwitcherCharacters,
  switcherKeydown,
} from "./ui/character-switcher.ts";
import { hooksView, renderExtensionCards } from "./ui/hooks.ts";
import { settingsView } from "./ui/settings.ts";
import { expandStage } from "./ui/expanded-stage.ts";
import { initialStudioLive, studioPresence } from "./lib/studio-live.ts";
import type { Bootstrap, CharacterInfo } from "./types.ts";

installExtensionOrdering();

let stage: CharacterStage | null = null;
let pendingDeletion: CharacterInfo | null = null;
let lastAudibleVolume = state.settings.volume || 0.8;
async function boot(
  id?: string,
  view = "studio",
  creationDraft: Element | null = null,
) {
  let data = await request<Bootstrap>(
    `/api/bootstrap${id ? `?character=${encodeURIComponent(id)}` : ""}`,
  );
  const remembered = !id
    ? localStorage.getItem("mutuals-current-character")
    : null;
  if (
    remembered &&
    remembered !== data.character.id &&
    data.characters.some((character) => character.id === remembered)
  )
    data = await request<Bootstrap>(
      `/api/bootstrap?character=${encodeURIComponent(remembered)}`,
    );
  stage?.dispose();
  state.bootstrap = data;
  localStorage.setItem("mutuals-current-character", data.character.id);
  state.managedCharacter = null;
  state.live = initialStudioLive();
  document.body.append($("#toast"));
  $("#app").innerHTML = shell();
  $("#view-studio").innerHTML = studio();
  renderForms();
  if (creationDraft) $("#view-character-new").replaceChildren(creationDraft);
  renderTranscript();
  try {
    stage = new CharacterStage($("#stage-canvas"));
    void stage.load(data.character);
  } catch {
    $("#stage-loading").textContent =
      "WebGL is unavailable. Enable hardware acceleration to use the 3D stage.";
  }
  setView(view);
  renderSessionState();
  await refreshDevices();
}

function renderForms() {
  renderSidebarCharacter();
  $("#view-character").innerHTML = characterView();
  renderCharacterCards();
  $("#view-character-detail").innerHTML = characterDetail();
  $("#view-hooks").innerHTML = hooksView();
  $("#view-settings").innerHTML = settingsView();
  renderStudioLive();
}

function setView(view: string) {
  const titles: Record<string, string> = {
    studio: "Studio",
    character: "Characters",
    "character-detail": (state.managedCharacter ?? state.bootstrap!.character)
      .name,
    "character-new": "New character",
    hooks: "Extensions",
    settings: "Settings",
  };
  if (!(view in titles)) return;
  document.querySelectorAll<HTMLElement>("main > .page").forEach((section) => {
    section.hidden = section.id !== `view-${view}`;
  });
  document
    .querySelectorAll<HTMLElement>(".nav-item[data-view]")
    .forEach((button) => {
      if (
        button.dataset.view ===
        (view.startsWith("character-") ? "character" : view)
      )
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  $("#page-title").textContent = titles[view];
  document.title = `${titles[view]} · Character Harness`;
  if (view === "character")
    void refreshLibrary().catch(() =>
      toast("Could not refresh the character library.", true),
    );
  window.scrollTo({ top: 0 });
}

function renderSessionState() {
  const connected = state.connected;
  const keyForm = document.querySelector<HTMLFormElement>(
    "#provider-keys-form",
  );
  if (keyForm) {
    const running = connected || state.connecting;
    keyForm.querySelector<HTMLFieldSetElement>("fieldset")!.disabled = running;
    keyForm.querySelector<HTMLElement>(
      '[data-action="end-settings-session"]',
    )!.hidden = !running;
    keyForm.querySelector("#provider-keys-note")!.textContent = running
      ? "End the session before changing keys."
      : "New keys apply to the next session. No app restart needed.";
    keyForm.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!.disabled = running;
  }
  $("#session-toggle").innerHTML =
    `${icon(connected ? "stop" : "studio", 17)}<span>${connected ? "End session" : state.connecting ? "Connecting…" : "Start session"}</span>${connected ? "" : icon("arrow", 17)}`;
  $<HTMLButtonElement>("#session-toggle").disabled = state.connecting;
  const liveMic = microphone.running && state.micMode === "live";
  const testing = microphone.running && state.micMode === "test";
  const mic = $<HTMLButtonElement>("#mic-toggle");
  mic.innerHTML = `${icon(microphone.running ? "mic" : "micOff", 16)} ${state.micPending ? (microphone.running ? "Stopping…" : "Enabling…") : liveMic ? "Microphone on" : testing ? "Microphone test" : "Microphone off"}`;
  mic.disabled = state.micPending;
  mic.setAttribute("aria-pressed", String(liveMic));
  mic.setAttribute(
    "aria-label",
    liveMic ? "Turn off microphone" : "Turn on microphone",
  );
  mic.classList.toggle("mic-active", liveMic);
  mic.classList.toggle("mic-off", !microphone.running);
  mic.classList.toggle("mic-testing", testing);
  const test = $<HTMLButtonElement>("#test-mic-button");
  test.innerHTML = `${icon(microphone.running ? "stop" : "mic", 16)} ${microphone.running ? "Stop microphone" : "Test microphone"}`;
  test.disabled = state.micPending;
  const muted = !state.settings.speakReplies || state.settings.volume === 0;
  $("#volume-toggle").innerHTML = icon(muted ? "volumeOff" : "volume", 18);
  $("#speaker-toggle").innerHTML =
    `${icon(muted ? "volumeOff" : "volume", 16)} ${muted ? "Muted" : "Sound on"}`;
  $("#speaker-toggle").setAttribute("aria-pressed", String(muted));
  $("#speaker-toggle").setAttribute(
    "aria-label",
    muted ? "Unmute character audio" : "Mute character audio",
  );
  $("#speaker-toggle").classList.toggle("speaker-muted", muted);
  $<HTMLInputElement>("#volume").value = String(state.settings.volume);
  $("#volume-value").textContent =
    `${Math.round(state.settings.volume * 100)}%`;
  renderStudioPresence();
  if (!connected) $("#stage-caption").textContent = "";
}

function renderStudioPresence() {
  const presence = studioPresence({
    connected: state.connected,
    connecting: state.connecting,
    microphone: microphone.running,
    mode: state.micMode,
    hearing: microphone.hearingSpeech,
    playing: output.playing,
    status: state.status,
  });
  const label = document.getElementById("listening-state");
  if (!label) return;
  if (label.textContent !== presence.label) label.textContent = presence.label;
  $("#studio-listening").dataset.state = presence.kind;
  const short =
    presence.kind === "idle"
      ? state.connected
        ? "Ready"
        : "Offline"
      : presence.kind === "error"
        ? "Needs attention"
        : presence.kind === "testing"
          ? "Local test"
          : presence.kind === "listening"
            ? "Listening"
            : presence.kind === "speaking"
              ? "Speaking"
              : state.status === "Thinking"
                ? "Thinking"
                : state.status === "Transcribing…"
                  ? "Transcribing"
                  : "Connecting";
  $("#character-presence").textContent = short;
  const transcript = $("#live-transcript");
  transcript.hidden = !state.live.partialTranscript;
  if (transcript.textContent !== state.live.partialTranscript)
    transcript.textContent = state.live.partialTranscript;
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
    if (kind === "audiooutput" && select.disabled) {
      if (state.settings.outputDevice) {
        state.settings.outputDevice = "";
        saveSettings();
      }
      continue;
    }
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
    if (!select.value && selected) {
      Object.assign(state.settings, {
        [kind === "audioinput" ? "inputDevice" : "outputDevice"]: "",
      });
      saveSettings();
    }
  }
}

async function saveCharacter(edits: object) {
  const c = state.managedCharacter ?? state.bootstrap!.character;
  const updated = await request<CharacterInfo>("/api/character", {
    ...edits,
    id: c.id,
    revision: c.revision,
  });
  await acceptCharacterUpdate(updated);
  toast("Character settings saved.");
  record("settings", "Character settings saved");
}
async function acceptCharacterUpdate(updated: CharacterInfo) {
  const expandedForms = [
    ...document.querySelectorAll<HTMLFormElement>(
      "#view-character-detail details.authoring-card[open] > form",
    ),
  ].map((form) => form.id);
  if (state.managedCharacter?.id === updated.id)
    state.managedCharacter = updated;
  if (state.bootstrap!.character.id === updated.id)
    state.bootstrap!.character = updated;
  const entry = state.bootstrap!.characters.find((c) => c.id === updated.id);
  if (entry) {
    entry.name = updated.name;
    entry.modifiedAt = Date.now();
  }
  renderForms();
  for (const id of expandedForms)
    document.getElementById(id)!.closest<HTMLDetailsElement>("details")!.open =
      true;
  await refreshDevices();
  renderSessionState();
  renderTranscript();
  if (!$("#view-character-detail").hidden) setView("character-detail");
}
async function refreshLibrary() {
  const data = await request<Bootstrap>(
    `/api/bootstrap?character=${encodeURIComponent(state.bootstrap!.character.id)}`,
  );
  state.bootstrap!.characters = data.characters;
  state.bootstrap!.availableExtensions = data.availableExtensions;
  state.bootstrap!.chatPresets = data.chatPresets;
  state.bootstrap!.voicePresets = data.voicePresets;
  renderSidebarCharacter();
  renderCharacterCards();
}
async function openCharacter(id: string) {
  state.managedCharacter = await request<CharacterInfo>(
    `/api/character?character=${encodeURIComponent(id)}`,
  );
  renderForms();
  await refreshDevices();
  setView("character-detail");
}
async function uploadCharacter(
  url: string,
  form: FormData,
): Promise<CharacterInfo & { id: string }> {
  const response = await fetch(url, { method: "POST", body: form });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Could not save character files.");
  return result;
}

async function selectCharacter(id: string, view = "studio") {
  if (id === state.bootstrap!.character.id) {
    setView(view);
    return;
  }
  endSession();
  state.messages = [];
  const draft =
    view === "character-new"
      ? $("#view-character-new").firstElementChild
      : null;
  await boot(id, view, draft);
}

const value = (id: string) => $<HTMLInputElement>(`#${id}`).value;

document.addEventListener(
  "close",
  () => document.body.append($("#toast")),
  true,
);

const actions: Record<string, (element: HTMLElement) => void | Promise<void>> =
  {
    "upload-extension": () =>
      $<HTMLDialogElement>("#extension-upload-dialog").showModal(),
    "close-extension-upload": () =>
      $<HTMLDialogElement>("#extension-upload-dialog").close(),
    "configure-extensions": async () => {
      await openCharacter(state.bootstrap!.character.id);
      const form = $("#character-extensions-form");
      form.closest<HTMLDetailsElement>("details")!.open = true;
      form
        .closest("details")!
        .scrollIntoView({ behavior: "smooth", block: "start" });
    },
    "switch-character-menu": async () => {
      if (!$("#character-switcher-menu").hidden) closeCharacterSwitcher();
      else {
        await refreshLibrary();
        openCharacterSwitcher();
      }
    },
    "close-character-switcher": () => closeCharacterSwitcher(true),
    "edit-provider-key": (element) => {
      const row = element.closest(".provider-key")!;
      row.querySelector<HTMLElement>(".provider-key-editor")!.hidden = false;
      element.hidden = true;
      element
        .closest("form")!
        .querySelector<HTMLButtonElement>('button[type="submit"]')!.hidden =
        false;
      row.querySelector<HTMLInputElement>("input")!.focus();
    },
    "cancel-provider-key": (element) => {
      const row = element.closest(".provider-key")!;
      row.querySelector<HTMLInputElement>("input")!.value = "";
      row.querySelector<HTMLElement>(".provider-key-editor")!.hidden = true;
      const edit = row.querySelector<HTMLButtonElement>(
        '[data-action="edit-provider-key"]',
      )!;
      edit.hidden = false;
      edit.focus();
      const form = element.closest("form")!;
      form.querySelector<HTMLButtonElement>('button[type="submit"]')!.hidden =
        !form.querySelector(".provider-key-editor:not([hidden])");
    },
    "confirm-delete-character": async (element) => {
      if (!pendingDeletion) return;
      element.setAttribute("disabled", "");
      try {
        const deleted = pendingDeletion;
        await request("/api/character-delete", {
          id: deleted.id,
          revision: deleted.revision,
        });
        $<HTMLDialogElement>("#delete-character-dialog").close();
        pendingDeletion = null;
        if (state.bootstrap!.character.id === deleted.id) {
          await selectCharacter("foxglove", "character");
        } else {
          if (state.managedCharacter?.id === deleted.id)
            state.managedCharacter = null;
          await refreshLibrary();
          renderForms();
          setView("character");
        }
        toast(`${deleted.name} deleted.`);
      } finally {
        element.removeAttribute("disabled");
      }
    },
    "new-character": () => {
      $("#view-character-new").innerHTML = createCharacterView();
      setView("character-new");
    },
    "add-animation": (element) => {
      element
        .closest("form")!
        .querySelector(".animation-assignments")!
        .insertAdjacentHTML("beforeend", animationRow());
    },
    "remove-animation": (element) => {
      element.closest(".animation-row")?.remove();
    },
    "toggle-sidebar": () => {
      const collapsed =
        $(".workspace-layout").classList.toggle("sidebar-collapsed");
      const button = $(".sidebar-toggle");
      button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute(
        "aria-label",
        collapsed ? "Expand sidebar" : "Collapse sidebar",
      );
      button.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    },
    "audio-setup": async () => {
      $<HTMLDialogElement>("#audio-settings-dialog").showModal();
      await refreshDevices();
      renderSessionState();
    },
    mic: async () => {
      if (microphone.running && state.micMode === "test")
        await toggleMicrophone(true);
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
      const muted = !state.settings.speakReplies || state.settings.volume === 0;
      state.settings.speakReplies = muted;
      if (muted && state.settings.volume === 0)
        state.settings.volume = lastAudibleVolume;
      if (!state.settings.speakReplies) stopCharacterSpeech();
      output.volume(state.settings.speakReplies ? state.settings.volume : 0);
      saveSettings();
      renderSessionState();
    },
    context: () => {
      document
        .querySelectorAll<HTMLDetailsElement>(".studio-volume-menu")
        .forEach((menu) => (menu.open = false));
      $<HTMLDialogElement>("#context-dialog").showModal();
    },
    "close-dialog": (element) =>
      element.closest<HTMLDialogElement>("dialog")!.close(),
    fullscreen: () => expandStage(),
    "reset-character": () => {
      $("#view-character-detail").innerHTML = characterDetail();
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
    "end-settings-session": () => {
      endSession();
      $("#view-settings").innerHTML = settingsView();
    },
  };

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest(".studio-volume-menu"))
    document
      .querySelectorAll<HTMLDetailsElement>(".studio-volume-menu")
      .forEach((menu) => (menu.open = false));
  if (!target.closest("#character-switcher-menu, #character-account"))
    closeCharacterSwitcher();
  document
    .querySelectorAll<HTMLDetailsElement>(".language-picker[open]")
    .forEach((picker) => {
      if (!picker.contains(event.target as Node)) picker.open = false;
    });
  const sortMenu = document.querySelector<HTMLDetailsElement>(".library-sort");
  if (sortMenu && !(event.target as HTMLElement).closest(".library-sort"))
    sortMenu.open = false;
  const element = (event.target as HTMLElement).closest<HTMLElement>(
    "button, [data-view]",
  );
  if (!element) return;
  void (async () => {
    if (element.dataset.language) chooseLanguage(element);
    if (element.dataset.promptMode) {
      const group = element.closest<HTMLElement>(".prompt-field")!;
      const textarea = group.querySelector<HTMLTextAreaElement>("textarea")!;
      const preview = group.querySelector<HTMLElement>(".prompt-preview")!;
      const show = element.dataset.promptMode === "preview";
      if (show)
        preview.innerHTML =
          promptPreview(textarea.value) ||
          "<p>Write a personality to preview it here.</p>";
      textarea.hidden = show;
      preview.hidden = !show;
      group
        .querySelectorAll<HTMLButtonElement>("[data-prompt-mode]")
        .forEach((button) =>
          button.setAttribute("aria-pressed", String(button === element)),
        );
    }
    if (element.dataset.view) {
      if (element.matches(".nav-item")) {
        state.managedCharacter = null;
        renderForms();
      }
      setView(element.dataset.view);
    }
    if (element.dataset.switcherPage) {
      renderSwitcherCharacters(undefined, Number(element.dataset.switcherPage));
      document
        .querySelector<HTMLButtonElement>("#switcher-results button")
        ?.focus();
    }
    if (element.dataset.switchCharacter) {
      const view = document
        .querySelector<HTMLElement>("main > .page:not([hidden])")!
        .id.replace("view-", "");
      closeCharacterSwitcher();
      if (element.dataset.switchCharacter === state.bootstrap!.character.id) {
        state.managedCharacter = null;
        renderForms();
        setView(view);
      } else {
        await selectCharacter(element.dataset.switchCharacter, view);
      }
    }
    if (element.dataset.deleteCharacter) {
      pendingDeletion = await request<CharacterInfo>(
        `/api/character?character=${encodeURIComponent(element.dataset.deleteCharacter)}`,
      );
      $("#delete-character-name").textContent = pendingDeletion.name;
      $("#delete-active-note").hidden =
        pendingDeletion.id !== state.bootstrap!.character.id;
      $<HTMLDialogElement>("#delete-character-dialog").showModal();
    }
    if (element.dataset.character)
      await openCharacter(element.dataset.character);
    if (element.dataset.characterSort) {
      renderCharacterCards(undefined, 1, element.dataset.characterSort);
      const menu = document.querySelector<HTMLDetailsElement>(".library-sort")!;
      menu.open = false;
      menu.querySelector<HTMLElement>("summary")!.focus();
    }
    if (element.dataset.characterPage)
      renderCharacterCards(undefined, Number(element.dataset.characterPage));
    if (element.dataset.moveExtension)
      moveExtension(
        element.closest<HTMLElement>(".extension-choice")!,
        element.dataset.moveExtension,
      );
    if (element.dataset.gesture) stage?.gesture(element.dataset.gesture);
    if (element.dataset.extensionPage)
      renderExtensionCards(undefined, Number(element.dataset.extensionPage));
    if (element.id === "session-toggle") {
      if (state.connected) endSession();
      else await startSession();
    }
    if (element.dataset.action)
      await actions[element.dataset.action]?.(element);
  })().catch((error) => {
    toast(error.message, true);
    renderSessionState();
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const volume = document.querySelector<HTMLDetailsElement>(
      ".studio-volume-menu[open]",
    );
    if (volume) {
      volume.open = false;
      volume.querySelector<HTMLElement>("summary")!.focus();
      event.preventDefault();
    }
  }
  languageKeydown(event);
  switcherKeydown(event);
  const menu = (event.target as HTMLElement).closest<HTMLDetailsElement>(
    ".library-sort",
  );
  if (!menu) return;
  if (event.key === "Escape") {
    menu.open = false;
    menu.querySelector<HTMLElement>("summary")!.focus();
    event.preventDefault();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  menu.open = true;
  const buttons = [
    ...menu.querySelectorAll<HTMLButtonElement>("[data-character-sort]"),
  ];
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : index < 0
          ? event.key === "ArrowUp"
            ? buttons.length - 1
            : 0
          : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
            buttons.length;
  buttons[next].focus();
});
document.addEventListener(
  "toggle",
  (event) => {
    const picker = event.target as HTMLDetailsElement;
    if (picker.matches(".language-picker") && picker.open)
      picker.querySelector<HTMLInputElement>('input[type="search"]')!.focus();
  },
  true,
);

document.addEventListener("focusout", (event) => {
  const switcher = document.getElementById("character-switcher-menu");
  if (
    switcher &&
    !switcher.hidden &&
    event.relatedTarget &&
    !switcher.contains(event.relatedTarget as Node) &&
    event.relatedTarget !== document.getElementById("character-account")
  )
    closeCharacterSwitcher();
  const menu = (event.target as HTMLElement).closest<HTMLDetailsElement>(
    ".library-sort, .language-picker, .studio-volume-menu",
  );
  if (
    menu &&
    event.relatedTarget &&
    !menu.contains(event.relatedTarget as Node)
  )
    menu.open = false;
});

document.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  event.preventDefault();
  if (
    ["create-character-form", "character-form"].includes(form.id) &&
    revealInvalidCreationField(form)
  )
    return;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const buttonLabel = button?.innerHTML;
  if (button) button.disabled = true;
  void (async () => {
    if (form.id === "extension-upload-form") {
      $("#extension-upload-error").textContent = "";
      const response = await fetch("/api/extensions/import", {
        method: "POST",
        body: new FormData(form),
      });
      const result = await response.json();
      if (!response.ok) {
        $("#extension-upload-error").textContent =
          result.error ?? "Could not install extension.";
        return;
      }
      $<HTMLDialogElement>("#extension-upload-dialog").close();
      state.bootstrap!.availableExtensions = result.availableExtensions;
      renderForms();
      toast("Extension installed. Enable it in a character when you’re ready.");
    } else if (form.id === "create-character-form") {
      $("#create-character-error").textContent = "";
      const data = new FormData(form);
      data.set("definition", JSON.stringify(creationDefinition(form)));
      if (button) button.textContent = "Creating…";
      const created = await uploadCharacter("/api/characters", data);
      $("#view-character-new").replaceChildren();
      await refreshLibrary();
      await openCharacter(created.id);
      toast("Character created.");
    } else if (form.id === "provider-keys-form") {
      const c = state.managedCharacter ?? state.bootstrap!.character;
      const keys = Object.fromEntries(
        [...form.querySelectorAll<HTMLInputElement>("[data-provider-key]")].map(
          (input) => [input.dataset.providerKey!, input.value],
        ),
      );
      const updated = await request<CharacterInfo>("/api/provider-keys", {
        id: c.id,
        keys,
      });
      form.reset();
      await acceptCharacterUpdate(updated);
      toast("API keys saved. They will be used by the next session.");
    } else if (form.id === "character-assets-form") {
      const c = state.managedCharacter ?? state.bootstrap!.character;
      const data = new FormData(form);
      data.set("character", c.id);
      data.set(
        "definition",
        JSON.stringify({
          revision: c.revision,
          springs: $<HTMLInputElement>("#managed-springs").checked,
          animations: animationAssignments(form),
        }),
      );
      const updated = await uploadCharacter("/api/character-assets", data);
      await acceptCharacterUpdate(updated);
      await refreshLibrary();
      toast("Body and animations saved.");
    } else if (form.id === "character-extensions-form") {
      const c = state.managedCharacter ?? state.bootstrap!.character;
      const updated = await request<CharacterInfo>(
        "/api/character-extensions",
        {
          id: c.id,
          revision: c.revision,
          extensions: selectedExtensions(form),
        },
      );
      await acceptCharacterUpdate(updated);
      toast("Extensions saved for this character.");
    } else if (form.id === "chat-form") {
      const input = $<HTMLInputElement>("#chat-input");
      if (!input.value.trim()) return;
      await submit(input.value);
      input.value = "";
    } else if (form.id === "context-form") {
      await submit(value("screen-note"), "screen");
      $<HTMLTextAreaElement>("#screen-note").value = "";
      $<HTMLDialogElement>("#context-dialog").close();
      setView("studio");
    } else if (form.id === "character-form") {
      await saveCharacter({
        name: value("character-name"),
        chatApi: value("character-api"),
        chatBaseUrl: value("character-base-url"),
        chatKeyName: value("character-key-name"),
        description: value("character-description"),
        prompt: value("character-prompt"),
        model: value("character-model"),
      });
    } else if (form.id === "character-voice-form") {
      await saveCharacter({
        voiceId: value("managed-voice-id"),
        language: value("managed-language"),
      });
    }
  })()
    .catch((error) => {
      if (form.id === "create-character-form")
        $("#create-character-error").textContent = error.message;
      else toast(error.message, true);
    })
    .finally(() => {
      if (button) {
        button.disabled = false;
        if (buttonLabel) button.innerHTML = buttonLabel;
      }
    });
});

const numericSettings = new Set(["gain", "volume", "threshold", "silenceMs"]);
const booleanSettings = new Set([
  "echoCancellation",
  "noiseSuppression",
  "speakReplies",
  "captions",
]);
document.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "switcher-search") renderSwitcherCharacters(input.value, 1);
  if (input.closest(".language-search")) filterLanguageOptions(input);
  if (input.id === "extension-search") renderExtensionCards(input.value);
  if (input.id === "character-search") renderCharacterCards(input.value, 1);
  if (input.type === "range") {
    const label = document.getElementById(`${input.id}-value`);
    if (label)
      label.textContent =
        input.id === "volume"
          ? `${Math.round(Number(input.value) * 100)}%`
          : `${input.value}${input.id === "silenceMs" ? " ms" : ""}`;
  }
  if (numericSettings.has(input.id)) {
    Object.assign(state.settings, { [input.id]: Number(input.value) });
    saveSettings();
    if (input.id === "volume") {
      if (state.settings.volume > 0) lastAudibleVolume = state.settings.volume;
      output.volume(state.settings.speakReplies ? state.settings.volume : 0);
      renderSessionState();
    }
  }
});

document.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  void (async () => {
    if (input.matches("[data-voice-preset]"))
      changeVoicePreset(input as unknown as HTMLSelectElement);
    if (input.matches("[data-chat-preset]"))
      changeChatPreset(input as unknown as HTMLSelectElement);
    if (input.classList.contains("animation-kind")) {
      const row = input.closest(".animation-row")!;
      const name = row.querySelector<HTMLInputElement>(".animation-name")!;
      name.required = input.value !== "idle";
      name.placeholder =
        input.value === "idle"
          ? "Not needed for idle"
          : input.value === "talk"
            ? "regular"
            : "wave";
      row.querySelector<HTMLElement>(".animation-hold")!.hidden =
        input.value !== "gesture";
    }
    if (input.id === "background-select") {
      state.settings.background =
        input.value as typeof state.settings.background;
      $("#character-stage").classList.remove("sky", "paper", "blue");
      $("#character-stage").classList.add(state.settings.background);
      saveSettings();
    }
    if (booleanSettings.has(input.id)) {
      Object.assign(state.settings, { [input.id]: input.checked });
      saveSettings();
      renderSessionState();
      if (input.id === "speakReplies" && !input.checked) stopCharacterSpeech();
      if (
        ["echoCancellation", "noiseSuppression"].includes(input.id) &&
        microphone.running
      ) {
        const test = state.micMode === "test";
        await toggleMicrophone(test);
        await toggleMicrophone(test);
      }
    }
    if (input.id === "input-device") {
      state.settings.inputDevice = input.value;
      saveSettings();
      if (microphone.running) {
        const test = state.micMode === "test";
        await toggleMicrophone(test);
        await toggleMicrophone(test);
      }
    }
    if (input.id === "output-device") {
      await output.ready(
        state.settings.speakReplies ? state.settings.volume : 0,
        input.value,
      );
      state.settings.outputDevice = input.value;
      saveSettings();
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
document.addEventListener("studio-live", () => {
  if (state.bootstrap) {
    renderStudioLive();
    renderStudioPresence();
  }
});

navigator.mediaDevices?.addEventListener("devicechange", () => {
  if (state.bootstrap) void refreshDevices();
});

function updateMeters() {
  requestAnimationFrame(updateMeters);
  if (!state.bootstrap) return;
  const level = Math.min(1, microphone.level * 8);
  document
    .querySelectorAll<HTMLElement>("[data-input-level]")
    .forEach((meter) => {
      meter.style.width = `${Math.round(level * 100)}%`;
      meter.parentElement?.setAttribute(
        "aria-valuenow",
        String(Math.round(level * 100)),
      );
    });
  renderStudioPresence();
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
