// Level 7 shaders: the drowned office (instanced boxes) and the entity (ray-marched SDF on a
// proxy box), both drawn into the ocean renderer's main pass. They include the ocean's own
// frame uniforms, atmosphere and environment cube, so sunlight, sky light and haze match
// the sea exactly, and they read the same lamp list the sea surface uses.
import { FRAME_WGSL, ATMO_CORE_WGSL, EXTRA_WGSL, ENV_MIPS } from '../wgsl/common.js';
import { SKY_RENDER_FUNCS } from '../wgsl/sky.js';
import { ENTITY_WGSL, EXIT_FONT_WGSL, MATERIALS_WGSL } from '../game/fx.js';
import { FONT_WORDS } from './story.js';

// Shared bindings and lighting for both passes. Binding 7 is pass specific.
const SEA_COMMON = FRAME_WGSL + ATMO_CORE_WGSL + EXTRA_WGSL + /* wgsl */ `
struct SeaGame {
  torch: vec4f,        // x = power
  misc: vec4f,         // x = time, y = mean water level, z = walkway surface height
  room: vec4f,         // indoor mask placement: origin x, z, size x, z (m)
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var<storage, read> sunVis: array<f32, 4>;
@group(0) @binding(6) var<storage, read> X: Extras;
@group(0) @binding(8) var<uniform> SG: SeaGame;
@group(0) @binding(9) var indoorTex: texture_2d<f32>;   // 1 where a cell is roofed over
` + SKY_RENDER_FUNCS + /* wgsl */ `
const ENV_MAXMIP: f32 = ${ENV_MIPS - 1}.0;

// 0 outdoors, 1 under a roof (soft at the ends of corridors)
fn indoorAt(p: vec3f) -> f32 {
  let uv = (p.xz - SG.room.xy) / SG.room.zw;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 0.0; }
  return textureSampleLevel(indoorTex, sampC, uv, 0.0).r;
}

// Diffuse lighting at p with normal n: low sun, sky, lamps and the handheld torch.
// Returns irradiance / pi (multiply by albedo).
fn lightAt(p: vec3f, n: vec3f) -> vec3f {
  let Ld = F.sunDir.xyz;
  // indoors the roof and walls keep the sun out and most of the sky
  let ind = indoorAt(p + n * 0.3);
  let sunE = sunIlluminance() * sunVis[0] * (1.0 - ind);
  var e = sunE * max(dot(n, Ld), 0.0) / PI;
  // sky light from the environment cube, darkened for faces looking down at the sea
  let sky = textureSampleLevel(envCube, sampC, normalize(vec3f(n.x, max(n.y, 0.0) + 0.25, n.z)), ENV_MAXMIP - 1.0).rgb;
  e += sky * (0.55 + 0.45 * n.y) * mix(1.0, 0.1, ind);
  let nl = u32(X.info.x);
  for (var i = 0u; i < nl; i++) {
    let lp = X.lamps[i];
    let v = lp.pos.xyz - p;
    let d2 = dot(v, v);
    if (d2 > lp.pos.w * lp.pos.w) { continue; }
    let l = v * inverseSqrt(d2);
    let win = smoothstep(lp.pos.w, lp.pos.w * 0.5, sqrt(d2));
    // panels face down: little light reaches anything above them
    let emit = 0.25 + 0.75 * clamp(l.y + 0.2, 0.0, 1.0);
    e += lp.col.rgb * win * emit * max(dot(n, l), 0.0) / (d2 + 0.5);
    // indoors, light bounces off the carpet and walls onto everything, the ceiling too
    e += lp.col.rgb * win * ind * 0.3 / (d2 + 2.0);
  }
  if (SG.torch.x > 0.0) {
    let v = F.camPos.xyz - normalize(F.camUp.xyz) * 0.12 - p;
    let d2 = dot(v, v);
    let l = v * inverseSqrt(d2);
    let ca = dot(-l, F.camFwd.xyz);
    let spot = smoothstep(0.80, 0.96, ca) + 0.15 * smoothstep(0.5, 0.82, ca);
    e += vec3f(0.92, 0.96, 1.0) * SG.torch.x * spot * max(dot(n, l), 0.0) / (0.3 * d2 + 0.25);
  }
  return e;
}

// Glossy highlight of the lamps on wet surfaces.
fn wetSpec(p: vec3f, n: vec3f, V: vec3f, rough: f32) -> vec3f {
  var s = vec3f(0.0);
  let nl = u32(X.info.x);
  for (var i = 0u; i < nl; i++) {
    let lp = X.lamps[i];
    let v = lp.pos.xyz - p;
    let d2 = dot(v, v);
    if (d2 > lp.pos.w * lp.pos.w) { continue; }
    let l = v * inverseSqrt(d2);
    let h = normalize(l + V);
    let a2 = rough * rough;
    let nh = max(dot(n, h), 0.0);
    let dd = nh * nh * (a2 - 1.0) + 1.0;
    s += lp.col.rgb * smoothstep(lp.pos.w, lp.pos.w * 0.5, sqrt(d2)) * (a2 / (PI * dd * dd)) * 0.03 * max(dot(n, l), 0.0) / (d2 + 0.5);
  }
  return s;
}

// The low sun glinting off glossy surfaces (GGX lobe, small Fresnel).
fn sunSpec(p: vec3f, n: vec3f, V: vec3f, rough: f32) -> vec3f {
  let Ld = F.sunDir.xyz;
  if (indoorAt(p + n * 0.3) > 0.5) { return vec3f(0.0); }
  let h = normalize(Ld + V);
  let a2 = rough * rough;
  let nh = max(dot(n, h), 0.0);
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  return sunIlluminance() * sunVis[0] * (a2 / (PI * dd * dd)) * 0.04 * max(dot(n, Ld), 0.0);
}

// same aerial perspective as the sea surface
fn seaFog(col: vec3f, rel: vec3f) -> vec3f {
  let dist = length(rel);
  let V = -rel / dist;
  let T = exp(-max(F.fogExt.rgb, vec3f(F.fogExt.w)) * dist);
  return col * T + skyAtmo(normalize(vec3f(-V.x, 0.002, -V.z))) * (1.0 - T);
}

// Unit-cube corner for vertex vi of 36 (two triangles per face, both sides drawn).
fn cubeCorner(vi: u32) -> vec3f {
  let face = vi / 6u;
  let k = vi % 6u;
  var st = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
                           vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let q = st[k];
  let axis = face / 2u;
  let sgn = select(-1.0, 1.0, (face & 1u) == 0u);
  if (axis == 0u) { return vec3f(sgn, q.x, q.y); }
  if (axis == 1u) { return vec3f(q.x, sgn, q.y); }
  return vec3f(q.x, q.y, sgn);
}
fn cubeNormal(vi: u32) -> vec3f {
  let face = vi / 6u;
  let sgn = select(-1.0, 1.0, (face & 1u) == 0u);
  let axis = face / 2u;
  return select(select(vec3f(0.0, 0.0, sgn), vec3f(0.0, sgn, 0.0), axis == 1u), vec3f(sgn, 0.0, 0.0), axis == 0u);
}
`;

