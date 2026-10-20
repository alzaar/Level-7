// Procedural sound for the games (WebAudio, no assets). Everything is synthesised: the
// fluorescent hum, carpet footsteps, the entity, and the stings used by the jump scares.
// Must be created from a user gesture.
export function createAudio() {
  const ac = new AudioContext();
  const now = () => ac.currentTime;

  const out = ac.createDynamicsCompressor();
  out.threshold.value = -8; out.knee.value = 6; out.ratio.value = 5;
  out.connect(ac.destination);
  const master = ac.createGain();
  master.gain.value = 0.85;
  master.connect(out);

  // long, dull room reverb from a decaying noise impulse
  const verb = ac.createConvolver();
  {
    const len = Math.floor(ac.sampleRate * 2.6);
    const ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp += (Math.random() * 2 - 1 - lp) * 0.35;
        d[i] = lp * Math.pow(1 - i / len, 2.4);
      }
    }
    verb.buffer = ir;
  }
  const verbIn = ac.createGain();
  verbIn.gain.value = 0.5;
  verbIn.connect(verb).connect(master);

  const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  {
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const brown = ac.createBuffer(1, ac.sampleRate * 4, ac.sampleRate);
  {
    const d = brown.getChannelData(0);
    let v = 0;
    for (let i = 0; i < d.length; i++) { v = (v + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = v * 3.5; }
  }
  const drive = ac.createWaveShaper();
  {
    const c = new Float32Array(1024);
    for (let i = 0; i < c.length; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(x * 4); }
    drive.curve = c;
  }
  drive.connect(master);

  // ---- helpers -------------------------------------------------------------------------
  const gainNode = (v, dest) => { const g = ac.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g; };
  const env = (g, t0, a, peak, dur) => {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + dur);
  };
  const noiseSrc = (buf = noise, loop = false) => {
    const s = ac.createBufferSource();
    s.buffer = buf; s.loop = loop;
    if (!loop) s.playbackRate.value = 0.8 + Math.random() * 0.4;
    return s;
  };
  const filt = (type, f, q = 1) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const osc = (type, f) => { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; return o; };
  const panner = (x, z, ref = 2, roll = 1.2) => {
    const p = ac.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    p.refDistance = ref; p.rolloffFactor = roll; p.maxDistance = 200;
    p.positionX.value = x; p.positionY.value = 1.6; p.positionZ.value = z;
    p.connect(master);
    const send = gainNode(0.6, verbIn);
    p.connect(send);
    return p;
  };
  const stopAt = (nodes, t) => { for (const n of nodes) n.stop(t); };

  // ---- beds ----------------------------------------------------------------------------
  const room = noiseSrc(brown, true);
  const roomLP = filt('lowpass', 180);
  const roomG = gainNode(0.10, master);
  room.connect(roomLP).connect(roomG);
  room.start();

  // the hum: mains frequency and harmonics through a resonant band, level follows the lights
  const humG = gainNode(0, master);
  const humBP = filt('bandpass', 240, 2.5);
  humBP.connect(humG);
  const humOscs = [osc('sawtooth', 120), osc('sine', 60), osc('square', 240)];
  const humMix = [0.5, 0.8, 0.08];
  humOscs.forEach((o, i) => { o.connect(gainNode(humMix[i], humBP)); o.start(); });
  const buzzG = gainNode(0, master);
  const buzz = osc('square', 120);
  buzz.connect(filt('highpass', 900)).connect(buzzG);
  buzz.start();

  // open sea: slow surging surf (silent unless a level turns it up)
  const surf = noiseSrc(noise, true);
  const surfLP = filt('lowpass', 500, 0.7);
  const surfG = gainNode(0, master);
  const swellLFO = osc('sine', 0.11);
  const swellAmt = gainNode(0);
  swellLFO.connect(swellAmt).connect(surfG.gain);
  surf.connect(surfLP).connect(surfG);
  surfG.connect(gainNode(0.4, verbIn));
  surf.start(); swellLFO.start();
  function setSea(level) {
    const t = now();
    surfG.gain.setTargetAtTime(0.10 * level, t, 0.5);
    swellAmt.gain.setTargetAtTime(0.07 * level, t, 0.5);
    surfLP.frequency.setTargetAtTime(380 + 500 * level, t, 0.5);
  }

  // water washing over the walkway around your feet
  function splash(level = 1) {
    const t = now();
    const s = noiseSrc();
    const bp = filt('bandpass', 900, 0.6);
    bp.frequency.setValueAtTime(1800, t);
    bp.frequency.exponentialRampToValueAtTime(350, t + 0.7);
    const g = ac.createGain();
    s.connect(bp).connect(g);
    g.connect(master); g.connect(gainNode(0.3, verbIn));
    env(g, t, 0.05, 0.35 * level, 0.7);
    s.start(t, Math.random()); s.stop(t + 1.0);
  }

  // something very large moving underneath: a sub-bass groan with a slow wobble
  function groan(x, z) {
    const t = now();
    const p = panner(x, z, 12, 0.4);
    const g = ac.createGain();
    const os = [osc('sawtooth', 34), osc('sawtooth', 35.5), osc('sine', 51)];
    const lp = filt('lowpass', 160, 4);
    lp.frequency.setValueAtTime(90, t);
    lp.frequency.linearRampToValueAtTime(260, t + 2.5);
    lp.frequency.linearRampToValueAtTime(70, t + 6);
    for (const o of os) {
      o.frequency.setValueAtTime(o.frequency.value, t);
      o.frequency.linearRampToValueAtTime(o.frequency.value * 0.82, t + 6);
      o.connect(lp);
    }
    lp.connect(g).connect(p);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.6, t + 2.0);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 6.2);
    for (const o of os) o.start(t);
    stopAt(os, t + 6.4);
  }

  // the exit sign buzzes too: a faint positional cue to steer by
  let exitPan = null;
  const setExit = (x, z) => {
    if (exitPan) { exitPan.positionX.value = x; exitPan.positionZ.value = z; return; }
    exitPan = panner(x, z, 1.5, 1.6);
    const o = osc('sawtooth', 100);
    const g = gainNode(0.05);
    o.connect(filt('bandpass', 1400, 4)).connect(g).connect(exitPan);
    o.start();
  };

  // ---- one-shots ------------------------------------------------------------------------
  function step(sprint) {
    const t = now();
    const s = noiseSrc();
    const g = ac.createGain();
    s.connect(filt('lowpass', sprint ? 700 : 450)).connect(g);
    g.connect(master); g.connect(gainNode(0.15, verbIn));
    env(g, t, 0.008, sprint ? 0.22 : 0.14, 0.11);
    s.start(t, Math.random()); s.stop(t + 0.2);
  }

  function heartbeat(level) {
    const t = now();
    for (const [dt, a] of [[0, 1], [0.16, 0.7]]) {
      const o = osc('sine', 52);
      o.frequency.setValueAtTime(70, t + dt);
      o.frequency.exponentialRampToValueAtTime(38, t + dt + 0.14);
      const g = gainNode(0, master);
      o.connect(g);
      env(g, t + dt, 0.01, 0.55 * a * level, 0.16);
      o.start(t + dt); o.stop(t + dt + 0.25);
    }
  }

  function entStep(x, z) {
    const t = now();
    const p = panner(x, z, 2.5, 1.0);
    const o = osc('sine', 60);
    o.frequency.setValueAtTime(85, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.22);
    const g = ac.createGain();
    o.connect(g).connect(p);
    env(g, t, 0.006, 0.9, 0.25);
    const s = noiseSrc();
    const g2 = ac.createGain();
    s.connect(filt('lowpass', 260)).connect(g2).connect(p);
    env(g2, t, 0.004, 0.7, 0.12);
    o.start(t); s.start(t, Math.random()); stopAt([o, s], t + 0.4);
  }

  // jump-scare sting: dissonant distorted cluster, screech and a sub drop
  function sting(power = 1) {
    const t = now();
    const g = ac.createGain();
    g.connect(drive);
    env(g, t, 0.006, 0.55 * power, 1.4);
    const os = [];
    for (const f of [233, 247, 349, 370, 523]) {
      const o = osc('sawtooth', f);
      o.detune.value = (Math.random() - 0.5) * 40;
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 0.94, t + 1.4);
      o.connect(g); os.push(o);
    }
    const sc = osc('square', 1500);
    sc.frequency.setValueAtTime(1300, t);
    sc.frequency.exponentialRampToValueAtTime(2600, t + 0.35);
    sc.frequency.exponentialRampToValueAtTime(900, t + 1.2);
    const scG = ac.createGain();
    sc.connect(filt('bandpass', 2200, 3)).connect(scG).connect(master);
    env(scG, t, 0.01, 0.3 * power, 1.0);
    const s = noiseSrc();
    const sf = filt('bandpass', 3000, 0.8);
    sf.frequency.setValueAtTime(4000, t);
    sf.frequency.exponentialRampToValueAtTime(500, t + 1.0);
    const sG = ac.createGain();
    s.connect(sf).connect(sG).connect(master);
    sG.connect(verbIn);
    env(sG, t, 0.004, 0.8 * power, 0.9);
    const sub = osc('sine', 80);
    sub.frequency.setValueAtTime(90, t);
    sub.frequency.exponentialRampToValueAtTime(28, t + 0.9);
    const subG = gainNode(0, master);
    sub.connect(subG);
    env(subG, t, 0.005, 1.0 * power, 0.9);
    for (const n of [...os, sc, s, sub]) n.start(t);
    stopAt([...os, sc, s, sub], t + 1.8);
  }

  // being caught: a long, rising, tremolo shriek on top of the sting
  function scream() {
    sting(1.2);
    const t = now();
    const g = ac.createGain();
    const trem = osc('sine', 31);
    const tremG = gainNode(0.5);
    trem.connect(tremG).connect(g.gain);
    g.connect(drive);
    env(g, t, 0.02, 0.6, 2.0);
    const os = [];
    for (const f of [620, 655, 930]) {
      const o = osc('sawtooth', f);
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * 2.2, t + 1.6);
      o.connect(filt('bandpass', 1800, 1.2)).connect(g);
      os.push(o);
    }
    for (const n of [...os, trem]) n.start(t);
    stopAt([...os, trem], t + 2.3);
  }

  function powerDown() {
    const t = now();
    clunk(0.7);
    const o = osc('sawtooth', 120);
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(18, t + 1.0);
    const g = ac.createGain();
    o.connect(filt('lowpass', 600)).connect(g).connect(master);
    env(g, t, 0.01, 0.3, 1.0);
    o.start(t); o.stop(t + 1.2);
  }

  function clunk(level = 1) {
    const t = now();
    const s = noiseSrc();
    const g = ac.createGain();
    s.connect(filt('lowpass', 900)).connect(g);
    g.connect(master); g.connect(verbIn);
    env(g, t, 0.003, 0.7 * level, 0.18);
    s.start(t, Math.random()); s.stop(t + 0.3);
  }

  // a tube bursting overhead: crack plus a few glassy tinkles
  function pop(x, z) {
    const t = now();
    const p = panner(x, z, 2.0, 1.0);
    const s = noiseSrc();
    const g = ac.createGain();
    s.connect(filt('highpass', 1200)).connect(g).connect(p);
    env(g, t, 0.002, 1.2, 0.08);
    s.start(t, Math.random()); s.stop(t + 0.15);
    for (let i = 0; i < 6; i++) {
      const tt = t + 0.04 + Math.random() * 0.5;
      const o = osc('sine', 2800 + Math.random() * 3500);
      const og = ac.createGain();
      o.connect(og).connect(p);
      env(og, tt, 0.002, 0.08, 0.12 + Math.random() * 0.2);
      o.start(tt); o.stop(tt + 0.4);
    }
  }

  function whisper(x, z) {
    const t = now();
    const p = panner(x, z, 1.5, 1.0);
    const s = noiseSrc();
    const bp = filt('bandpass', 1200, 9);
    for (let k = 0; k < 6; k++) bp.frequency.setValueAtTime(700 + Math.random() * 2200, t + k * 0.18);
    const g = ac.createGain();
    s.connect(bp).connect(g).connect(p);
    env(g, t, 0.3, 1.4, 1.0);
    s.start(t, Math.random()); s.stop(t + 1.5);
  }

  // distant howl when a hunt starts
  function roar(x, z) {
    const t = now();
    const p = panner(x, z, 6, 0.6);
    const g = ac.createGain();
    const trem = osc('sine', 8);
    const tremG = gainNode(0.4);
    trem.connect(tremG).connect(g.gain);
    const os = [osc('sawtooth', 68), osc('sawtooth', 71.5), osc('square', 103)];
    const lp = filt('lowpass', 500, 3);
    lp.frequency.setValueAtTime(250, t);
    lp.frequency.linearRampToValueAtTime(900, t + 0.8);
    lp.frequency.linearRampToValueAtTime(200, t + 2.6);
    for (const o of os) {
      o.frequency.setValueAtTime(o.frequency.value, t);
      o.frequency.linearRampToValueAtTime(o.frequency.value * 1.25, t + 0.7);
      o.frequency.linearRampToValueAtTime(o.frequency.value * 0.8, t + 2.6);
      o.connect(lp);
    }
    lp.connect(g).connect(p);
    env(g, t, 0.35, 1.5, 2.4);
    for (const n of [...os, trem]) n.start(t);
    stopAt([...os, trem], t + 3.0);
  }

  // low swell when you first notice something watching you
  function dread() {
    const t = now();
    const g = gainNode(0, master);
    g.connect(verbIn);
    const os = [osc('sine', 55), osc('sine', 58.3), osc('triangle', 110.6)];
    for (const o of os) o.connect(g);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
    for (const o of os) o.start(t);
    stopAt(os, t + 3.6);
  }

  // ---- per frame -------------------------------------------------------------------------
  let heartT = 0;
  function update(dt, cam, hum, flicker, heart) {
    const L = ac.listener;
    const fx = Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
    if (L.positionX) {
      L.positionX.value = cam.x; L.positionY.value = 1.6; L.positionZ.value = cam.z;
      L.forwardX.value = fx; L.forwardY.value = 0; L.forwardZ.value = fz;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      L.setPosition(cam.x, 1.6, cam.z);
      L.setOrientation(fx, 0, fz, 0, 1, 0);
    }
    const t = now();
    humG.gain.setTargetAtTime(0.06 * hum, t, 0.03);
    buzzG.gain.setTargetAtTime(0.03 * flicker, t, 0.01);
    if (heart > 0) {
      heartT -= dt;
      if (heartT <= 0) { heartbeat(Math.min(1, heart)); heartT = 60 / (70 + 90 * Math.min(1, heart)); }
    }
  }

  function setMuffled(on) { master.gain.setTargetAtTime(on ? 0.15 : 0.85, now(), 0.2); }

  return { ac, update, step, entStep, sting, scream, powerDown, clunk, pop, whisper, roar, dread, setExit, setMuffled, setSea, splash, groan };
}
