// Shared horror effects for the Level 0 and Level 7 games: the entity (a ray-marched SDF),
// the EXIT sign font, and the camcorder composite.
import { FS_TRI, AGX_WGSL } from '../wgsl/post.js';

// The entity. The including shader provides its state through five functions:
//   entPos() -> vec3f      feet position (m)
//   entFacing() -> f32     facing angle (rad, 0 = +z)
//   entParams() -> vec4f   visible, face glow, arm raise, twitch
//   entClock() -> f32      time (s), drives the twitching
//   entCreep() -> f32      0..1, how far it has grown into something worse: taller and
//                          thinner, hunched, head cocked, arms to its ankles, a gaping grin,
//                          more eyes. At 0 it is the original figure.
export const ENTITY_WGSL = /* wgsl */ `
fn sdCapsule(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let pa = p - a; let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
fn sdEllipsoid(p: vec3f, r: vec3f) -> f32 {
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}
fn entScale() -> f32 { return 1.0 + 0.22 * entCreep(); }
fn entHead() -> vec3f {
  let c = entCreep();
  let tw = entParams().w;
  let t = entClock();
  let jit = (sin(t * 37.0) + sin(t * 23.0 + 1.0)) * 0.5 * tw;
  // further gone, the head hangs forward on its neck and sits off to one side
  return vec3f(jit * 0.035 + 0.05 * c, 2.13 - 0.03 * entParams().z - 0.16 * c, 0.05 * entParams().z + jit * 0.01 + 0.3 * c);
}
// head space: centred on the head, tilted to its cocked angle (+z out of the face)
fn entHeadSpace(q: vec3f) -> vec3f {
  let a = 0.5 * entCreep() + 0.08 * sin(entClock() * 0.7) * entCreep();
  let v = q - entHead();
  return vec3f(cos(a) * v.x - sin(a) * v.y, sin(a) * v.x + cos(a) * v.y, v.z);
}
// world position -> the figure's own frame, divided by its scale
fn entToLocal(p: vec3f) -> vec3f {
  let f = vec2f(sin(entFacing()), cos(entFacing()));
  let q = p - entPos();
  return vec3f(dot(q.xz, vec2f(f.y, -f.x)), q.y, dot(q.xz, f)) / entScale();
}
fn entShoulderZ() -> f32 { return 0.2 * entCreep(); }
fn arm(p: vec3f, s: f32) -> f32 {
  let c = entCreep();
  let sh = vec3f(0.23 * s, 1.68 - 0.06 * c, entShoulderZ());
  let rest = vec3f((0.31 + 0.04 * c) * s, 0.62 - 0.44 * c, 0.07 + 0.15 * c);
  let hand = mix(rest, vec3f(0.27 * s, 1.72, 0.78), entParams().z);
  let dir = normalize(hand - sh);
  var d = sdCapsule(p, sh, hand, 0.034 - 0.009 * c);
  for (var k = -1; k <= 1; k++) {
    let off = vec3f(f32(k) * (0.028 + 0.02 * c), 0.0, f32(k) * 0.01 * s);
    d = min(d, sdCapsule(p, hand, hand + dir * (0.21 + 0.24 * c) + off, 0.011));
  }
  return d;
}
fn entSdf(p: vec3f) -> f32 {
  let c = entCreep();
  let hc = entHead();
  let leg = 0.045 - 0.012 * c;
  var d = sdCapsule(p, vec3f(-0.09, 0.0, 0.0), vec3f(-0.07, 1.05, 0.0), leg);
  d = min(d, sdCapsule(p, vec3f(0.09, 0.0, 0.0), vec3f(0.07, 1.05, 0.0), leg));
  // the spine bends forward as it goes on
  let chest = vec3f(0.0, 1.68 - 0.06 * c, 0.03 + entShoulderZ());
  d = smin(d, sdCapsule(p, vec3f(0.0, 1.0, 0.0), chest, 0.115 - 0.03 * c), 0.08);
  d = smin(d, sdCapsule(p, vec3f(-0.21, chest.y, entShoulderZ()), vec3f(0.21, chest.y, entShoulderZ()), 0.05), 0.06);
  d = smin(d, arm(p, -1.0), 0.03);
  d = smin(d, arm(p, 1.0), 0.03);
  d = smin(d, sdCapsule(p, chest + vec3f(0.0, 0.02, 0.0), hc - vec3f(0.0, 0.13, 0.04 * c), 0.033 - 0.008 * c), 0.05);
  d = smin(d, sdEllipsoid(entHeadSpace(p), vec3f(0.12, 0.17 + 0.03 * c, 0.13)), 0.04);
  return d;
}
fn traceEnt(ro: vec3f, rd: vec3f, tMax: f32) -> f32 {
  if (entParams().x < 0.5) { return -1.0; }
  let R = 1.25 * entScale();
  let oc = ro.xz - entPos().xz;
  let a = dot(rd.xz, rd.xz);
  if (a < 1e-8) { return -1.0; }
  let b = dot(oc, rd.xz);
  let disc = b * b - a * (dot(oc, oc) - R * R);
  if (disc < 0.0) { return -1.0; }
  let s = sqrt(disc);
  let t1 = min((-b + s) / a, tMax);
  var t = max((-b - s) / a, 0.0);
  for (var i = 0; i < 110; i++) {
    if (t > t1) { break; }
    let d = entSdf(entToLocal(ro + rd * t)) * entScale();
    if (d < 0.0008 * (1.0 + t)) { return t; }
    t += d * 0.9;
  }
  return -1.0;
}
fn entNormal(q: vec3f) -> vec3f {
  let e = vec2f(0.002, -0.002);
  return normalize(e.xyy * entSdf(q + e.xyy) + e.yyx * entSdf(q + e.yyx) +
                   e.yxy * entSdf(q + e.yxy) + e.xxx * entSdf(q + e.xxx));
}
fn entLocalToWorldDir(n: vec3f) -> vec3f {
  let f = vec2f(sin(entFacing()), cos(entFacing()));
  let r = vec2f(f.y, -f.x);
  let xz = r * n.x + f * n.z;
  return normalize(vec3f(xz.x, n.y, xz.y));
}
// eyes and grin, in head space (+z faces out of the face)
fn faceGlow(q: vec3f) -> f32 {
  let c = entCreep();
  let fp = entHeadSpace(q);
  if (fp.z < 0.02) { return 0.0; }
  // pinprick eyes set a little too far apart; further gone, more of them open
  let ex = vec2f(abs(fp.x), fp.y) - vec2f(0.052, 0.04);
  var eye = smoothstep(0.016 + 0.004 * c, 0.006, length(ex));
  let ex2 = vec2f(abs(fp.x), fp.y) - vec2f(0.03, 0.095);
  eye = max(eye, smoothstep(0.012, 0.004, length(ex2)) * smoothstep(0.4, 0.65, c));
  eye = max(eye, smoothstep(0.014, 0.005, length(fp.xy - vec2f(0.0, 0.135))) * smoothstep(0.75, 0.95, c));
  // the mouth: a slit along a curve, filled by two rows of interlocking points; it gapes
  let w = 0.11 + 0.045 * c;
  let ax = abs(fp.x) / w;
  if (ax > 1.0) { return eye * 2.0; }
  let yc = -0.06 - 0.02 * c + 3.2 * fp.x * fp.x;
  let halfH = (0.021 + 0.03 * c) * (1.0 - ax * ax) + 0.003;
  let m = (fp.y - yc) / halfH;
  if (abs(m) > 1.0) { return eye * 2.0; }
  let up = 1.0 - abs(fract(fp.x * 70.0) - 0.5) * 2.0;
  let dn = 1.0 - abs(fract(fp.x * 70.0 + 0.5) - 0.5) * 2.0;
  let reach = 1.15 - 0.35 * c;            // gaping: the teeth no longer meet
  let tooth = max(step(1.0 - reach * up, m), step(m, -1.0 + reach * dn));
  return max(eye * 2.0, tooth * smoothstep(1.0, 0.85, abs(m)) * 1.2);
}
`;

