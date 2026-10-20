// Level 7: the drowned backrooms. The ocean renderer draws the sea and sky; this file adds
// the walkway and drowned office (instanced boxes), the entity, lamps the sea reflects, and
// the game: a walkway to an EXIT door, a storm and nightfall that build over time, and a
// director that schedules the scares. The lamps are the only safe ground.
import { createOceanRenderer, OCEAN_DEFAULTS, rendererLog, D2R } from '../renderer.js';
import { MAX_LAMPS, MAX_RIPPLES, EXTRA_BYTES, EX_LAMPS, EX_RIPPLES, EX_PROBES } from '../wgsl/common.js';
import { GAME_COMPOSITE } from '../game/fx.js';
import { SEA_PROPS, SEA_ENTITY, SEA_LANDMARKS } from './shaders.js';
import { generateSea, onWalkway, collideSea, collideRects, seaLOS, buildWaterField, SLAB_TOP } from './level.js';
import { createAudio } from '../game/audio.js';
import { fontWords, FONT_WORDS } from './story.js';

const qs = new URLSearchParams(location.search);

// Any key can be overridden from the URL, e.g. ?lampPower=8&entSpeed=4
export const SEA_TUNE = {
  lampPower: 5.0,      // ceiling lamp strength
  exitPower: 4.0,      // red light over the exit
  torch: 2.0,          // flashlight strength
  walk: 2.2,           // m/s
  sprint: 4.4,
  swim: 1.3,           // m/s, 2.1 with Shift
  jump: 3.6,           // m/s take-off speed (about 0.65 m high)
  swimStamina: 45,     // seconds of steady swimming from full stamina
  staminaS: 6.5,       // seconds of sprint from full
  entSpeed: 3.4,       // entity top speed while hunting
  safeR: 3.4,          // m, how close it can get to a working lamp
  firstScare: 55,      // s until the first blackout
  nightfall: 300,      // s until the sun is fully down
};
for (const k of Object.keys(SEA_TUNE)) if (qs.has(k)) SEA_TUNE[k] = Number(qs.get(k));

const AUTO = qs.get('auto') === '1';
const SHOT = qs.get('shot');
const SHOT_FRAMES = Number(qs.get('frames')) || 90;
const SHOW_FPS = qs.get('fps') === '1';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hash7 = (a, b) => { const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return s - Math.floor(s); };

// How many times the level has been replayed. Every replay goes one level deeper, and
// deeper is longer, more tangled, darker, and the thing in it is worse. Remembered between
// visits in this browser (a convenience only: it falls back to 1 if storage is unavailable).
const DEPTH_KEY = 'level7.depth';
// Escape descent 7 and the game is finished (you can keep going past it if you want).
// Dying never takes you past the final descent: you have to get out of it.
export const FINAL_DESCENT = 7;

// Phones and tablets: touch controls and a lighter renderer. ?touch=1 / ?quality=low|high
// force either half for testing.
const IS_TOUCH = qs.get('touch') ? qs.get('touch') === '1'
  : (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0) && !matchMedia('(pointer: fine)').matches;
const QUALITY = qs.get('quality') || (IS_TOUCH ? 'low' : 'high');
const DPR = window.devicePixelRatio || 1;
const Q = QUALITY === 'low'
  ? {
    msaa: 1,
    // render near 1 CSS pixel per pixel, never more; the governor can go down to ~0.55
    scale: Math.min(1, 1.0 / DPR), minScale: 0.55 / DPR, maxScale: Math.min(1, 1.3 / DPR),
    litLamps: 14, marks: 8,
  }
  : { msaa: 4, scale: 1, minScale: 0.5, maxScale: 1, litLamps: 47, marks: 64 };
function loadDepth() {
  try { return Math.max(1, Number(localStorage.getItem(DEPTH_KEY)) || 1); } catch (e) { return 1; }
}
function saveDepth(d) {
  try { localStorage.setItem(DEPTH_KEY, String(d)); } catch (e) { /* private mode: not remembered */ }
}
// What changes with depth. Descent 1 is the original level.
function escalation(d) {
  const k = d - 1;
  return {
    creep: Math.min(1, k / 5),                       // the entity's shape
    red: clamp((k - 1) / 4, 0, 1),                   // its eyes
    entSpeed: Math.min(4.2, SEA_TUNE.entSpeed + 0.2 * k),
    drain: Math.max(3.5, 7 - 0.7 * k),               // seconds a lamp holds out under siege
    huntLen: 38 + 4 * k,
    pace: 1 / (1 + 0.22 * k),                        // scale on the time between scares
    firstScare: Math.max(15, SEA_TUNE.firstScare - 9 * k),
    sunStart: Math.max(-0.6, 1.8 - 0.45 * k),
    stormBase: Math.min(0.5, 0.1 * k),
    nightfall: Math.max(150, SEA_TUNE.nightfall - 30 * k),
  };
}

// touch layout straight away, before the renderer has started (that can take a moment)
if (IS_TOUCH) {
  document.body.classList.add('touch');
  for (const el of document.querySelectorAll('.go')) el.textContent = el.textContent.replace('CLICK', 'TAP');
}

const QUIET = {};
for (const k of ['update', 'step', 'entStep', 'sting', 'scream', 'powerDown', 'clunk', 'pop', 'whisper', 'roar', 'dread', 'setExit', 'setMuffled', 'setSea', 'splash', 'groan']) QUIET[k] = () => {};