// Writing on the walls: hand-painted 5x7 glyphs with shake, paint runs and wear, plus
// drawn grins and handprints (glyphs 1 and 2).
const WRITING_WGSL = /* wgsl */ `
const FONT_WORDS: u32 = ${FONT_WORDS}u;
struct Decal {
  a: vec4f,   // centre xyz, size of one font pixel (m)
  b: vec4f,   // first glyph, columns, rows, host wall box
  c: vec4f,   // wall normal x, z, shake, paint runs
  d: vec4f,   // ink rgb, fade
};
@group(0) @binding(11) var<storage, read> decals: array<Decal>;
@group(0) @binding(12) var<storage, read> glyphText: array<u32>;   // the font, then the text

fn glyphBit5(code: u32, x: i32, y: i32) -> bool {
  if (x < 0 || x > 4 || y < 0 || y > 6) { return false; }
  let word = glyphText[code * 2u + select(1u, 0u, y < 4)];
  let row = select(y - 4, y, y < 4);
  return ((word >> u32(row * 5 + x)) & 1u) != 0u;
}
fn segDist(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a; let ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// ink coverage at (fx, fy) in one 6x8 character cell (pixel units, y down)
fn glyphInk(code: u32, f: vec2f, radius: f32, drip: f32, h: f32) -> f32 {
  if (code == 0u) { return 0.0; }
  if (code == 1u) {
    // a drawn grin: two eyes and a wide mouth full of teeth
    let c = f - vec2f(2.5, 3.5);
    var d = min(length(c - vec2f(-1.3, -1.6)), length(c - vec2f(1.3, -1.6))) - 0.55;
    let mx = clamp(c.x, -2.3, 2.3);
    let my = 0.6 + 1.0 * (1.0 - (mx / 2.3) * (mx / 2.3));
    d = min(d, abs(length(c - vec2f(mx, my))) - 0.28);
    let tooth = abs(fract(c.x * 1.3) - 0.5) * 2.0;
    if (abs(c.x) < 2.0 && c.y > 0.6 && c.y < my + 0.1) { d = min(d, tooth * 0.6 - 0.15); }
    return smoothstep(0.15, -0.1, d);
  }
  if (code == 2u) {
    // a handprint: palm, four fingers and a thumb, smudged
    let c = f;
    var d = length((c - vec2f(2.5, 4.7)) / vec2f(1.7, 1.55)) - 1.0;
    d = min(d, segDist(c, vec2f(1.0, 3.6), vec2f(0.6, 0.9)) - 0.42);
    d = min(d, segDist(c, vec2f(2.0, 3.4), vec2f(1.9, 0.1)) - 0.45);
    d = min(d, segDist(c, vec2f(3.0, 3.4), vec2f(3.1, 0.2)) - 0.45);
    d = min(d, segDist(c, vec2f(3.9, 3.6), vec2f(4.4, 1.2)) - 0.4);
    d = min(d, segDist(c, vec2f(1.0, 5.2), vec2f(-0.6, 3.9)) - 0.45);
    let smudge = vnoise(c * 2.3 + h * 17.0);
    return smoothstep(0.2, -0.2, d) * (0.55 + 0.45 * smudge);
  }
  // strokes: round blobs on the lit font pixels, so neighbours join into lines
  let cell = vec2i(floor(f));
  var dm = 9.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = cell + vec2i(i, j);
      if (glyphBit5(code, q.x, q.y)) { dm = min(dm, length(f - (vec2f(q) + 0.5))); }
    }
  }
  var ink = smoothstep(radius + 0.12, radius - 0.12, dm);
  // paint running down from the lowest stroke of a column
  if (drip > 0.0) {
    let x = i32(floor(f.x));
    if (x >= 0 && x <= 4) {
      var low = -1;
      for (var y = 6; y >= 0; y--) { if (glyphBit5(code, x, y)) { low = y; break; } }
      let hc = hash21(vec2f(f32(x), h * 31.0));
      if (low >= 0 && hc < drip * 0.55) {
        let len = (1.5 + 6.0 * hash21(vec2f(h * 7.0, f32(x)))) * drip;
        let t = f.y - (f32(low) + 0.5);
        let wdt = 0.24 * (1.0 - 0.6 * clamp(t / len, 0.0, 1.0));
        if (t > 0.0 && t < len && abs(f.x - (f32(x) + 0.5)) < wdt) { ink = max(ink, 0.9); }
        // a bead at the end of the run
        if (length(vec2f(f.x - (f32(x) + 0.5), (t - len) * 1.2)) < wdt * 1.4) { ink = max(ink, 0.9); }
      }
    }
  }
  return ink;
}
// paint coverage of decal k at world point p on a face with normal n; also its colour
fn writing(k: u32, p: vec3f, n: vec3f, inkCol: ptr<function, vec3f>) -> f32 {
  let D = decals[k];
  if (dot(n.xz, D.c.xy) < 0.9) { return 0.0; }
  let px = D.a.w;
  let cols = i32(D.b.y);
  let rows = i32(D.b.z);
  let rel = p - D.a.xyz;
  let s = dot(rel.xz, vec2f(D.c.y, -D.c.x));    // to the right of a reader facing the wall
  let gx = (s + f32(cols) * 3.0 * px) / px;
  let gy = (f32(rows) * 4.0 * px - rel.y) / px;
  let col = i32(floor(gx / 6.0));
  if (col < 0 || col >= cols || gy < -1.0) { return 0.0; }
  // the line a run of paint started from may be above this point
  var ink = 0.0;
  let rowTop = i32(floor(gy / 8.0));
  for (var r = max(rowTop - 1, 0); r <= min(rowTop, rows - 1); r++) {
    let code = glyphText[FONT_WORDS + u32(D.b.x) + u32(r * cols + col)];
    let h = hash21(vec2f(f32(k) * 13.0 + f32(col), f32(r)));
    // every character a little off: shifted, slanted, smudged
    var f = vec2f(gx - f32(col) * 6.0, gy - f32(r) * 8.0);
    f += (vec2f(h, hash21(vec2f(h, 3.7))) - 0.5) * D.c.z * 2.0;
    f.x += (f.y - 3.5) * (h - 0.5) * D.c.z * 0.5;
    let radius = mix(0.68, 0.74, clamp(D.c.w * 1.5, 0.0, 1.0));
    ink = max(ink, glyphInk(code, f, radius, D.c.w, h));
  }
  // worn and faded in patches
  ink *= (1.0 - D.d.w) * (0.7 + 0.3 * smoothstep(0.3, 0.7, fbm(vec2f(s, rel.y) * 6.0 + f32(k))));
  *inkCol = D.d.rgb;
  return ink;
}
`;