export const EXIT_FONT_WGSL = /* wgsl */ `
// ---- 3x5 bitmap font for the EXIT sign (rows top to bottom, 3 bits per row) ----------
fn glyphBit(letter: i32, col: i32, row: i32) -> bool {
  // 15 bits per letter, row 0 in the most significant group of three
  var bits: u32;
  switch (letter) {
    case 0: { bits = 0x79E7u; }     // E: 111 100 111 100 111
    case 1: { bits = 0x5AADu; }     // X: 101 101 010 101 101
    case 2: { bits = 0x7497u; }     // I: 111 010 010 010 111
    default: { bits = 0x7492u; }    // T: 111 010 010 010 010
  }
  let shift = u32((4 - row) * 3 + (2 - col));
  return ((bits >> shift) & 1u) != 0u;
}
fn exitSign(s: f32, y: f32) -> f32 {
  // s: metres to the viewer's right of the door centre, y: height
  let lx = (s + 0.32) / 0.64;
  let ly = (2.43 - y) / 0.22;
  if (lx < 0.0 || lx > 1.0 || ly < 0.0 || ly > 1.0) { return -1.0; }
  let gx = i32(floor(lx * 17.0)) - 1;
  let gy = i32(floor(ly * 7.0)) - 1;
  if (gx < 0 || gx > 14 || gy < 0 || gy > 4) { return 0.0; }
  let col = gx % 4;
  if (col == 3) { return 0.0; }
  return select(0.0, 1.0, glyphBit(gx / 4, col, gy));
}
`;