async function seaMain() {
  const canvas = document.getElementById('c');
  const P7 = {
    ...OCEAN_DEFAULTS,
    sunElev: 1.8, sunAzim: 4, clouds: 0.55, veil: 0.6, haze: 5.0, exposure: 1.5, bloom: 0.1,
    windSpeed: 4.5, swellHs: 0.5, swellLength: 70, choppy: 1.0, turbidity: 0.8, sunScale: 1,
  };
  for (const k of Object.keys(P7)) if (qs.has(k)) P7[k] = Number(qs.get(k));
  const fw = Number(qs.get('w')) || 0, fh = Number(qs.get('h')) || 0;
  let renderScale = Number(qs.get('scale')) || Q.scale;

  let drawExtra = null;
  let fillComp = null;
  const R = await createOceanRenderer(canvas, P7, {
    fixedSize: () => [fw, fh],
    scale: () => renderScale,
    msaa: Q.msaa,
    composite: { wgsl: GAME_COMPOSITE, floats: 12, fill: (c, fi) => fillComp(c, fi) },
    draw: (rp) => drawExtra(rp),
  });
  const device = R.device;
  const sh = R.shared;
  const BU = GPUBufferUsage;

  // --------------------------------------------------------------------------------------
  // Pipelines for the drowned office and the entity
  // --------------------------------------------------------------------------------------
  const [propsMod, entMod, markMod] = await Promise.all([R.shader(SEA_PROPS, 'sea props'), R.shader(SEA_ENTITY, 'sea entity'), R.shader(SEA_LANDMARKS, 'landmarks')]);
  const mkPipe = (module, label) => device.createRenderPipelineAsync({
    label, layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: sh.hdrFormat }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: sh.depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
    multisample: { count: sh.msaa },
  });
  const [propsPipe, entPipe, markPipe] = await Promise.all([mkPipe(propsMod, 'sea props'), mkPipe(entMod, 'sea entity'), mkPipe(markMod, 'landmarks')]);
  const MAX_MARKS = 64;
  const markBuf = device.createBuffer({ size: MAX_MARKS * 32, usage: BU.STORAGE | BU.COPY_DST });
  const markData = new Float32Array(MAX_MARKS * 8);
  let markCount = 0;
  const MAX_BOXES = 4096;
  const MAX_GLOW = 256;
  const boxBuf = device.createBuffer({ size: MAX_BOXES * 32, usage: BU.STORAGE | BU.COPY_DST });
  const boxData = new Float32Array(MAX_BOXES * 8);
  const gameUBO = device.createBuffer({ size: 48, usage: BU.UNIFORM | BU.COPY_DST });
  const gameData = new Float32Array(12);
  const entUBO = device.createBuffer({ size: 48, usage: BU.UNIFORM | BU.COPY_DST });
  const entData = new Float32Array(12);
  const glowBuf = device.createBuffer({ size: MAX_GLOW * 16, usage: BU.STORAGE | BU.COPY_DST });
  const glowData = new Float32Array(MAX_GLOW * 4);
  // writing on the walls
  const MAX_DECALS = 256, MAX_TEXT = 8192;
  const decalBuf = device.createBuffer({ size: MAX_DECALS * 64, usage: BU.STORAGE | BU.COPY_DST });
  const decalData = new Float32Array(MAX_DECALS * 16);
  const textBuf = device.createBuffer({ size: MAX_TEXT * 4, usage: BU.STORAGE | BU.COPY_DST });
  const extra = new Float32Array(EXTRA_BYTES / 4);
  const common = [{ buffer: sh.frameUBO }, sh.transView, sh.skyView, sh.sampClamp, sh.envCubeView, { buffer: sh.sunVisBuf }, { buffer: sh.extraBuf }];
  const mkBG = (pipe, more) => device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: [...common, ...more].map((r, i) => ({ binding: i, resource: r })),
  });
  // the indoor mask changes with every layout, so these are rebuilt per run
  let indoorTex = null, bgProps = null, bgEnt = null, bgMarks = null;
  function setIndoor(m) {
    if (indoorTex) indoorTex.destroy();
    indoorTex = device.createTexture({ size: [m.w, m.h], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: indoorTex }, m.bytes, { bytesPerRow: m.w }, [m.w, m.h]);
    bgProps = mkBG(propsPipe, [{ buffer: boxBuf }, { buffer: gameUBO }, indoorTex.createView(), { buffer: glowBuf }, { buffer: decalBuf }, { buffer: textBuf }]);
    bgEnt = mkBG(entPipe, [{ buffer: entUBO }, { buffer: gameUBO }, indoorTex.createView()]);
    bgMarks = mkBG(markPipe, [{ buffer: markBuf }, { buffer: gameUBO }, indoorTex.createView()]);
    gameData[8] = m.x0; gameData[9] = m.z0; gameData[10] = m.w * 2.5; gameData[11] = m.h * 2.5;
  }
  let boxCount = 0;
  let entVisible = false;
  drawExtra = (rp) => {
    if (boxCount) { rp.setPipeline(propsPipe); rp.setBindGroup(0, bgProps); rp.draw(36, boxCount); }
    if (markCount) { rp.setPipeline(markPipe); rp.setBindGroup(0, bgMarks); rp.draw(36, markCount); }
    if (entVisible) { rp.setPipeline(entPipe); rp.setBindGroup(0, bgEnt); rp.draw(36); }
  };

  // --------------------------------------------------------------------------------------
  // Game state
  // --------------------------------------------------------------------------------------
  let audio = QUIET;
  let seed = Number(qs.get('seed')) || (Math.random() * 1e9) >>> 0;
  let depth = Number(qs.get('depth')) || loadDepth();
  let ESC = escalation(depth);
  let S, rnd;
  let lampVal = new Float32Array(0), lampDrain = new Float32Array(0), lampBurst = new Float32Array(0);
  const G = {}, PL = {}, E = {}, next = {}, deep = {};

  function newRun() {
    ESC = escalation(depth);
    S = generateSea((seed + depth * 7919) >>> 0, depth);
    let s = (seed ^ 0x5bd1e995) >>> 0;
    rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    boxCount = Math.min(MAX_BOXES, S.boxes.length);
    for (let k = 0; k < boxCount; k++) {
      const b = S.boxes[k], o = k * 8;
      boxData[o] = b.c[0]; boxData[o + 1] = b.c[1]; boxData[o + 2] = b.c[2]; boxData[o + 3] = b.m;
      boxData[o + 4] = b.h[0]; boxData[o + 5] = b.h[1]; boxData[o + 6] = b.h[2]; boxData[o + 7] = b.s;
    }
    device.queue.writeBuffer(boxBuf, 0, boxData, 0, boxCount * 8);
    setIndoor(S.indoor);
    if (SHOT) rendererLog(`gen boxes=${S.boxes.length} decal0=${S.decals[0] ? S.decals[0].x.toFixed(2) + ',' + S.decals[0].z.toFixed(2) : '-'}`);
    const nd = Math.min(MAX_DECALS, S.decals.length);
    S.decals.slice(0, nd).forEach((dc, i) => {
      decalData.set([dc.x, dc.y, dc.z, dc.px, dc.start, dc.cols, dc.rows, dc.host,
        dc.nx, dc.nz, dc.shake, dc.drip, dc.col[0], dc.col[1], dc.col[2], dc.fade], i * 16);
    });
    if (nd) device.queue.writeBuffer(decalBuf, 0, decalData, 0, nd * 16);
    const words = new Uint32Array(Math.min(MAX_TEXT, FONT_WORDS + S.text.length));
    words.set(fontWords());
    words.set(S.text.slice(0, words.length - FONT_WORDS), FONT_WORDS);
    device.queue.writeBuffer(textBuf, 0, words);
    // tests: ?mark=type,dist puts one landmark of that type straight ahead of the start view
    if (qs.has('mark')) {
      const [mt, md] = qs.get('mark').split(',').map(Number);
      const yaw0 = qs.get('at') ? Number(qs.get('at').split(',')[2]) * D2R : S.start.yaw;
      const px = qs.get('at') ? Number(qs.get('at').split(',')[0]) : S.start.x;
      const pz = qs.get('at') ? Number(qs.get('at').split(',')[1]) : S.start.z;
      const mx = px + Math.sin(yaw0) * (md || 60), mz = pz - Math.cos(yaw0) * (md || 60);
      S.landmarks = [{ type: mt, x: mx, z: mz, y: 0, yaw: Math.atan2(px - mx, pz - mz) + 0.5,
        scale: mt === 6 ? 8 : (mt >= 3 ? 1.8 : 1), seed: 0.4, watches: false }];
    }
    markCount = Math.min(MAX_MARKS, Q.marks, S.landmarks.length);
    writeMarks();
    fakeLeft = S.fakeExits.slice();
    lampVal = new Float32Array(S.lamps.length);
    lampDrain = new Float32Array(S.lamps.length);
    lampBurst = new Float32Array(S.lamps.length);
    Object.assign(G, {
      state: AUTO ? 'play' : 'title', time: 0, power: 1, powerTarget: 1, sun: 1, sunTarget: 1, alarm: 0,
      flash: 0, glitch: 0, shake: 0, fade: 1, msg: '', msgT: 0, endT: 0, storm: 0, specT: 0, hum: 0, buzz: 0,
      lookDown: 0, paused: false, swimHint: false, calmUntil: 0,
    });
    G.storm = ESC.stormBase;
    Object.assign(PL, {
      x: S.start.x, z: S.start.z, vx: 0, vz: 0, yaw: S.start.yaw, pitch: -0.05, stamina: 1, tired: false,
      bob: 0, moving: 0, torch: qs.get('torch') === '1', battery: 1, eyeY: SLAB_TOP + 1.62, targetYaw: 0,
      // movement: 'ground' | 'air' | 'swim' | 'climb'
      mode: 'ground', feetY: SLAB_TOP, vy: 0, jumpHeld: false, dip: 0,
      swimT: 0, sinkT: 0, strokeT: 0, climbT: 0, cx0: 0, cz0: 0, cy0: 0, cx1: 0, cz1: 0,
    });
    if (qs.get('at')) {
      const v = qs.get('at').split(',').map(Number);
      PL.x = v[0]; PL.z = v[1]; PL.yaw = (v[2] || 0) * D2R; PL.pitch = (v[3] || 0) * D2R;
    }
    Object.assign(E, { mode: 'away', x: 0, z: 0, y: -3, ty: -3, face: 0, t: 0, look: 0, seen: false, creep: 0, glow: 1, raise: 0, twitch: 0, vanishT: 0, stepT: 0, sink: false, vx: 0, vz: 0 });
    const pc = ESC.pace;
    Object.assign(next, {
      stalk: (18 + rnd() * 10) * pc, burst: (28 + rnd() * 20) * pc, blackout: ESC.firstScare + rnd() * 15 * pc,
      hunt: (120 + rnd() * 30) * pc, deep: (35 + rnd() * 20) * pc, rise: 40 * pc,
      // scares that only exist deeper down
      behind: depth >= 2 ? (30 + rnd() * 15) * pc : Infinity,
      cross: depth >= 2 ? (40 + rnd() * 20) * pc : Infinity,
      window: depth >= 3 ? (20 + rnd() * 10) * pc : Infinity,
    });
    Object.assign(deep, { on: false, t: 0, dur: 1, x: 0, z: 0, dx: 1, dz: 0, speed: 3.6, hunting: false });
    extra.fill(0);
    ripples.length = 0;
    // let the sea know where the walkway and the drowned walls stand
    const fld = buildWaterField(S);
    R.setObstacleField(fld.bytes, fld.n, fld.n);
    extra[12] = fld.x0; extra[13] = fld.z0; extra[14] = fld.size; extra[15] = 1;
    audio.setExit(S.exit.signX, S.exit.signZ);
    hudMsg(depth === 1 ? 'Follow the walkway. Find the EXIT.' : `DESCENT ${depth}. Find the EXIT.`, 6);
    for (const el of document.querySelectorAll('.depth')) el.textContent = depth <= FINAL_DESCENT ? `${depth} / ${FINAL_DESCENT}` : `${depth}`;
  }
  let fakeLeft = [];

  // landmarks on the horizon; statues and idols turn to face you while you are not looking
  function writeMarks() {
    for (let k = 0; k < markCount; k++) {
      const m = S.landmarks[k], o = k * 8;
      markData[o] = m.x; markData[o + 1] = m.y; markData[o + 2] = m.z; markData[o + 3] = m.yaw;
      markData[o + 4] = m.type; markData[o + 5] = m.scale; markData[o + 6] = m.seed; markData[o + 7] = ESC.creep;
    }
    device.queue.writeBuffer(markBuf, 0, markData, 0, markCount * 8);
  }
  function updateMarks() {
    let moved = false;
    for (let k = 0; k < markCount; k++) {
      const m = S.landmarks[k];
      if (!m.watches || inView(m.x, m.z, 0.55)) continue;
      const want = Math.atan2(PL.x - m.x, PL.z - m.z);
      const dy = Math.atan2(Math.sin(want - m.yaw), Math.cos(want - m.yaw));
      if (Math.abs(dy) > 0.01) { m.yaw = want; moved = true; }
    }
    if (moved) writeMarks();
  }

  // --------------------------------------------------------------------------------------
  // Input and screens
  // --------------------------------------------------------------------------------------
  const keys = Object.create(null);
  // tests: ?hold=KeyW,ShiftLeft keeps those keys down for the whole run
  for (const k of (qs.get('hold') || '').split(',')) if (k) keys[k] = true;
  addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'KeyF') toggleTorch();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  function toggleTorch() {
    if (G.state === 'play' && !G.paused && PL.battery > 0.02) { PL.torch = !PL.torch; audio.clunk(0.25); }
  }
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas && G.state === 'play') {
      PL.yaw += e.movementX * 0.0022;
      PL.pitch = clamp(PL.pitch - e.movementY * 0.0022, -1.35, 1.35);
    }
  });
  const overlay = document.getElementById('overlay');
  const screens = {};
  for (const el of overlay.querySelectorAll('[data-screen]')) screens[el.dataset.screen] = el;
  function showScreen(name) {
    overlay.classList.toggle('hidden', !name);
    for (const k in screens) screens[k].classList.toggle('hidden', k !== name);
  }
  overlay.addEventListener('click', () => {
    if (audio === QUIET) {
      try { audio = createAudio(); audio.setExit(S.exit.signX, S.exit.signZ); } catch (e) { rendererLog('audio failed: ' + e); }
    }
    if (audio.ac && audio.ac.state === 'suspended') audio.ac.resume();
    if (G.state === 'finished') return;            // its own buttons decide
    if (G.state === 'dead' || G.state === 'won') {
      if (G.endT < 1.2) return;
      seed = (seed + 1) >>> 0;
      // escaping always goes deeper; being caught does not carry you past the last descent
      depth = G.state === 'dead' && depth === FINAL_DESCENT ? depth : depth + 1;
      saveDepth(depth);
      newRun();
      R.invalidate('spectrum');
      G.state = 'play';
    } else if (G.state === 'title') {
      G.state = 'play';
    }
    G.paused = false;
    audio.setMuffled(false);
    showScreen(null);
    grabInput();
  });
  function grabInput() {
    if (!IS_TOUCH) { canvas.requestPointerLock(); return; }
    // phones: go fullscreen and hold landscape where the browser allows it
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' }).then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape')).catch(() => {});
    }
  }
  // start over: back to descent 1 (on the title screen it rebuilds the level right away;
  // on an end screen the next click starts descent 1)
  for (const btn of overlay.querySelectorAll('.reset')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      depth = G.state === 'title' ? 1 : 0;   // the end-screen click adds one
      saveDepth(Math.max(1, depth));
      if (G.state === 'title') { newRun(); R.invalidate('spectrum'); }
      else {
        for (const el of document.querySelectorAll('.depth')) el.textContent = '1';
        overlay.click();
      }
    });
  }
  canvas.addEventListener('click', () => { if (G.state === 'play' && !IS_TOUCH) canvas.requestPointerLock(); });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas && G.state === 'play' && !AUTO && !IS_TOUCH) {
      G.paused = true;
      audio.setMuffled(true);
      showScreen('pause');
    }
  });

  // the ending: start over, or keep descending past it
  const finBtn = (sel, d) => {
    const b = overlay.querySelector(sel);
    if (b) b.addEventListener('click', (e) => {
      e.stopPropagation();
      depth = d(); saveDepth(depth);
      seed = (seed + 1) >>> 0;
      newRun(); R.invalidate('spectrum');
      G.state = 'play'; G.paused = false;
      audio.setMuffled(false);
      showScreen(null);
      grabInput();
    });
  };
  finBtn('.fin-restart', () => 1);
  finBtn('.fin-deeper', () => FINAL_DESCENT + 1);

  // ---- touch controls: thumbstick on the left, drag to look on the right, buttons ----
  const touchUI = document.getElementById('touch');
  const stickEl = document.getElementById('stick'), knobEl = document.getElementById('knob');
  const TS = { id: -1, ox: 0, oy: 0, mx: 0, my: 0, lookId: -1, lx: 0, ly: 0 };
  const STICK_R = 56;
  if (IS_TOUCH) {
    touchUI.addEventListener('pointerdown', (e) => {
      if (G.state !== 'play' || G.paused) return;
      if (e.clientX < innerWidth * 0.45 && TS.id < 0) {
        // the stick appears under your thumb
        TS.id = e.pointerId; TS.ox = e.clientX; TS.oy = e.clientY; TS.mx = TS.my = 0;
        stickEl.style.left = e.clientX + 'px'; stickEl.style.top = e.clientY + 'px';
        stickEl.classList.add('on');
        knobEl.style.transform = 'translate(0px, 0px)';
      } else if (TS.lookId < 0) {
        TS.lookId = e.pointerId; TS.lx = e.clientX; TS.ly = e.clientY;
      }
      touchUI.setPointerCapture(e.pointerId);
    });
    touchUI.addEventListener('pointermove', (e) => {
      if (e.pointerId === TS.id) {
        let dx = e.clientX - TS.ox, dy = e.clientY - TS.oy;
        const l = Math.hypot(dx, dy);
        if (l > STICK_R) { dx *= STICK_R / l; dy *= STICK_R / l; }
        TS.mx = dx / STICK_R; TS.my = dy / STICK_R;
        knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
      } else if (e.pointerId === TS.lookId && G.state === 'play') {
        PL.yaw += (e.clientX - TS.lx) * 0.0055;
        PL.pitch = clamp(PL.pitch - (e.clientY - TS.ly) * 0.0055, -1.35, 1.35);
        TS.lx = e.clientX; TS.ly = e.clientY;
      }
    });
    const release = (e) => {
      if (e.pointerId === TS.id) { TS.id = -1; TS.mx = TS.my = 0; stickEl.classList.remove('on'); }
      if (e.pointerId === TS.lookId) TS.lookId = -1;
    };
    touchUI.addEventListener('pointerup', release);
    touchUI.addEventListener('pointercancel', release);
    const hold = (id, code) => {
      const b = document.getElementById(id);
      b.addEventListener('pointerdown', (e) => { e.stopPropagation(); keys[code] = true; b.classList.add('down'); });
      const up = (e) => { e.stopPropagation(); keys[code] = false; b.classList.remove('down'); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
    };
    hold('btn-jump', 'Space');
    document.getElementById('btn-torch').addEventListener('pointerdown', (e) => { e.stopPropagation(); toggleTorch(); });
    document.getElementById('btn-pause').addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (G.state !== 'play') return;
      G.paused = true; audio.setMuffled(true); showScreen('pause');
    });
  }
  // the phone was put away mid-run
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && G.state === 'play' && !AUTO) { G.paused = true; audio.setMuffled(true); showScreen('pause'); }
  });

  const hud = {
    root: document.getElementById('hud'), rec: document.getElementById('rec'), tc: document.getElementById('tc'),
    msg: document.getElementById('msg'), stam: document.getElementById('stam'), stamBar: document.getElementById('stam-bar'),
    batt: document.getElementById('batt'), battBar: document.getElementById('batt-bar'), fps: document.getElementById('fps'),
    deadTime: document.getElementById('dead-time'), deadWhy: document.getElementById('dead-why'), wonTime: document.getElementById('won-time'),
  };
  function hudMsg(text, secs) { G.msg = text; G.msgT = secs; hud.msg.textContent = text; }
  const fmtTime = (s) => [s / 3600, (s / 60) % 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':');
  let fpsAcc = 0, fpsN = 0;
  function updateHud(dt) {
    hud.root.classList.toggle('hidden', G.state !== 'play' && G.state !== 'caught' && G.state !== 'drowning');
    if (IS_TOUCH) touchUI.classList.toggle('hidden', G.state !== 'play' || G.paused);
    hud.rec.style.visibility = (G.time % 1) < 0.6 ? 'visible' : 'hidden';
    hud.tc.textContent = fmtTime(G.time);
    G.msgT -= dt;
    hud.msg.style.opacity = clamp(G.msgT, 0, 1) * (G.alarm > 0.3 ? (Math.sin(G.time * 30) > 0 ? 1 : 0.4) : 1);
    hud.stam.style.opacity = PL.stamina < 0.99 ? 1 : 0;
    hud.stamBar.style.width = (PL.stamina * 100).toFixed(1) + '%';
    hud.stamBar.classList.toggle('tired', PL.tired);
    hud.batt.style.opacity = PL.torch || PL.battery < 0.99 ? 1 : 0;
    hud.battBar.style.width = (PL.battery * 100).toFixed(1) + '%';
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5 && SHOW_FPS) {
      hud.fps.textContent = `${(fpsN / fpsAcc).toFixed(0)} fps` + (R.hasTS ? ` gpu ${R.gpuMs.toFixed(1)} ms` : '');
      fpsAcc = 0; fpsN = 0;
    }
  }

  // --------------------------------------------------------------------------------------
  // Lamps
  // --------------------------------------------------------------------------------------
  // a lamp protects you while it is alive; its flickering is only for show
  const lampAlive = (k) => S.lamps[k].kind !== 'dead' && lampBurst[k] <= 0 && G.power > 0.5;
  const lampSafe = (x, z, r) => {
    for (let k = 0; k < S.lamps.length; k++) {
      const L = S.lamps[k];
      if (lampAlive(k) && Math.hypot(L.x - x, L.z - z) < r) return k;
    }
    return -1;
  };
  const lampOrder = new Uint16Array(1024), lampDist = new Float32Array(1024);
  function updateLamps(dt) {
    const t = G.time;
    G.power += (G.powerTarget - G.power) * Math.min(1, dt * (G.powerTarget < G.power ? 9 : 30));
    G.alarm += ((E.mode === 'hunt' ? 0.9 : E.mode === 'caught' ? 0.5 : 0) - G.alarm) * Math.min(1, dt * 2);
    const tick = Math.floor(t * 13);
    const entNear = E.mode !== 'away' || E.vanishT > 0;
    const siren = 1 - G.alarm * (0.45 + 0.2 * Math.sin(t * 5.5));
    let hum = 0, buzz = 0;
    const n = S.lamps.length;
    for (let k = 0; k < n; k++) {
      const L = S.lamps[k];
      let v = 0, flick = 0;
      if (L.kind === 'on') v = L.base;
      else if (L.kind === 'flicker') {
        const nn = Math.sin(t * 1.7 + L.phase) * Math.sin(t * 0.63 + L.phase * 2.1);
        v = L.base;
        if (nn > 0.3) { flick = 1; v = Math.sin(t * 57 + L.phase) * Math.sin(t * 23 + L.phase) > -0.2 ? L.base : 0.05; }
      }
      if (lampBurst[k] > 0) {
        lampBurst[k] -= dt;
        v = lampBurst[k] > 0.05 ? 2 : (hash7(k, tick) > 0.5 ? 1 : 0);
        flick = 1;
      }
      // a lamp under siege stutters more and more before it gives out
      if (lampDrain[k] > 0 && v > 0 && hash7(k + 7, tick) < lampDrain[k] / 9) { v *= 0.1; flick = 1; }
      if (entNear && v > 0) {
        const d = Math.hypot(L.x - E.x, L.z - E.z);
        if (d < 6 && hash7(k, tick) < 0.55 * (1 - d / 6)) { v *= 0.05; flick = 1; }
      }
      if (deep.on && v > 0) {
        const d = Math.hypot(L.x - deep.x, L.z - deep.z);
        if (d < 14 && hash7(k + 3, tick) < 0.35 * (1 - d / 14)) { v *= 0.1; flick = 1; }
      }
      v *= G.power;
      lampVal[k] = v;
      const I = v * SEA_TUNE.lampPower * siren;
      if (k < MAX_GLOW) {
        glowData[k * 4] = I; glowData[k * 4 + 1] = I * (0.93 - 0.87 * G.alarm); glowData[k * 4 + 2] = I * (0.74 - 0.72 * G.alarm);
      }
      const d = Math.hypot(L.x - PL.x, L.z - PL.z);
      lampOrder[k] = k; lampDist[k] = d;
      if (d < 5) { hum += v * (1 - d / 5); buzz += flick * (1 - d / 5); }
    }
    device.queue.writeBuffer(glowBuf, 0, glowData, 0, Math.min(n, MAX_GLOW) * 4);
    // only the nearest lamps light the scene (lamps reach 16 m; there can be many more of them)
    const order = lampOrder.subarray(0, n);
    order.sort((a, b) => lampDist[a] - lampDist[b]);
    const nLit = Math.min(n, MAX_LAMPS - 1, Q.litLamps);
    for (let m = 0; m < nLit; m++) {
      const k = order[m], L = S.lamps[k], o = EX_LAMPS + m * 8;
      extra[o] = L.x; extra[o + 1] = L.y; extra[o + 2] = L.z; extra[o + 3] = 16;
      extra[o + 4] = glowData[k * 4]; extra[o + 5] = glowData[k * 4 + 1]; extra[o + 6] = glowData[k * 4 + 2]; extra[o + 7] = 0;
    }
    // red emergency light over the exit stays on through everything
    const o = EX_LAMPS + nLit * 8;
    extra[o] = S.exit.signX; extra[o + 1] = S.exit.signY; extra[o + 2] = S.exit.signZ; extra[o + 3] = 18;
    extra[o + 4] = SEA_TUNE.exitPower; extra[o + 5] = SEA_TUNE.exitPower * 0.04; extra[o + 6] = SEA_TUNE.exitPower * 0.015; extra[o + 7] = 0;
    extra[0] = nLit + 1;
    G.hum = hum; G.buzz = Math.min(1, buzz);
  }
  function burstLamp(k) {
    if (SHOT) rendererLog(`t=${G.time.toFixed(1)} lamp ${k} bursts (drain ${lampDrain[k].toFixed(1)})`);
    S.lamps[k].kind = 'dead';
    lampBurst[k] = 0.35;
    lampDrain[k] = 0;
    audio.pop(S.lamps[k].x, S.lamps[k].z);
    G.glitch = Math.max(G.glitch, 0.3);
  }

  // --------------------------------------------------------------------------------------
  // Sea state: the storm builds and the sun goes down
  // --------------------------------------------------------------------------------------
  function updateSea(dt) {
    const want = Math.min(1, ESC.stormBase + clamp(G.time / 260, 0, 1) * 0.75 + (E.mode === 'hunt' ? 0.25 : 0));
    G.storm += (want - G.storm) * Math.min(1, dt * 0.3);
    G.specT -= dt;
    const hs = 0.5 + 0.9 * G.storm, ws = 4.5 + 5 * G.storm;
    if (G.specT <= 0 && (Math.abs(hs - P7.swellHs) > 0.01 || Math.abs(ws - P7.windSpeed) > 0.05)) {
      P7.swellHs = hs; P7.windSpeed = ws;
      R.invalidate('spectrum');
      G.specT = 0.5;
    }
    if (!qs.has('sunElev')) P7.sunElev = ESC.sunStart - (ESC.sunStart + 1.2) * clamp(G.time / ESC.nightfall, 0, 1);
    const prevSun = G.sun;
    G.sun += (G.sunTarget - G.sun) * Math.min(1, dt * (G.sunTarget < G.sun ? 8 : 25));
    P7.sunScale = G.sun;
    if (Math.abs(prevSun - G.sun) > 0.002) R.invalidate('env');
    audio.setSea(0.45 + 0.55 * G.storm);

    // the thing beneath
    if (deep.on) {
      deep.t += dt;
      if (deep.hunting) {
        // it has noticed you in the water: it turns toward you
        const tx = PL.x - deep.x, tz = PL.z - deep.z, tl = Math.hypot(tx, tz) || 1;
        const k = Math.min(1, dt * 0.8);
        deep.dx += (tx / tl - deep.dx) * k; deep.dz += (tz / tl - deep.dz) * k;
        const dl = Math.hypot(deep.dx, deep.dz) || 1;
        deep.dx /= dl; deep.dz /= dl;
        if (PL.mode !== 'swim') { deep.hunting = false; deep.t = Math.max(deep.t, deep.dur * 0.55); }
      }
      deep.x += deep.dx * deep.speed * dt; deep.z += deep.dz * deep.speed * dt;
      const k = Math.sin(Math.PI * clamp(deep.t / deep.dur, 0, 1));
      extra[4] = deep.x; extra[5] = deep.z; extra[6] = 17; extra[7] = 0.9 * k;
      extra[8] = deep.dx; extra[9] = deep.dz; extra[10] = 5.5;
      if (deep.t > deep.dur * 0.45 && deep.t - dt <= deep.dur * 0.45) audio.groan(deep.x, deep.z);
      if (deep.t > deep.dur) { deep.on = false; extra[7] = 0; }
    }
  }

  // --------------------------------------------------------------------------------------
  // Ripples on the water (splashes, strokes, footsteps in the sea)
  // --------------------------------------------------------------------------------------
  const ripples = [];
  function ripple(x, z, strength) {
    ripples.push({ x, z, t: 0, s: strength });
    if (ripples.length > MAX_RIPPLES) ripples.shift();
  }
  function writeRipples(dt) {
    for (let i = ripples.length - 1; i >= 0; i--) { ripples[i].t += dt; if (ripples[i].t > 4) ripples.splice(i, 1); }
    ripples.forEach((r, n) => {
      const o = EX_RIPPLES + n * 4;
      extra[o] = r.x; extra[o + 1] = r.z; extra[o + 2] = r.t; extra[o + 3] = r.s;
    });
    extra[1] = ripples.length;
  }

  // --------------------------------------------------------------------------------------
  // Player: walk, run and jump on the walkway; fall; swim; climb back out
  // --------------------------------------------------------------------------------------
  const EYE = 1.62;           // eye height above the feet when standing
  const SWIM_EYE = 0.17;      // eye height above the water when swimming
  const GRAV = 9.8;
  const waterAtPlayer = () => R.heights[1];   // measured wave height under the player

  function updatePlayer(dt) {
    const control = G.state === 'play';
    let f = control ? (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) : 0;
    let s = control ? (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) : 0;
    const stick = Math.hypot(TS.mx, TS.my);
    if (control && stick > 0.2) { f = -TS.my; s = TS.mx; }
    const len = Math.hypot(f, s) || 1;
    const want = (f || s) ? 1 : 0;
    const shift = keys.ShiftLeft || keys.ShiftRight || stick > 0.92;
    const space = control && keys.Space;
    if (!space) PL.jumpHeld = false;
    const sy = Math.sin(PL.yaw), cy = Math.cos(PL.yaw);
    const dx = (f * sy + s * cy) / len * want, dz = (-f * cy + s * sy) / len * want;
    PL.dip = Math.max(0, PL.dip - dt * 1.5);

    if (PL.torch) {
      PL.battery = Math.max(0, PL.battery - dt / 160);
      if (PL.battery <= 0) { PL.torch = false; audio.clunk(0.25); hudMsg('The battery is dead', 3); }
    } else PL.battery = Math.min(1, PL.battery + dt / 400);

    if (PL.mode === 'climb') {
      // hauling yourself up over the edge of a slab
      PL.climbT = Math.min(1, PL.climbT + dt / 0.8);
      const e = PL.climbT * PL.climbT * (3 - 2 * PL.climbT);
      PL.x = PL.cx0 + (PL.cx1 - PL.cx0) * e; PL.z = PL.cz0 + (PL.cz1 - PL.cz0) * e;
      PL.feetY = PL.cy0 + (SLAB_TOP - PL.cy0) * Math.min(1, e * 1.3);
      PL.vx = PL.vz = 0;
      if (PL.climbT >= 1) { PL.mode = 'ground'; PL.feetY = SLAB_TOP; audio.step(false); }
      return;
    }

    if (PL.mode === 'swim') {
      const wh = waterAtPlayer();
      const fast = want && shift && PL.stamina > 0.05;
      const speed = (fast ? SEA_TUNE.swim * 1.6 : SEA_TUNE.swim) * (PL.stamina > 0 ? 1 : 0.4);
      const a = Math.min(1, dt * 2.5);                 // water drag: slow to start and stop
      PL.vx += (dx * speed - PL.vx) * a; PL.vz += (dz * speed - PL.vz) * a;
      PL.x += PL.vx * dt; PL.z += PL.vz * dt;
      collideRects(S.waterSolids, PL, 0.32);
      PL.feetY = wh - 1.45;
      PL.swimT += dt;
      PL.stamina = Math.max(0, PL.stamina - dt * (fast ? 1 / 10 : (want ? 1 : 0.5) / SEA_TUNE.swimStamina));
      PL.moving = 0;
      PL.strokeT -= dt;
      if (PL.strokeT <= 0) {
        if (want) { audio.splash(fast ? 0.45 : 0.3); ripple(PL.x, PL.z, fast ? 0.9 : 0.6); PL.strokeT = fast ? 0.45 : 0.7; }
        else { ripple(PL.x, PL.z, 0.25); PL.strokeT = 1.6; }
      }
      // reach a walkway edge and pull yourself up (push toward it, or press Space)
      const rx = PL.x + sy * 0.95, rz = PL.z - cy * 0.95;
      if ((f > 0 || space) && onWalkway(S, rx, rz) && seaLOS(S, PL.x, PL.z, rx, rz)) {
        // land a body's width in from the edge
        const far = onWalkway(S, PL.x + sy * 1.4, PL.z - cy * 1.4) ? 1.4 : 0.95;
        Object.assign(PL, { mode: 'climb', climbT: 0, cx0: PL.x, cz0: PL.z, cy0: PL.feetY, cx1: PL.x + sy * far, cz1: PL.z - cy * far, swimT: 0, sinkT: 0 });
        audio.splash(0.7); ripple(PL.x, PL.z, 1.0);
        return;
      }
      // out of breath: you start going under
      if (PL.stamina <= 0) {
        PL.sinkT += dt;
        G.glitch = Math.max(G.glitch, 0.15 * PL.sinkT);
        if (PL.sinkT > 3.5 && G.state === 'play') drown('THE WATER TOOK YOU');
      } else PL.sinkT = Math.max(0, PL.sinkT - dt);
      return;
    }

    // on the walkway, or in the air above it
    const grounded = PL.mode === 'ground';
    const sprinting = grounded && want && shift && !PL.tired && f >= 0;
    if (grounded) PL.stamina = clamp(PL.stamina + dt * (sprinting ? -1 / SEA_TUNE.staminaS : (want ? 1 / 14 : 1 / 7)), 0, 1);
    if (PL.stamina <= 0) PL.tired = true;
    if (PL.tired && PL.stamina > 0.4) PL.tired = false;
    const speed = sprinting ? SEA_TUNE.sprint : SEA_TUNE.walk * (PL.tired ? 0.8 : 1);
    const a = Math.min(1, dt * (grounded ? 9 : 1.5));   // little steering in mid-air
    PL.vx += (dx * speed - PL.vx) * a; PL.vz += (dz * speed - PL.vz) * a;
    const ox = PL.x, oz = PL.z;
    PL.x += PL.vx * dt; PL.z += PL.vz * dt;
    collideSea(S, PL, 0.28);
    if (grounded && space && !PL.jumpHeld) {
      PL.mode = 'air'; PL.vy = SEA_TUNE.jump; PL.jumpHeld = true;
      PL.stamina = Math.max(0, PL.stamina - 0.04);
    }
    if (PL.mode === 'ground' && !onWalkway(S, PL.x, PL.z)) { PL.mode = 'air'; PL.vy = 0; }

    if (PL.mode === 'air') {
      PL.vy -= GRAV * dt;
      PL.feetY += PL.vy * dt;
      // below the top of the slabs, their sides are walls
      if (PL.feetY < SLAB_TOP - 0.05) collideRects(S.waterSolids, PL, 0.28);
      const over = onWalkway(S, PL.x, PL.z);
      if (over && PL.vy <= 0 && PL.feetY <= SLAB_TOP && PL.feetY > SLAB_TOP - 0.3) {
        PL.mode = 'ground'; PL.feetY = SLAB_TOP;
        PL.dip = Math.min(0.12, -PL.vy * 0.025);
        audio.step(true);
      } else if (!over && PL.feetY <= waterAtPlayer()) {
        // into the sea
        PL.mode = 'swim';
        PL.dip = clamp(-PL.vy * 0.05, 0.08, 0.25);
        PL.vx *= 0.35; PL.vz *= 0.35; PL.vy = 0;
        PL.swimT = 0; PL.strokeT = 0.8;
        audio.splash(1.5);
        ripple(PL.x, PL.z, 2.4);
        if (!G.swimHint) { G.swimHint = true; hudMsg('Swim back to the walkway', 3.5); }
      }
      return;
    }

    const moved = Math.hypot(PL.x - ox, PL.z - oz);
    PL.moving += ((moved / Math.max(dt, 1e-4) > 0.3 ? 1 : 0) - PL.moving) * Math.min(1, dt * 6);
    const before = Math.floor(PL.bob / Math.PI);
    PL.bob += moved * (sprinting ? 2.3 : 2.8);
    if (Math.floor(PL.bob / Math.PI) !== before) audio.step(sprinting);
  }

  // --------------------------------------------------------------------------------------
  // Entity and director
  // --------------------------------------------------------------------------------------
  const viewDir = () => [Math.sin(PL.yaw), -Math.cos(PL.yaw)];
  const entDist = () => Math.hypot(E.x - PL.x, E.z - PL.z);
  function inView(x, z, cosLimit) {
    const dx = x - PL.x, dz = z - PL.z, d = Math.hypot(dx, dz) || 1;
    const [vx, vz] = viewDir();
    return (dx * vx + dz * vz) / d * Math.cos(PL.pitch) > cosLimit;
  }
  // where its feet go: the slab, or a little below the measured wave height
  const groundY = (x, z) => (onWalkway(S, x, z) ? SLAB_TOP : R.heights[2] - 0.25);
  // how high its face is above its feet (it grows and hunches deeper down)
  const headH = () => (2.13 - 0.16 * ESC.creep) * (1 + 0.22 * ESC.creep);
  const isIndoors = () => { const c = S.cells.get(Math.floor(PL.x / 2.5) + ',' + Math.floor(PL.z / 2.5)); return !!(c && c.enc); };
  function placeInFront(d) {
    const [vx, vz] = viewDir();
    let dd = d;
    while (dd > 0.6 && !seaLOS(S, PL.x, PL.z, PL.x + vx * (dd + 0.3), PL.z + vz * (dd + 0.3))) dd -= 0.1;
    E.x = PL.x + vx * dd; E.z = PL.z + vz * dd;
    E.y = E.ty = groundY(E.x, E.z);
  }
  function vanish(loud) {
    E.mode = 'away';
    E.vanishT = 0.5;
    audio.whisper(E.x, E.z);
    if (loud) audio.sting(0.55);
    G.glitch = Math.max(G.glitch, loud ? 0.8 : 0.35);
  }
  // somewhere out on the water, preferably where you are not looking
  function pickWaterSpot(minD, maxD, behind) {
    for (let tries = 0; tries < 60; tries++) {
      const a = PL.yaw + (behind ? Math.PI + (rnd() - 0.5) * 3.2 : (rnd() - 0.5) * 6.28);
      const d = minD + rnd() * (maxD - minD);
      const x = PL.x + Math.sin(a) * d, z = PL.z - Math.cos(a) * d;
      if (onWalkway(S, x, z) || !seaLOS(S, PL.x, PL.z, x, z)) continue;
      return [x, z];
    }
    return null;
  }

  function startStalk() {
    const c = pickWaterSpot(18, 34, true);
    if (!c) { next.stalk = G.time + 5; return; }
    [E.x, E.z] = c;
    Object.assign(E, { mode: 'stalk', t: 0, look: 0, seen: false, creep: 0, glow: 0.8, raise: 0, twitch: 0, y: -0.25, ty: -0.25, sink: false });
  }
  function startHunt() {
    const c = pickWaterSpot(24, 34, true);
    if (!c) { next.hunt = G.time + 8; return; }
    [E.x, E.z] = c;
    Object.assign(E, { mode: 'hunt', t: 0, stepT: 1.2, glow: 1, raise: 0.15, twitch: 0.25, y: -2.6, ty: -0.25, sink: false });
    audio.roar(E.x, E.z);
    G.glitch = 0.6;
    hudMsg('STAY IN THE LIGHT', 4);
  }
  function startBlackout() {
    Object.assign(E, { mode: 'blackout', t: 0, glow: 0, raise: 0, twitch: 0 });
    G.powerTarget = 0; G.sunTarget = 0.035;
    audio.powerDown();
  }
  function startRise(x, z) {
    Object.assign(E, { mode: 'rise', t: 0, x, z, y: -2.4, ty: -0.3, glow: 1.4, raise: 0.4, twitch: 1, sink: false });
    ripple(x, z, 2.2);
    G.flash = 0.6; G.shake = 0.5; G.glitch = 0.9;
    audio.sting(1);
  }
  function startDeep() {
    // cross beneath the walkway near the player, from one side to the other
    const a = rnd() * Math.PI * 2;
    deep.dx = Math.cos(a); deep.dz = Math.sin(a);
    deep.x = PL.x - deep.dx * 48 + (rnd() - 0.5) * 8; deep.z = PL.z - deep.dz * 48 + (rnd() - 0.5) * 8;
    deep.t = 0; deep.dur = 96 / 3.6; deep.on = true; deep.speed = 3.6; deep.hunting = false;
    audio.groan(deep.x + deep.dx * 20, deep.z + deep.dz * 20);
  }
  // something under the water has noticed a swimmer
  function startDeepHunt() {
    const a = rnd() * Math.PI * 2;
    deep.x = PL.x + Math.cos(a) * 32; deep.z = PL.z + Math.sin(a) * 32;
    deep.dx = -Math.cos(a); deep.dz = -Math.sin(a);
    deep.t = 0; deep.dur = 40; deep.on = true; deep.speed = 4.2; deep.hunting = true;
    audio.groan(deep.x, deep.z);
    hudMsg('GET OUT OF THE WATER', 3.5);
  }
  // (descent 2+) close behind you; turn around in time and it is right there
  function startBehind() {
    const [vx, vz] = viewDir();
    const x = PL.x - vx * 1.7, z = PL.z - vz * 1.7;
    if (!seaLOS(S, PL.x, PL.z, x, z)) return false;
    Object.assign(E, { mode: 'behind', t: 0, x, z, glow: 1.2, raise: 0.25, twitch: 0.7, sink: false });
    E.y = E.ty = Math.min(groundY(x, z), PL.eyeY - headH() + 0.12);   // leaning in close
    audio.whisper(x, z);
    return true;
  }
  // (descent 2+) it sprints across your path a few metres ahead
  function startCross() {
    const [vx, vz] = viewDir();
    const d = 6 + rnd() * 3;
    const ax = PL.x + vx * d, az = PL.z + vz * d;
    if (!seaLOS(S, PL.x, PL.z, ax, az)) return false;
    const side = rnd() < 0.5 ? 1 : -1;
    const px = -vz * side, pz = vx * side;
    // only where it can actually run across: no walls along its line
    if (!seaLOS(S, ax - px * 5, az - pz * 5, ax + px * 5, az + pz * 5)) return false;
    Object.assign(E, { mode: 'cross', t: 0, x: ax - px * 5, z: az - pz * 5, vx: px * 10, vz: pz * 10, glow: 1, raise: 0.1, twitch: 0.5, sink: false, stepT: 0 });
    E.y = E.ty = groundY(E.x, E.z);
    return true;
  }
  // (descent 3+) indoors: its face at a window you are looking toward, from the sea side
  function startWindow() {
    if (!isIndoors()) return false;
    for (const w of S.windows) {
      const d = Math.hypot(w.x - PL.x, w.z - PL.z);
      if (d < 1.0 || d > 4.5 || !inView(w.x, w.z, 0.55)) continue;
      const x = w.x + w.ox * 0.45, z = w.z + w.oz * 0.45;
      Object.assign(E, { mode: 'window', t: 0, x, z, glow: 1.3, raise: 0.6, twitch: 1, sink: false, look: 0 });
      E.y = E.ty = SLAB_TOP + 1.55 - headH();
      audio.dread();
      return true;
    }
    return false;
  }
  // (descent 2+) a false EXIT: it was waiting behind the door
  function triggerFake(f) {
    const dx = PL.x - f.x, dz = PL.z - f.z, d = Math.hypot(dx, dz) || 1;
    Object.assign(E, { mode: 'fake', t: 0, x: f.x + dx / d * 0.2, z: f.z + dz / d * 0.2, glow: 1.6, raise: 0.9, twitch: 1, sink: false });
    E.y = E.ty = PL.eyeY - headH() + 0.05;      // stooped right down to your eyes
    G.flash = 1; G.shake = 0.8; G.glitch = 1;
    audio.clunk(1); audio.sting(1.2);
    hudMsg('NOT THIS ONE', 3);
    // the door and its sign are gone; the wall stays
    for (let k = f.boxes[1] - 2; k < f.boxes[1]; k++) { const o = k * 8; boxData[o + 4] = boxData[o + 5] = boxData[o + 6] = 0; }
    device.queue.writeBuffer(boxBuf, (f.boxes[1] - 2) * 32, boxData, (f.boxes[1] - 2) * 8, 16);
  }
  function caught() {
    G.state = 'caught';
    E.mode = 'caught'; E.t = 0;
    const dx = E.x - PL.x, dz = E.z - PL.z, d = Math.hypot(dx, dz) || 1;
    PL.targetYaw = Math.atan2(dx, -dz);
    E.x = PL.x + dx / d * 0.55; E.z = PL.z + dz / d * 0.55;
    Object.assign(E, { y: PL.eyeY - headH() + 0.03, ty: PL.eyeY - headH() + 0.03, glow: 1.6, raise: 1, twitch: 1 });
    G.powerTarget = 1; G.sunTarget = 1;
    G.flash = 1; G.shake = 1; G.glitch = 1;
    audio.scream();
  }
  function drown(why = 'THE WATER TOOK YOU') {
    G.state = 'drowning';
    G.endT = 0;
    G.drownWhy = why;
    PL.mode = 'swim';
    E.mode = 'drown'; E.t = 0;
    const [vx, vz] = viewDir();
    E.x = PL.x + vx * 1.5; E.z = PL.z + vz * 1.5;
    PL.targetYaw = PL.yaw;
    Object.assign(E, { y: -2.6, ty: -1.6, glow: 1.5, raise: 0.3, twitch: 1, sink: false });
    audio.splash(1.6);
  }
  function die(why) {
    G.state = 'dead'; G.endT = 0;
    hud.deadTime.textContent = fmtTime(G.time);
    hud.deadWhy.textContent = why;
    // the last descent has to be escaped: being caught there starts it again
    document.getElementById('dead-go').textContent = (IS_TOUCH ? 'TAP' : 'CLICK') + (depth === FINAL_DESCENT ? ' TO TRY THE LAST DESCENT AGAIN' : ' TO GO DEEPER');
    audio.setMuffled(true);
    if (document.pointerLockElement) document.exitPointerLock();
    showScreen('dead');
  }

  let lastMode = '', lastMove = '', prevMode = 'away';
  function updateDirector(dt) {
    const t = G.time;
    if (SHOT && PL.mode !== lastMove) {
      rendererLog(`t=${t.toFixed(2)} player ${lastMove || '-'} -> ${PL.mode} at ${PL.x.toFixed(2)},${PL.z.toFixed(2)} feet=${PL.feetY.toFixed(2)} water=${R.heights[1].toFixed(2)}`);
      lastMove = PL.mode;
    }
    if (SHOT && E.mode !== lastMode) { rendererLog(`t=${t.toFixed(1)} entity ${lastMode || '-'} -> ${E.mode}`); lastMode = E.mode; }
    if (E.vanishT > 0) E.vanishT -= dt;
    const pc = ESC.pace;
    // a breath between scares: they land harder after a moment of quiet
    if (E.mode === 'away' && prevMode !== 'away') G.calmUntil = t + 6 * pc;
    prevMode = E.mode;
    if (E.mode === 'away' && G.state === 'play' && t > (G.calmUntil || 0)) {
      if (t > next.blackout) { startBlackout(); next.blackout = t + (160 + rnd() * 90) * pc; }
      else if (t > next.hunt) startHunt();
      else if (t > next.window && startWindow()) next.window = t + (25 + rnd() * 15) * pc;
      else if (t > next.behind && PL.mode === 'ground') next.behind = startBehind() ? t + (28 + rnd() * 20) * pc : t + 3;
      else if (t > next.cross && PL.mode === 'ground') next.cross = startCross() ? t + (35 + rnd() * 20) * pc : t + 3;
      else if (t > next.stalk) startStalk();
    }
    if (!deep.on && t > next.deep && G.state === 'play' && PL.mode !== 'swim') { startDeep(); next.deep = t + (70 + rnd() * 50) * pc; }
    if (PL.mode === 'swim' && G.state === 'play') {
      if (PL.swimT > 6 && !(deep.on && deep.hunting)) startDeepHunt();
      if (deep.on && deep.hunting && Math.hypot(deep.x - PL.x, deep.z - PL.z) < 2.5) drown('SOMETHING PULLED YOU UNDER');
    }
    if (t > next.burst && E.mode !== 'blackout') {
      next.burst = t + (30 + rnd() * 25) * pc;
      const cand = [];
      for (let k = 0; k < S.lamps.length; k++) {
        const d = Math.hypot(S.lamps[k].x - PL.x, S.lamps[k].z - PL.z);
        if (S.lamps[k].kind === 'on' && d > 2.5 && d < 14) cand.push(k);
      }
      if (cand.length) burstLamp(cand[Math.floor(rnd() * cand.length)]);
    }
    // looking down over the edge for too long
    if (E.mode === 'away' && G.state === 'play' && PL.mode === 'ground' && t > next.rise) {
      const [vx, vz] = viewDir();
      const ex = PL.x + vx * 1.4, ez = PL.z + vz * 1.4;
      if (PL.pitch < -0.35 && !onWalkway(S, ex, ez) && seaLOS(S, PL.x, PL.z, ex, ez)) {
        G.lookDown += dt;
        if (G.lookDown > 1.3) { startRise(ex, ez); next.rise = t + 75; G.lookDown = 0; }
      } else G.lookDown = Math.max(0, G.lookDown - dt);
    }

    E.t += dt;
    E.face = Math.atan2(PL.x - E.x, PL.z - E.z);
    E.y += (E.ty - E.y) * Math.min(1, dt * (E.mode === 'rise' ? 7 : 2.2));
    if (E.mode === 'stalk') {
      const d = entDist();
      const seenNow = seaLOS(S, PL.x, PL.z, E.x, E.z) && inView(E.x, E.z, Math.cos(30 * D2R)) && E.y > -1;
      if (!E.sink) E.ty = groundY(E.x, E.z);
      if (E.sink) {
        E.ty = -3;
        if (E.y < -2.6) { E.mode = 'away'; next.stalk = t + (20 + rnd() * 16) * pc; }
      } else if (seenNow) {
        E.look += dt; E.creep = 0;
        if (!E.seen && E.look > 0.06) { E.seen = true; audio.dread(); G.glitch = Math.max(G.glitch, 0.25); }
        if (d < 7) { vanish(true); next.stalk = t + (20 + rnd() * 16) * pc; }
        else if (E.look > 1.3) { E.sink = true; audio.whisper(E.x, E.z); }
      } else if (E.seen) {
        // it only comes closer while you are not looking
        E.creep += dt;
        if (E.creep > 1.6) {
          E.creep = 0;
          const nd = Math.max(5.5, d * 0.7);
          const nx = PL.x + (E.x - PL.x) / d * nd, nz = PL.z + (E.z - PL.z) / d * nd;
          if (!onWalkway(S, nx, nz)) { E.x = nx; E.z = nz; }
        }
        if (E.t > 45) { E.sink = true; }
      } else if (E.t > 25) { E.mode = 'away'; next.stalk = t + 15; }
    } else if (E.mode === 'hunt') {
      const d = entDist();
      if (E.t < 1.6) {
        E.ty = groundY(E.x, E.z);                       // rising out of the sea
        if (E.t - dt <= 0) ripple(E.x, E.z, 1.6);
      } else {
        const speed = 2.5 + (ESC.entSpeed - 2.5) * Math.min(1, (E.t - 1.6) / 6);
        const vx = PL.x - E.x, vz = PL.z - E.z, vl = Math.hypot(vx, vz) || 1;
        E.x += vx / vl * Math.min(vl, speed * dt);
        E.z += vz / vl * Math.min(vl, speed * dt);
        // it will not step into a working light
        let held = -1;
        for (let k = 0; k < S.lamps.length; k++) {
          if (!lampAlive(k)) continue;
          const L = S.lamps[k];
          const lx = E.x - L.x, lz = E.z - L.z, ld = Math.hypot(lx, lz);
          if (ld < SEA_TUNE.safeR) { E.x = L.x + lx / (ld || 1) * SEA_TUNE.safeR; E.z = L.z + lz / (ld || 1) * SEA_TUNE.safeR; held = k; }
        }
        // ...but the light you are hiding under starts to fail
        const safeK = lampSafe(PL.x, PL.z, SEA_TUNE.safeR - 0.3);
        if (safeK >= 0 && held === safeK) {
          lampDrain[safeK] += dt;
          if (lampDrain[safeK] > ESC.drain) { burstLamp(safeK); hudMsg('MOVE', 2.5); }
        }
        E.ty = groundY(E.x, E.z);
        E.stepT -= dt;
        if (E.stepT <= 0 && held < 0) {
          if (onWalkway(S, E.x, E.z)) audio.entStep(E.x, E.z); else { audio.splash(0.5); ripple(E.x, E.z, 0.8); }
          E.stepT = 0.42 * ESC.entSpeed / speed;
        }
      }
      if (d < 0.85 && E.t > 1.6) caught();
      else if (E.t > ESC.huntLen) {
        E.mode = 'sinking'; E.ty = -3;
        audio.whisper(E.x, E.z);
        next.hunt = t + (80 + rnd() * 40) * pc; next.stalk = t + (18 + rnd() * 10) * pc;
        hudMsg('...it went back under', 3);
        lampDrain.fill(0);
      }
    } else if (E.mode === 'sinking') {
      if (E.y < -2.6) E.mode = 'away';
    } else if (E.mode === 'blackout') {
      if (E.t > 0.9 && E.t - dt <= 0.9) { placeInFront(3.4); E.glow = 0.5; }
      if (E.t > 2.2 && E.t - dt <= 2.2) {
        G.powerTarget = 1; G.power = 1.2; G.sunTarget = 1; G.sun = 1;
        R.invalidate('env');
        placeInFront(1.25);
        E.glow = 1.4; E.raise = 0.55; E.twitch = 1;
        G.flash = 1; G.shake = 0.7; G.glitch = 1;
        audio.clunk(1); audio.sting(1);
      }
      if (E.t > 2.95) {
        vanish(false);
        next.hunt = Math.min(next.hunt, t + 22 + rnd() * 10);
        next.stalk = Math.max(next.stalk, t + 12);
      }
    } else if (E.mode === 'behind') {
      if (E.t > 0.2 && inView(E.x, E.z, 0.55)) {
        Object.assign(E, { mode: 'behindSeen', t: 0, glow: 1.6, raise: 0.7, twitch: 1 });
        G.flash = 0.8; G.shake = 0.6; G.glitch = 1;
        audio.sting(1);
      } else if (E.t > 5) { E.mode = 'away'; E.vanishT = 0.3; }
    } else if (E.mode === 'behindSeen') {
      if (E.t > 0.45) vanish(false);
    } else if (E.mode === 'cross') {
      E.x += E.vx * dt; E.z += E.vz * dt;
      E.ty = groundY(E.x, E.z);
      E.face = Math.atan2(E.vx, E.vz);
      E.stepT -= dt;
      if (E.stepT <= 0) {
        if (onWalkway(S, E.x, E.z)) audio.entStep(E.x, E.z); else { audio.splash(0.4); ripple(E.x, E.z, 0.7); }
        E.stepT = 0.16;
      }
      if (E.t > 0.45 && E.t - dt <= 0.45) { audio.sting(0.5); G.glitch = Math.max(G.glitch, 0.5); }
      if (E.t > 1.0) E.mode = 'away';
    } else if (E.mode === 'window') {
      if (inView(E.x, E.z, 0.8)) E.look += dt;
      if (E.look > 0.25) {
        // it slams against the opening
        Object.assign(E, { mode: 'windowSeen', t: 0, raise: 0.95, glow: 1.6 });
        G.flash = 0.7; G.shake = 0.5; G.glitch = 0.9;
        audio.clunk(1); audio.sting(1);
      } else if (E.t > 6) E.mode = 'away';
    } else if (E.mode === 'windowSeen' || E.mode === 'fake') {
      if (E.t > (E.mode === 'fake' ? 0.9 : 0.7)) vanish(false);
    } else if (E.mode === 'rise') {
      if (E.t > 1.1) { E.ty = -3; E.mode = 'sinking'; audio.whisper(E.x, E.z); }
    } else if (E.mode === 'caught') {
      if (E.t > 1.7 && G.state === 'caught') die('IT FOUND YOU');
    } else if (E.mode === 'drown') {
      // you go in; it is waiting
      if (E.t > 0.35 && E.t - dt <= 0.35) { E.ty = R.waterH + 0.38 - headH(); G.flash = 1; G.shake = 1; G.glitch = 1; audio.scream(); }
      if (E.t > 1.1) G.fade = Math.max(0, 1 - (E.t - 1.1) * 1.4);
      if (E.t > 2.0 && G.state === 'drowning') die(G.drownWhy);
    }

    // false exits
    if (G.state === 'play' && (E.mode === 'away' || E.mode === 'stalk')) {
      for (let i = 0; i < fakeLeft.length; i++) {
        if (Math.hypot(PL.x - fakeLeft[i].x, PL.z - fakeLeft[i].z) < 1.3) { triggerFake(fakeLeft.splice(i, 1)[0]); break; }
      }
    }

    if (G.state === 'play' && Math.hypot(PL.x - S.exit.x, PL.z - S.exit.z) < 0.8) {
      const last = depth === FINAL_DESCENT;
      G.state = last ? 'finished' : 'won'; G.endT = 0;
      E.mode = 'away';
      hud.wonTime.textContent = fmtTime(G.time);
      document.getElementById('won-time-fin').textContent = fmtTime(G.time);
      audio.clunk(1);
      audio.setMuffled(true);
      if (document.pointerLockElement) document.exitPointerLock();
      showScreen(last ? 'finished' : 'won');
    }
  }

  // --------------------------------------------------------------------------------------
  // Frame
  // --------------------------------------------------------------------------------------
  let clock = 0;
  fillComp = (c, fi) => {
    const hunting = E.mode === 'hunt' ? 1 : 0;
    c[0] = P7.exposure; c[1] = P7.bloom; c[2] = fi % 64; c[3] = 0.38 + 0.2 * hunting;
    c[4] = G.flash; c[5] = 0.003 + 0.003 * hunting; c[6] = 0.06 + 0.05 * G.glitch; c[7] = G.fade;
    c[8] = -0.08; c[9] = clock; c[10] = G.glitch; c[11] = G.alarm * 0.12;
  };

  const forced = qs.get('event');
  const forcedAt = Number(qs.get('eventAt')) || 0;
  let forcedDone = !forced;
  let frameIndex = 0;
  let last = performance.now();
  const fixedDt = SHOT ? 1 / 60 : 0;

  // dynamic resolution: every 1.5 s, step the render scale toward a steady ~45-58 fps
  const GOVERN = !SHOT && !fw && !qs.has('scale');
  let govT = 0, govN = 0, govSkip = 2;
  function govern(rawDt) {
    if (!GOVERN || G.paused || document.hidden) return;
    govT += rawDt; govN++;
    if (govT < 1.5) return;
    const ms = govT / govN * 1000;
    govT = 0; govN = 0;
    if (govSkip > 0) { govSkip--; return; }          // let shaders and level settle first
    let next = renderScale;
    if (ms > 22) next = Math.max(Q.minScale, renderScale * (ms > 30 ? 0.8 : 0.9));
    else if (ms < 17 && renderScale < Q.maxScale) next = Math.min(Q.maxScale, renderScale * 1.08);
    if (Math.abs(next - renderScale) > 0.005) renderScale = next;
  }

  function frame(now) {
    govern(Math.min(0.25, (now - last) / 1000));
    let dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (fixedDt) dt = fixedDt;
    clock += dt;
    frameIndex++;
    const live = G.state === 'play' || G.state === 'caught' || G.state === 'drowning';
    if (!G.paused && live) {
      G.time += dt;
      if (!forcedDone && G.time >= forcedAt) {
        forcedDone = true;
        if (forced === 'stalk') startStalk();
        else if (forced === 'hunt') startHunt();
        else if (forced === 'blackout') startBlackout();
        else if (forced === 'deep') startDeep();
        else if (forced === 'caught') { placeInFront(1.2); caught(); }
        else if (forced === 'drown') drown();
        else if (forced === 'rise') { const [vx, vz] = viewDir(); startRise(PL.x + vx * 1.6, PL.z + vz * 1.6); }
        else if (forced === 'behind') startBehind();
        else if (forced === 'cross') startCross();
        else if (forced === 'window') startWindow();
        else if (forced === 'fake' && fakeLeft.length) {
          // stand just inside the trigger distance of a false exit, facing it
          const f = fakeLeft[0];
          PL.x = f.x + f.nx * 1.25; PL.z = f.z + f.nz * 1.25; PL.yaw = Math.atan2(-f.nx, f.nz); PL.pitch = 0;
        }
        else if (forced === 'pose') { placeInFront(Number(qs.get('dist')) || 4); Object.assign(E, { mode: 'pose', t: 0, glow: 1 }); }
      }
      updatePlayer(dt);
      updateDirector(dt);
      if ((G.state === 'caught' || G.state === 'drowning') && E.mode !== 'away') {
        let dy = PL.targetYaw - PL.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        PL.yaw += dy * Math.min(1, dt * 18);
        PL.pitch += ((G.state === 'drowning' ? -0.22 : 0.02) - PL.pitch) * Math.min(1, dt * 10);
      }
    }
    if (G.state === 'dead' || G.state === 'won' || G.state === 'finished') { G.endT += dt; G.fade = Math.max(0, G.fade - dt * 1.5); }
    else if (G.state !== 'drowning') G.fade = Math.min(1, G.fade + dt * 2);
    G.flash = Math.max(0, G.flash - dt * 2.0);
    G.glitch = Math.max(0, G.glitch - dt * 1.4);
    G.shake = Math.max(0, G.shake - dt * 1.6);
    if (G.state === 'caught' || G.state === 'drowning') G.glitch = Math.max(G.glitch, 0.5);
    updateLamps(dt);
    updateSea(dt);
    if (G.state !== 'title') updateMarks();

    // camera
    const cam = R.cam;
    const sh2 = G.shake * G.shake;
    const wh = waterAtPlayer();
    let eye;
    if (PL.mode === 'swim') {
      // riding the swell; sinking when exhausted or being pulled down
      const sinking = G.state === 'drowning' ? Math.min(1, E.t) : clamp(PL.sinkT / 3.5, 0, 1);
      eye = wh + SWIM_EYE * (1 - 0.7 * sinking) + Math.sin(clock * 1.9) * 0.025;
    } else if (PL.mode === 'climb') {
      eye = Math.max(wh + SWIM_EYE, PL.feetY + EYE);
    } else {
      eye = PL.feetY + EYE + (PL.mode === 'ground' ? Math.sin(PL.bob * 2) * 0.03 * PL.moving : 0);
    }
    eye -= PL.dip;
    PL.eyeY = eye;
    cam.x = PL.x; cam.z = PL.z;
    // never below the surface: the renderer has no underwater view
    cam.y = Math.max(eye, Math.max(wh, R.waterH) + 0.05) + (Math.random() - 0.5) * 0.05 * sh2;
    cam.yaw = PL.yaw + Math.sin(PL.bob) * 0.006 * PL.moving + (Math.random() - 0.5) * 0.06 * sh2;
    cam.pitch = PL.pitch + (Math.random() - 0.5) * 0.06 * sh2;
    cam.fovY = (R.W < R.H ? 82 : 62) * D2R;
    if (G.state === 'title') { cam.yaw += Math.sin(clock * 0.08) * 0.6; cam.pitch = -0.03 + Math.sin(clock * 0.05) * 0.05; }

    // GPU data
    entVisible = E.mode !== 'away' && !(E.mode === 'blackout' && E.t <= 0.9) && E.y > -2.55;
    entData[0] = E.x; entData[1] = E.y; entData[2] = E.z; entData[3] = E.face;
    entData[4] = entVisible ? 1 : 0; entData[5] = E.glow; entData[6] = E.raise; entData[7] = E.twitch;
    entData[8] = ESC.creep; entData[9] = ESC.red;
    device.queue.writeBuffer(entUBO, 0, entData);
    const lowBatt = PL.battery < 0.15 ? (Math.sin(clock * 40) * Math.sin(clock * 13) > 0.2 ? 0.15 : 1) : 1;
    gameData[0] = PL.torch ? SEA_TUNE.torch * lowBatt : 0;
    gameData[4] = clock; gameData[5] = 0; gameData[6] = SLAB_TOP;
    device.queue.writeBuffer(gameUBO, 0, gameData);
    writeRipples(dt);
    extra[2] = 2;                                   // probe points: player, entity
    extra[EX_PROBES] = PL.x; extra[EX_PROBES + 1] = PL.z; extra[EX_PROBES + 2] = E.x; extra[EX_PROBES + 3] = E.z;
    R.writeExtra(extra);

    const heart = E.mode === 'hunt' ? clamp(1.2 - entDist() / 30, 0.35, 1)
      : (deep.on && deep.hunting ? clamp(1.3 - Math.hypot(deep.x - PL.x, deep.z - PL.z) / 30, 0.4, 1)
        : (E.mode === 'stalk' && E.seen ? 0.3 : (deep.on ? 0.25 : (PL.mode === 'swim' ? 0.2 : 0))));
    audio.update(dt, cam, G.state === 'dead' || G.state === 'won' ? 0 : G.hum, G.buzz, G.paused ? 0 : heart);
    updateHud(dt);

    const swapTex = R.render(dt);
    if (SHOT && frameIndex === SHOT_FRAMES) { saveShot(swapTex); return; }
    requestAnimationFrame(frame);
  }

  async function saveShot(swapTex) {
    const blob = await R.capture(swapTex);
    await fetch('/__shot?name=' + encodeURIComponent(SHOT), { method: 'POST', body: blob });
    rendererLog(`shot saved ${SHOT} ${R.W}x${R.H} t=${G.time.toFixed(1)} depth=${depth} state=${G.state} move=${PL.mode} stamina=${PL.stamina.toFixed(2)} entity=${E.mode} at ${PL.x.toFixed(1)},${PL.z.toFixed(1)} waterH=${R.waterH.toFixed(2)}`);
    document.title = 'SHOT DONE';
  }

  if (AUTO && qs.get('audio') === '1') audio = createAudio();
  newRun();
  if (!AUTO) showScreen('title');
  requestAnimationFrame(frame);
}

addEventListener('error', (e) => rendererLog('error: ' + e.message + ' @' + e.lineno));
seaMain().catch((e) => { rendererLog('init failed: ' + (e && e.stack || e)); });