export const SEA_PROPS = SEA_COMMON + EXIT_FONT_WGSL + MATERIALS_WGSL + WRITING_WGSL + /* wgsl */ `
struct Box { c: vec4f, h: vec4f };   // c.xyz centre, c.w material; h.xyz half size, h.w seed
@group(0) @binding(7) var<storage, read> boxes: array<Box>;
@group(0) @binding(10) var<storage, read> lampGlow: array<vec4f>;  // every lamp's colour, by index
fn lampColor(i: u32) -> vec3f { return lampGlow[i].rgb; }

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) rel: vec3f,
  @location(1) @interpolate(flat) n: vec3f,
  @location(2) @interpolate(flat) id: u32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let b = boxes[ii];
  let world = b.c.xyz + cubeCorner(vi) * b.h.xyz;
  var o: VO;
  o.rel = world - F.camPos.xyz;
  o.pos = F.viewProj * vec4f(o.rel, 1.0);
  o.n = cubeNormal(vi);
  o.id = ii;
  return o;
}

fn ceilingTiles(p: vec2f, fw: f32) -> vec3f {
  let tp = vec2f(p.x / 0.625, p.y / 0.625 + 0.5);
  let tile = floor(tp);
  let tf = fract(tp);
  let th = hash21(tile);
  var c = vec3f(0.74, 0.71, 0.58) * (0.95 + 0.1 * vnoise(p * 3.0));
  if (th < 0.18) { c *= vec3f(0.75, 0.62, 0.42) * (0.6 + 0.4 * fbm(p * 6.0)); }
  if (th > 0.93) { c = vec3f(0.02); }
  let gl = min(min(tf.x, 1.0 - tf.x), min(tf.y, 1.0 - tf.y));
  return mix(c, c * 0.5, (1.0 - smoothstep(0.012, 0.025, gl)) * detail(0.015, fw));
}

@fragment fn fs(in: VO, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var b = boxes[in.id];
  var mat = u32(b.c.w);
  var seed = b.h.w;
  // writing: shade the wall it is on exactly as that wall, then paint over it
  var decal = -1;
  if (mat == 10u) {
    decal = i32(seed);
    b = boxes[u32(decals[u32(decal)].b.w)];
    mat = u32(b.c.w);
    seed = b.h.w;
  }
  let p = F.camPos.xyz + in.rel;
  let dist = length(in.rel);
  let V = -in.rel / dist;
  let fw = dist * 2.0 * length(F.camUp.xyz) * F.screen.w;
  var n = in.n;
  let lc = p - b.c.xyz;                   // box-local position
  // along-face coordinate for vertical faces
  let u = select(p.z, p.x, abs(n.z) > 0.5) * select(1.0, -1.0, n.x < -0.5 || n.z > 0.5);
  let top = n.y > 0.5;
  let bottom = n.y < -0.5;
  let water = SG.misc.y;
  var alb = vec3f(0.5);
  var emis = vec3f(0.0);
  var gloss = 0.0;

  if (mat == 0u) {                        // walkway slab
    if (top) {
      alb = carpet(p.xz, fw) * vec3f(0.85, 0.85, 0.8);
      // soaked: darker, and lamps reflect in it
      let soak = smoothstep(0.35, 0.75, fbm(p.xz * 0.5 + 7.0));
      alb *= mix(0.7, 0.45, soak);
      gloss = 0.4 + 0.6 * soak;
    } else {
      // soaked carpet edge over grey concrete, with a green tide stain
      let edge = smoothstep(b.c.y + b.h.y - 0.06, b.c.y + b.h.y - 0.03, p.y);
      alb = mix(vec3f(0.26, 0.25, 0.22), vec3f(0.22, 0.16, 0.08), edge) * (0.75 + 0.5 * vnoise(vec2f(u * 3.0, p.y * 9.0)));
      gloss = 0.6;
    }
  } else if (mat == 1u || mat == 2u) {    // wallpapered wall / pillar
    // half extent of this face along the wall: tiny for the end of a wall
    let faceHalf = select(b.h.x, b.h.z, abs(n.x) > 0.5);
    let yy = p.y - SG.misc.z;             // height above the walkway surface
    if (top || bottom) {
      alb = vec3f(0.16, 0.15, 0.13);
    } else if (mat == 1u && faceHalf < 0.16) {
      // wall end: painted drywall edge
      alb = vec3f(0.6, 0.52, 0.29) * (0.92 + 0.08 * vnoise(vec2f(u * 20.0, p.y * 6.0)));
      gloss = 0.1;
    } else if (mat == 1u && yy > 0.0 && yy < 0.95 && b.c.y - b.h.y < SG.misc.z + 0.01) {
      // wainscot: painted panelling below the chair rail, routed into 60 cm panels
      alb = vec3f(0.47, 0.42, 0.27) * (0.93 + 0.07 * vnoise(vec2f(u * 4.0, yy * 4.0)));
      let pu = fract(u / 0.6 + 0.5);
      let groove = min(pu, 1.0 - pu) * 0.6;
      let inset = min(groove, min(yy - 0.12, 0.95 - yy));   // distance to the panel's border
      alb *= 1.0 - 0.35 * (1.0 - smoothstep(0.004, 0.009, groove)) * detail(0.006, fw);
      alb *= 1.0 - 0.12 * (1.0 - smoothstep(0.05, 0.065, inset)) * smoothstep(0.035, 0.05, inset) * detail(0.01, fw);
      // damp has crept up from the walkway
      alb = mix(alb, alb * vec3f(0.6, 0.55, 0.42), smoothstep(0.45, 0.7, fbm(vec2f(u * 1.3 + seed * 5.0, yy * 3.0))) * (1.0 - smoothstep(0.2, 0.8, yy)));
      gloss = 0.3;
      let along = select(lc.z, lc.x, b.h.x > b.h.z);
      alb *= (0.75 + 0.25 * smoothstep(0.0, 0.3, max(b.h.x, b.h.z) - abs(along))) * (0.8 + 0.2 * smoothstep(0.1, 0.3, yy)) * (0.85 + 0.15 * smoothstep(0.0, 0.08, 0.95 - yy));
    } else {
      alb = wallpaper(u, yy, fw, seed);
      // hung in 53 cm strips: fine seams, and now and then a strip lifting at the top
      let su = u / 0.53;
      let sf = fract(su);
      let seamD = min(sf, 1.0 - sf) * 0.53;
      alb *= 1.0 - 0.2 * (1.0 - smoothstep(0.0, 0.005, seamD)) * detail(0.005, fw);
      let curl = step(0.78, hash21(vec2f(floor(su), seed * 31.0))) * smoothstep(1.7, 2.6, yy)
               * (1.0 - smoothstep(0.0, 0.06 * smoothstep(1.7, 2.6, yy), seamD));
      alb = mix(alb, vec3f(0.80, 0.77, 0.66), curl * 0.8);   // the paper backing shows
      // satin stripes catch the light
      gloss = 0.1 + 0.12 * step(0.5, fract(u / 0.16 + 0.25)) * detail(0.04, fw);
      // contact shadows: at the ends of the wall, under the cap rail, above the baseboard
      let along = select(lc.z, lc.x, b.h.x > b.h.z);
      let ao = (0.72 + 0.28 * smoothstep(0.0, 0.3, max(b.h.x, b.h.z) - abs(along)))
             * (0.78 + 0.22 * smoothstep(0.0, 0.2, b.c.y + b.h.y - p.y))
             * (0.8 + 0.2 * smoothstep(0.1, 0.4, yy + step(yy, -0.05) * 9.0));
      alb *= ao;
    }
  } else if (mat == 3u) {                 // ceiling fragment
    if (bottom) {
      alb = ceilingTiles(p.xz, fw);
      let li = i32(seed);
      if (li >= 0 && abs(lc.x) < 0.625 && abs(lc.z) < 0.3125) {
        let rim = abs(lc.x) > 0.6 || abs(lc.z) > 0.29;
        let L = lampColor(u32(li));
        alb = select(vec3f(0.55, 0.55, 0.5), vec3f(0.35), rim);
        if (!rim) { emis = L * 1.15 * (0.9 + 0.1 * step(0.5, fract(lc.x * 40.0)) * step(0.5, fract(lc.z * 40.0)) * detail(0.012, fw)); }
      }
    } else {
      alb = vec3f(0.2, 0.19, 0.17) * (0.8 + 0.4 * vnoise(p.xz * 2.0));
    }
  } else if (mat == 7u) {                 // cast-iron lamp post
    if (seed > 0.5) {
      // shaft and arm are round bars: bend the normal across the short axes
      let longAx = select(select(2u, 1u, b.h.y >= b.h.z), 0u, b.h.x > b.h.y && b.h.x > b.h.z);
      var q = lc / b.h.xyz;
      q[longAx] = 0.0;
      if (abs(n[longAx]) < 0.5) { n = normalize(n + q * 0.9); }
    }
    alb = vec3f(0.035, 0.045, 0.04) * (0.9 + 0.2 * vnoise(vec2f(u * 8.0, p.y * 3.0)));
    let rust = smoothstep(0.5, 0.0, p.y - SG.misc.z) * smoothstep(0.45, 0.7, fbm(vec2f(u * 6.0, p.y * 10.0)));
    alb = mix(alb, vec3f(0.13, 0.06, 0.025), rust);
    gloss = 0.6 * (1.0 - rust);
  } else if (mat == 8u) {                 // lantern
    let li = i32(seed);
    let L = select(vec3f(0.0), lampColor(u32(max(li, 0))), li >= 0);
    alb = vec3f(0.035, 0.04, 0.038);
    gloss = 0.5;
    if (bottom) {
      alb = vec3f(0.12, 0.11, 0.09);
      emis = L * 0.6;
    } else if (!top) {
      // four glass panes between iron frame bars, a roof band above them
      let t = select(lc.z / b.h.z, lc.x / b.h.x, abs(n.z) > 0.5);
      let fy = lc.y / b.h.y;
      let bar = abs(t) > 0.8 || fy > 0.5 || fy < -0.82 || abs(t) < 0.05;
      if (!bar) {
        // smoked glass: in daylight it is dark, lit only by its own lamp
        alb = vec3f(0.07, 0.065, 0.055);
        gloss = 0.9;
        emis = L * (0.22 + 0.14 * smoothstep(0.5, -0.8, fy));
      }
    }
  } else if (mat == 9u) {                 // trim: baseboards and cap rails
    if (seed < 0.5) {
      // painted wooden baseboard with a groove below its top edge
      alb = vec3f(0.56, 0.5, 0.37);
      let fromTop = b.c.y + b.h.y - p.y;
      if (!top && fromTop > 0.018 && fromTop < 0.028) { alb *= 0.55; }
      gloss = 0.35;
    } else {
      alb = vec3f(0.19, 0.12, 0.065) * (0.85 + 0.3 * vnoise(vec2f(u * 3.0, p.y * 60.0)));
      gloss = 0.45;
    }
  } else if (mat == 4u) {                 // door frame
    alb = vec3f(0.16, 0.10, 0.06) * (0.85 + 0.3 * vnoise(vec2f(u * 2.0, p.y * 30.0)));
    gloss = 0.3;
  } else if (mat == 5u) {                 // exit door
    let along = select(lc.x, lc.z, b.h.x < b.h.z);
    let yy = lc.y;
    let frame = abs(along) > max(b.h.x, b.h.z) - 0.06 || yy > b.h.y - 0.06;
    alb = select(vec3f(0.12, 0.14, 0.12), vec3f(0.05), frame) * (0.85 + 0.15 * fbm(vec2f(along * 6.0, yy * 3.0)));
    if (abs(yy + 0.03) < 0.025 && abs(along) < 0.42) { alb = vec3f(0.3, 0.3, 0.28); gloss = 0.8; }
    gloss = max(gloss, 0.3);
  } else {                                // exit sign
    alb = vec3f(0.05, 0.02, 0.02);
    // the lettered faces are the two large ones
    let face = select(abs(n.z) > 0.5, abs(n.x) > 0.5, b.h.x < b.h.z);
    if (face) {
      // s: to the viewer's right along the sign
      let s = dot(lc.xz, vec2f(n.z, -n.x));
      let g = exitSign(s, lc.y + 2.32);
      if (g >= 0.0) { emis = mix(vec3f(0.3, 0.008, 0.0), vec3f(5.0, 0.13, 0.04), g); }
    }
  }

  if (decal >= 0) {
    var inkCol = vec3f(0.0);
    let ink = writing(u32(decal), p, n, &inkCol);
    alb = mix(alb, inkCol, ink);
    gloss = mix(gloss, 0.35, ink);
  }

  // tide line: soaked, dark and green below the reach of the waves, a ragged splash zone
  // above it, dry higher up
  let reach = water + 0.3 + 0.12 * vnoise(vec2f(u * 2.0, 0.5));
  let wet = 1.0 - smoothstep(reach - 0.08, reach + 0.08, p.y);
  let splash = (1.0 - smoothstep(reach, reach + 0.35, p.y)) * (1.0 - wet) * smoothstep(0.4, 0.7, vnoise(vec2f(u * 9.0, p.y * 14.0)));
  if (!top) {
    alb = mix(alb, alb * vec3f(0.32, 0.38, 0.28) + vec3f(0.0, 0.012, 0.004), wet);
    alb *= 1.0 - 0.3 * splash;
    gloss = max(gloss, max(wet, splash) * 0.8);
  }

  var col = alb * lightAt(p, n) + emis;
  if (gloss > 0.0) { col += gloss * (wetSpec(p, n, V, 0.25) + sunSpec(p, n, V, 0.3)); }
  return vec4f(seaFog(col, in.rel), 1.0);
}
`;