// Procedural backrooms materials: noise helpers, yellow wallpaper, damp carpet.
// detail() fades a feature out once it is smaller than the pixel footprint fw (m).
export const MATERIALS_WGSL = /* wgsl */ `
// ---- noise ---------------------------------------------------------------------------
fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p: vec2f) -> f32 {
  var s = 0.0; var a = 0.5; var q = p;
  for (var o = 0; o < 4; o++) { s += a * vnoise(q); q = q * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// fade a detail of size 'feature' out once it gets smaller than the pixel footprint
fn detail(feature: f32, fw: f32) -> f32 { return 1.0 - smoothstep(0.5, 1.5, fw / feature); }

fn wallpaper(u: f32, y: f32, fw: f32, seed: f32) -> vec3f {
  var c = vec3f(0.70, 0.60, 0.31);
  // fine vertical stripes and a faded diamond motif
  let st = detail(0.08, fw);
  c *= 1.0 + 0.045 * st * cos(u * 6.2831853 / 0.16);
  let g = vec2f(fract(u / 0.16), fract(y / 0.22)) - 0.5;
  let dm = abs(g.x) + abs(g.y) * 0.73;
  let motif = smoothstep(0.30, 0.27, dm) - smoothstep(0.24, 0.21, dm);
  c *= 1.0 - 0.07 * motif * detail(0.05, fw);
  // blotches, drips running down from the ceiling, damp creeping up from the carpet
  let blot = fbm(vec2f(u * 0.8 + seed * 7.0, y * 0.6));
  c *= 1.0 - 0.22 * smoothstep(0.55, 0.8, blot);
  let drip = fbm(vec2f(u * 4.0 + seed * 13.0, y * 0.35)) * smoothstep(1.0, 2.7, y);
  c = mix(c, c * vec3f(0.62, 0.52, 0.34), smoothstep(0.5, 0.75, drip) * 0.8);
  let damp = fbm(vec2f(u * 1.5 + seed, y * 2.0)) * (1.0 - smoothstep(0.1, 0.55, y));
  c = mix(c, c * vec3f(0.55, 0.47, 0.32), smoothstep(0.35, 0.6, damp));
  c *= 0.94 + 0.06 * vnoise(vec2f(u, y) * 90.0) * detail(0.012, fw) + 0.03 * (1.0 - detail(0.012, fw));
  return c;
}

fn carpet(p: vec2f, fw: f32) -> vec3f {
  var c = vec3f(0.33, 0.235, 0.10);
  let fiber = hash21(floor(p * 220.0));
  c *= mix(1.0, 0.82 + 0.36 * fiber, detail(0.005, fw));
  c *= 0.9 + 0.2 * vnoise(p * 4.0);
  let wet = fbm(p * 0.35 + 3.0);
  c = mix(c, c * vec3f(0.55, 0.48, 0.38), smoothstep(0.52, 0.7, wet));
  let stain = fbm(p * 1.3 + 11.0);
  c = mix(c, c * 0.6, smoothstep(0.62, 0.78, stain) * 0.7);
  return c;
}
`;

