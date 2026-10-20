// Level 7 generator: a walkway of carpeted floor slabs winding across the open sea toward
// an EXIT door, with the rest of a drowned office poking out of the water around it.
// Everything is an axis-aligned box. The walkway is a set of grid cells; you can stand on a
// cell, and stepping off one means going into the water.
import { STORY, inkStyle, encodeLine } from './story.js';

// small seeded random number generator
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SEA_CELL = 2.5;      // m
export const SLAB_TOP = 0.65;     // walkway surface height above mean sea level (m)
export const ROOM_H = 2.7;        // wall / ceiling height above the walkway (m)
export const WAINSCOT = 0.95;     // height of the panelled lower part of the walls (m)

// box materials (must match level7/shaders.js)
export const M_SLAB = 0, M_WALL = 1, M_PILLAR = 2, M_CEIL = 3, M_FRAME = 4, M_DOOR = 5, M_SIGN = 6;
export const M_POLE = 7, M_LAMP = 8, M_TRIM = 9, M_DECAL = 10;
// landmarks on the horizon (must match level7/shaders.js)
export const LM_SHIP = 0, LM_PLANE = 1, LM_TOWER = 2, LM_HEAD = 3, LM_STATUE = 4, LM_HAND = 5, LM_IDOL = 6;
// trim kinds (box seed for M_TRIM)
const TRIM_BASE = 0, TRIM_CAP = 1;
// lamp post parts (box seed for M_POLE)
const POLE_PLINTH = 0, POLE_SHAFT = 1, POLE_ARM = 2;

