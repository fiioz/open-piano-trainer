const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES_SHARP[pc]}${octave}`;
}

function isBlackKey(midi) {
  const pc = ((midi % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

function getWhiteIndexInRange(midiStart, midi) {
  let count = 0;
  for (let m = midiStart; m < midi; m += 1) {
    if (!isBlackKey(m)) count += 1;
  }
  return count;
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.waveform = "piano";
    this.masterGain = 0.55;
    this.releaseMs = 180;
    this.active = new Map();
    this.dry = null;
    this.wet = null;
    this.convolver = null;
    this.compressor = null;
    this.noiseBuffer = null;
  }

  ensure() {
    if (this.ctx) return;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextCtor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterGain;
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.12;

    this.dry = this.ctx.createGain();
    this.wet = this.ctx.createGain();
    this.dry.gain.value = 0.92;
    this.wet.gain.value = 0.26;

    this.convolver = this.ctx.createConvolver();
    this.convolver.buffer = this._makeImpulseResponse(1.4, 2.2);

    this.dry.connect(this.compressor);
    this.wet.connect(this.convolver);
    this.convolver.connect(this.compressor);
    this.compressor.connect(this.master);
    this.master.connect(this.ctx.destination);

    this.noiseBuffer = this._makeNoiseBuffer(0.06);
  }

  async resume() {
    this.ensure();
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  setMasterGain01(v) {
    this.masterGain = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.masterGain;
  }

  setWaveform(w) {
    this.waveform = w;
  }

  setReleaseMs(ms) {
    this.releaseMs = clamp(ms, 20, 800);
  }

  play(midi, velocity01 = 0.9) {
    this.ensure();
    if (this.active.has(midi)) return;
    if (this.waveform === "piano") {
      this._playPiano(midi, velocity01);
      return;
    }
    const now = this.ctx.currentTime;

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(clamp(velocity01, 0.05, 1) * 0.45, now + 0.01);

    const osc1 = this.ctx.createOscillator();
    osc1.type = this.waveform;
    osc1.frequency.value = midiToFreq(midi);

    const osc2 = this.ctx.createOscillator();
    osc2.type = this.waveform;
    osc2.frequency.value = midiToFreq(midi) * 2;

    const osc2Gain = this.ctx.createGain();
    osc2Gain.gain.value = 0.08;

    const out = this._makeStereoPan(midi);
    gainNode.connect(out);
    out.connect(this.dry);
    out.connect(this.wet);

    osc1.connect(gainNode);
    osc2.connect(osc2Gain);
    osc2Gain.connect(gainNode);

    osc1.start();
    osc2.start();

    this.active.set(midi, { kind: "basic", osc1, osc2, gainNode, out });
  }

  stop(midi) {
    if (!this.ctx) return;
    const node = this.active.get(midi);
    if (!node) return;
    const now = this.ctx.currentTime;
    const releaseSec = this.releaseMs / 1000;

    if (node.kind === "piano") {
      node.amp.gain.cancelScheduledValues(now);
      node.amp.gain.setValueAtTime(Math.max(node.amp.gain.value, 0.0001), now);
      node.amp.gain.exponentialRampToValueAtTime(0.0001, now + releaseSec);

      const stopAt = now + releaseSec + 0.03;
      for (const o of node.oscs) o.stop(stopAt);
      if (node.noise) node.noise.stop(now + 0.08);

      this.active.delete(midi);
      return;
    }

    node.gainNode.gain.cancelScheduledValues(now);
    node.gainNode.gain.setValueAtTime(Math.max(node.gainNode.gain.value, 0.0001), now);
    node.gainNode.gain.exponentialRampToValueAtTime(0.0001, now + releaseSec);

    const stopAt = now + releaseSec + 0.02;
    node.osc1.stop(stopAt);
    node.osc2.stop(stopAt);

    this.active.delete(midi);
  }

  _makeNoiseBuffer(seconds) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) {
      ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    return buf;
  }

  _makeImpulseResponse(seconds, decay) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let c = 0; c < 2; c += 1) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i += 1) {
        const t = i / len;
        const env = Math.pow(1 - t, decay);
        ch[i] = (Math.random() * 2 - 1) * env * 0.7;
      }
    }
    return buf;
  }

  _makeStereoPan(midi) {
    const p = (midi - 60) / 48;
    const pan = clamp(p, -1, 1);
    if (typeof this.ctx.createStereoPanner === "function") {
      const sp = this.ctx.createStereoPanner();
      sp.pan.value = pan;
      return sp;
    }
    const g = this.ctx.createGain();
    g.gain.value = 1;
    return g;
  }

  _playPiano(midi, velocity01) {
    const now = this.ctx.currentTime;
    const freq = midiToFreq(midi);
    const vel = clamp(velocity01, 0.05, 1);

    const out = this._makeStereoPan(midi);

    const amp = this.ctx.createGain();
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(0.0001 + vel * 0.72, now + 0.012);

    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.6;
    const baseCut = 900 + vel * 5200 + clamp((midi - 36) / 72, 0, 1) * 1600;
    lp.frequency.setValueAtTime(baseCut, now);
    lp.frequency.exponentialRampToValueAtTime(Math.max(700, baseCut * 0.55), now + 0.35);

    amp.connect(lp);
    lp.connect(out);
    out.connect(this.dry);
    out.connect(this.wet);

    const oscs = [];
    const partials = [
      { mul: 1, gain: 0.82, detune: Math.random() * 10 - 5 },
      { mul: 2, gain: 0.26, detune: (Math.random() * 10 - 5) * 1.2 },
      { mul: 3, gain: 0.18, detune: (Math.random() * 10 - 5) * 1.6 },
      { mul: 4, gain: 0.10, detune: (Math.random() * 10 - 5) * 2.0 },
      { mul: 5, gain: 0.06, detune: (Math.random() * 10 - 5) * 2.4 },
      { mul: 6, gain: 0.04, detune: (Math.random() * 10 - 5) * 2.8 },
    ];

    for (const p of partials) {
      const o = this.ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = freq * p.mul * (1 + p.mul * 0.00018);
      o.detune.value = p.detune;

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      const peak = Math.max(0.0001, vel * p.gain);
      g.gain.exponentialRampToValueAtTime(peak, now + 0.008);
      const decay = 0.08 + (1 - vel) * 0.10 + (p.mul - 1) * 0.045;
      g.gain.exponentialRampToValueAtTime(0.0001, now + decay);

      o.connect(g);
      g.connect(amp);
      o.start(now);
      oscs.push(o);
    }

    let noise = null;
    if (this.noiseBuffer) {
      noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(0.0001, now);
      ng.gain.exponentialRampToValueAtTime(0.0001 + vel * 0.12, now + 0.002);
      ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

      const hp = this.ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 900;

      noise.connect(ng);
      ng.connect(hp);
      hp.connect(amp);
      noise.start(now);
    }

    this.active.set(midi, { kind: "piano", oscs, amp, out, noise });
  }

  click(velocity01 = 0.9) {
    this.ensure();
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 1100;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(clamp(velocity01, 0.05, 1) * 0.18, now + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);

    osc.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.05);
  }
}

class StaffRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  drawStaff({ x = 40, y = 55, width = 820, lineGap = 18 } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(15,23,42,0.55)";
    for (let i = 0; i < 5; i += 1) {
      const yy = y + i * lineGap;
      ctx.beginPath();
      ctx.moveTo(x, yy);
      ctx.lineTo(x + width, yy);
      ctx.stroke();
    }
    ctx.restore();
    return { x, y, width, lineGap };
  }

  drawTrebleHint({ x = 16, y = 22 } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "rgba(15,23,42,0.55)";
    ctx.font = "bold 36px ui-sans-serif, system-ui";
    ctx.fillText("𝄞", x, y + 62);
    ctx.restore();
  }

  diatonicStepFromE4(midi) {
    const name = midiToName(midi);
    const letter = name[0];
    const octave = parseInt(name.slice(-1), 10);
    const letterIndex = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 }[letter] ?? 0;
    const absolute = octave * 7 + letterIndex;
    const e4Absolute = 4 * 7 + 2;
    return absolute - e4Absolute;
  }

  drawNoteTreble(midi, { staff, noteX = 360, color = "rgba(15,23,42,0.92)" } = {}) {
    const ctx = this.ctx;
    const s = staff ?? this.drawStaff();
    const bottomLineY = s.y + 4 * s.lineGap;
    const step = this.diatonicStepFromE4(midi);
    const y = bottomLineY - (step * s.lineGap) / 2;

    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    const headW = 18;
    const headH = 12;
    ctx.beginPath();
    ctx.ellipse(noteX, y, headW / 2, headH / 2, -0.3, 0, Math.PI * 2);
    ctx.fill();

    const stemUp = y > s.y + 2 * s.lineGap;
    const stemX = stemUp ? noteX + headW / 2 - 2 : noteX - headW / 2 + 2;
    const stemTopY = stemUp ? y - 48 : y + 48;
    ctx.beginPath();
    ctx.moveTo(stemX, y);
    ctx.lineTo(stemX, stemTopY);
    ctx.stroke();

    const topLineY = s.y;
    const stepFromTopLine = (topLineY - y) / (s.lineGap / 2);
    const stepFromBottomLine = (y - bottomLineY) / (s.lineGap / 2);
    const needsLedgerAbove = stepFromTopLine > 0;
    const needsLedgerBelow = stepFromBottomLine > 0;

    ctx.strokeStyle = "rgba(15,23,42,0.75)";
    if (needsLedgerAbove) {
      const lines = Math.ceil(stepFromTopLine / 2);
      for (let i = 1; i <= lines; i += 1) {
        const yy = topLineY - i * s.lineGap;
        ctx.beginPath();
        ctx.moveTo(noteX - 18, yy);
        ctx.lineTo(noteX + 18, yy);
        ctx.stroke();
      }
    }

    if (needsLedgerBelow) {
      const lines = Math.ceil(stepFromBottomLine / 2);
      for (let i = 1; i <= lines; i += 1) {
        const yy = bottomLineY + i * s.lineGap;
        ctx.beginPath();
        ctx.moveTo(noteX - 18, yy);
        ctx.lineTo(noteX + 18, yy);
        ctx.stroke();
      }
    }

    const pc = ((midi % 12) + 12) % 12;
    const sharp = pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
    if (sharp) {
      ctx.save();
      ctx.fillStyle = color;
      ctx.font = "bold 20px ui-sans-serif, system-ui";
      ctx.fillText("♯", noteX - 30, y + 7);
      ctx.restore();
    }

    ctx.restore();
  }

  render(midi) {
    this.clear();
    const staff = this.drawStaff();
    this.drawTrebleHint();
    if (typeof midi === "number") {
      this.drawNoteTreble(midi, { staff });
    }
  }

  renderSequence({ events, positionBeat, windowBeats = 8 } = {}) {
    this.clear();
    const staff = this.drawStaff();
    this.drawTrebleHint();

    if (!Array.isArray(events) || events.length === 0) return;

    const ctx = this.ctx;
    const left = staff.x + 60;
    const right = staff.x + staff.width - 18;
    const usableW = Math.max(10, right - left);

    const startBeat = Math.max(0, (positionBeat ?? 0) - windowBeats * 0.15);
    const endBeat = startBeat + windowBeats;

    const viewEvents = events.filter((e) => typeof e.startBeat === "number" && e.startBeat >= startBeat - 0.0001 && e.startBeat <= endBeat + 0.0001);

    for (const e of viewEvents) {
      const x = left + ((e.startBeat - startBeat) / windowBeats) * usableW;
      const midis = Array.isArray(e.midis) ? e.midis : [e.midi];
      const playable = midis.filter((m) => typeof m === "number");
      if (playable.length === 0) continue;
      const color = e.startBeat <= (positionBeat ?? 0) ? "rgba(15,23,42,0.45)" : "rgba(15,23,42,0.85)";
      for (const m of playable) {
        this.drawNoteTreble(m, { staff, noteX: x, color });
      }
    }

    const playheadX = left + (((positionBeat ?? 0) - startBeat) / windowBeats) * usableW;
    ctx.save();
    ctx.strokeStyle = "rgba(99,102,241,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, staff.y - 24);
    ctx.lineTo(playheadX, staff.y + staff.lineGap * 4 + 24);
    ctx.stroke();
    ctx.restore();
  }

  renderSequenceSystems({ events, positionBeat, systems = 5, beatsPerSystem = 4, lineGap = 14 } = {}) {
    this.clear();
    if (!Array.isArray(events) || events.length === 0) {
      const staff = this.drawStaff({ lineGap });
      this.drawTrebleHint({ y: staff.y - 34 });
      return;
    }

    const safeSystems = clamp(Math.round(systems || 5), 1, 8);
    const safeBeats = clamp(Number(beatsPerSystem) || 4, 2, 16);
    const beat = Math.max(0, Number(positionBeat) || 0);

    const staffX = 40;
    const staffW = this.canvas.width - staffX * 2;
    const left = staffX + 60;
    const right = staffX + staffW - 18;
    const usableW = Math.max(10, right - left);

    const staffHeight = lineGap * 4;
    const systemPad = Math.round(lineGap * 2.2);
    const topPad = Math.round(lineGap * 2.2);

    const middleIndex = Math.floor(safeSystems / 2);
    const centerSystemIndex = Math.floor(beat / safeBeats);
    const firstSystemIndex = Math.max(0, centerSystemIndex - middleIndex);
    const startBeat = firstSystemIndex * safeBeats;

    const ctx = this.ctx;

    for (let i = 0; i < safeSystems; i += 1) {
      const systemStartBeat = startBeat + i * safeBeats;
      const systemEndBeat = systemStartBeat + safeBeats;
      const y = topPad + i * (staffHeight + systemPad);

      const staff = this.drawStaff({ x: staffX, y, width: staffW, lineGap });
      this.drawTrebleHint({ x: 16, y: staff.y - 34 });

      const viewEvents = events.filter((e) => typeof e.startBeat === "number" && e.startBeat >= systemStartBeat - 0.0001 && e.startBeat <= systemEndBeat + 0.0001);
      for (const e of viewEvents) {
        const x = left + ((e.startBeat - systemStartBeat) / safeBeats) * usableW;
        const midis = Array.isArray(e.midis) ? e.midis : [e.midi];
        const playable = midis.filter((m) => typeof m === "number");
        if (playable.length === 0) continue;
        const color = e.startBeat <= beat ? "rgba(15,23,42,0.42)" : "rgba(15,23,42,0.9)";
        for (const m of playable) {
          this.drawNoteTreble(m, { staff, noteX: x, color });
        }
      }

      if (beat >= systemStartBeat && beat <= systemEndBeat) {
        const playheadX = left + ((beat - systemStartBeat) / safeBeats) * usableW;
        ctx.save();
        ctx.strokeStyle = "rgba(99,102,241,0.95)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, staff.y - 18);
        ctx.lineTo(playheadX, staff.y + staff.lineGap * 4 + 18);
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}

class Metronome {
  constructor(audio) {
    this.audio = audio;
    this.timer = null;
    this.bpm = 90;
    this.isRunning = false;
    this.onTick = () => {};
  }

  setBpm(bpm) {
    this.bpm = clamp(bpm, 40, 220);
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    const intervalMs = Math.round((60_000 / this.bpm) * 1);
    this.timer = window.setInterval(() => {
      this.audio.click(0.85);
      this.onTick();
    }, intervalMs);
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
  }
}

class Trainer {
  constructor({ renderer, onUpdate }) {
    this.renderer = renderer;
    this.onUpdate = onUpdate;
    this.targetMidi = null;
    this.correct = 0;
    this.wrong = 0;
    this.inRangeMin = 60;
    this.inRangeMax = 81;
  }

  resetScore() {
    this.correct = 0;
    this.wrong = 0;
    this.onUpdate();
  }

  newQuestion() {
    const midi = this.pickRandomMidi();
    this.targetMidi = midi;
    this.renderer.render(midi);
    this.onUpdate();
  }

  pickRandomMidi() {
    const min = this.inRangeMin;
    const max = this.inRangeMax;
    const midi = min + Math.floor(Math.random() * (max - min + 1));
    return midi;
  }

  onPlayed(midi) {
    if (this.targetMidi == null) return { ok: null, expected: null };
    if (midi === this.targetMidi) {
      this.correct += 1;
      this.onUpdate();
      return { ok: true, expected: this.targetMidi };
    }
    this.wrong += 1;
    this.onUpdate();
    return { ok: false, expected: this.targetMidi };
  }
}

function parseScoreJSON(text) {
  const data = JSON.parse(text);
  const score = Array.isArray(data) ? { tempoBpm: 90, events: data } : data;
  const tempoBpm = typeof score.tempoBpm === "number" ? score.tempoBpm : 90;
  const eventsRaw = Array.isArray(score.events) ? score.events : [];

  const events = eventsRaw
    .map((e) => {
      const startBeat = Number(e.startBeat);
      const durationBeats = Number(e.durationBeats ?? e.durationBeat ?? e.durBeats);
      const midis = Array.isArray(e.midis) ? e.midis.map((m) => Number(m)) : null;
      const midi = e.midi != null ? Number(e.midi) : null;
      const velocity01 = e.velocity01 != null ? Number(e.velocity01) : 0.85;
      if (!Number.isFinite(startBeat) || !Number.isFinite(durationBeats) || durationBeats <= 0) return null;
      const pitches = midis ?? (midi != null ? [midi] : []);
      if (pitches.length === 0 || pitches.some((m) => !Number.isFinite(m))) return null;
      return { startBeat, durationBeats, midis: pitches, velocity01: clamp(velocity01, 0.05, 1) };
    })
    .filter(Boolean)
    .sort((a, b) => a.startBeat - b.startBeat);

  const endBeat = events.reduce((max, e) => Math.max(max, e.startBeat + e.durationBeats), 0);
  return { title: score.title ?? "Imported JSON", tempoBpm, events, endBeat };
}

function parseMusicXML(text) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, "application/xml");
  const parserError = xml.querySelector("parsererror");
  if (parserError) {
    throw new Error("MusicXML parse error");
  }

  const tempoFromSound = (() => {
    const sound = xml.querySelector("direction sound[tempo]");
    if (!sound) return null;
    const v = Number(sound.getAttribute("tempo"));
    return Number.isFinite(v) ? v : null;
  })();

  const tempoFromMetronome = (() => {
    const perMin = xml.querySelector("direction metronome per-minute");
    if (!perMin) return null;
    const v = Number(perMin.textContent?.trim() || "");
    return Number.isFinite(v) ? v : null;
  })();

  const tempoBpm = tempoFromSound ?? tempoFromMetronome ?? 90;
  const title = xml.querySelector("work work-title")?.textContent?.trim() || xml.querySelector("movement-title")?.textContent?.trim() || "Imported MusicXML";

  const part = xml.querySelector("part");
  if (!part) {
    throw new Error("MusicXML missing part");
  }

  const events = [];
  let currentBeat = 0;
  let divisions = 1;
  let lastNonChordStartBeat = 0;

  const measures = [...part.querySelectorAll("measure")];
  for (const measure of measures) {
    const divNode = measure.querySelector("attributes divisions");
    if (divNode) {
      const v = Number(divNode.textContent?.trim() || "");
      if (Number.isFinite(v) && v > 0) divisions = v;
    }

    const notes = [...measure.querySelectorAll("note")];
    for (const note of notes) {
      const isRest = !!note.querySelector("rest");
      const isChord = !!note.querySelector("chord");
      const durationDiv = Number(note.querySelector("duration")?.textContent?.trim() || "");
      const durationBeats = Number.isFinite(durationDiv) && durationDiv > 0 ? durationDiv / divisions : 0;

      if (!isChord) {
        lastNonChordStartBeat = currentBeat;
      }

      if (!isRest) {
        const step = note.querySelector("pitch step")?.textContent?.trim();
        const octaveText = note.querySelector("pitch octave")?.textContent?.trim();
        const alterText = note.querySelector("pitch alter")?.textContent?.trim();
        const octave = octaveText != null ? Number(octaveText) : null;
        const alter = alterText != null ? Number(alterText) : 0;
        if (step && Number.isFinite(octave)) {
          const basePc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[step] ?? null;
          if (basePc != null) {
            const midi = 12 * (octave + 1) + basePc + (Number.isFinite(alter) ? alter : 0);
            const startBeat = isChord ? lastNonChordStartBeat : currentBeat;
            if (durationBeats > 0) {
              events.push({ startBeat, durationBeats, midis: [midi], velocity01: 0.85 });
            }
          }
        }
      }

      if (!isChord) {
        currentBeat += durationBeats;
      }
    }
  }

  const normalized = events
    .filter((e) => Number.isFinite(e.startBeat) && Number.isFinite(e.durationBeats) && e.durationBeats > 0 && Array.isArray(e.midis) && e.midis.length > 0)
    .sort((a, b) => a.startBeat - b.startBeat);

  const endBeat = normalized.reduce((max, e) => Math.max(max, e.startBeat + e.durationBeats), 0);
  return { title, tempoBpm, events: normalized, endBeat };
}

function parseMIDI(arrayBuffer, { title = "Imported MIDI" } = {}) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  let pos = 0;

  function readU8() {
    const v = view.getUint8(pos);
    pos += 1;
    return v;
  }

  function readU16() {
    const v = view.getUint16(pos, false);
    pos += 2;
    return v;
  }

  function readU32() {
    const v = view.getUint32(pos, false);
    pos += 4;
    return v;
  }

  function readStr(n) {
    const s = String.fromCharCode(...bytes.slice(pos, pos + n));
    pos += n;
    return s;
  }

  function readVarLen() {
    let value = 0;
    while (true) {
      const b = readU8();
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
  }

  const header = readStr(4);
  if (header !== "MThd") throw new Error("Invalid MIDI header");
  const headerLen = readU32();
  if (headerLen < 6) throw new Error("Invalid MIDI header length");

  const format = readU16();
  const ntrks = readU16();
  const division = readU16();
  if (headerLen > 6) pos += headerLen - 6;

  let ppq = division;
  if ((division & 0x8000) !== 0) {
    ppq = 480;
  }

  let tempoUsPerQuarter = null;
  const noteOnMap = new Map();
  const events = [];

  function keyFor(ch, note) {
    return `${ch}:${note}`;
  }

  for (let t = 0; t < ntrks; t += 1) {
    const trk = readStr(4);
    if (trk !== "MTrk") throw new Error("Invalid MIDI track header");
    const trkLen = readU32();
    const endPos = pos + trkLen;

    let tick = 0;
    let runningStatus = 0;

    while (pos < endPos) {
      const delta = readVarLen();
      tick += delta;

      let status = bytes[pos];
      if (status < 0x80) {
        status = runningStatus;
      } else {
        pos += 1;
        runningStatus = status;
      }

      if (status === 0xff) {
        const type = readU8();
        const len = readVarLen();
        if (type === 0x51 && len === 3 && tempoUsPerQuarter == null) {
          const a = readU8();
          const b = readU8();
          const c = readU8();
          tempoUsPerQuarter = (a << 16) | (b << 8) | c;
        } else {
          pos += len;
        }
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const len = readVarLen();
        pos += len;
        continue;
      }

      const type = status & 0xf0;
      const ch = status & 0x0f;

      const data1 = readU8();
      const data2 = type === 0xc0 || type === 0xd0 ? null : readU8();

      if (type === 0x90 && data2 != null && data2 > 0) {
        const k = keyFor(ch, data1);
        const prev = noteOnMap.get(k);
        if (prev) {
          const startBeatPrev = prev.tick / ppq;
          const durBeatsPrev = Math.max(1 / ppq, (tick - prev.tick) / ppq);
          events.push({ startBeat: startBeatPrev, durationBeats: durBeatsPrev, midis: [data1], velocity01: prev.velocity01 });
        }
        noteOnMap.set(k, { tick, velocity01: clamp(data2 / 127, 0.05, 1) });
      } else if (type === 0x80 || (type === 0x90 && (data2 ?? 0) === 0)) {
        const k = keyFor(ch, data1);
        const start = noteOnMap.get(k);
        if (start) {
          noteOnMap.delete(k);
          const startBeat = start.tick / ppq;
          const durationBeats = Math.max(1 / ppq, (tick - start.tick) / ppq);
          events.push({ startBeat, durationBeats, midis: [data1], velocity01: start.velocity01 });
        }
      }
    }

    pos = endPos;
  }

  const tempoBpm = tempoUsPerQuarter ? 60_000_000 / tempoUsPerQuarter : 90;
  const normalized = events
    .filter((e) => Number.isFinite(e.startBeat) && Number.isFinite(e.durationBeats) && e.durationBeats > 0 && Array.isArray(e.midis) && e.midis.length > 0)
    .sort((a, b) => a.startBeat - b.startBeat);
  const endBeat = normalized.reduce((max, e) => Math.max(max, e.startBeat + e.durationBeats), 0);
  return { title, tempoBpm: clamp(tempoBpm, 30, 220), events: normalized, endBeat };
}

function formatSeconds(sec) {
  if (!Number.isFinite(sec)) return "0.0s";
  if (sec < 0) return "0.0s";
  return `${sec.toFixed(1)}s`;
}

class ScorePlayer {
  constructor({ audio, pianoUi, renderer, onNoteReadout, onRender }) {
    this.audio = audio;
    this.pianoUi = pianoUi;
    this.renderer = renderer;
    this.onNoteReadout = onNoteReadout;
    this.onRender = onRender;

    this.score = null;
    this.isPlaying = false;
    this.loop = false;
    this.tempoBpm = 90;
    this.speed = 1;
    this.positionBeat = 0;

    this._timers = [];
    this._rafId = 0;
    this._playStartMs = 0;
    this._playStartBeat = 0;
  }

  setLoop(loop) {
    this.loop = !!loop;
  }

  setTempo(bpm) {
    this.tempoBpm = clamp(Number(bpm) || 90, 30, 220);
    if (this.isPlaying) this._restartFromCurrentPosition();
    this._render();
  }

  setSpeed(mult) {
    const v = Number(mult);
    this.speed = clamp(Number.isFinite(v) ? v : 1, 0.25, 1.5);
    if (this.isPlaying) this._restartFromCurrentPosition();
    this._render();
  }

  loadScore(score) {
    if (!score || !Array.isArray(score.events)) {
      this.score = null;
      this.stop();
      return;
    }
    this.score = {
      title: score.title ?? "Imported",
      tempoBpm: typeof score.tempoBpm === "number" ? score.tempoBpm : 90,
      events: score.events,
      endBeat: typeof score.endBeat === "number" ? score.endBeat : score.events.reduce((max, e) => Math.max(max, e.startBeat + e.durationBeats), 0),
    };
    this.tempoBpm = clamp(this.score.tempoBpm, 30, 220);
    this.positionBeat = 0;
    this.stop();
    this._render();
  }

  getEndBeat() {
    if (!this.score) return 0;
    return Math.max(0, this.score.endBeat || 0);
  }

  getBeatMs() {
    return 60_000 / this.tempoBpm;
  }

  getPositionSeconds() {
    const beatMs = this.getBeatMs();
    return (this.positionBeat * beatMs) / 1000 / this.speed;
  }

  getTotalSeconds() {
    const beatMs = this.getBeatMs();
    return (this.getEndBeat() * beatMs) / 1000 / this.speed;
  }

  async play() {
    if (!this.score || this.score.events.length === 0) return;
    if (this.isPlaying) return;
    await this.audio.resume();
    this.isPlaying = true;
    this._playStartMs = performance.now();
    this._playStartBeat = this.positionBeat;
    this._scheduleFrom(this.positionBeat);
    this._tick();
  }

  pause() {
    if (!this.isPlaying) return;
    this.positionBeat = this._computeCurrentBeat();
    this.isPlaying = false;
    this._clearTimers();
    this._stopAllNotes();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._render();
  }

  stop() {
    this.isPlaying = false;
    this._clearTimers();
    this._stopAllNotes();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this.positionBeat = 0;
    this._render();
  }

  seekToBeat(beat) {
    this.positionBeat = clamp(Number(beat) || 0, 0, this.getEndBeat());
    if (this.isPlaying) this._restartFromCurrentPosition();
    else this._render();
  }

  _restartFromCurrentPosition() {
    const beat = this._computeCurrentBeat();
    this.isPlaying = false;
    this._clearTimers();
    this._stopAllNotes();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this.positionBeat = clamp(beat, 0, this.getEndBeat());
    this.play();
  }

  _computeCurrentBeat() {
    if (!this.isPlaying) return this.positionBeat;
    const elapsedMs = performance.now() - this._playStartMs;
    const beatMs = this.getBeatMs();
    const deltaBeats = (elapsedMs * this.speed) / beatMs;
    return this._playStartBeat + deltaBeats;
  }

  _stopAllNotes() {
    const activeMidis = [...this.audio.active.keys()];
    for (const midi of activeMidis) {
      this.audio.stop(midi);
      this.pianoUi.setActive(midi, false);
    }
  }

  _clearTimers() {
    for (const id of this._timers) window.clearTimeout(id);
    this._timers = [];
  }

  _scheduleFrom(startBeat) {
    const beatMs = this.getBeatMs();
    const startMs = performance.now();
    const events = this.score?.events ?? [];

    for (const e of events) {
      if (e.startBeat + e.durationBeats <= startBeat) continue;
      const delayMs = ((e.startBeat - startBeat) * beatMs) / this.speed;
      if (delayMs < -2) continue;
      const durationMs = (e.durationBeats * beatMs) / this.speed;
      const midis = Array.isArray(e.midis) ? e.midis : [];
      const velocity01 = e.velocity01 != null ? e.velocity01 : 0.85;

      const onId = window.setTimeout(() => {
        for (const midi of midis) {
          this.audio.play(midi, velocity01);
          this.pianoUi.setActive(midi, true);
        }
        if (midis.length) {
          this.onNoteReadout(Math.max(...midis), "Auto");
        }
      }, Math.max(0, delayMs));
      this._timers.push(onId);

      const offId = window.setTimeout(() => {
        for (const midi of midis) {
          this.audio.stop(midi);
          this.pianoUi.setActive(midi, false);
        }
      }, Math.max(0, delayMs + Math.max(10, durationMs)));
      this._timers.push(offId);
    }

    const endBeat = this.getEndBeat();
    const tailMs = ((endBeat - startBeat) * beatMs) / this.speed;
    const endId = window.setTimeout(() => {
      if (!this.isPlaying) return;
      if (this.loop) {
        this.seekToBeat(0);
        this.play();
        return;
      }
      this.stop();
    }, Math.max(0, tailMs + 30));
    this._timers.push(endId);
  }

  _tick() {
    if (!this.isPlaying) return;
    const beat = this._computeCurrentBeat();
    this.positionBeat = beat;
    this._render();
    this._rafId = requestAnimationFrame(() => this._tick());
  }

  _render() {
    this.onRender?.({
      hasScore: !!this.score,
      title: this.score?.title ?? "",
      tempoBpm: this.tempoBpm,
      speed: this.speed,
      positionBeat: this.positionBeat,
      endBeat: this.getEndBeat(),
      positionSeconds: this.getPositionSeconds(),
      totalSeconds: this.getTotalSeconds(),
      isPlaying: this.isPlaying,
    });

    if (this.score) {
      this.renderer.renderSequenceSystems({ events: this.score.events, positionBeat: this.positionBeat, systems: 5, beatsPerSystem: 4, lineGap: 14 });
    } else {
      this.renderer.render();
    }
  }
}

class PianoUI {
  constructor(rootEl, { midiStart, midiEnd, onNoteOn, onNoteOff, onAnyNote }) {
    this.rootEl = rootEl;
    this.midiStart = midiStart;
    this.midiEnd = midiEnd;
    this.onNoteOn = onNoteOn;
    this.onNoteOff = onNoteOff;
    this.onAnyNote = onAnyNote;
    this.keyEls = new Map();
    this.pressedByPointer = new Map();
    this.whiteWidth = 24;
  }

  build() {
    this.rootEl.innerHTML = "";
    const totalWhites = (() => {
      let count = 0;
      for (let m = this.midiStart; m <= this.midiEnd; m += 1) {
        if (!isBlackKey(m)) count += 1;
      }
      return count;
    })();

    const target = Math.min(28, Math.max(18, Math.floor((window.innerWidth || 1200) / 52)));
    const whiteWidth = target;
    this.whiteWidth = whiteWidth;
    this.rootEl.style.width = `${totalWhites * whiteWidth}px`;
    const baseLeft = 0;

    for (let m = this.midiStart; m <= this.midiEnd; m += 1) {
      const black = isBlackKey(m);
      const el = document.createElement("div");
      el.className = `key ${black ? "key--black" : "key--white"}`;
      el.dataset.midi = String(m);

      const label = document.createElement("div");
      label.className = "key__label";
      label.textContent = midiToName(m).replace("#", "♯");
      el.appendChild(label);

      const whiteIndex = getWhiteIndexInRange(this.midiStart, m);
      if (black) {
        const left = baseLeft + (whiteIndex - 1) * whiteWidth + Math.floor(whiteWidth * 0.67);
        el.style.left = `${left}px`;
        el.style.width = `${Math.floor(whiteWidth * 0.62)}px`;
      } else {
        const left = baseLeft + whiteIndex * whiteWidth;
        el.style.left = `${left}px`;
        el.style.width = `${whiteWidth}px`;
      }

      this.attachPointer(el);
      this.rootEl.appendChild(el);
      this.keyEls.set(m, el);
    }
  }

  attachPointer(el) {
    const onDown = (ev) => {
      ev.preventDefault();
      const midi = Number(el.dataset.midi);
      const pointerId = ev.pointerId ?? 0;
      this.pressedByPointer.set(pointerId, midi);
      this.setActive(midi, true);
      this.onNoteOn(midi, 0.9);
      this.onAnyNote(midi);
    };

    const onUp = (ev) => {
      ev.preventDefault();
      const pointerId = ev.pointerId ?? 0;
      const midi = this.pressedByPointer.get(pointerId);
      if (typeof midi === "number") {
        this.pressedByPointer.delete(pointerId);
        this.setActive(midi, false);
        this.onNoteOff(midi);
      }
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointerleave", (ev) => {
      if (ev.buttons === 1) onUp(ev);
    });
  }

  setActive(midi, active) {
    const el = this.keyEls.get(midi);
    if (!el) return;
    if (active) el.classList.add("key--active");
    else el.classList.remove("key--active");
  }
}

const dom = {
  btnResumeAudio: document.getElementById("btnResumeAudio"),
  pianoScroll: document.getElementById("pianoScroll"),
  piano: document.getElementById("piano"),
  octaveInfo: document.getElementById("octaveInfo"),

  tabPractice: document.getElementById("tabPractice"),
  tabTrainer: document.getElementById("tabTrainer"),
  tabSettings: document.getElementById("tabSettings"),
  viewPractice: document.getElementById("viewPractice"),
  viewTrainer: document.getElementById("viewTrainer"),
  viewSettings: document.getElementById("viewSettings"),

  currentNoteName: document.getElementById("currentNoteName"),
  currentNoteMeta: document.getElementById("currentNoteMeta"),
  staffCanvasPractice: document.getElementById("staffCanvasPractice"),
  staffCanvasTrainer: document.getElementById("staffCanvasTrainer"),
  staffCanvasPlayer: document.getElementById("staffCanvasPlayer"),

  tempo: document.getElementById("tempo"),
  tempoValue: document.getElementById("tempoValue"),
  btnMetronome: document.getElementById("btnMetronome"),
  metronomeStatus: document.getElementById("metronomeStatus"),

  scoreFile: document.getElementById("scoreFile"),
  scoreInfo: document.getElementById("scoreInfo"),
  btnScorePlay: document.getElementById("btnScorePlay"),
  btnScorePause: document.getElementById("btnScorePause"),
  btnScoreStop: document.getElementById("btnScoreStop"),
  scoreLoop: document.getElementById("scoreLoop"),
  scoreTempo: document.getElementById("scoreTempo"),
  scoreTempoValue: document.getElementById("scoreTempoValue"),
  scoreSpeed: document.getElementById("scoreSpeed"),
  scoreSpeedValue: document.getElementById("scoreSpeedValue"),
  scoreProgress: document.getElementById("scoreProgress"),
  scoreTime: document.getElementById("scoreTime"),
  pdfWrap: document.getElementById("pdfWrap"),
  pdfFrame: document.getElementById("pdfFrame"),
  pdfHint: document.getElementById("pdfHint"),
  btnOpenPdf: document.getElementById("btnOpenPdf"),
  piastudyUrl: document.getElementById("piastudyUrl"),
  btnLoadPiastudy: document.getElementById("btnLoadPiastudy"),
  svgWrap: document.getElementById("svgWrap"),
  svgBody: document.getElementById("svgBody"),
  svgHint: document.getElementById("svgHint"),

  waveform: document.getElementById("waveform"),
  masterGain: document.getElementById("masterGain"),
  masterGainValue: document.getElementById("masterGainValue"),
  releaseMs: document.getElementById("releaseMs"),
  releaseMsValue: document.getElementById("releaseMsValue"),

  midiStatus: document.getElementById("midiStatus"),
  midiDevices: document.getElementById("midiDevices"),

  btnNewQuestion: document.getElementById("btnNewQuestion"),
  btnResetScore: document.getElementById("btnResetScore"),
  trainerCorrect: document.getElementById("trainerCorrect"),
  trainerWrong: document.getElementById("trainerWrong"),
  trainerFeedback: document.getElementById("trainerFeedback"),
};

function setActiveTab(which) {
  const pairs = [
    { tab: dom.tabPractice, view: dom.viewPractice, key: "practice" },
    { tab: dom.tabTrainer, view: dom.viewTrainer, key: "trainer" },
    { tab: dom.tabSettings, view: dom.viewSettings, key: "settings" },
  ];

  for (const p of pairs) {
    const active = p.key === which;
    p.tab.classList.toggle("tab--active", active);
    p.tab.setAttribute("aria-selected", active ? "true" : "false");
    p.view.classList.toggle("view--active", active);
  }
}

const audio = new AudioEngine();
const staffPractice = new StaffRenderer(dom.staffCanvasPractice);
const staffTrainer = new StaffRenderer(dom.staffCanvasTrainer);
const staffPlayer = new StaffRenderer(dom.staffCanvasPlayer);
const metronome = new Metronome(audio);

const trainer = new Trainer({
  renderer: staffTrainer,
  onUpdate: () => {
    dom.trainerCorrect.textContent = String(trainer.correct);
    dom.trainerWrong.textContent = String(trainer.wrong);
  },
});

let baseOctave = 4;

function midiRangeForBaseOctave(octave) {
  const start = (octave + 1) * 12;
  return { start, end: start + 23 };
}

let midiRange = midiRangeForBaseOctave(baseOctave);

const pianoUi = new PianoUI(dom.piano, {
  midiStart: 21,
  midiEnd: 108,
  onNoteOn: (midi, vel) => audio.play(midi, vel),
  onNoteOff: (midi) => audio.stop(midi),
  onAnyNote: (midi) => onPlayedAny(midi),
});

function scrollPianoToMidi(midi) {
  const keyEl = pianoUi.keyEls.get(midi);
  if (!keyEl || !dom.pianoScroll) return;
  const targetX = keyEl.offsetLeft - Math.round(dom.pianoScroll.clientWidth / 2) + Math.round(keyEl.clientWidth / 2);
  dom.pianoScroll.scrollLeft = clamp(targetX, 0, Math.max(0, dom.pianoScroll.scrollWidth - dom.pianoScroll.clientWidth));
}

function rebuildKeyboardMapping() {
  midiRange = midiRangeForBaseOctave(baseOctave);
  dom.octaveInfo.textContent = `Octave: ${baseOctave} (C${baseOctave}–B${baseOctave + 1})`;
  scrollPianoToMidi((baseOctave + 1) * 12);
}

function setCurrentNote(midi, source) {
  dom.currentNoteName.textContent = midiToName(midi).replace("#", "♯");
  dom.currentNoteMeta.textContent = source;
  staffPractice.render(midi);
}

function onPlayedAny(midi) {
  setCurrentNote(midi, "Play");
  const result = trainer.onPlayed(midi);
  if (result.ok === true) {
    dom.trainerFeedback.textContent = `Correct: ${midiToName(midi)}`;
  } else if (result.ok === false) {
    dom.trainerFeedback.textContent = `Wrong. Expected: ${midiToName(result.expected)}, got: ${midiToName(midi)}`;
  }
}

function setMasterGainUI() {
  const v01 = Number(dom.masterGain.value) / 100;
  audio.setMasterGain01(v01);
  dom.masterGainValue.textContent = v01.toFixed(2);
}

function setReleaseUI() {
  const ms = Number(dom.releaseMs.value);
  audio.setReleaseMs(ms);
  dom.releaseMsValue.textContent = String(ms);
}

function setTempoUI() {
  const bpm = Number(dom.tempo.value);
  dom.tempoValue.textContent = String(bpm);
  metronome.setBpm(bpm);
}

function toggleMetronome() {
  if (!metronome.isRunning) {
    metronome.start();
    dom.btnMetronome.textContent = "停止";
    dom.metronomeStatus.textContent = "运行中";
  } else {
    metronome.stop();
    dom.btnMetronome.textContent = "开始";
    dom.metronomeStatus.textContent = "停止";
  }
}

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

const KEYMAP = new Map([
  ["z", 0],
  ["s", 1],
  ["x", 2],
  ["d", 3],
  ["c", 4],
  ["v", 5],
  ["g", 6],
  ["b", 7],
  ["h", 8],
  ["n", 9],
  ["j", 10],
  ["m", 11],
  [",", 12],
  ["l", 13],
  [".", 14],
  [";", 15],
  ["/", 16],
]);

const pressedKeys = new Map();

function handleKeyDown(ev) {
  if (ev.repeat) return;
  if (isEditableTarget(ev.target)) return;

  if (ev.shiftKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
    ev.preventDefault();
    baseOctave = clamp(baseOctave + (ev.key === "ArrowUp" ? 1 : -1), 2, 6);
    rebuildKeyboardMapping();
    return;
  }

  const key = ev.key.toLowerCase();
  const offset = KEYMAP.get(key);
  if (typeof offset !== "number") return;
  ev.preventDefault();

  const midi = midiRange.start + offset;
  pressedKeys.set(key, midi);
  pianoUi.setActive(midi, true);
  audio.play(midi, 0.9);
  onPlayedAny(midi);
}

function handleKeyUp(ev) {
  if (isEditableTarget(ev.target)) return;
  const key = ev.key.toLowerCase();
  const midi = pressedKeys.get(key);
  if (typeof midi !== "number") return;
  ev.preventDefault();
  pressedKeys.delete(key);
  pianoUi.setActive(midi, false);
  audio.stop(midi);
}

function attachTabs() {
  dom.tabPractice.addEventListener("click", () => setActiveTab("practice"));
  dom.tabTrainer.addEventListener("click", () => setActiveTab("trainer"));
  dom.tabSettings.addEventListener("click", () => setActiveTab("settings"));
}

function attachControls() {
  dom.btnResumeAudio.addEventListener("click", async () => {
    try {
      await audio.resume();
      dom.btnResumeAudio.textContent = "声音已启用";
    } catch (e) {
      dom.btnResumeAudio.textContent = "启用失败";
      console.error(e);
    }
  });

  dom.waveform.addEventListener("change", () => audio.setWaveform(dom.waveform.value));
  dom.masterGain.addEventListener("input", setMasterGainUI);
  dom.releaseMs.addEventListener("input", setReleaseUI);
  dom.tempo.addEventListener("input", setTempoUI);
  dom.btnMetronome.addEventListener("click", toggleMetronome);

  dom.btnNewQuestion.addEventListener("click", () => {
    trainer.newQuestion();
    dom.trainerFeedback.textContent = "—";
  });
  dom.btnResetScore.addEventListener("click", () => {
    trainer.resetScore();
    dom.trainerFeedback.textContent = "—";
  });
}

function updateScoreInfoText(score) {
  if (!score) {
    dom.scoreInfo.textContent = "支持 MusicXML / JSON / MIDI（PDF 仅预览）";
    return;
  }
  dom.scoreInfo.textContent = `${score.title} | ${Math.round(score.tempoBpm)} BPM | ${score.events.length} notes`;
}

function stripSvgScripts(svgText) {
  try {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const scripts = doc.querySelectorAll("script");
    for (const s of scripts) s.remove();
    return doc.documentElement?.outerHTML || svgText;
  } catch {
    return svgText;
  }
}

function decodeBasicEntities(text) {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#38;", "&")
    .replaceAll("&amp;", "&");
}

function extractPiastudyResourcesFromHtml(htmlText) {
  const text = decodeBasicEntities(htmlText);
  const midiUrl = /midiUrl":"(https?:\/\/[^"\s]+?\.mid[^"\s]*)"/i.exec(text)?.[1] ?? "";
  const spaceUrl = /spaceUrl":"(https?:\/\/[^"\s]+?\.json[^"\s]*)"/i.exec(text)?.[1] ?? "";

  const svgUrls = Array.from(new Set(text.match(/https?:\/\/[^"\s]+?\.svg[^"\s]*/gi) ?? []));

  return { midiUrl, spaceUrl, svgUrls };
}

function extractNoteTimelineFromSpaceJson(space) {
  const results = [];

  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const it of node) visit(it);
      return;
    }
    if (typeof node !== "object") return;

    const nt = node.noteTimestamp;
    if (Array.isArray(nt)) {
      for (const item of nt) {
        const startMs = Number(item?.startTime);
        const notesInfo = Array.isArray(item?.notesInfo) ? item.notesInfo : [];
        const ids = notesInfo.map((n) => String(n?.noteName || "")).filter(Boolean);
        if (Number.isFinite(startMs) && ids.length) results.push({ startMs, ids });
      }
    }

    for (const k of Object.keys(node)) {
      if (k === "noteTimestamp") continue;
      visit(node[k]);
    }
  }

  visit(space);
  results.sort((a, b) => a.startMs - b.startMs);
  return results;
}

class SvgScoreView {
  constructor({ wrapEl, bodyEl, hintEl }) {
    this.wrapEl = wrapEl;
    this.bodyEl = bodyEl;
    this.hintEl = hintEl;
    this.noteElById = new Map();
    this.timeline = [];
    this._activeIds = [];
    this._lastIndex = -1;
  }

  hide() {
    this.wrapEl.hidden = true;
    this.bodyEl.innerHTML = "";
    this.noteElById.clear();
    this.timeline = [];
    this._activeIds = [];
    this._lastIndex = -1;
  }

  async loadFromUrls({ svgUrls, spaceUrl }) {
    this.wrapEl.hidden = false;
    this.hintEl.textContent = "加载中…";
    this.bodyEl.innerHTML = "";
    this.noteElById.clear();
    this._activeIds = [];
    this._lastIndex = -1;

    const svgTexts = await Promise.all(
      (svgUrls || []).map(async (u) => {
        const resp = await fetch(u, { mode: "cors" });
        if (!resp.ok) throw new Error(`Fetch SVG failed: ${resp.status}`);
        return stripSvgScripts(await resp.text());
      }),
    );

    for (const svgText of svgTexts) {
      const page = document.createElement("div");
      page.className = "svgPage";
      page.innerHTML = svgText;
      this.bodyEl.appendChild(page);
    }

    const noteNodes = this.bodyEl.querySelectorAll("g.note[id]");
    for (const el of noteNodes) {
      const id = el.getAttribute("id");
      if (id) this.noteElById.set(id, el);
    }

    if (spaceUrl) {
      const sResp = await fetch(spaceUrl, { mode: "cors" });
      if (!sResp.ok) throw new Error(`Fetch space JSON failed: ${sResp.status}`);
      const space = await sResp.json();
      this.timeline = extractNoteTimelineFromSpaceJson(space);
    } else {
      this.timeline = [];
    }

    this.hintEl.textContent = `已加载 SVG：${svgTexts.length} 页，notes：${this.noteElById.size}`;
  }

  clearActive() {
    for (const id of this._activeIds) {
      const el = this.noteElById.get(id);
      if (el) el.classList.remove("note--active");
    }
    this._activeIds = [];
  }

  update(currentMs) {
    if (!this.timeline.length) return;
    const t = Number(currentMs);
    if (!Number.isFinite(t)) return;

    let lo = 0;
    let hi = this.timeline.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.timeline[mid].startMs;
      if (v <= t) lo = mid + 1;
      else hi = mid - 1;
    }
    const idx = clamp(hi, 0, this.timeline.length - 1);
    if (idx === this._lastIndex) return;
    this._lastIndex = idx;

    this.clearActive();
    const ids = this.timeline[idx].ids;
    this._activeIds = ids;
    let firstEl = null;
    for (const id of ids) {
      const el = this.noteElById.get(id);
      if (el) {
        el.classList.add("note--active");
        if (!firstEl) firstEl = el;
      }
    }

    if (firstEl) {
      const container = this.bodyEl;
      const cRect = container.getBoundingClientRect();
      const nRect = firstEl.getBoundingClientRect();
      const margin = 80;
      const above = nRect.top < cRect.top + margin;
      const below = nRect.bottom > cRect.bottom - margin;
      if (above || below) {
        const delta = nRect.top - cRect.top - Math.round(cRect.height / 2);
        container.scrollTop += delta;
      }
    }
  }
}

function attachScorePlayer() {
  let currentPdfUrl = "";
  const svgView = new SvgScoreView({ wrapEl: dom.svgWrap, bodyEl: dom.svgBody, hintEl: dom.svgHint });

  function setPdfPreview(url) {
    if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
    currentPdfUrl = url || "";
    if (currentPdfUrl) {
      dom.pdfWrap.hidden = false;
      dom.pdfFrame.src = currentPdfUrl;
      dom.staffCanvasPlayer.style.display = "none";
      dom.svgWrap.hidden = true;
      dom.btnOpenPdf.disabled = false;
    } else {
      dom.pdfWrap.hidden = true;
      dom.pdfFrame.removeAttribute("src");
      dom.staffCanvasPlayer.style.display = "";
      dom.btnOpenPdf.disabled = true;
    }
  }

  function setSvgMode(enabled) {
    if (enabled) {
      dom.staffCanvasPlayer.style.display = "none";
      dom.pdfWrap.hidden = true;
      dom.svgWrap.hidden = false;
    } else {
      dom.svgWrap.hidden = true;
      dom.staffCanvasPlayer.style.display = "";
      svgView.hide();
    }
  }

  const player = new ScorePlayer({
    audio,
    pianoUi,
    renderer: staffPlayer,
    onNoteReadout: (midi, source) => setCurrentNote(midi, source),
    onRender: (state) => {
      dom.scoreTempo.value = String(Math.round(state.tempoBpm));
      dom.scoreTempoValue.textContent = String(Math.round(state.tempoBpm));
      dom.scoreSpeedValue.textContent = `${state.speed.toFixed(2)}x`;

      const endBeat = state.endBeat || 0;
      const pct = endBeat > 0 ? clamp(state.positionBeat / endBeat, 0, 1) : 0;
      const progressValue = Math.round(pct * 1000);
      if (document.activeElement !== dom.scoreProgress) {
        dom.scoreProgress.value = String(progressValue);
      }
      dom.scoreTime.textContent = `${formatSeconds(state.positionSeconds)} / ${formatSeconds(state.totalSeconds)}`;

      dom.btnScorePlay.disabled = !state.hasScore || state.isPlaying;
      dom.btnScorePause.disabled = !state.hasScore || !state.isPlaying;
      dom.btnScoreStop.disabled = !state.hasScore;

      if (!dom.svgWrap.hidden) {
        svgView.update(state.positionSeconds * 1000);
      }
    },
  });

  dom.scoreLoop.addEventListener("change", () => player.setLoop(dom.scoreLoop.checked));

  dom.scoreTempo.addEventListener("input", () => {
    const bpm = Number(dom.scoreTempo.value);
    dom.scoreTempoValue.textContent = String(bpm);
    player.setTempo(bpm);
  });

  dom.scoreSpeed.addEventListener("input", () => {
    const speed = Number(dom.scoreSpeed.value) / 100;
    player.setSpeed(speed);
    dom.scoreSpeedValue.textContent = `${player.speed.toFixed(2)}x`;
  });

  dom.btnScorePlay.addEventListener("click", () => player.play());
  dom.btnScorePause.addEventListener("click", () => player.pause());
  dom.btnScoreStop.addEventListener("click", () => player.stop());

  dom.scoreProgress.addEventListener("input", () => {
    const endBeat = player.getEndBeat();
    const pct = Number(dom.scoreProgress.value) / 1000;
    const beat = endBeat * clamp(pct, 0, 1);
    player.seekToBeat(beat);
  });

  dom.btnOpenPdf.addEventListener("click", () => {
    if (!currentPdfUrl) return;
    window.open(currentPdfUrl, "_blank", "noopener,noreferrer");
  });

  dom.scoreFile.addEventListener("change", async () => {
    const file = dom.scoreFile.files?.[0];
    if (!file) return;
    try {
      const lower = (file.name || "").toLowerCase();
      if (lower.endsWith(".pdf")) {
        player.loadScore(null);
        setPdfPreview(URL.createObjectURL(file));
        updateScoreInfoText(null);
        dom.scoreTime.textContent = "PDF preview";
        return;
      }

      setPdfPreview("");
      setSvgMode(false);
      let score;
      if (lower.endsWith(".mid") || lower.endsWith(".midi")) {
        const buf = await file.arrayBuffer();
        score = parseMIDI(buf, { title: file.name || "Imported MIDI" });
      } else {
        const text = await file.text();
        score = lower.endsWith(".json") ? parseScoreJSON(text) : parseMusicXML(text);
      }
      player.loadScore(score);
      dom.scoreTempo.value = String(Math.round(player.tempoBpm));
      dom.scoreTempoValue.textContent = String(Math.round(player.tempoBpm));
      updateScoreInfoText({ title: score.title, tempoBpm: score.tempoBpm, events: score.events });
      dom.scoreProgress.value = "0";
      dom.scoreTime.textContent = `${formatSeconds(0)} / ${formatSeconds(player.getTotalSeconds())}`;
    } catch (e) {
      player.loadScore(null);
      dom.scoreInfo.textContent = "Import failed: unsupported or invalid file";
      setPdfPreview("");
      setSvgMode(false);
      console.error(e);
    }
  });

  dom.btnLoadPiastudy.addEventListener("click", async () => {
    const url = String(dom.piastudyUrl.value || "").trim();
    if (!url) return;
    try {
      dom.scoreInfo.textContent = "Loading from URL…";
      setPdfPreview("");
      setSvgMode(true);

      const resp = await fetch(url, { mode: "cors" });
      if (!resp.ok) throw new Error(`Fetch page failed: ${resp.status}`);
      const html = await resp.text();
      const { midiUrl, spaceUrl, svgUrls } = extractPiastudyResourcesFromHtml(html);
      if (!midiUrl || !svgUrls.length) {
        throw new Error("Cannot find midiUrl/svgUrls in page");
      }

      const midiResp = await fetch(midiUrl, { mode: "cors" });
      if (!midiResp.ok) throw new Error(`Fetch MIDI failed: ${midiResp.status}`);
      const midiBuf = await midiResp.arrayBuffer();
      const score = parseMIDI(midiBuf, { title: "Piastudy MIDI" });
      player.loadScore(score);
      dom.scoreTempo.value = String(Math.round(player.tempoBpm));
      dom.scoreTempoValue.textContent = String(Math.round(player.tempoBpm));
      updateScoreInfoText({ title: score.title, tempoBpm: score.tempoBpm, events: score.events });
      dom.scoreProgress.value = "0";
      dom.scoreTime.textContent = `${formatSeconds(0)} / ${formatSeconds(player.getTotalSeconds())}`;

      await svgView.loadFromUrls({ svgUrls, spaceUrl });
      dom.scoreInfo.textContent = `Loaded from URL | MIDI+SVG${spaceUrl ? "+JSON" : ""}`;
    } catch (e) {
      player.loadScore(null);
      setSvgMode(false);
      dom.scoreInfo.textContent = "Load failed: possibly blocked by CORS";
      console.error(e);
    }
  });

  player.loadScore(null);
  setPdfPreview("");
  setSvgMode(false);
  return player;
}

async function initMIDI() {
  if (!("requestMIDIAccess" in navigator)) {
    dom.midiStatus.textContent = "Web MIDI 不可用（浏览器不支持或未开启权限）";
    dom.midiDevices.textContent = "—";
    return;
  }

  try {
    const access = await navigator.requestMIDIAccess();
    const inputs = [...access.inputs.values()];
    dom.midiStatus.textContent = inputs.length ? "MIDI 输入已连接" : "未发现 MIDI 输入设备";
    dom.midiDevices.textContent = inputs.length ? inputs.map((i) => i.name || "MIDI Input").join(" | ") : "—";

    for (const input of inputs) {
      input.onmidimessage = (msg) => {
        const [status, data1, data2] = msg.data;
        const cmd = status & 0xf0;
        const note = data1;
        const vel = data2;
        const velocity01 = vel / 127;
        if (cmd === 0x90 && vel > 0) {
          audio.play(note, velocity01);
          pianoUi.setActive(note, true);
          setCurrentNote(note, "MIDI");
          const result = trainer.onPlayed(note);
          if (result.ok === true) dom.trainerFeedback.textContent = `Correct: ${midiToName(note)}`;
          if (result.ok === false) dom.trainerFeedback.textContent = `Wrong. Expected: ${midiToName(result.expected)}, got: ${midiToName(note)}`;
        } else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) {
          audio.stop(note);
          pianoUi.setActive(note, false);
        }
      };
    }

    access.onstatechange = () => initMIDI();
  } catch (e) {
    if (e?.name === "NotAllowedError") {
      dom.midiStatus.textContent = "MIDI 权限未授予";
      dom.midiDevices.textContent = "—";
      return;
    }
    dom.midiStatus.textContent = "MIDI 初始化失败（可能需要用户手动授权）";
    dom.midiDevices.textContent = "—";
    console.error(e);
  }
}

function init() {
  attachTabs();
  attachControls();
  attachScorePlayer();
  setMasterGainUI();
  setReleaseUI();
  setTempoUI();
  pianoUi.build();
  rebuildKeyboardMapping();
  scrollPianoToMidi(60);
  staffPractice.render();
  staffTrainer.render();
  staffPlayer.render();
  trainer.newQuestion();
  window.addEventListener("keydown", handleKeyDown, { passive: false });
  window.addEventListener("keyup", handleKeyUp, { passive: false });
  window.addEventListener("resize", () => {
    const prev = dom.pianoScroll?.scrollLeft ?? 0;
    pianoUi.build();
    if (dom.pianoScroll) dom.pianoScroll.scrollLeft = prev;
  });
  initMIDI();
}

init();