// Camcorder look: lens distortion, chromatic aberration, tape tearing, scanlines, grain,
// and the red/white flashes used by the scares.
export const GAME_COMPOSITE = FS_TRI + AGX_WGSL + /* wgsl */ `
struct P { p: vec4f, q: vec4f, r: vec4f };
// p: exposure, bloom, frame, vignette
// q: scare flash, chromatic aberration, grain, fade (1 = visible)
// r: desaturation, time, glitch, red tint
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> U: P;

fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }
fn h11(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }

@fragment fn fs(in: VO) -> @location(0) vec4f {
  let t = U.r.y;
  let g = U.r.z;
  let cc = in.uv - 0.5;
  var uv = 0.5 + cc * (0.965 + 0.09 * dot(cc, cc));
  // tape tearing: random bands slide sideways while glitching
  let band = floor(uv.y * 42.0);
  let tear = (h11(band + floor(t * 24.0)) - 0.5) * step(0.55, h11(band * 1.73 + floor(t * 13.0)));
  uv.x += tear * g * 0.07 + g * 0.003 * sin(uv.y * 320.0 + t * 60.0);
  let ca = U.q.y * (0.3 + 3.0 * dot(cc, cc)) + g * 0.012;
  var c = vec3f(textureSampleLevel(hdr, samp, uv + cc * ca, 0.0).r,
                textureSampleLevel(hdr, samp, uv, 0.0).g,
                textureSampleLevel(hdr, samp, uv - cc * ca, 0.0).b);
  let b = textureSampleLevel(bloom, samp, uv, 0.0).rgb * (1.0 / 8.0);
  c = mix(c, b, U.p.y);
  c *= U.p.x;
  let d = cc * vec2f(1.6, 1.0);
  c *= max(0.0, 1.0 - U.p.w * dot(d, d));
  c *= mix(vec3f(1.0), vec3f(1.5, 0.45, 0.4), U.r.w);
  // scare flash: the room blows out red but dark things stay dark, so the silhouette reads
  c = mix(c, c * vec3f(2.6, 0.55, 0.45) + vec3f(0.35, 0.01, 0.0) * U.q.x, U.q.x);
  var o = agx(c);
  o = agxLook(o, 1.0 - U.r.x, 1.15);
  o = agxEotf(o);
  // rolling tracking band and static
  let ry = fract(t * 0.11);
  let inBand = smoothstep(0.03, 0.0, abs(uv.y - ry)) * (0.25 + g);
  let st = ign(in.pos.xy + vec2f(U.p.z * 7.13, U.p.z * 3.7));
  o = mix(o, vec3f(st), clamp(inBand * 0.3 + g * 0.22, 0.0, 1.0));
  o *= 0.95 + 0.05 * sin(in.pos.y * 1.7);
  o += (st - 0.5) * U.q.z;
  o *= U.q.w;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { o = vec3f(0.0); }
  return vec4f(clamp(o, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