// depth: how many times the level has been replayed (1 = first visit). Deeper levels are
// longer and more tangled, have false exits and more failing lamps, and run partly through
// enclosed corridors with windows onto the sea.
export function generateSea(seed, depth = 1) {
  const rnd = mulberry32(seed);
  const C = SEA_CELL;
  const D = Math.max(1, depth);
  const LEN = Math.min(170, 60 + 20 * (D - 1));
  const turnP = Math.min(0.55, 0.28 + 0.05 * (D - 1));
  const roomEvery = Math.max(9, 14 - (D - 1));
  const spurP = Math.min(0.4, 0.12 + 0.05 * (D - 1));
  const spurMax = Math.min(12, 4 + 2 * (D - 1));
  // how much of the walk runs indoors: open the first time, then it varies from run to run
  const enclosedFrac = D === 1 ? 0 : D === 2 ? 0.3 : 0.2 + rnd() * 0.5;
  const deadP = Math.min(0.35, 0.1 + 0.035 * (D - 1));
  const flickerP = Math.min(0.4, 0.12 + 0.04 * (D - 1));
  const lampKind = () => (rnd() < flickerP ? 'flicker' : (rnd() < deadP ? 'dead' : 'on'));
  const cells = new Map();                 // "i,j" -> { i, j, path, enc }
  const key = (i, j) => i + ',' + j;
  const addCell = (i, j, path) => { if (!cells.has(key(i, j))) cells.set(key(i, j), { i, j, path }); };
  const boxes = [];                        // { c: [x,y,z], h: [hx,hy,hz], m, s }
  const lamps = [];                        // { x, y, z, kind, base, phase, box }
  const solids = [];                       // collision AABBs on the walkway: [x0, z0, x1, z1]
  const box = (cx, cy, cz, hx, hy, hz, m, s = rnd()) => { boxes.push({ c: [cx, cy, cz], h: [hx, hy, hz], m, s }); return boxes.length - 1; };
  const solid = (cx, cz, hx, hz) => solids.push([cx - hx, cz - hz, cx + hx, cz + hz]);

  // ---- the path: a self-avoiding walk heading roughly toward -z (into the sunset) ----
  const path = [[0, 0]];
  addCell(0, 0, true);
  let di = 0, dj = -1, i = 0, j = 0, run = 0;
  const rooms = [];
  while (path.length < LEN) {
    // turn sometimes, prefer heading -z
    if (run > 2 && rnd() < turnP) {
      const opts = dj !== 0 ? [[1, 0], [-1, 0]] : [[0, -1], [0, -1], [di, 0]];
      [di, dj] = opts[Math.floor(rnd() * opts.length)];
      run = 0;
    }
    const ni = i + di, nj = j + dj;
    let free = true;
    for (let a = -1; a <= 1 && free; a++) for (let b = -1; b <= 1; b++) {
      if (a === -di && b === -dj) continue;
      const c = cells.get(key(ni + a, nj + b));
      if (c && !(ni + a === i && nj + b === j) && (a === 0 || b === 0)) { free = false; break; }
    }
    if (!free) { [di, dj] = [0, -1]; run = 0; if (cells.has(key(i, j - 1))) break; continue; }
    i = ni; j = nj; run++;
    addCell(i, j, true);
    path.push([i, j]);
    if (path.length % roomEvery === 0 && path.length < LEN - 4) rooms.push([i, j]);
  }
  // rooms: 3x3 platforms along the way
  for (const [ri, rj] of rooms) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) addCell(ri + a, rj + b, false);
  // dead-end spurs branch off sideways; deeper down they are longer and fork
  const freeAt = (a, b, fromA, fromB) => {
    if (cells.has(key(a, b))) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (a + dx === fromA && b + dz === fromB) continue;
      if (cells.has(key(a + dx, b + dz))) return false;
    }
    return true;
  };
  const deadEnds = [];                     // [i, j, di, dj] for long spurs, outward direction
  const spur = (si, sj, sx, sz, len, fork) => {
    let ci = si, cj = sj, n = 0;
    for (let s2 = 1; s2 <= len; s2++) {
      const ni = ci + sx, nj = cj + sz;
      if (!freeAt(ni, nj, ci, cj)) break;
      addCell(ni, nj, false);
      ci = ni; cj = nj; n++;
      if (fork && s2 >= 2 && rnd() < 0.35) { spur(ci, cj, sz, sx, 2 + Math.floor(rnd() * 3), false); fork = false; }
    }
    if (n >= 3) deadEnds.push([ci, cj, sx, sz]);
  };
  for (let k = 4; k < path.length - 6; k++) {
    if (rnd() > spurP) continue;
    const [pi, pj] = path[k], [qi, qj] = path[k + 1];
    const dx = qi - pi, dz = qj - pj;
    const sgn = rnd() < 0.5 ? 1 : -1;
    spur(pi, pj, -dz * sgn, dx * sgn, 2 + Math.floor(rnd() * (spurMax - 1)), D >= 3);
  }
  // exit platform at the end, door on its far side
  const [ei, ej] = path[path.length - 1];
  const [ldi, ldj] = [di, dj];
  const eci = ei + ldi, ecj = ej + ldj;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) addCell(eci + a, ecj + b, false);

  // edges that will carry an exit door (real or false): no ordinary wall goes there
  const reserved = new Set();
  const edgeKey = (a, b, ex, ez) => a + ',' + b + ',' + ex + ',' + ez;
  for (let a = -1; a <= 1; a++) {
    reserved.add(edgeKey(eci + (ldi !== 0 ? ldi : a), ecj + (ldj !== 0 ? ldj : a), ldi, ldj));
  }
  // shuffle (Fisher-Yates: a sort with a random comparator draws a different number of
  // random values in different JS engines, which would change every layout after this)
  for (let i = deadEnds.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [deadEnds[i], deadEnds[j]] = [deadEnds[j], deadEnds[i]];
  }
  const fakeSpots = deadEnds.filter(([fi, fj, sx, sz]) => !cells.has(key(fi + sx, fj + sz))).slice(0, Math.min(3, D - 1));
  for (const [fi, fj, sx, sz] of fakeSpots) reserved.add(edgeKey(fi, fj, sx, sz));

  // ---- enclosed stretches: runs of the path get walls on both sides and a ceiling ----
  const pathCells = path.map(([a, b]) => cells.get(key(a, b)));
  const pathIndex = new Map(path.map(([a, b], k) => [key(a, b), k]));
  const writable = [];
  let enclosed = 0;
  for (let pass = 0; pass < 4 && enclosed < enclosedFrac * path.length; pass++) {
    for (let k = 3; k < path.length - 4 && enclosed < enclosedFrac * path.length; k++) {
      if (pathCells[k].enc || rnd() > 0.08) continue;
      const len = 5 + Math.floor(rnd() * 9);
      for (let m = k; m < Math.min(path.length - 4, k + len); m++) {
        if (!pathCells[m].enc) { pathCells[m].enc = true; enclosed++; }
      }
      k += len;
    }
  }

  // ---- slabs ----
  for (const c of cells.values()) {
    box((c.i + 0.5) * C, SLAB_TOP - 1.6, (c.j + 0.5) * C, C / 2, 1.6, C / 2, M_SLAB);
  }
  const has = (a, b) => cells.has(key(a, b));

  // ---- walls on outer edges, doorframes across the path ----
  const T = 0.09;                          // half wall thickness
  const wallY = SLAB_TOP + ROOM_H / 2, wallH = ROOM_H / 2;
  // A finished wall: drywall with a baseboard on both faces and a cap rail along the top.
  // (cx, cz) centre, half length 'len' along x or z, from y0 up to y1.
  const wall = (cx, cz, len, alongX, y0 = SLAB_TOP, y1 = SLAB_TOP + ROOM_H, base = true, cap = true) => {
    const hy = (y1 - y0) / 2;
    const hx = alongX ? len : T, hz = alongX ? T : len;
    box(cx, y0 + hy, cz, hx, hy, hz, M_WALL);
    if (base) {
      const bt = T + 0.014;                // baseboards stand slightly proud of the wall
      box(cx, y0 + 0.06, cz, alongX ? len : bt, 0.06, alongX ? bt : len, M_TRIM, TRIM_BASE);
      if (y1 > y0 + WAINSCOT + 0.1) {
        const rt = T + 0.018;              // chair rail capping the wainscot panel
        box(cx, y0 + WAINSCOT + 0.022, cz, alongX ? len : rt, 0.022, alongX ? rt : len, M_TRIM, TRIM_CAP);
      }
    }
    if (cap) {
      const ct = T + 0.022;                // cap rail overhangs a little on both faces and ends
      box(cx, y1 + 0.025, cz, alongX ? len + 0.02 : ct, 0.025, alongX ? ct : len + 0.02, M_TRIM, TRIM_CAP);
    }
    if (Math.abs(y0 - SLAB_TOP) < 0.01) solid(cx, cz, hx, hz);     // only walls standing on the walkway
  };
  // a wall with a window in it, looking out to sea (outward normal ox, oz)
  const windows = [];
  const SILL = 0.95, HEAD = 2.05;
  const windowWall = (cx, cz, len, alongX, ox, oz) => {
    const pier = 0.3;
    for (const sgn of [-1, 1]) {
      const px = alongX ? cx + sgn * (len - pier / 2) : cx, pz = alongX ? cz : cz + sgn * (len - pier / 2);
      wall(px, pz, pier / 2, alongX);
    }
    const open = len - pier;
    wall(cx, cz, open, alongX, SLAB_TOP, SLAB_TOP + SILL, true, true);          // the cap is the sill
    wall(cx, cz, open, alongX, SLAB_TOP + HEAD, SLAB_TOP + ROOM_H, false, true);
    windows.push({ x: cx, z: cz, ox, oz, y: SLAB_TOP + SILL, half: open });
  };
  for (const c of cells.values()) {
    const x0 = c.i * C, z0 = c.j * C;
    const edges = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [ex, ez] of edges) {
      if (has(c.i + ex, c.j + ez) || reserved.has(edgeKey(c.i, c.j, ex, ez))) continue;
      if (!c.enc && rnd() > (c.path ? 0.16 : 0.42)) continue;
      const wx = ex < 0 ? x0 + T : ex > 0 ? x0 + C - T : x0 + C / 2;
      const wz = ez < 0 ? z0 + T : ez > 0 ? z0 + C - T : z0 + C / 2;
      if (c.enc && rnd() < 0.45) windowWall(wx, wz, C / 2, ex === 0, ex, ez);
      else {
        // plain walls on the walkway are where people wrote things
        if (c.path) writable.push({ k: pathIndex.get(key(c.i, c.j)), x: wx - ex * T, z: wz - ez * T, nx: -ex, nz: -ez, host: boxes.length, len: C / 2 });
        wall(wx, wz, C / 2, ex === 0);
      }
    }
  }
  for (let k = 3; k < path.length - 2; k++) {
    if (rnd() > 0.12) continue;
    if (pathCells[k].enc) continue;
    const [pi, pj] = path[k], [qi, qj] = path[k + 1], [oi, oj] = path[k - 1];
    // only on straight stretches: at a corner the frame would stand along the walkway
    if (qi - pi !== pi - oi || qj - pj !== pj - oj) continue;
    const cx = (pi + 0.5) * C, cz = (pj + 0.5) * C;
    const alongX = qi !== pi;              // path runs along x here: frame spans z
    const jamb = 0.09, open = 0.55;
    for (const s of [-1, 1]) {
      if (alongX) { box(cx, wallY, cz + s * (open + jamb), 0.1, wallH, jamb, M_FRAME); solid(cx, cz + s * (open + jamb), 0.1, jamb); }
      else { box(cx + s * (open + jamb), wallY, cz, jamb, wallH, 0.1, M_FRAME); solid(cx + s * (open + jamb), cz, jamb, 0.1); }
      // wall filling the rest of the cell beside the frame
      const fill = (C / 2 - open - 2 * jamb) / 2;
      const off = open + 2 * jamb + fill;
      if (alongX) wall(cx, cz + s * off, fill, false); else wall(cx + s * off, cz, fill, true);
    }
    // the wall above the opening
    if (alongX) wall(cx, cz, open + 2 * jamb, false, SLAB_TOP + 2.1, SLAB_TOP + ROOM_H, false);
    else wall(cx, cz, open + 2 * jamb, true, SLAB_TOP + 2.1, SLAB_TOP + ROOM_H, false);
  }

  // ---- lamp posts along the walkway ----
  // A cast-iron post on a plinth stands just inside an edge that borders the water; its arm
  // reaches in over the walkway and the lantern hangs at the end of it.
  const POST_H = 3.05;                     // lantern height above the walkway
  let side = 1;
  const lampPost = (ci, cj, kind) => {
    // edges of this cell (or, inside a room, of a neighbouring cell) that face open water
    const cand = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const oi = ci + a, oj = cj + b;
      if (!has(oi, oj) || (a !== 0 && b !== 0)) continue;
      if (cells.get(key(oi, oj)).enc) continue;            // no lamp posts indoors
      for (const [ex, ez] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) if (!has(oi + ex, oj + ez)) cand.push([oi, oj, ex, ez, a === 0 && b === 0 ? 2 : 1]);
    }
    if (!cand.length) return;
    // prefer this cell's own edges, alternating sides along the path
    cand.sort((p, q) => q[4] - p[4]);
    const own = cand.filter((c) => c[4] === cand[0][4]);
    const [oi, oj, ex, ez] = own[(side = 1 - side) % own.length];
    const inset = 0.32;
    const px = (oi + 0.5) * C + ex * (C / 2 - inset), pz = (oj + 0.5) * C + ez * (C / 2 - inset);
    const reach = 0.75;                    // arm length, pointing back over the walkway
    const lx = px - ex * reach, lz = pz - ez * reach;
    const y0 = SLAB_TOP;
    box(px, y0 + 0.025, pz, 0.17, 0.025, 0.17, M_POLE, POLE_PLINTH);         // base plate
    box(px, y0 + 0.14, pz, 0.12, 0.14, 0.12, M_POLE, POLE_PLINTH);
    box(px, y0 + 0.28 + (POST_H + 0.1 - 0.28) / 2, pz, 0.045, (POST_H + 0.1 - 0.28) / 2, 0.045, M_POLE, POLE_SHAFT);
    box(px, y0 + 0.9, pz, 0.065, 0.03, 0.065, M_POLE, POLE_PLINTH);           // collar
    box((px + lx) / 2, y0 + POST_H + 0.12, (pz + lz) / 2, ex !== 0 ? reach / 2 + 0.03 : 0.03, 0.03, ez !== 0 ? reach / 2 + 0.03 : 0.03, M_POLE, POLE_ARM);
    box(lx, y0 + POST_H + 0.105, lz, 0.18, 0.022, 0.18, M_POLE, POLE_PLINTH);  // roof
    box(lx, y0 + POST_H + 0.15, lz, 0.05, 0.025, 0.05, M_POLE, POLE_PLINTH);    // finial
    box(lx, y0 + POST_H - 0.07, lz, 0.13, 0.155, 0.13, M_LAMP, lamps.length);
    lamps.push({ x: lx, y: y0 + POST_H - 0.24, z: lz, kind, base: 0.85 + rnd() * 0.15, phase: rnd() * 1000, box: boxes.length - 1 });
    solid(px, pz, 0.13, 0.13);
  };
  for (let k = 0; k < path.length; k++) {
    if (k % 4 !== 0 && !(k === 1)) continue;
    if (pathCells[k].enc) continue;
    const [pi, pj] = path[k];
    lampPost(pi, pj, k < 3 ? 'on' : lampKind());
  }
  // indoors: a tiled ceiling over every enclosed cell, a recessed light in every other one
  const ceilY = SLAB_TOP + ROOM_H + 0.12;
  let lit = 0;
  for (let k = 0; k < path.length; k++) {
    if (!pathCells[k].enc) continue;
    const [pi, pj] = path[k];
    const x = (pi + 0.5) * C, z = (pj + 0.5) * C;
    if (lit++ % 2 === 0) {
      box(x, ceilY, z, C / 2, 0.12, C / 2, M_CEIL, lamps.length);
      lamps.push({ x, y: ceilY - 0.14, z, kind: lampKind(), base: 0.85 + rnd() * 0.15, phase: rnd() * 1000, box: boxes.length - 1 });
    } else {
      box(x, ceilY, z, C / 2, 0.12, C / 2, M_CEIL, -1);
    }
  }
  for (const [ri, rj] of rooms) lampPost(ri, rj, 'on');
  lampPost(eci, ecj, 'on');

  // ---- exit doors: a wall with a door and a lit EXIT sign over it, facing (nx, nz) ----
  const exitDoor = (fx, fz, nx, nz, wallLen) => {
    const across = nx !== 0;                                    // door plane spans z
    const first = boxes.length;
    wall(fx, fz, wallLen, !across);
    const dX = fx + nx * (T + 0.02), dZ = fz + nz * (T + 0.02);
    box(dX, SLAB_TOP + 1.03, dZ, across ? 0.03 : 0.5, 1.03, across ? 0.5 : 0.03, M_DOOR);
    const sX = fx + nx * (T + 0.05), sZ = fz + nz * (T + 0.05);
    box(sX, SLAB_TOP + 2.32, sZ, across ? 0.05 : 0.32, 0.12, across ? 0.32 : 0.05, M_SIGN, nx + nz * 2);
    return { x: dX + nx * 0.3, z: dZ + nz * 0.3, nx, nz, signX: sX + nx * 0.3, signY: SLAB_TOP + 2.32, signZ: sZ + nz * 0.3, boxes: [first, boxes.length] };
  };
  // the real one, on the far edge of the exit platform, facing back down the path
  const exit = exitDoor((eci + 0.5) * C + ldi * (C * 1.5 - T), (ecj + 0.5) * C + ldj * (C * 1.5 - T), -ldi, -ldj, C * 1.5);
  // false ones at the ends of long dead ends (from the second visit on)
  const fakeExits = [];
  for (const [fi, fj, sx, sz] of fakeSpots) {
    fakeExits.push(exitDoor((fi + 0.5) * C + sx * (C / 2 - T), (fj + 0.5) * C + sz * (C / 2 - T), -sx, -sz, C / 2));
  }

  // ---- the drowned office near the walkway: wall tops, pillars and dead ceilings ----
  const nearPath = (x, z, r) => {
    for (const c of cells.values()) {
      if (Math.abs((c.i + 0.5) * C - x) < r && Math.abs((c.j + 0.5) * C - z) < r) return true;
    }
    return false;
  };
  const minI = Math.min(...[...cells.values()].map((c) => c.i)), maxI = Math.max(...[...cells.values()].map((c) => c.i));
  const minJ = Math.min(...[...cells.values()].map((c) => c.j)), maxJ = Math.max(...[...cells.values()].map((c) => c.j));
  let placed = 0, tries = 0;
  while (placed < 120 && tries < 4000) {
    tries++;
    // close around the walkway; the horizon belongs to the landmarks
    const r = 8 + Math.pow(rnd(), 1.4) * 80;
    const a = rnd() * Math.PI * 2;
    const bx = ((minI + maxI) / 2 + 0.5) * C + Math.cos(a) * r;
    const bz = ((minJ + maxJ) / 2 + 0.5) * C + Math.sin(a) * r * 1.3;
    if (nearPath(bx, bz, 7)) continue;
    const gx = Math.round(bx / C) * C, gz = Math.round(bz / C) * C;  // stay on the office grid
    const rise = -0.6 + rnd() * 3.0;                                  // how far the top sticks out
    const kind = rnd();
    if (kind < 0.6) {
      const len = C * (1 + Math.floor(rnd() * 4)) / 2;
      const alongX = rnd() < 0.5;
      wall(gx, gz, len, alongX, rise - 6, rise, false);
    } else if (kind < 0.85) {
      box(gx, rise - 3, gz, 0.3, 3, 0.3, M_PILLAR);
    } else {
      // a ceiling slab hanging over the water at room height; its lamp is long dead
      box(gx + C / 2, SLAB_TOP + ROOM_H + 0.12 + (rnd() - 0.5) * 0.6, gz + C / 2, C / 2, 0.12, C / 2, M_CEIL, -1);
    }
    placed++;
  }

  // ---- landmarks: what is left of the world, out on the horizon ----
  // Wrecked ships and a crashed airliner, a drowned tower, colossal stone figures; deeper
  // down there are more of them, and statues of the thing itself.
  const cx0 = ((minI + maxI) / 2 + 0.5) * C, cz0 = ((minJ + maxJ) / 2 + 0.5) * C;
  const reach = Math.max(maxI - minI, maxJ - minJ) * C * 0.5;
  const kinds = [LM_SHIP, LM_PLANE, LM_TOWER, LM_TOWER, LM_HEAD, LM_STATUE, LM_HAND, LM_SHIP, LM_STATUE, LM_TOWER];
  if (D >= 2) kinds.push(LM_HAND, LM_STATUE, LM_HEAD);
  if (D >= 3) kinds.push(LM_IDOL);
  if (D >= 5) kinds.push(LM_IDOL, LM_STATUE, LM_PLANE);
  if (D >= 7) kinds.push(LM_IDOL);
  const landmarks = [];
  const farFromWalkway = (x, z, r) => {
    for (const c of cells.values()) if (Math.hypot((c.i + 0.5) * C - x, (c.j + 0.5) * C - z) < r) return false;
    return true;
  };
  for (const type of kinds) {
    // the big ones further out; statues can stand a little closer
    const big = type === LM_SHIP || type === LM_TOWER || type === LM_PLANE;
    for (let tries2 = 0; tries2 < 80; tries2++) {
      const a = rnd() * Math.PI * 2;
      const near = Math.max(0.55, 1 - 0.08 * (D - 1));     // deeper down they stand closer
      const r = reach + ((big ? 120 : 60) + rnd() * (big ? 260 : 160)) * near;
      const x = cx0 + Math.cos(a) * r, z = cz0 + Math.sin(a) * r;
      if (!farFromWalkway(x, z, big ? 70 : 45)) continue;
      if (landmarks.some((m) => Math.hypot(m.x - x, m.z - z) < 70)) continue;
      // figures face the walkway; wrecks lie however they came to rest
      const faceIn = Math.atan2(cx0 - x, cz0 - z);
      const yaw = (type === LM_HEAD || type === LM_STATUE || type === LM_IDOL || type === LM_HAND) ? faceIn + (rnd() - 0.5) * 0.4 : rnd() * Math.PI * 2;
      const scale = type === LM_IDOL ? 7 + rnd() * 2 : (type === LM_HEAD || type === LM_HAND || type === LM_STATUE ? 1.7 : 0.9) + rnd() * 0.5;
      landmarks.push({ type, x, z, y: 0, yaw, scale, seed: rnd(),
        watches: type === LM_STATUE || type === LM_IDOL || (type === LM_HEAD && D >= 5) || (type === LM_HAND && D >= 6) });
      break;
    }
  }

  // on the last descent, something enormous stands out past the exit, waiting for you to reach it
  if (D >= 7) {
    landmarks.push({ type: LM_IDOL, x: exit.x - exit.nx * 55, z: exit.z - exit.nz * 55, y: 0,
      yaw: Math.atan2(exit.nx, exit.nz), scale: 11, seed: 0.5, watches: true });
  }

  // ---- the writing on the walls ----
  const decals = [];
  const text = [];
  {
    const drnd = mulberry32(seed ^ 0x51a7e);
    const ink = inkStyle(D);
    const used = new Set();
    writable.sort((a, b) => a.k - b.k);
    // put a mark on the wall nearest to path position k that is still free
    const place = (k, line, big) => {
      let best = -1, bd = Infinity;
      for (let w = 0; w < writable.length; w++) {
        if (used.has(w)) continue;
        const d = Math.abs(writable[w].k - k);
        if (d < bd) { bd = d; best = w; }
      }
      if (best < 0) return;
      used.add(best);
      const w = writable[best];
      const marksOnly = !/[A-Z0-9]/.test(line);
      const px = ink.px * (marksOnly && /[@#]/.test(line) ? 2.4 : 1) * (0.9 + 0.2 * drnd());
      // wrap into rows that fit the wall
      const maxCols = Math.max(4, Math.floor((w.len * 2 - 0.35) / (6 * px)));
      const rows = [];
      for (const word of line.split(' ')) {
        const cur = rows[rows.length - 1];
        if (cur !== undefined && (cur + ' ' + word).length <= maxCols) rows[rows.length - 1] = cur + ' ' + word;
        else rows.push(word.slice(0, maxCols));
      }
      const cols = Math.max(...rows.map((r) => r.length));
      const start = text.length;
      for (const r of rows) text.push(...encodeLine(r.padEnd(cols)));
      const width = cols * 6 * px, height = rows.length * 8 * px;
      // slid along the wall a little, at about eye level
      const slide = (drnd() - 0.5) * Math.max(0, w.len * 2 - 0.3 - width);
      const ax = w.nz, az = -w.nx;   // along the wall, to the right of someone facing it
      const cy = SLAB_TOP + (marksOnly ? 1.2 + drnd() * 0.7 : 1.45 + drnd() * 0.35) + height / 2;
      decals.push({
        x: w.x + ax * slide + w.nx * 0.0015, y: cy, z: w.z + az * slide + w.nz * 0.0015,
        px, start, cols, rows: rows.length, host: w.host, nx: w.nx, nz: w.nz,
        col: ink.col, shake: ink.shake, drip: ink.drip, fade: ink.fade + (D > 1 && drnd() < 0.2 ? 0.25 : 0),
        w: width, h: height,
      });
    };
    // the story for this descent, in order from the start of the walkway to the exit
    const lines = STORY[Math.min(D, STORY.length) - 1];
    const span = path.length;
    lines.forEach((line, i) => place(Math.round((i + 0.6) / (lines.length + 0.2) * span), line));
    // and more marks the deeper you go: tallies, handprints, grins
    const extra = D <= 1 ? 1 : Math.min(18, 3 * (D - 1));
    for (let e = 0; e < extra; e++) {
      const r = drnd();
      const mark = D >= 4 && r < 0.35 ? '@' : D >= 2 && r < 0.65 ? '#' : '|||| ' + '|'.repeat(1 + Math.floor(drnd() * 4));
      place(Math.floor(drnd() * span), mark);
    }
  }

  // each mark is a sliver of a box just proud of its wall; the shader repaints the wall
  // under it (from the host box) and puts the writing on top
  decals.forEach((dc, i) => {
    const runs = dc.drip * 8 * dc.px;                 // room below for the paint to run
    const along = dc.w / 2 + dc.px, half = dc.h / 2 + dc.px + runs / 2;
    box(dc.x, dc.y - runs / 2, dc.z, dc.nx !== 0 ? 0.0008 : along, half, dc.nz !== 0 ? 0.0008 : along, M_DECAL, i);
  });

  // what a swimmer bumps into: slab sides and anything else standing in the water
  const waterSolids = [];
  for (const c of cells.values()) waterSolids.push([c.i * C, c.j * C, (c.i + 1) * C, (c.j + 1) * C]);
  for (const b of boxes) {
    if (b.m !== M_WALL && b.m !== M_PILLAR) continue;
    if (b.c[1] - b.h[1] > 0.3 || b.c[1] + b.h[1] < -0.3) continue;   // not standing in the water
    waterSolids.push([b.c[0] - b.h[0], b.c[2] - b.h[2], b.c[0] + b.h[0], b.c[2] + b.h[2]]);
  }

  // where it is indoors (roofed), one texel per cell, for the shaders' sky and sun light
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  for (const c of cells.values()) { i0 = Math.min(i0, c.i); j0 = Math.min(j0, c.j); i1 = Math.max(i1, c.i); j1 = Math.max(j1, c.j); }
  const iw = i1 - i0 + 3, ih = j1 - j0 + 3;
  const indoorBytes = new Uint8Array(iw * ih);
  for (const c of cells.values()) if (c.enc) indoorBytes[(c.j - j0 + 1) * iw + (c.i - i0 + 1)] = 255;
  const indoor = { bytes: indoorBytes, w: iw, h: ih, x0: (i0 - 1) * C, z0: (j0 - 1) * C };

  const [si, sj] = path[0];
  return {
    cells, path, boxes, lamps, solids, waterSolids, exit, fakeExits, windows, indoor, landmarks, decals, text, depth: D,
    start: { x: (si + 0.5) * C, z: (sj + 0.5) * C + 0.6, yaw: 0 },
  };
}

export function onWalkway(S, x, z) {
  return S.cells.has(Math.floor(x / SEA_CELL) + ',' + Math.floor(z / SEA_CELL));
}

// push a circle out of the walkway's walls and frames (mutates p {x, z})
export function collideSea(S, p, r) { collideRects(S.solids, p, r); }

// Is the straight segment between two points free of walkway walls? (for line of sight)
export function seaLOS(S, ax, az, bx, bz) {
  for (const [x0, z0, x1, z1] of S.solids) {
    // slab test against the AABB
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dz = bz - az;
    for (const [o, d, lo, hi] of [[ax, dx, x0, x1], [az, dz, z0, z1]]) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { t0 = 2; break; } continue; }
      let ta = (lo - o) / d, tb = (hi - o) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    if (t0 <= t1) return false;
  }
  return true;
}

