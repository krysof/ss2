(() => {
  "use strict";

  if ("serviceWorker" in navigator &&
      (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js", { scope: "./" })
        .catch(error => console.warn("Service worker registration failed", error));
    });
  }

  const INPUT = {
    left: 1 << 0, right: 1 << 1, up: 1 << 2, down: 1 << 3,
    a: 1 << 4, b: 1 << 5, start: 1 << 6, c: 1 << 7, d: 1 << 8,
  };
  // The original config dialog persists 15 bindings per player, including
  // diagonal and A+B/C+D bindings. These maps are replaced from the generated
  // C++ defaults / versioned JSON as soon as the WASM module is ready.
  let keyMap = new Map();
  let secondKeyMap = new Map();
  let gamepadMaps = [new Map(), new Map()];
  let gamepadKeyboardMaps = [new Map(), new Map()];
  const heldKeyboardCodes = new Set();

  const canvas = document.querySelector("#screen");
  const context = canvas.getContext("2d", { alpha: false });
  const loading = document.querySelector("#loading");
  const pointers = new Map();
  const music = new Audio();
  music.preload = "none";
  let audioUnlocked = false;
  let pendingMusicPlay = false;
  let soundContext = null;
  let effectsGain = null;
  let effectsAttenuation = 0;
  let pageSuspended = false;
  let platformModalOpen = false;
  let resetFrameClock = false;
  let resumeMusicAfterSuspend = false;
  const soundBuffers = new Map();
  const soundVoices = Array.from({ length: 4 }, () => ({
    generation: 0, source: null, soundId: 0,
  }));

  function ensureSoundContext() {
    if (soundContext) return soundContext;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    soundContext = new AudioContext();
    effectsGain = soundContext.createGain();
    // DirectSound volume is signed hundredths of a decibel. The portable
    // event carries its positive attenuation magnitude from the original
    // lookup table, including -100 dB at the zero-percent setting.
    effectsGain.gain.value = Math.pow(10, -effectsAttenuation / 2000);
    effectsGain.connect(soundContext.destination);
    return soundContext;
  }

  function playMusicWhenAllowed() {
    if (!audioUnlocked || !music.src) {
      pendingMusicPlay = Boolean(music.src);
      return;
    }
    pendingMusicPlay = false;
    music.play().catch(() => { pendingMusicPlay = true; });
  }

  function unlockAudio() {
    audioUnlocked = true;
    const audioContext = ensureSoundContext();
    audioContext?.resume().catch(() => {});
    if (pendingMusicPlay) playMusicWhenAllowed();
  }

  function stopSoundVoice(index) {
    const voice = soundVoices[index];
    ++voice.generation;
    if (voice.source) {
      try { voice.source.stop(); } catch (_) {}
      voice.source.disconnect();
      voice.source = null;
    }
    voice.soundId = 0;
  }

  function stopSound(soundId) {
    for (let index = 0; index < soundVoices.length; ++index) {
      if (soundVoices[index].soundId === soundId) stopSoundVoice(index);
    }
  }

  function soundBankName(bank) {
    return `SND_${bank.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  function loadSoundBuffer(bank) {
    if (!soundBuffers.has(bank)) {
      soundBuffers.set(bank, (async () => {
        const response = await fetch(`assets/data/DATA/${soundBankName(bank)}.WAV`);
        if (!response.ok) throw new Error(`sound bank ${response.status}`);
        const audioContext = ensureSoundContext();
        if (!audioContext) throw new Error("WebAudio unavailable");
        const buffer = await audioContext.decodeAudioData(await response.arrayBuffer());
        if (buffer.numberOfChannels !== 1) {
          throw new Error("sound bank format");
        }
        return buffer;
      })());
    }
    return soundBuffers.get(bank);
  }

  async function playSound(event) {
    if (!audioUnlocked || event.voiceSlot < 1 || event.voiceSlot > 4 ||
        event.bank > 0x19 || event.sampleLength === 0) return;
    const index = event.voiceSlot - 1;
    stopSoundVoice(index);
    const voice = soundVoices[index];
    const generation = voice.generation;
    voice.soundId = event.soundId;
    try {
      const buffer = await loadSoundBuffer(event.bank);
      if (voice.generation !== generation || voice.soundId !== event.soundId) return;
      const audioContext = ensureSoundContext();
      if (!audioContext) return;
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      // The original spatial animation opcode selects one of three mapping
      // entries before dispatch; this DirectSound path itself applies no pan.
      source.connect(effectsGain || audioContext.destination);
      source.onended = () => {
        if (voice.generation === generation && voice.source === source) {
          source.disconnect();
          voice.source = null;
          voice.soundId = 0;
        }
      };
      voice.source = source;
      source.start(0, event.sampleStart / 11025, event.sampleLength / 11025);
    } catch (error) {
      if (voice.generation === generation) {
        voice.source = null;
        voice.soundId = 0;
      }
      console.error(error);
    }
  }

  function touchInputMask() {
    let mask = 0;
    for (const value of pointers.values()) mask |= value.bit;
    return mask;
  }

  function keyboardInput(bindings) {
    let mask = 0;
    for (const code of heldKeyboardCodes) mask |= bindings.get(code) || 0;
    return mask;
  }

  function gamepadInput(index, bindings, fallbackBindings) {
    let mask = keyboardInput(fallbackBindings);
    const pads = navigator.getGamepads?.();
    const pad = pads?.[index];
    if (!pad?.connected) return mask;

    // 0x00412790 reads the two axes directly, then scans the seven A..Start
    // records. A joystick code in 1..11 is a one-based button index.
    const pressed = button => pad.buttons[button]?.pressed === true;
    const axisX = Number.isFinite(pad.axes[0]) ? pad.axes[0] : 0;
    const axisY = Number.isFinite(pad.axes[1]) ? pad.axes[1] : 0;
    const gamepadDeadZone = 0.5;
    if (pressed(14) || axisX < -gamepadDeadZone) mask |= INPUT.left;
    if (pressed(15) || axisX > gamepadDeadZone) mask |= INPUT.right;
    if (pressed(12) || axisY < -gamepadDeadZone) mask |= INPUT.up;
    if (pressed(13) || axisY > gamepadDeadZone) mask |= INPUT.down;
    for (const [button, value] of bindings) {
      if (pressed(button)) mask |= value;
    }
    return mask;
  }

  function originalKeyCodeToDomCodes(code) {
    if (code >= 0x41 && code <= 0x5a) {
      return [`Key${String.fromCharCode(code)}`];
    }
    if (code >= 0x30 && code <= 0x39) return [`Digit${code - 0x30}`];
    if (code >= 0x60 && code <= 0x69) return [`Numpad${code - 0x60}`];
    if (code >= 0x70 && code <= 0x7b) return [`F${code - 0x6f}`];
    switch (code) {
    case 0x08: return ["Backspace"];
    case 0x09: return ["Tab"];
    case 0x0d: return ["Enter", "NumpadEnter"];
    case 0x10: return ["ShiftLeft", "ShiftRight"];
    case 0x11: return ["ControlLeft", "ControlRight"];
    case 0x12: return ["AltLeft", "AltRight"];
    case 0x1b: return ["Escape"];
    case 0x20: return ["Space"];
    case 0x121: return ["PageUp"];
    case 0x122: return ["PageDown"];
    case 0x123: return ["End"];
    case 0x124: return ["Home"];
    case 0x125: return ["ArrowLeft"];
    case 0x126: return ["ArrowUp"];
    case 0x127: return ["ArrowRight"];
    case 0x128: return ["ArrowDown"];
    case 0x12d: return ["Insert"];
    case 0x12e: return ["Delete"];
    default: return [];
    }
  }

  function rebuildKeyboardMaps(module) {
    const maps = [new Map(), new Map()];
    const joystickMaps = [new Map(), new Map()];
    const joystickKeyboardMaps = [new Map(), new Map()];
    for (let player = 0; player < maps.length; ++player) {
      for (let binding = 0; binding < 15; ++binding) {
        const mask = module._sam2_controller_binding_mask(binding);
        const originalCode =
          module._sam2_controller_keyboard_code(player, binding);
        for (const domCode of originalKeyCodeToDomCodes(originalCode)) {
          maps[player].set(domCode, (maps[player].get(domCode) || 0) | mask);
        }
        const joystickCode =
          module._sam2_controller_joystick_code(player, binding);
        if (binding >= 8 && joystickCode >= 1 && joystickCode < 12) {
          const button = joystickCode - 1;
          joystickMaps[player].set(
            button, (joystickMaps[player].get(button) || 0) | mask);
        } else if (binding >= 8 && joystickCode >= 12) {
          for (const domJoystickCode of originalKeyCodeToDomCodes(joystickCode)) {
            joystickKeyboardMaps[player].set(
              domJoystickCode,
              (joystickKeyboardMaps[player].get(domJoystickCode) || 0) | mask);
          }
        }
      }
    }
    [keyMap, secondKeyMap] = maps;
    gamepadMaps = joystickMaps;
    gamepadKeyboardMaps = joystickKeyboardMaps;
    heldKeyboardCodes.clear();
  }

  function key(event, down) {
    if (platformModalOpen) return;
    const bit = keyMap.get(event.code);
    const secondBit = secondKeyMap.get(event.code);
    const joystickBit = gamepadKeyboardMaps[0].get(event.code);
    const secondJoystickBit = gamepadKeyboardMaps[1].get(event.code);
    if (bit === undefined && secondBit === undefined &&
        joystickBit === undefined && secondJoystickBit === undefined) return;
    event.preventDefault();
    if (down) unlockAudio();
    if (down) heldKeyboardCodes.add(event.code);
    else heldKeyboardCodes.delete(event.code);
  }

  function refreshButton(button) {
    button.classList.toggle("active", [...pointers.values()].some(value => value.button === button));
  }

  function releasePointer(event) {
    const value = pointers.get(event.pointerId);
    if (!value) return;
    pointers.delete(event.pointerId);
    refreshButton(value.button);
  }

  function clearPhysicalInput() {
    heldKeyboardCodes.clear();
    for (const value of pointers.values()) value.button.classList.remove("active");
    pointers.clear();
  }

  function setPageSuspended(suspended) {
    if (pageSuspended === suspended) return;
    pageSuspended = suspended;
    resetFrameClock = true;
    clearPhysicalInput();
    if (suspended) {
      resumeMusicAfterSuspend = Boolean(music.src) && !music.paused;
      music.pause();
      soundContext?.suspend().catch(() => {});
      return;
    }
    if (audioUnlocked) soundContext?.resume().catch(() => {});
    if (resumeMusicAfterSuspend) playMusicWhenAllowed();
    resumeMusicAfterSuspend = false;
  }

  for (const button of document.querySelectorAll("[data-input]")) {
    const bit = INPUT[button.dataset.input];
    button.addEventListener("pointerdown", event => {
      event.preventDefault();
      unlockAudio();
      releasePointer(event);
      pointers.set(event.pointerId, { bit, button });
      button.classList.add("active");
      button.setPointerCapture?.(event.pointerId);
    });
    button.addEventListener("pointerup", releasePointer);
    button.addEventListener("pointercancel", releasePointer);
    button.addEventListener("lostpointercapture", releasePointer);
    button.addEventListener("contextmenu", event => event.preventDefault());
  }

  window.addEventListener("keydown", event => key(event, true));
  window.addEventListener("keyup", event => key(event, false));
  window.addEventListener("blur", () => {
    setPageSuspended(true);
  });
  window.addEventListener("focus", () => {
    if (!document.hidden) setPageSuspended(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      setPageSuspended(true);
    } else if (document.hasFocus()) {
      setPageSuspended(false);
    }
  });
  document.addEventListener("contextmenu", event => event.preventDefault());

  async function start() {
    if (typeof createSamurai2 !== "function") throw new Error("loader");
    const module = await createSamurai2({ locateFile: file => file, printErr: console.error });
    if (!module._sam2_init()) throw new Error("init");

    // FUN_00410ba0/0x00410e90 read/write window placement and four audio
    // DWORDs. 0x00412970/0x00412c50 additionally preserve a controller selector
    // and 15 keyboard/joystick bindings per player. Keep the exact raw values
    // in one versioned JSON record; the former audio-only v1 remains a migration
    // source.
    const preferencesStorageKey = "samurai-shodown-2.preferences.v2";
    const legacyPreferencesStorageKey = "samurai-shodown-2.preferences.v1";
    let lastPreferencesJson = "";
    function platformPreferences() {
      const controllers = [];
      for (let player = 0; player < 2; ++player) {
        const bindings = [];
        for (let binding = 0; binding < 15; ++binding) {
          bindings.push([
            module._sam2_controller_keyboard_code(player, binding) >>> 0,
            module._sam2_controller_joystick_code(player, binding) >>> 0,
          ]);
        }
        controllers.push({
          selector: module._sam2_controller_selector(player) >>> 0, bindings,
        });
      }
      return {
        version: 2,
        effectsEnabled: module._sam2_effects_enabled() !== 0,
        effectsPercent: module._sam2_effects_percent() >>> 0,
        musicEnabled: module._sam2_music_enabled() !== 0,
        musicPercent: module._sam2_music_percent() >>> 0,
        window: {
          sizeX: module._sam2_window_size_x() >>> 0,
          sizeY: module._sam2_window_size_y() >>> 0,
          topX: module._sam2_window_top_x(),
          topY: module._sam2_window_top_y(),
        },
        controllers,
      };
    }
    // Capture the executable-derived defaults before importing persisted host
    // values. The original property pages restore these table values rather
    // than whatever happened to be active when the sheet was opened.
    const factoryPreferences = platformPreferences();
    function validPreferenceDword(value) {
      return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
    }
    function validPreferenceSignedDword(value) {
      return Number.isInteger(value) &&
        value >= -0x80000000 && value <= 0x7fffffff;
    }
    function validAudioPreferences(preferences) {
      return typeof preferences?.effectsEnabled === "boolean" &&
        validPreferenceDword(preferences.effectsPercent) &&
        typeof preferences.musicEnabled === "boolean" &&
        validPreferenceDword(preferences.musicPercent);
    }
    function applyAudioPreferences(preferences) {
      module._sam2_set_audio_settings(
        preferences.effectsEnabled ? 1 : 0, preferences.effectsPercent,
        preferences.musicEnabled ? 1 : 0, preferences.musicPercent);
    }
    if (validPreferenceDword(window.outerWidth) &&
        validPreferenceDword(window.outerHeight) &&
        validPreferenceSignedDword(window.screenX) &&
        validPreferenceSignedDword(window.screenY)) {
      module._sam2_set_window_preferences(
        window.outerWidth, window.outerHeight, window.screenX, window.screenY);
    }
    try {
      const saved = localStorage.getItem(preferencesStorageKey);
      if (saved) {
        const preferences = JSON.parse(saved);
        const placement = preferences?.window;
        const controllers = preferences?.controllers;
        if (preferences?.version === 2 && validAudioPreferences(preferences) &&
            validPreferenceDword(placement?.sizeX) &&
            validPreferenceDword(placement?.sizeY) &&
            validPreferenceSignedDword(placement?.topX) &&
            validPreferenceSignedDword(placement?.topY) &&
            Array.isArray(controllers) && controllers.length === 2 &&
            controllers.every(controller =>
              validPreferenceDword(controller?.selector) &&
              Array.isArray(controller?.bindings) &&
              controller.bindings.length === 15 &&
              controller.bindings.every(binding =>
                Array.isArray(binding) && binding.length === 2 &&
                validPreferenceDword(binding[0]) &&
                validPreferenceDword(binding[1])))) {
          applyAudioPreferences(preferences);
          module._sam2_set_window_preferences(
            placement.sizeX, placement.sizeY, placement.topX, placement.topY);
          controllers.forEach((controller, player) => {
            module._sam2_set_controller_selector(player, controller.selector);
            controller.bindings.forEach((binding, index) => {
              module._sam2_set_controller_binding(
                player, index, binding[0], binding[1]);
            });
          });
        }
      } else {
        const legacy = localStorage.getItem(legacyPreferencesStorageKey);
        if (legacy) {
          const preferences = JSON.parse(legacy);
          if (preferences?.version === 1 && validAudioPreferences(preferences)) {
            applyAudioPreferences(preferences);
          }
        }
      }
    } catch (error) {
      console.warn("preferences storage import failed", error);
    }
    rebuildKeyboardMaps(module);
    function persistPreferences() {
      const encoded = JSON.stringify(platformPreferences());
      if (encoded === lastPreferencesJson) return;
      try {
        localStorage.setItem(preferencesStorageKey, encoded);
        lastPreferencesJson = encoded;
      } catch (error) {
        console.warn("preferences storage export failed", error);
      }
    }
    persistPreferences();

    const optionsDialog = document.querySelector("#options-dialog");
    const aboutDialog = document.querySelector("#about-dialog");
    const screenFrame = document.querySelector(".screen-frame");
    const bindingLabels = [
      "Up", "Down", "Left", "Right",
      "Up + Left", "Up + Right", "Down + Left", "Down + Right",
      "Quick Slash - A", "Power Slash - B", "Quick Kick - C",
      "Power Kick - D", "Strong Slash - A+B", "Strong Kick - C+D",
      "Start Button",
    ];
    let optionDraft = null;
    let displayMode = "current";
    let captureBinding = null;
    let captureHeldButtons = new Set();

    function setPlatformModal(open) {
      platformModalOpen = open;
      resetFrameClock = true;
      clearPhysicalInput();
      if (!open && captureBinding) {
        captureBinding.button.classList.remove("capturing");
        captureBinding = null;
      }
    }

    function closeMenus() {
      for (const root of document.querySelectorAll(".menu-root.open")) {
        root.classList.remove("open");
        root.querySelector("[data-menu-root]")?.setAttribute(
          "aria-expanded", "false");
      }
    }

    function originalKeyName(code) {
      if (code === 0) return "None";
      if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code);
      if (code >= 0x30 && code <= 0x39) return String.fromCharCode(code);
      if (code >= 0x60 && code <= 0x69) return `Num ${code - 0x60}`;
      if (code >= 0x70 && code <= 0x7b) return `F${code - 0x6f}`;
      const names = new Map([
        [0x08, "Backspace"], [0x09, "Tab"], [0x0d, "Enter"],
        [0x10, "Shift"], [0x11, "Ctrl"], [0x12, "Alt"],
        [0x1b, "Escape"], [0x20, "Space"],
        [0x121, "Page Up"], [0x122, "Page Down"], [0x123, "End"],
        [0x124, "Home"], [0x125, "Left"], [0x126, "Up"],
        [0x127, "Right"], [0x128, "Down"], [0x12d, "Insert"],
        [0x12e, "Delete"],
      ]);
      return names.get(code) || `0x${code.toString(16).toUpperCase()}`;
    }

    function originalJoystickName(code) {
      if (code === 0) return "None";
      if (code >= 1 && code < 12) return `Button ${code}`;
      return originalKeyName(code);
    }

    function domCodeToOriginalKeyCode(code) {
      if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
      if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
      if (/^Numpad[0-9]$/.test(code)) return 0x60 + Number(code.slice(6));
      if (/^F(?:[1-9]|1[0-2])$/.test(code)) return 0x6f + Number(code.slice(1));
      const values = new Map([
        ["Backspace", 0x08], ["Tab", 0x09], ["Enter", 0x0d],
        ["ShiftLeft", 0x10], ["ShiftRight", 0x10],
        ["ControlLeft", 0x11], ["ControlRight", 0x11],
        ["AltLeft", 0x12], ["AltRight", 0x12], ["Escape", 0x1b],
        ["Space", 0x20], ["PageUp", 0x121], ["PageDown", 0x122],
        ["End", 0x123], ["Home", 0x124], ["ArrowLeft", 0x125],
        ["ArrowUp", 0x126], ["ArrowRight", 0x127],
        ["ArrowDown", 0x128], ["Insert", 0x12d], ["Delete", 0x12e],
      ]);
      return values.get(code) ?? null;
    }

    function refreshBindingButton(button, player, binding) {
      const controller = optionDraft.controllers[player];
      const joystick = controller.selector !== 0xffffffff;
      const code = controller.bindings[binding][joystick ? 1 : 0] >>> 0;
      button.textContent = joystick ? originalJoystickName(code) :
        originalKeyName(code);
      button.title = `${bindingLabels[binding]}: ${button.textContent}`;
    }

    function fillControllerSelector(select, selected) {
      select.replaceChildren();
      const keyboard = document.createElement("option");
      keyboard.value = String(0xffffffff);
      keyboard.textContent = "Keyboard";
      select.append(keyboard);
      const pads = navigator.getGamepads?.() || [];
      for (let index = 0; index < pads.length; ++index) {
        const pad = pads[index];
        if (!pad?.connected) continue;
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = pad.id || `Gamepad ${index + 1}`;
        select.append(option);
      }
      if (selected !== 0xffffffff &&
          ![...select.options].some(option => Number(option.value) === selected)) {
        const missing = document.createElement("option");
        missing.value = String(selected);
        missing.textContent = `Gamepad ${selected + 1}`;
        select.append(missing);
      }
      select.value = String(selected >>> 0);
    }

    function renderPlayerPage(page) {
      const player = Number(page.dataset.player);
      const controller = optionDraft.controllers[player];
      const select = page.querySelector("[data-controller-selector]");
      fillControllerSelector(select, controller.selector >>> 0);
      select.onchange = () => {
        controller.selector = Number(select.value) >>> 0;
        if (captureBinding) {
          captureBinding.button.classList.remove("capturing");
          captureBinding = null;
        }
        renderPlayerPage(page);
      };
      const grid = page.querySelector("[data-binding-grid]");
      grid.replaceChildren();
      bindingLabels.forEach((label, binding) => {
        const row = document.createElement("div");
        row.className = "binding-row";
        const caption = document.createElement("label");
        caption.textContent = label;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "binding-capture";
        refreshBindingButton(button, player, binding);
        button.addEventListener("click", () => {
          if (captureBinding) captureBinding.button.classList.remove("capturing");
          const joystick = controller.selector !== 0xffffffff;
          captureBinding = { player, binding, button, joystick };
          captureHeldButtons = new Set();
          if (joystick) {
            const pad = navigator.getGamepads?.()[controller.selector];
            pad?.buttons.forEach((value, index) => {
              if (value.pressed) captureHeldButtons.add(index);
            });
          }
          button.classList.add("capturing");
          button.textContent = joystick ? "Press a button..." : "Press a key...";
        });
        row.append(caption, button);
        grid.append(row);
      });
    }

    function selectOptionTab(name) {
      for (const tab of optionsDialog.querySelectorAll("[data-option-tab]")) {
        const selected = tab.dataset.optionTab === name;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      for (const page of optionsDialog.querySelectorAll("[data-option-page]")) {
        page.classList.toggle("active", page.dataset.optionPage === name);
      }
    }

    function refreshSoundPage() {
      const effects = optionsDialog.querySelector("#effects-percent");
      const musicPercent = optionsDialog.querySelector("#music-percent");
      optionsDialog.querySelector("#effects-enabled").checked =
        optionDraft.effectsEnabled;
      effects.value = String(optionDraft.effectsPercent);
      optionsDialog.querySelector("#music-enabled").checked =
        optionDraft.musicEnabled;
      musicPercent.value = String(optionDraft.musicPercent);
      optionsDialog.querySelector("#effects-percent-output").value =
        `${effects.value}%`;
      optionsDialog.querySelector("#music-percent-output").value =
        `${musicPercent.value}%`;
    }

    function openOptions(page) {
      closeMenus();
      optionDraft = platformPreferences();
      displayMode = document.fullscreenElement === screenFrame ? "fullscreen" :
        document.body.classList.contains("display-640") ? "640" :
        document.body.classList.contains("display-320") ? "320" : "current";
      const radio = optionsDialog.querySelector(
        `input[name="display-mode"][value="${displayMode}"]`);
      if (radio) radio.checked = true;
      refreshSoundPage();
      for (const playerPage of optionsDialog.querySelectorAll("[data-player]")) {
        renderPlayerPage(playerPage);
      }
      selectOptionTab(page);
      setPlatformModal(true);
      optionsDialog.showModal();
    }

    async function applyDisplaySelection() {
      const selected = optionsDialog.querySelector(
        'input[name="display-mode"]:checked')?.value || "current";
      displayMode = selected;
      document.body.classList.toggle("display-320", selected === "320");
      document.body.classList.toggle("display-640", selected === "640");
      if (selected === "fullscreen") {
        if (document.fullscreenElement !== screenFrame) {
          await screenFrame.requestFullscreen?.();
        }
      } else if (document.fullscreenElement === screenFrame) {
        await document.exitFullscreen?.();
      }
      const size = selected === "320" ? [320, 240] :
        selected === "640" ? [640, 480] :
        [Math.max(1, window.outerWidth), Math.max(1, window.outerHeight)];
      module._sam2_set_window_preferences(
        size[0], size[1], Math.trunc(window.screenX), Math.trunc(window.screenY));
    }

    async function applyOptions() {
      optionDraft.effectsEnabled =
        optionsDialog.querySelector("#effects-enabled").checked;
      optionDraft.effectsPercent = Number(
        optionsDialog.querySelector("#effects-percent").value);
      optionDraft.musicEnabled =
        optionsDialog.querySelector("#music-enabled").checked;
      optionDraft.musicPercent = Number(
        optionsDialog.querySelector("#music-percent").value);
      module._sam2_set_audio_settings(
        optionDraft.effectsEnabled ? 1 : 0, optionDraft.effectsPercent,
        optionDraft.musicEnabled ? 1 : 0, optionDraft.musicPercent);
      optionDraft.controllers.forEach((controller, player) => {
        module._sam2_set_controller_selector(player, controller.selector >>> 0);
        controller.bindings.forEach((binding, index) => {
          module._sam2_set_controller_binding(
            player, index, binding[0] >>> 0, binding[1] >>> 0);
        });
      });
      rebuildKeyboardMaps(module);
      await applyDisplaySelection();
      persistPreferences();
    }

    for (const tab of optionsDialog.querySelectorAll("[data-option-tab]")) {
      tab.addEventListener("click", () => selectOptionTab(tab.dataset.optionTab));
    }
    for (const input of optionsDialog.querySelectorAll(
         "#effects-percent, #music-percent")) {
      input.addEventListener("input", () => {
        optionsDialog.querySelector(`#${input.id}-output`).value = `${input.value}%`;
      });
    }
    optionsDialog.querySelector("#sound-defaults").addEventListener("click", () => {
      optionDraft.effectsEnabled = factoryPreferences.effectsEnabled;
      optionDraft.effectsPercent = factoryPreferences.effectsPercent;
      optionDraft.musicEnabled = factoryPreferences.musicEnabled;
      optionDraft.musicPercent = factoryPreferences.musicPercent;
      refreshSoundPage();
    });
    for (const page of optionsDialog.querySelectorAll("[data-player]")) {
      page.querySelector("[data-controller-defaults]").addEventListener("click", () => {
        const player = Number(page.dataset.player);
        optionDraft.controllers[player] = JSON.parse(JSON.stringify(
          factoryPreferences.controllers[player]));
        renderPlayerPage(page);
      });
    }
    optionsDialog.querySelector("#options-apply").addEventListener(
      "click", () => { void applyOptions(); });
    optionsDialog.querySelector("#options-ok").addEventListener("click", async () => {
      await applyOptions();
      optionsDialog.close();
    });
    optionsDialog.querySelector("#options-cancel").addEventListener(
      "click", () => optionsDialog.close());
    optionsDialog.addEventListener("close", () => setPlatformModal(false));
    optionsDialog.addEventListener("cancel", () => setPlatformModal(false));
    aboutDialog.addEventListener("close", () => setPlatformModal(false));
    aboutDialog.addEventListener("cancel", () => setPlatformModal(false));

    document.addEventListener("keydown", event => {
      if (!captureBinding) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const captured = captureBinding;
      if (event.code === "Escape") {
        captured.button.classList.remove("capturing");
        refreshBindingButton(captured.button, captured.player, captured.binding);
        captureBinding = null;
        return;
      }
      const code = event.code === "Backspace" ? 0 :
        domCodeToOriginalKeyCode(event.code);
      if (code === null) return;
      if (captured.joystick && code !== 0 && code < 12) return;
      const field = captured.joystick ? 1 : 0;
      const duplicate = code === 0 ? -1 :
        optionDraft.controllers[captured.player].bindings.findIndex(
          (binding, index) => index !== captured.binding &&
            binding[field] === code);
      if (duplicate >= 0) {
        window.alert(
          `Cannot map '${originalKeyName(code)}' to more than one action!`);
        captured.button.classList.remove("capturing");
        captureBinding = null;
        refreshBindingButton(captured.button, captured.player, captured.binding);
        return;
      }
      optionDraft.controllers[captured.player]
        .bindings[captured.binding][field] = code;
      captured.button.classList.remove("capturing");
      captureBinding = null;
      refreshBindingButton(captured.button, captured.player, captured.binding);
    }, true);

    function pollGamepadBinding() {
      if (!captureBinding?.joystick) return;
      const captured = captureBinding;
      const selector =
        optionDraft.controllers[captured.player].selector;
      const pad = navigator.getGamepads?.()[selector];
      if (!pad?.connected) return;
      const pressed = new Set();
      for (let index = 0; index < Math.min(11, pad.buttons.length); ++index) {
        if (!pad.buttons[index].pressed) continue;
        pressed.add(index);
        if (captureHeldButtons.has(index)) continue;
        const code = index + 1;
        const duplicate = optionDraft.controllers[captured.player].bindings.findIndex(
          (binding, bindingIndex) => bindingIndex !== captured.binding &&
            binding[1] === code);
        if (duplicate >= 0) {
          window.alert(
            `Cannot map '${originalJoystickName(code)}' to more than one action!`);
        } else {
          optionDraft.controllers[captured.player]
            .bindings[captured.binding][1] = code;
        }
        captured.button.classList.remove("capturing");
        captureBinding = null;
        refreshBindingButton(captured.button, captured.player, captured.binding);
        return;
      }
      captureHeldButtons = pressed;
    }

    for (const button of document.querySelectorAll("[data-menu-root]")) {
      button.addEventListener("click", event => {
        event.stopPropagation();
        const root = button.closest(".menu-root");
        const opening = !root.classList.contains("open");
        closeMenus();
        if (opening) {
          root.classList.add("open");
          button.setAttribute("aria-expanded", "true");
        }
      });
    }
    for (const root of document.querySelectorAll(".menu-root")) {
      root.addEventListener("pointerenter", () => {
        if (!document.querySelector(".menu-root.open") || root.classList.contains("open")) {
          return;
        }
        closeMenus();
        root.classList.add("open");
        root.querySelector("[data-menu-root]").setAttribute("aria-expanded", "true");
      });
    }
    document.addEventListener("pointerdown", event => {
      if (!event.target.closest(".platform-menu")) closeMenus();
    });
    for (const command of document.querySelectorAll("[data-menu-command]")) {
      command.addEventListener("click", () => {
        const id = Number(command.dataset.menuCommand);
        closeMenus();
        if (id === 40006) {
          clearPhysicalInput();
          module._sam2_reset();
          resetFrameClock = true;
        } else if (id === 40001) {
          window.close();
        } else if (id === 40012) {
          openOptions("display");
        } else if (id === 40016) {
          openOptions("sound");
        } else if (id === 40017) {
          openOptions("player-1");
        } else if (id === 40018) {
          openOptions("player-2");
        } else if (id >= 40013 && id <= 40015) {
          const fragment = id === 40013 ? "Contents" :
            id === 40014 ? "search" : "using-help";
          const help = window.open(`help.html#${fragment}`, "samurai2-help");
          help?.focus();
        } else if (id === 40025) {
          setPlatformModal(true);
          aboutDialog.showModal();
        }
      });
    }

    // The registry value is 0x72 bytes. 0x004d77e0 scans the complete block
    // but copies only its first six dwords into game state; keep the opaque
    // tail too. The former 24-byte v1 key remains a one-way migration source.
    const rankingStorageKey = "samurai-shodown-2.rank-data.v2";
    const legacyRankingStorageKey = "samurai-shodown-2.rank-data.v1";
    let lastRankingHex = "";
    function importRankingHex(saved, size, importer) {
      if (!saved || saved.length !== size * 2 ||
          !/^[0-9a-f]+$/i.test(saved)) return false;
      const bytes = new Uint8Array(size);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(
          saved.slice(index * 2, index * 2 + 2), 16);
      }
      const pointer = module._sam2_upload_buffer(bytes.length);
      if (!pointer) return false;
      module.HEAPU8.set(bytes, pointer);
      return importer(bytes.length) !== 0;
    }
    try {
      const saved = localStorage.getItem(rankingStorageKey);
      if (importRankingHex(
          saved, 0x72,
          size => module._sam2_import_persistent_ranking_data(size))) {
        lastRankingHex = saved.toLowerCase();
      } else {
        importRankingHex(
          localStorage.getItem(legacyRankingStorageKey), 24,
          size => module._sam2_import_ranking_data(size));
      }
    } catch (error) {
      console.warn("ranking storage import failed", error);
    }

    function persistRanking() {
      const size = module._sam2_persistent_ranking_data_size();
      const pointer = module._sam2_persistent_ranking_data();
      if (size !== 0x72 || !pointer) return;
      let encoded = "";
      for (const value of module.HEAPU8.subarray(pointer, pointer + size)) {
        encoded += value.toString(16).padStart(2, "0");
      }
      if (encoded === lastRankingHex) return;
      try {
        localStorage.setItem(rankingStorageKey, encoded);
        lastRankingHex = encoded;
      } catch (error) {
        console.warn("ranking storage export failed", error);
      }
    }

    // Save_Data is the original variable-size registry allocation used by the
    // four-command service at 0x004da040. Missing and present-but-empty are
    // distinct states, so null means no localStorage entry while "" is valid.
    const saveDataStorageKey = "samurai-shodown-2.save-data.v1";
    let lastSaveDataHex = null;
    function decodeHex(saved) {
      if (saved.length % 2 !== 0 ||
          (saved.length !== 0 && !/^[0-9a-f]+$/i.test(saved))) return null;
      const bytes = new Uint8Array(saved.length / 2);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(
          saved.slice(index * 2, index * 2 + 2), 16);
      }
      return bytes;
    }
    try {
      const saved = localStorage.getItem(saveDataStorageKey);
      if (saved !== null) {
        const bytes = decodeHex(saved);
        if (bytes !== null) {
          const pointer = module._sam2_upload_buffer(bytes.length);
          const uploaded = bytes.length === 0 || pointer;
          if (bytes.length !== 0 && pointer) {
            module.HEAPU8.set(bytes, pointer);
          }
          if (uploaded && module._sam2_import_save_data(bytes.length) !== 0) {
            lastSaveDataHex = saved.toLowerCase();
          }
        }
      }
    } catch (error) {
      console.warn("Save_Data storage import failed", error);
    }

    function persistSaveData() {
      const present = module._sam2_save_data_present() !== 0;
      if (!present) {
        if (lastSaveDataHex === null) return;
        try {
          localStorage.removeItem(saveDataStorageKey);
          lastSaveDataHex = null;
        } catch (error) {
          console.warn("Save_Data storage erase failed", error);
        }
        return;
      }
      const size = module._sam2_save_data_size();
      const pointer = module._sam2_save_data();
      if (size !== 0 && !pointer) return;
      let encoded = "";
      for (const value of module.HEAPU8.subarray(pointer, pointer + size)) {
        encoded += value.toString(16).padStart(2, "0");
      }
      if (encoded === lastSaveDataHex) return;
      try {
        localStorage.setItem(saveDataStorageKey, encoded);
        lastSaveDataHex = encoded;
      } catch (error) {
        console.warn("Save_Data storage export failed", error);
      }
    }

    async function upload(url, load) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`asset ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const pointer = module._sam2_upload_buffer(bytes.length);
      if (!pointer) throw new Error("asset memory");
      module.HEAPU8.set(bytes, pointer);
      if (!load(bytes.length)) throw new Error("asset format");
    }

    const patternResponse = await fetch("assets/audio/patterns/manifest.json");
    if (!patternResponse.ok) throw new Error(`pattern manifest ${patternResponse.status}`);
    const patternManifest = await patternResponse.json();
    if (patternManifest.bank_count !== 25 || patternManifest.record_count !== 857) {
      throw new Error("pattern manifest format");
    }
    for (const bank of patternManifest.banks) {
      const bankNumber = Number.parseInt(bank.path.slice(4, 6), 16);
      await upload(`assets/audio/patterns/${bank.path}`,
        size => module._sam2_load_sound_patterns(size, bankNumber, bank.wav_data_bytes));
    }
    // The original title route selects palette package 5 and resolves its
    // bank-19 patterns through the first static SPR manager slot.
    await upload("assets/data/DATA/GAME1.PRG",
      size => module._sam2_load_game1(size, 5));
    await upload("assets/data/DATA/GAME_CV.PRG",
      size => module._sam2_load_game_cv(size));
    await upload("assets/data/embedded/CV_M.PRG",
      size => module._sam2_load_game_cv_tile_bank_map(size));
    await upload("assets/data/DATA/063_S1.FIX",
      size => module._sam2_load_fix(size));
    await upload("assets/data/DATA/F1400.SPR",
      size => module._sam2_load_sprite_archive(size, 0));
    await upload("assets/data/DATA/B100.BGR",
      size => module._sam2_load_frontend_background_archive(size));

    const width = module._sam2_width();
    const height = module._sam2_height();
    canvas.width = width;
    canvas.height = height;
    const image = context.createImageData(width, height);
    const byteCount = width * height * 4;
    let previous = performance.now();
    let battleResourceLoad = null;
    let fatalError = null;
    loading.classList.add("hidden");

    function fighterAssetName(prefix, fighter, extension) {
      const selector = fighter.toString(16).toUpperCase().padStart(2, "0");
      return `${prefix}_${selector}.${extension}`;
    }

    function fighterSpriteName(fighter) {
      const selector = (fighter + 1).toString(16).toUpperCase().padStart(2, "0");
      return `F0C${selector}.SPR`;
    }

    function enemyProgramName(fighter) {
      return fighter === 0x0A ? "SQU_OB.PRG" : fighterAssetName("SQU", fighter, "PRG");
    }

    function stageArchiveName(code) {
      return `B${code.toString(16).toUpperCase().padStart(3, "0")}.BGR`;
    }

    async function loadBattleResources() {
      const loadEnding =
        module._sam2_frontend_ending_resources_requested() !== 0;
      if (loadEnding) {
        await upload("assets/data/DATA/END_CV.PRG",
          size => module._sam2_load_ending_game_cv(size));
        await upload("assets/data/embedded/CV_E.PRG",
          size => module._sam2_load_ending_game_cv_tile_bank_map(size));
        for (const [slot, name] of
             ["F1400.SPR", "F1500.SPR", "F1600.SPR", "F0806.SPR"].entries()) {
          await upload(`assets/data/DATA/${name}`,
            size => module._sam2_load_ending_sprite_archive(size, slot));
        }
        if (!module._sam2_mark_frontend_battle_resources_ready()) {
          throw new Error("ending resources were rejected");
        }
        return;
      }
      const first = module._sam2_frontend_selected_fighter(0);
      const second = module._sam2_frontend_selected_fighter(1);
      const activeMask = module._sam2_frontend_active_mask();
      if (first > 0x11 || second > 0x11) throw new Error("fighter selection");
      if (activeMask < 1 || activeMask > 3) throw new Error("active player mask");
      const loadFighters =
        module._sam2_frontend_fighter_resources_requested() !== 0;
      const loadStage =
        module._sam2_frontend_stage_resources_requested() !== 0;
      if (loadFighters) {
        await upload(`assets/data/embedded/${fighterAssetName("PLY", first, "PRG")}`,
          size => module._sam2_load_resident_fighter_program(size, 0));
        await upload(`assets/data/embedded/${fighterAssetName("PLY", second, "PRG")}`,
          size => module._sam2_load_resident_fighter_program(size, 1));
        const enemy = activeMask === 2 ? first : second;
        if (activeMask !== 3 && enemy !== 0x0C) {
          await upload(`assets/data/embedded/${enemyProgramName(enemy)}`,
            size => module._sam2_load_enemy_program(size));
        }
      }
      if (loadStage) {
        const stageArchiveCount =
          module._sam2_frontend_battle_stage_archive_count();
        if (stageArchiveCount < 1 || stageArchiveCount > 2) {
          throw new Error("battle stage archive count");
        }
        for (let index = 0; index < stageArchiveCount; index += 1) {
          const code =
            module._sam2_frontend_battle_stage_archive_code(index);
          if (code > 0xFFF) throw new Error("battle stage archive code");
          await upload(`assets/data/DATA/${stageArchiveName(code)}`,
            size => module._sam2_load_stage_archive(size, code));
        }
      }
      if (loadFighters) {
        await upload(`assets/data/DATA/${fighterSpriteName(first)}`,
          size => module._sam2_load_sprite_archive(size, 12));
        await upload(`assets/data/DATA/${fighterSpriteName(second)}`,
          size => module._sam2_load_sprite_archive(size, 16));
      }
      if (!module._sam2_mark_frontend_battle_resources_ready()) {
        throw new Error("battle resources were rejected");
      }
    }

    function requestBattleResources() {
      if (battleResourceLoad ||
          !module._sam2_frontend_battle_resources_requested()) return;
      battleResourceLoad = loadBattleResources()
        .then(() => { battleResourceLoad = null; })
        .catch(error => {
          fatalError = error;
          loading.classList.remove("hidden");
          loading.classList.add("error");
          console.error(error);
        });
    }

    function consumeAudioEvents() {
      const count = module._sam2_audio_event_count();
      for (let index = 0; index < count; ++index) {
        const kind = module._sam2_audio_event_kind(index);
        const value = module._sam2_audio_event_value(index);
        const flags = module._sam2_audio_event_flags(index);
        switch (kind) {
        case 0: // sound_play
          void playSound({
            soundId: value,
            bank: module._sam2_audio_event_bank(index),
            voiceSlot: module._sam2_audio_event_voice_slot(index),
            sampleStart: module._sam2_audio_event_sample_start(index),
            sampleLength: module._sam2_audio_event_sample_length(index),
          });
          break;
        case 1: // sound_stop
          stopSound(value);
          break;
        case 2: // sound_stop_all
          for (let voice = 0; voice < soundVoices.length; ++voice) stopSoundVoice(voice);
          break;
        case 3: { // music_play: value is the physical CD track number
          const source = `assets/audio/track${String(value).padStart(2, "0")}.flac`;
          if (!music.src.endsWith(source)) music.src = source;
          music.loop = (flags & 2) !== 0;
          music.currentTime = 0;
          pendingMusicPlay = true;
          playMusicWhenAllowed();
          break;
        }
        case 4: // music_pause
          music.pause();
          pendingMusicPlay = false;
          break;
        case 5: // music_resume
          music.loop = (flags & 2) !== 0;
          pendingMusicPlay = true;
          playMusicWhenAllowed();
          break;
        case 6: // music_stop
          music.pause();
          pendingMusicPlay = false;
          try { music.currentTime = 0; } catch (_) {}
          break;
        case 7: // effects_volume: positive DirectSound attenuation, 1/100 dB
          effectsAttenuation = Math.min(value, 10000);
          if (effectsGain && soundContext) {
            effectsGain.gain.setValueAtTime(
              Math.pow(10, -effectsAttenuation / 2000), soundContext.currentTime);
          }
          break;
        case 8: // music_volume: identical left/right WinMM aux word
          music.volume = Math.min(value, 0xffff) / 0xffff;
          break;
        default:
          break;
        }
      }
      module._sam2_clear_audio_events();
    }

    function frame(now) {
      if (fatalError) return;
      pollGamepadBinding();
      if (resetFrameClock) {
        previous = now;
        resetFrameClock = false;
      }
      if (pageSuspended || platformModalOpen) {
        previous = now;
        requestAnimationFrame(frame);
        return;
      }
      const elapsed = Math.min((now - previous) / 1000, .25);
      previous = now;
      const firstController = module._sam2_controller_selector(0) >>> 0;
      const secondController = module._sam2_controller_selector(1) >>> 0;
      module._sam2_set_input(touchInputMask() |
        (firstController === 0xffffffff ? keyboardInput(keyMap) :
          gamepadInput(
            firstController, gamepadMaps[0], gamepadKeyboardMaps[0])));
      module._sam2_set_second_input(
        secondController === 0xffffffff ? keyboardInput(secondKeyMap) :
          gamepadInput(secondController, gamepadMaps[1], gamepadKeyboardMaps[1]));
      module._sam2_step(elapsed);
      persistPreferences();
      persistRanking();
      persistSaveData();
      requestBattleResources();
      consumeAudioEvents();
      const pointer = module._sam2_framebuffer();
      image.data.set(module.HEAPU8.subarray(pointer, pointer + byteCount));
      context.putImageData(image, 0, 0);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  start().catch(error => {
    loading.classList.add("error");
    console.error(error);
  });
})();
