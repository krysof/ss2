(() => {
  "use strict";

  const INPUT = {
    left: 1 << 0, right: 1 << 1, up: 1 << 2, down: 1 << 3,
    a: 1 << 4, b: 1 << 5, start: 1 << 6, c: 1 << 7, d: 1 << 8,
  };
  const keyMap = new Map([
    ["ArrowLeft", INPUT.left],
    ["ArrowRight", INPUT.right],
    ["ArrowUp", INPUT.up],
    ["ArrowDown", INPUT.down],
    ["KeyZ", INPUT.a],
    ["KeyX", INPUT.b],
    ["KeyC", INPUT.c],
    ["KeyV", INPUT.d],
    ["Enter", INPUT.start],
  ]);
  const secondKeyMap = new Map([
    ["KeyA", INPUT.left], ["Numpad4", INPUT.left],
    ["KeyD", INPUT.right], ["Numpad6", INPUT.right],
    ["KeyW", INPUT.up], ["Numpad8", INPUT.up],
    ["KeyS", INPUT.down], ["Numpad5", INPUT.down],
    ["KeyJ", INPUT.a], ["Numpad1", INPUT.a],
    ["KeyK", INPUT.b], ["Numpad2", INPUT.b],
    ["KeyL", INPUT.c], ["Numpad3", INPUT.c],
    ["Semicolon", INPUT.d], ["Numpad0", INPUT.d],
  ]);

  const canvas = document.querySelector("#screen");
  const context = canvas.getContext("2d", { alpha: false });
  const loading = document.querySelector("#loading");
  const pointers = new Map();
  let keyboardInput = 0;
  let secondKeyboardInput = 0;
  const music = new Audio();
  music.preload = "none";
  let audioUnlocked = false;
  let pendingMusicPlay = false;
  let soundContext = null;
  let effectsGain = null;
  let effectsAttenuation = 0;
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

  function inputMask() {
    let mask = keyboardInput;
    for (const value of pointers.values()) mask |= value.bit;
    return mask;
  }

  function key(event, down) {
    const bit = keyMap.get(event.code);
    const secondBit = secondKeyMap.get(event.code);
    if (bit === undefined && secondBit === undefined) return;
    event.preventDefault();
    if (down) unlockAudio();
    if (bit !== undefined) {
      keyboardInput = down ? keyboardInput | bit : keyboardInput & ~bit;
    }
    if (secondBit !== undefined) {
      secondKeyboardInput =
        down ? secondKeyboardInput | secondBit : secondKeyboardInput & ~secondBit;
    }
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
    keyboardInput = 0;
    secondKeyboardInput = 0;
    for (const value of pointers.values()) value.button.classList.remove("active");
    pointers.clear();
  });
  document.addEventListener("contextmenu", event => event.preventDefault());

  async function start() {
    if (typeof createSamurai2 !== "function") throw new Error("loader");
    const module = await createSamurai2({ locateFile: file => file, printErr: console.error });
    if (!module._sam2_init()) throw new Error("init");

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
      const first = module._sam2_frontend_selected_fighter(0);
      const second = module._sam2_frontend_selected_fighter(1);
      if (first > 0x11 || second > 0x11) throw new Error("fighter selection");
      const loadFighters =
        module._sam2_frontend_fighter_resources_requested() !== 0;
      if (loadFighters) {
        await upload(`assets/data/embedded/${fighterAssetName("PLY", first, "PRG")}`,
          size => module._sam2_load_resident_fighter_program(size, 0));
        await upload(`assets/data/embedded/${fighterAssetName("PLY", second, "PRG")}`,
          size => module._sam2_load_resident_fighter_program(size, 1));
        if (second !== 0x0C) {
          await upload(`assets/data/embedded/${enemyProgramName(second)}`,
            size => module._sam2_load_enemy_program(size));
        }
      }
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
      const elapsed = Math.min((now - previous) / 1000, .25);
      previous = now;
      module._sam2_set_input(inputMask());
      module._sam2_set_second_input(secondKeyboardInput);
      module._sam2_step(elapsed);
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