// Signed distance (m) from the water surface to the nearest structure standing in it, on a
// grid around the walkway: negative inside. Encoded for the ocean renderer as r8 = (d + 2) / 8.
export function buildWaterField(S, res = 0.25, margin = 24) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [a, b, c, d] of S.waterSolids) {
    // only what is near the walkway matters; distant ruins keep the open-sea look
    if (!nearWalkway(S, (a + c) / 2, (b + d) / 2, margin)) continue;
    x0 = Math.min(x0, a); z0 = Math.min(z0, b); x1 = Math.max(x1, c); z1 = Math.max(z1, d);
  }
  x0 -= margin; z0 -= margin; x1 += margin; z1 += margin;
  const size = Math.max(x1 - x0, z1 - z0);
  const n = Math.min(1024, Math.ceil(size / res));
  const cell = size / n;
  const inside = new Uint8Array(n * n);
  for (const [a, b, c, d] of S.waterSolids) {
    const i0 = Math.max(0, Math.floor((a - x0) / cell)), i1 = Math.min(n - 1, Math.ceil((c - x0) / cell) - 1);
    const j0 = Math.max(0, Math.floor((b - z0) / cell)), j1 = Math.min(n - 1, Math.ceil((d - z0) / cell) - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) inside[j * n + i] = 1;
  }
  const dOut = edt(inside, n, 1);   // distance from water texels to structure
  const dIn = edt(inside, n, 0);    // distance from structure texels to water
  const bytes = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) {
    const d = inside[k] ? -(Math.sqrt(dIn[k]) - 0.5) * cell : (Math.sqrt(dOut[k]) - 0.5) * cell;
    bytes[k] = Math.round(Math.max(0, Math.min(1, (d + 2) / 8)) * 255);
  }
  return { bytes, n, x0, z0, size };
}
function nearWalkway(S, x, z, r) {
  for (const c of S.cells.values()) {
    if (Math.abs((c.i + 0.5) * SEA_CELL - x) < r && Math.abs((c.j + 0.5) * SEA_CELL - z) < r) return true;
  }
  return false;
}
// Squared Euclidean distance (in texels) to the nearest texel whose mask equals 'target'
// (Felzenszwalb & Huttenlocher, separable).
function edt(mask, n, target) {
  const INF = 1e20;
  const g = new Float64Array(n * n);
  for (let k = 0; k < n * n; k++) g[k] = mask[k] === target ? 0 : INF;
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (get, set) => {
    for (let q = 0; q < n; q++) f[q] = get(q);
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    for (let q = 0; q < n; q++) set(q, d[q]);
  };
  for (let i = 0; i < n; i++) pass((q) => g[q * n + i], (q, val) => { g[q * n + i] = val; });
  for (let j = 0; j < n; j++) pass((q) => g[j * n + q], (q, val) => { g[j * n + q] = val; });
  return g;
}

// Push a circle out of axis-aligned rectangles [x0, z0, x1, z1] (mutates p {x, z}).
export function collideRects(rects, p, r) {
  for (const [x0, z0, x1, z1] of rects) {
    if (p.x < x0 - r || p.x > x1 + r || p.z < z0 - r || p.z > z1 + r) continue;
    const qx = Math.max(x0, Math.min(x1, p.x)), qz = Math.max(z0, Math.min(z1, p.z));
    const dx = p.x - qx, dz = p.z - qz, d = Math.hypot(dx, dz);
    if (d >= r) continue;
    if (d > 1e-6) { p.x += dx / d * (r - d); p.z += dz / d * (r - d); }
    else {
      const ox = Math.min(p.x - x0, x1 - p.x), oz = Math.min(p.z - z0, z1 - p.z);
      if (ox < oz) p.x = (p.x - x0 < x1 - p.x) ? x0 - r : x1 + r; else p.z = (p.z - z0 < z1 - p.z) ? z0 - r : z1 + r;
    }
  }
}
