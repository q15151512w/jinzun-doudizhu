/* ============================================================
   金樽牌局 · 声音
   纯 Web Audio 合成的五声音阶氛围音乐 + 牌桌音效
   （无任何外部音频文件）
   ============================================================ */
(function (global) {
  'use strict';

  const PREF_KEY = 'jinzun.ddz.audio';
  const STEP = 0.42;            // 每步 0.42s ≈ 71 BPM 的八分音符
  const BASE_FREQ = 293.66;     // D4

  let prefs = { music: true, sfx: true };
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (typeof saved.music === 'boolean') prefs.music = saved.music;
    if (typeof saved.sfx === 'boolean') prefs.sfx = saved.sfx;
  } catch (e) { /* noop */ }

  let ctx = null;
  let master = null;
  let musicBus = null;
  let sfxBus = null;
  let delaySend = null;
  let noiseBuf = null;
  let timer = null;
  let nextTime = 0;
  let step = 0;
  let running = false;

  const MUSIC_VOL = 0.16;

  // 旋律：相对 D4 的半音偏移（五声音阶 0,3,5,7,10 + 八度），null 为休止
  const MELODY = [
    12, null, 10, null, 7, null, null, 5,
    7, null, 10, 12, null, 10, null, null,
    15, null, 12, null, 10, null, 7, null,
    5, null, 7, 5, 3, null, null, null
  ];
  const CHORDS = [
    [50, 53, 57], // Dm
    [46, 50, 53], // Bb
    [48, 52, 55], // C
    [45, 48, 52]  // Am
  ];

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* noop */ }
  }

  function midiToFreq(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    musicBus = ctx.createGain();
    musicBus.gain.value = prefs.music ? MUSIC_VOL : 0;
    musicBus.connect(master);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = prefs.sfx ? 0.55 : 0;
    sfxBus.connect(master);

    // 空间感：带反馈的低通延迟
    const delay = ctx.createDelay(1.2);
    delay.delayTime.value = 0.34;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.3;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 1700;
    const wet = ctx.createGain();
    wet.gain.value = 0.45;
    delay.connect(damp);
    damp.connect(feedback);
    feedback.connect(delay);
    damp.connect(wet);
    wet.connect(musicBus);
    delaySend = delay;

    // 白噪声缓冲（音效复用）
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function noise(when, dur, filterType, freqStart, freqEnd, gainVal, destination) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filterType || 'bandpass';
    f.frequency.setValueAtTime(freqStart, when);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), when + dur);
    f.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gainVal, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(f);
    f.connect(g);
    g.connect(destination || sfxBus);
    src.start(when);
    src.stop(when + dur + 0.05);
    return g;
  }

  function tone(type, freq, when, dur, gainVal, dest, opts) {
    opts = opts || {};
    const osc = ctx.createOscillator();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, when);
    if (opts.endFreq) {
      osc.frequency.exponentialRampToValueAtTime(opts.endFreq, when + (opts.slide || dur));
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainVal), when + (opts.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    let node = osc;
    if (opts.filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.filter;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(dest || sfxBus);
    osc.start(when);
    osc.stop(when + dur + 0.05);
    return g;
  }

  /* ------------------------- instruments ------------------------- */

  function pluck(freq, when, gainVal, send, dur) {
    const t = when;
    const d = dur || 1.9;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const overtone = ctx.createOscillator();
    overtone.type = 'sawtooth';
    overtone.frequency.value = freq * 2.002;
    const overtoneGain = ctx.createGain();
    overtoneGain.gain.value = 0.1;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(3600, t);
    filter.frequency.exponentialRampToValueAtTime(420, t + Math.min(1.4, d * 0.75));

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainVal), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);

    osc.connect(filter);
    overtone.connect(overtoneGain);
    overtoneGain.connect(filter);
    filter.connect(g);
    g.connect(musicBus);

    if (send && delaySend) {
      const sg = ctx.createGain();
      sg.gain.value = send;
      g.connect(sg);
      sg.connect(delaySend);
    }

    osc.start(t);
    overtone.start(t);
    osc.stop(t + d + 0.05);
    overtone.stop(t + d + 0.05);
  }

  function pad(notes, when, dur) {
    for (const midi of notes) {
      const freq = midiToFreq(midi);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.028, when + 2.2);
      g.gain.linearRampToValueAtTime(0.0001, when + dur);

      const a = ctx.createOscillator();
      a.type = 'sine';
      a.frequency.value = freq;
      const b = ctx.createOscillator();
      b.type = 'triangle';
      b.frequency.value = freq * 2.001;
      const bg = ctx.createGain();
      bg.gain.value = 0.18;

      a.connect(g);
      b.connect(bg);
      bg.connect(g);
      g.connect(musicBus);

      a.start(when);
      b.start(when);
      a.stop(when + dur + 0.1);
      b.stop(when + dur + 0.1);
    }
  }

  function bell(freq, when, gainVal) {
    const g1 = tone('sine', freq, when, 2.6, gainVal || 0.045, musicBus, { attack: 0.008 });
    const g2 = tone('sine', freq * 2.76, when, 1.4, (gainVal || 0.045) * 0.4, musicBus, { attack: 0.006 });
    if (delaySend) {
      const send = ctx.createGain();
      send.gain.value = 0.35;
      g1.connect(send);
      send.connect(delaySend);
      g2.connect(send);
    }
  }

  /* ------------------------- sequencer ------------------------- */

  function playStep(index, when) {
    const s = index % 64;
    const note = MELODY[s % 32];

    if (note !== null && note !== undefined) {
      let freq = BASE_FREQ * Math.pow(2, note / 12);
      // 第二遍乐句加入轻微高八度的呼应
      if (s >= 32 && s % 8 === 4) freq *= 2;
      pluck(freq, when, 0.09 + Math.random() * 0.025, 0.45);
    }

    if (s % 16 === 0) {
      const chord = CHORDS[Math.floor(s / 16) % CHORDS.length];
      pad(chord, when, STEP * 16 + 0.6);
      const root = chord[0] - 12;
      pluck(midiToFreq(root), when, 0.07, 0.15, 3.2);
    }

    if (s % 16 === 12) {
      bell(midiToFreq(74 + (s % 32 === 12 ? 0 : 3)), when, 0.03);
    }

    // 极轻的木质节拍
    if (s % 8 === 4) {
      noise(when, 0.05, 'bandpass', 2400, 1800, 0.012, musicBus);
    }
  }

  function scheduler() {
    if (!ctx || !running) return;
    while (nextTime < ctx.currentTime + 0.9) {
      playStep(step, nextTime);
      step = (step + 1) % 64;
      nextTime += STEP;
    }
  }

  function startMusic() {
    if (!ensure()) return;
    if (running) return;
    running = true;
    nextTime = ctx.currentTime + 0.15;
    scheduler();
    timer = setInterval(scheduler, 220);
  }

  function stopMusic() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function setMusicEnabled(on) {
    prefs.music = !!on;
    savePrefs();
    if (on) {
      startMusic();
      if (ctx && musicBus) {
        musicBus.gain.cancelScheduledValues(ctx.currentTime);
        musicBus.gain.setTargetAtTime(MUSIC_VOL, ctx.currentTime, 0.25);
      }
    } else if (ctx && musicBus) {
      musicBus.gain.cancelScheduledValues(ctx.currentTime);
      musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    }
  }

  function setSfxEnabled(on) {
    prefs.sfx = !!on;
    savePrefs();
    if (ctx && sfxBus) {
      sfxBus.gain.setTargetAtTime(on ? 0.55 : 0, ctx.currentTime, 0.05);
    }
  }

  /* ------------------------- sfx ------------------------- */

  function sfxReady() {
    return ensure() && prefs.sfx && ctx;
  }

  const now = () => ctx.currentTime + 0.005;

  function sfxClick() {
    if (!sfxReady()) return;
    tone('sine', 620, now(), 0.07, 0.06, sfxBus, { endFreq: 880, slide: 0.05 });
  }

  function sfxSelect() {
    if (!sfxReady()) return;
    tone('triangle', 1100, now(), 0.045, 0.045, sfxBus, { endFreq: 1240, slide: 0.03 });
  }

  function sfxDeal() {
    if (!sfxReady()) return;
    const t = now();
    noise(t, 0.09, 'bandpass', 2800, 900, 0.07);
    tone('sine', 190, t, 0.06, 0.03);
  }

  function sfxPlay() {
    if (!sfxReady()) return;
    const t = now();
    noise(t, 0.11, 'bandpass', 2600, 700, 0.1);
    tone('sine', 160, t, 0.09, 0.05, sfxBus, { endFreq: 110 });
  }

  function sfxPass() {
    if (!sfxReady()) return;
    const t = now();
    tone('sine', 430, t, 0.16, 0.035, sfxBus);
    tone('sine', 350, t + 0.09, 0.2, 0.03, sfxBus);
  }

  function sfxBid(n) {
    if (!sfxReady()) return;
    const t = now();
    const base = [660, 784, 988][Math.min(2, Math.max(0, n - 1))];
    bellSfx(base, t, 0.07);
    bellSfx(base * 1.5, t + 0.07, 0.045);
  }

  function bellSfx(freq, when, gainVal) {
    tone('sine', freq, when, 1.1, gainVal, sfxBus, { attack: 0.006 });
  }

  function sfxBomb() {
    if (!sfxReady()) return;
    const t = now();
    noise(t, 0.55, 'lowpass', 5200, 140, 0.5);
    tone('sine', 95, t, 0.8, 0.4, sfxBus, { endFreq: 38, slide: 0.7 });
    tone('triangle', 220, t, 0.35, 0.14, sfxBus, { endFreq: 60, slide: 0.3 });
  }

  function sfxRocket() {
    if (!sfxReady()) return;
    const t = now();
    tone('sawtooth', 160, t, 0.5, 0.12, sfxBus, { endFreq: 1600, slide: 0.45, filter: 2600 });
    noise(t + 0.06, 0.65, 'bandpass', 900, 5000, 0.3);
    tone('sine', 70, t + 0.3, 0.9, 0.34, sfxBus, { endFreq: 34, slide: 0.8 });
  }

  function sfxWin() {
    if (!sfxReady()) return;
    const t = now();
    const notes = [62, 65, 67, 69, 72, 74];
    notes.forEach((midi, i) => {
      bellSfx(midiToFreq(midi + 12), t + i * 0.11, 0.075);
    });
    tone('triangle', midiToFreq(38), t, 1.8, 0.06, sfxBus, { attack: 0.05 });
  }

  function sfxLose() {
    if (!sfxReady()) return;
    const t = now();
    [69, 65, 62, 57].forEach((midi, i) => {
      tone('sine', midiToFreq(midi), t + i * 0.16, 0.7, 0.055, sfxBus);
    });
    tone('triangle', 60, t + 0.1, 2.2, 0.035, sfxBus, { attack: 0.2 });
  }

  function sfxChip() {
    if (!sfxReady()) return;
    const t = now();
    tone('sine', 1568, t, 0.25, 0.05, sfxBus);
    tone('sine', 2093, t + 0.04, 0.2, 0.03, sfxBus);
  }

  function sfxTurn() {
    if (!sfxReady()) return;
    bellSfx(1046, now(), 0.045);
  }

  function unlock() {
    const c = ensure();
    if (c && c.state === 'suspended') c.resume();
  }

  global.Sound = {
    unlock,
    startMusic,
    stopMusic,
    setMusicEnabled,
    setSfxEnabled,
    isMusicOn: () => prefs.music,
    isSfxOn: () => prefs.sfx,
    click: sfxClick,
    select: sfxSelect,
    deal: sfxDeal,
    play: sfxPlay,
    pass: sfxPass,
    bid: sfxBid,
    bomb: sfxBomb,
    rocket: sfxRocket,
    win: sfxWin,
    lose: sfxLose,
    chip: sfxChip,
    turn: sfxTurn
  };
})(window);