export const SEA_ENTITY = SEA_COMMON + ENTITY_WGSL + /* wgsl */ `
struct EntU { pos: vec4f, p: vec4f, q: vec4f };
// pos.xyz feet, pos.w facing; p: visible, glow, raise, twitch; q: creep, red eyes
@group(0) @binding(7) var<uniform> EU: EntU;
fn entCreep() -> f32 { return EU.q.x; }
fn entPos() -> vec3f { return EU.pos.xyz; }
fn entFacing() -> f32 { return EU.pos.w; }
fn entParams() -> vec4f { return EU.p; }
fn entClock() -> f32 { return SG.misc.x; }

struct VO { @builtin(position) pos: vec4f, @location(0) rel: vec3f };

// a proxy box around the figure; the fragment shader marches the real shape
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let sc = entScale();
  let world = EU.pos.xyz + vec3f(0.0, 1.35 * sc, 0.0) + cubeCorner(vi) * vec3f(1.3, 1.5, 1.3) * sc;
  var o: VO;
  o.rel = world - F.camPos.xyz;
  o.pos = F.viewProj * vec4f(o.rel, 1.0);
  return o;
}

struct FO { @location(0) col: vec4f, @builtin(frag_depth) depth: f32 };

@fragment fn fs(in: VO) -> FO {
  let rd = normalize(in.rel);
  let ro = F.camPos.xyz;
  let t = traceEnt(ro, rd, 1e4);
  if (t < 0.0) { discard; }
  let rel = rd * t;
  let q = entToLocal(ro + rel);
  let n = entLocalToWorldDir(entNormal(q));
  let p = ro + rel;
  var col = vec3f(0.010, 0.009, 0.008) * lightAt(p, n);
  let fres = pow(1.0 - max(dot(n, -rd), 0.0), 4.0);
  col += wetSpec(p, n, -rd, 0.3) * 0.5 + lightAt(p, n) * 0.02 * fres;
  col += mix(vec3f(1.0, 0.96, 0.88), vec3f(1.0, 0.08, 0.03), EU.q.y) * faceGlow(q) * EU.p.y * 5.0;
  // drips off the waterline glisten a little
  col += vec3f(0.6, 0.7, 0.75) * 0.02 * (1.0 - smoothstep(0.0, 0.6, p.y - SG.misc.y + 0.4)) * fres;
  var o: FO;
  o.col = vec4f(seaFog(col, rel), 1.0);
  let clip = F.viewProj * vec4f(rel, 1.0);
  o.depth = clip.z / clip.w;
  return o;
}
`;

// Landmarks on the horizon: wrecks, a drowned tower and colossal figures, each ray-marched
// as a signed distance field inside its own proxy box. The idol is the entity's own shape
// at giant scale (ENTITY_WGSL), carved in black stone.
export const SEA_LANDMARKS = SEA_COMMON + MATERIALS_WGSL + ENTITY_WGSL + /* wgsl */ `
struct Mark { a: vec4f, b: vec4f };   // a: x, y, z, yaw; b: type, scale, seed, creep
@group(0) @binding(7) var<storage, read> marks: array<Mark>;

var<private> gCreep: f32;
var<private> gUV: vec3f;              // surface pattern coordinates of the last map() call
fn entPos() -> vec3f { return vec3f(0.0); }
fn entFacing() -> f32 { return 0.0; }
fn entParams() -> vec4f { return vec4f(1.0, 1.0, 0.0, 0.0); }
fn entClock() -> f32 { return 0.0; }
fn entCreep() -> f32 { return gCreep; }

fn rotX(p: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
fn rotY(p: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
fn rotZ(p: vec3f, a: f32) -> vec3f { let c = cos(a); let s = sin(a); return vec3f(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }
fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}
fn sdRoundBox(p: vec3f, b: vec3f, r: f32) -> f32 { return sdBox(p, b - vec3f(r)) - r; }
fn sdCyl(p: vec3f, h: f32, r: f32) -> f32 {
  let d = abs(vec2f(length(p.xz), p.y)) - vec2f(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
}
// cone from radius r1 at y = -h to r2 at y = +h
fn sdCapCone(p: vec3f, h: f32, r1: f32, r2: f32) -> f32 {
  let q = vec2f(length(p.xz), p.y);
  let k1 = vec2f(r2, h);
  let k2 = vec2f(r2 - r1, 2.0 * h);
  let ca = vec2f(q.x - min(q.x, select(r2, r1, q.y < 0.0)), abs(q.y) - h);
  let cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
  let s = select(1.0, -1.0, cb.x < 0.0 && ca.y < 0.0);
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}

// materials
const LM_RUST: f32 = 1.0;
const LM_PAINT: f32 = 2.0;
const LM_BLACK: f32 = 3.0;
const LM_HULLW: f32 = 4.0;
const LM_DARK: f32 = 5.0;
const LM_CONCRETE: f32 = 6.0;
const LM_STONE: f32 = 7.0;
const LM_HOLLOW: f32 = 8.0;
const LM_BASALT: f32 = 9.0;

fn pick(a: vec2f, d: f32, m: f32) -> vec2f { return select(a, vec2f(d, m), d < a.x); }

// a freighter, listing hard, bow lifted, the stern under water
fn ship(p0: vec3f) -> vec2f {
  let p = rotZ(rotX(p0 - vec3f(0.0, 2.0, 0.0), -0.1), 0.32);
  gUV = vec3f(p.z, p.y, p.x);
  let taper = 1.0 - 0.85 * smoothstep(14.0, 33.0, p.z);
  var r = vec2f(sdRoundBox(vec3f(p.x / taper, p.y, p.z), vec3f(5.0, 4.5, 32.0), 1.4) * taper * 0.9, LM_RUST);
  r = pick(r, sdRoundBox(p - vec3f(0.0, 7.6, -17.0), vec3f(4.2, 3.2, 6.0), 0.3), LM_PAINT);
  r = pick(r, sdBox(p - vec3f(0.0, 11.6, -14.5), vec3f(3.6, 1.0, 2.6)), LM_PAINT);
  r = pick(r, sdCyl(p - vec3f(0.0, 13.0, -21.5), 3.2, 1.6), LM_BLACK);
  r = pick(r, sdCapsule(p, vec3f(0.0, 4.0, 12.0), vec3f(0.0, 18.0, 12.0), 0.25), LM_BLACK);
  r = pick(r, sdCapsule(p, vec3f(0.0, 15.0, 12.0), vec3f(0.0, 9.0, 22.0), 0.18), LM_BLACK);
  return r;
}

// an airliner gone in nose first, rolled onto the wing it still has
fn plane(p0: vec3f) -> vec2f {
  let p = rotZ(rotX(p0 - vec3f(0.0, 5.5, 0.0), 0.38), -0.5);
  gUV = vec3f(p.z, p.y, p.x);
  var r = vec2f(sdCapsule(p, vec3f(0.0, 0.0, -17.0), vec3f(0.0, 0.0, 16.0), 2.1), LM_HULLW);
  r = pick(r, sdBox(rotY(p - vec3f(-8.5, -0.7, 1.0), -0.42), vec3f(8.0, 0.22, 2.4)), LM_HULLW);
  r = pick(r, sdBox(rotX(p - vec3f(0.0, 3.6, -15.2), 0.5), vec3f(0.22, 3.4, 1.9)), LM_DARK);
  r = pick(r, sdBox(p - vec3f(-2.5, 0.6, -16.2), vec3f(3.2, 0.16, 1.3)), LM_HULLW);
  r = pick(r, sdCapsule(p, vec3f(-5.5, -1.9, 3.2), vec3f(-5.5, -1.9, 0.0), 0.95), LM_DARK);
  // the torn-off stub of the other wing
  r = pick(r, sdBox(rotY(p - vec3f(3.2, -0.7, 1.0), 0.42), vec3f(1.6, 0.22, 2.2)), LM_HULLW);
  return r;
}

// an office tower, tilted, its top broken off and a gash torn in one side
fn tower(p0: vec3f, seed: f32) -> vec2f {
  let p = rotX(rotZ(p0 - vec3f(0.0, 18.0, 0.0), 0.1 + 0.12 * seed), 0.07);
  gUV = vec3f(select(p.z, p.x, abs(p.z) > abs(p.x)), p.y, 0.0);
  var d = sdBox(p, vec3f(9.0, 30.0, 9.0));
  d = max(d, p.y - (27.0 - 6.0 * vnoise(p.xz * 0.35 + seed * 10.0)));
  d = max(d, -sdBox(p - vec3f(9.0, 10.0 + 8.0 * seed, 1.5), vec3f(3.0, 3.5 + 2.0 * vnoise(p.yz * 0.5), 4.5)));
  return vec2f(d, LM_CONCRETE);
}

// a colossal stone head, half sunk, tilted back, eyes and mouth hollow
fn head(p0: vec3f) -> vec2f {
  let p = rotZ(rotX(p0 - vec3f(0.0, 2.5, 0.0), 0.22), 0.18);
  gUV = p;
  var d = sdEllipsoid(p, vec3f(6.0, 8.0, 6.8));
  d = smin(d, sdCapsule(p, vec3f(0.0, 1.8, 6.0), vec3f(0.0, -1.6, 7.1), 1.0), 0.8);
  let eyes = min(length(p - vec3f(-2.3, 2.2, 5.9)), length(p - vec3f(2.3, 2.2, 5.9))) - 1.4;
  d = max(d, -eyes);
  let mouth = sdEllipsoid(p - vec3f(0.0, -3.6, 6.1), vec3f(2.3, 0.75, 2.0));
  d = max(d, -mouth);
  return vec2f(d, select(LM_STONE, LM_HOLLOW, min(eyes, mouth) < 0.25));
}

// a hooded figure on a plinth, head bowed, hands clasped; it turns to watch you
fn statue(p0: vec3f) -> vec2f {
  let p = p0;
  gUV = p;
  var r = vec2f(sdBox(p - vec3f(0.0, -1.0, 0.0), vec3f(4.0, 2.5, 4.0)), LM_STONE);
  var b = sdCapCone(p - vec3f(0.0, 6.5, 0.0), 5.0, 3.2, 1.5);
  b = smin(b, sdEllipsoid(p - vec3f(0.0, 11.2, 0.0), vec3f(2.3, 1.2, 1.7)), 0.6);
  let hp = rotX(p - vec3f(0.0, 12.6, 0.4), 0.45);
  var hood = sdEllipsoid(hp, vec3f(1.6, 2.0, 1.8));
  let face = sdEllipsoid(hp - vec3f(0.0, -0.3, 1.25), vec3f(1.0, 1.3, 0.9));
  hood = max(hood, -face);
  b = smin(b, hood, 0.4);
  b = smin(b, sdCapsule(p, vec3f(-1.3, 9.2, 1.0), vec3f(-0.1, 7.6, 1.9), 0.55), 0.4);
  b = smin(b, sdCapsule(p, vec3f(1.3, 9.2, 1.0), vec3f(0.1, 7.6, 1.9), 0.55), 0.4);
  r = pick(r, b, select(LM_STONE, LM_HOLLOW, face > -0.35 && face < 0.2 && hp.z > 0.6));
  return r;
}

// a stone hand reaching up out of the sea, fingers half curled
fn hand(p0: vec3f) -> vec2f {
  let p = rotZ(p0, 0.15);
  gUV = p;
  var d = sdCapsule(p, vec3f(0.0, -8.0, 0.0), vec3f(0.0, 1.5, 0.0), 1.5);
  d = smin(d, sdRoundBox(p - vec3f(0.0, 3.2, 0.0), vec3f(1.9, 2.0, 0.7), 0.5), 0.8);
  for (var i = 0; i < 4; i++) {
    let x = (f32(i) - 1.5) * 1.05;
    let len = (3.6 - abs(f32(i) - 1.4) * 0.5) * (1.0 + 0.6 * gCreep);
    let k1 = vec3f(x * 1.08, 5.0 + len, 0.6 + 0.3 * f32(i % 2));
    d = smin(d, sdCapsule(p, vec3f(x, 4.8, 0.0), k1, 0.45), 0.3);
    d = smin(d, sdCapsule(p, k1, k1 + vec3f(x * 0.05, 1.4, 1.6), 0.4), 0.2);
  }
  d = smin(d, sdCapsule(p, vec3f(1.9, 2.4, 0.3), vec3f(3.6, 5.0, 1.5), 0.55), 0.4);
  return vec2f(d, LM_STONE);
}

fn markMap(q: vec3f, t: u32, seed: f32) -> vec2f {
  switch (t) {
    case 0u: { return ship(q); }
    case 1u: { return plane(q); }
    case 2u: { return tower(q, seed); }
    case 3u: { return head(q); }
    case 4u: { return statue(q); }
    case 5u: { return hand(q); }
    default: { gUV = q; return vec2f(entSdf(q), LM_BASALT); }
  }
}
// local bounds per type: horizontal radius, lowest and highest y (before scaling)
fn markBounds(t: u32) -> vec3f {
  switch (t) {
    case 0u: { return vec3f(38.0, -9.0, 24.0); }
    case 1u: { return vec3f(24.0, -6.0, 22.0); }
    case 2u: { return vec3f(19.0, -14.0, 52.0); }
    case 3u: { return vec3f(11.0, -7.0, 14.0); }
    case 4u: { return vec3f(6.0, -4.0, 16.0); }
    case 5u: { return vec3f(7.0, -9.0, 14.0); }
    default: { return vec3f(1.4, -0.2, 2.7); }
  }
}

struct VO { @builtin(position) pos: vec4f, @location(0) rel: vec3f, @location(1) @interpolate(flat) id: u32 };

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let m = marks[ii];
  let bnd = markBounds(u32(m.b.x));
  let c = cubeCorner(vi);
  let local = vec3f(c.x * bnd.x, mix(bnd.y, bnd.z, c.y * 0.5 + 0.5), c.z * bnd.x) * m.b.y;
  var o: VO;
  o.rel = m.a.xyz + local - F.camPos.xyz;
  o.pos = F.viewProj * vec4f(o.rel, 1.0);
  o.id = ii;
  return o;
}

struct FO { @location(0) col: vec4f, @builtin(frag_depth) depth: f32 };

@fragment fn fs(in: VO) -> FO {
  let m = marks[in.id];
  let t = u32(m.b.x);
  let sc = m.b.y;
  let seed = m.b.z;
  gCreep = m.b.w;
  let bnd = markBounds(t) * sc;
  let ro = F.camPos.xyz;
  let rd = normalize(in.rel);
  // enter and leave the proxy box
  let bmin = m.a.xyz + vec3f(-bnd.x, bnd.y, -bnd.x);
  let bmax = m.a.xyz + vec3f(bnd.x, bnd.z, bnd.x);
  let inv = 1.0 / rd;
  let ta = (bmin - ro) * inv;
  let tb = (bmax - ro) * inv;
  let t0 = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), min(ta.z, tb.z));
  let t1 = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z));
  var tt = max(t0, 0.0);
  var hit = false;
  var q = vec3f(0.0);
  // stop once within a fraction of a pixel; far away that is a long way
  let pix = 2.0 * length(F.camUp.xyz) * F.screen.w;
  for (var i = 0; i < 56; i++) {
    if (tt > t1) { break; }
    q = rotY(ro + rd * tt - m.a.xyz, -m.a.w) / sc;
    let d = markMap(q, t, seed).x * sc;
    if (d < 0.6 * pix * tt) { hit = true; break; }
    tt += max(d, 0.5 * pix * tt);
  }
  if (!hit) { discard; }
  let res = markMap(q, t, seed);
  let uv = gUV;
  let e = vec2f(0.01, -0.01);
  let nl = normalize(e.xyy * markMap(q + e.xyy, t, seed).x + e.yyx * markMap(q + e.yyx, t, seed).x +
                     e.yxy * markMap(q + e.yxy, t, seed).x + e.xxx * markMap(q + e.xxx, t, seed).x);
  let n = rotY(nl, m.a.w);
  let rel = rd * tt;
  let p = ro + rel;

  // ---- materials ----
  let mat = res.y;
  var alb = vec3f(0.3);
  var emis = vec3f(0.0);
  var gloss = 0.0;
  if (mat == LM_RUST) {
    alb = mix(vec3f(0.24, 0.085, 0.035), vec3f(0.11, 0.06, 0.04), fbm(uv.xy * 0.25 + seed * 9.0));
    alb *= 0.75 + 0.35 * vnoise(vec2f(uv.x * 1.5, uv.y * 0.15));          // streaks running down
    gloss = 0.15;
  } else if (mat == LM_PAINT) {
    alb = vec3f(0.5, 0.47, 0.41) * (0.7 + 0.3 * fbm(uv.xy * 0.5));
    alb = mix(alb, vec3f(0.22, 0.09, 0.04), smoothstep(0.55, 0.75, vnoise(vec2f(uv.x * 2.0, uv.y * 0.3))) * 0.8);
    if (fract(uv.y / 2.2) > 0.55 && fract(uv.y / 2.2) < 0.8 && fract(uv.x / 1.6) < 0.5) { alb = vec3f(0.02); gloss = 0.6; }
  } else if (mat == LM_BLACK) {
    alb = vec3f(0.035);
  } else if (mat == LM_HULLW) {
    alb = vec3f(0.6, 0.61, 0.6) * (0.75 + 0.25 * fbm(uv.xy * 0.4 + seed));
    if (abs(uv.y - 0.7) < 0.28 && fract(uv.x / 0.9) < 0.38 && abs(uv.z) > 1.5) { alb = vec3f(0.02); gloss = 0.7; }
    gloss = max(gloss, 0.25);
  } else if (mat == LM_DARK) {
    alb = vec3f(0.08, 0.085, 0.09);
  } else if (mat == LM_CONCRETE) {
    alb = vec3f(0.34, 0.33, 0.31) * (0.75 + 0.3 * fbm(uv.xy * 0.2 + seed * 5.0));
    let cell = floor(vec2f(uv.x / 2.4, uv.y / 3.6));
    let f = fract(vec2f(uv.x / 2.4, uv.y / 3.6));
    if (f.x > 0.15 && f.x < 0.85 && f.y > 0.3 && f.y < 0.85) {
      alb = vec3f(0.025, 0.028, 0.03);
      gloss = 0.5;
      // a few rooms still have the lights on
      let h = hash21(cell + seed * 37.0);
      if (h > 0.985 - 0.05 * gCreep) {
        let fl = select(1.0, 0.15, sin(SG.misc.x * (3.0 + h * 40.0)) > 0.85);
        // deeper down the lights left on in the towers are red
        let red = step(0.5, hash21(cell + 7.0)) * smoothstep(0.3, 0.8, gCreep);
        emis = mix(vec3f(1.0, 0.85, 0.55), vec3f(1.0, 0.05, 0.02), red) * 0.35 * fl;
      }
    }
  } else if (mat == LM_STONE) {
    alb = vec3f(0.33, 0.33, 0.3) * (0.7 + 0.35 * fbm(uv.xy * 0.3 + uv.zz * 0.2));
    alb = mix(alb, vec3f(0.12, 0.17, 0.09), smoothstep(0.55, 0.75, fbm(uv.xz * 0.25 + uv.yy * 0.1 + 3.0)) * 0.7);
    // deeper down the stone faces weep: dark red streaks running from the eyes and mouth
    if ((t == 3u || t == 4u) && gCreep > 0.25 && uv.z > 0.0) {
      let src = select(vec2f(2.3, 2.2), vec2f(0.55, 12.6), t == 4u);
      let sx = abs(abs(uv.x) - src.x);
      let run = (src.y - uv.y) / (4.0 + 6.0 * hash21(vec2f(floor(uv.x * 3.0), 1.0)));
      let streak = (1.0 - smoothstep(0.08, 0.3, sx)) * step(0.0, run) * (1.0 - smoothstep(0.6, 1.0, run));
      alb = mix(alb, vec3f(0.16, 0.012, 0.01), streak * smoothstep(0.25, 0.7, gCreep));
    }
  } else if (mat == LM_HOLLOW) {
    alb = vec3f(0.01);
    // something is looking out of the dark, deeper down: first a glint, then a steady glow
    let glint = smoothstep(0.6, 0.95, hash21(floor(uv.xy * 0.8)));
    emis = vec3f(1.0, 0.1, 0.03) * (0.5 * glint * smoothstep(0.2, 0.5, gCreep) + 0.9 * smoothstep(0.5, 0.9, gCreep));
  } else {
    alb = vec3f(0.03, 0.03, 0.032);
    gloss = 0.5;
    emis = mix(vec3f(1.0, 0.96, 0.88), vec3f(1.0, 0.08, 0.03), 0.4 + 0.6 * gCreep) * faceGlow(q) * 4.0;
  }
  // stained dark and green where the sea has been
  let wet = 1.0 - smoothstep(0.5, 3.5, p.y);
  alb = mix(alb, alb * vec3f(0.35, 0.42, 0.32), wet);

  var col = alb * lightAt(p, n) + emis;
  col += gloss * (sunSpec(p, n, -rd, 0.3) + wetSpec(p, n, -rd, 0.3));
  var o: FO;
  o.col = vec4f(seaFog(col, rel), 1.0);
  let clip = F.viewProj * vec4f(rel, 1.0);
  o.depth = clip.z / clip.w;
  return o;
}
`;
