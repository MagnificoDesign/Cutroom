import { trackMotion } from './motion.mjs?v=15';
import { srgbToLinear, linearToSrgb } from './color.mjs?v=15';

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
export function transformPoint(t, x, y) {
  const c = Math.cos(t.angle) * t.scale, s = Math.sin(t.angle) * t.scale;
  return [c * x - s * y + t.tx, s * x + c * y + t.ty];
}
export function inverseTransform(t) {
  const c = Math.cos(t.angle) / t.scale, s = Math.sin(t.angle) / t.scale;
  return { scale: 1 / t.scale, angle: -t.angle, tx: -c * t.tx - s * t.ty, ty: s * t.tx - c * t.ty };
}
export function fitTransform(tracks, aspect = 16 / 9) {
  if (tracks.length < 24) return null;
  const points = tracks.map(p => ({ x: p.x / 96 - .5, y: (p.y / 54 - .5) / aspect,
    u: (p.x + p.dx) / 96 - .5, v: ((p.y + p.dy) / 54 - .5) / aspect }));
  let selected = points, result;
  for (let pass = 0; pass < 4; pass++) {
    const average = key => selected.reduce((s, p) => s + p[key], 0) / selected.length;
    const mx = average('x'), my = average('y'), mu = average('u'), mv = average('v');
    let aa = 0, bb = 0, denom = 0;
    for (const p of selected) {
      const x = p.x - mx, y = p.y - my, u = p.u - mu, v = p.v - mv;
      aa += x * u + y * v; bb += x * v - y * u; denom += x * x + y * y;
    }
    if (denom < .01) return null;
    aa /= denom; bb /= denom;
    result = { scale: Math.hypot(aa, bb), angle: Math.atan2(bb, aa), tx: mu - aa * mx + bb * my, ty: mv - bb * mx - aa * my };
    selected = points.filter(p => { const [x, y] = transformPoint(result, p.x, p.y); return Math.hypot(x - p.u, y - p.v) < .004; });
    if (selected.length < points.length * .88 || selected.length < 24) return null;
  }
  const covered = new Set(selected.map(p => `${Math.min(3, Math.floor((p.x + .5) * 4))}:${Math.min(2, Math.floor((p.y * aspect + .5) * 3))}`));
  return covered.size >= 8 ? result : null;
}
function halfTransform(t) {
  const scale = Math.sqrt(t.scale), angle = t.angle / 2, c = scale * Math.cos(angle), s = scale * Math.sin(angle), d = (1 + c) ** 2 + s * s;
  return { scale, angle, tx: ((1 + c) * t.tx + s * t.ty) / d, ty: (-s * t.tx + (1 + c) * t.ty) / d };
}
function coverZoom(t, aspect) {
  const c = Math.cos(t.angle), s = Math.sin(t.angle), dx = Math.abs(c * t.tx + s * t.ty), dy = Math.abs(-s * t.tx + c * t.ty);
  return Math.max(1, (Math.abs(c) * .5 + Math.abs(s) * .5 / aspect) / (t.scale * .5 - dx),
    (Math.abs(s) * .5 + Math.abs(c) * .5 / aspect) / (t.scale * .5 / aspect - dy));
}
function pixel(image, x, y, c) {
  x = clamp(x, 0, image.width - 1); y = clamp(y, 0, image.height - 1);
  const ix = Math.floor(x), iy = Math.floor(y), jx = Math.min(ix + 1, image.width - 1), jy = Math.min(iy + 1, image.height - 1), fx = x - ix, fy = y - iy;
  const at = (x, y) => image.data[(y * image.width + x) * 4 + c] / 255;
  return (at(ix, iy) * (1 - fx) + at(jx, iy) * fx) * (1 - fy) + (at(ix, jy) * (1 - fx) + at(jx, jy) * fx) * fy;
}
function pairs(a, b, t, aspect, step = 2) {
  const out = [];
  for (let y = 3; y < a.height - 3; y += step) for (let x = 3; x < a.width - 3; x += step) {
    const [u, v] = transformPoint(t, (x + .5) / a.width - .5, ((y + .5) / a.height - .5) / aspect);
    const xx = (u + .5) * b.width - .5, yy = (v * aspect + .5) * b.height - .5;
    if (xx < 2 || yy < 2 || xx >= b.width - 2 || yy >= b.height - 2) continue;
    out.push({ x, y, a: [0, 1, 2].map(c => pixel(a, x, y, c)), b: [0, 1, 2].map(c => pixel(b, xx, yy, c)) });
  }
  return out;
}
function matchingError(values, gains, width, height) {
  let total = 0, bad = 0; const tiles = Array.from({ length: 48 }, () => []);
  for (const p of values) {
    const error = p.a.reduce((sum, v, c) => sum + Math.abs(v - linearToSrgb(clamp(srgbToLinear(p.b[c]) * gains[c]))), 0) / 3;
    total += error; if (error > .10) bad++;
    tiles[Math.min(5, Math.floor(p.y / height * 6)) * 8 + Math.min(7, Math.floor(p.x / width * 8))].push(error);
  }
  return { mean: total / Math.max(1, values.length), bad: bad / Math.max(1, values.length),
    local: Math.max(...tiles.map(v => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)) };
}
const reliable = field => field.confidence >= .88 && field.tracks.length >= 40;

export function chooseFinishing(a, b, aspect = 16 / 9) {
  if (a.length < 3 || b.length < 3) return null;
  const left = a.at(-1), right = b[0];
  const before = trackMotion(a.at(-3).pixels, left.pixels), after = trackMotion(right.pixels, b[2].pixels);
  const field = trackMotion(left.pixels, right.pixels, { step: 5 });
  if (![before, after, field].every(reliable)) return null;
  const speedA = Math.hypot(before.x, before.y), speedB = Math.hypot(after.x, after.y);
  if (Math.max(speedA, speedB) > .18) return null; // Keep deliberate movement; this correction is for nearly still shots.
  const t = fitTransform(field.tracks, aspect);
  if (!t || Math.abs(t.angle) > Math.PI / 180 * .8 || Math.abs(Math.log(t.scale)) > .015 || Math.hypot(t.tx, t.ty) > .012) return null;
  const values = pairs(left.image, right.image, t, aspect);
  if (values.length < 400) return null;
  const logs = [0, 1, 2].map(c => values.filter(p => p.a[c] > .12 && p.a[c] < .88 && p.b[c] > .12 && p.b[c] < .88)
    .map(p => Math.log(srgbToLinear(p.a[c]) / srgbToLinear(p.b[c]))));
  if (logs.some(v => v.length < 250)) return null;
  const gainLogs = logs.map(median);
  if (gainLogs.some(g => Math.abs(g) > .20) || Math.max(...gainLogs) - Math.min(...gainLogs) > .12) return null;
  // A change must be stable for several source frames; flashes and auto-exposure
  // swings within either shot must not create a new correction at the cut.
  const level = frame => frame.image.data.reduce((s, v, i) => s + (i % 4 < 3 ? v : 0), 0) / (frame.image.width * frame.image.height * 3 * 255);
  if (Math.abs(level(a.at(-3)) - level(left)) > .025 || Math.abs(level(b[2]) - level(right)) > .025) return null;
  const gains = gainLogs.map(Math.exp), error = matchingError(values, gains, left.image.width, left.image.height);
  if (error.mean > .022 || error.bad > .006 || error.local > .055) return null;
  const movement = Math.hypot(t.tx, t.ty) + Math.abs(t.angle) / 3 + Math.abs(Math.log(t.scale)) / 3;
  const colorChange = Math.max(...gainLogs.map(Math.abs));
  const align = movement >= .0015, color = colorChange >= .025;
  if (!align && !color) return null;
  const identity = { scale: 1, angle: 0, tx: 0, ty: 0 };
  const half = align ? halfTransform(t) : identity, inverse = inverseTransform(half);
  const zoom = Math.max(coverZoom(half, aspect), coverZoom(inverse, aspect)) + (align ? .001 : 0);
  if (!Number.isFinite(zoom) || zoom > 1.035) return null;
  return { transform: t, gains, align, color, zoom, aspect, error,
    out: { ...half, zoom, gains: gainLogs.map(g => color ? Math.exp(-g / 2) : 1) },
    in: { ...inverse, zoom, gains: gainLogs.map(g => color ? Math.exp(g / 2) : 1) } };
}

export function validateFinishing(candidate, a, b) {
  const values = pairs(a, b, candidate.transform, candidate.aspect, Math.max(1, Math.floor(Math.max(a.width, a.height) / 384)));
  const after = matchingError(values, candidate.gains, a.width, a.height);
  const before = matchingError(pairs(a, b, { scale: 1, angle: 0, tx: 0, ty: 0 }, candidate.aspect,
    Math.max(1, Math.floor(Math.max(a.width, a.height) / 384))), [1, 1, 1], a.width, a.height);
  return values.length > 100 && after.mean < .025 && after.bad < .008 && after.local < .065 && after.mean < before.mean * .7;
}

export function finishingAt(effect, weight) {
  const w = .5 - .5 * Math.cos(Math.PI * clamp(weight));
  return { scale: effect.scale ** w, angle: effect.angle * w, tx: effect.tx * w, ty: effect.ty * w,
    zoom: 1 + (effect.zoom - 1) * w, gains: effect.gains.map(g => g ** w) };
}

export function drawFinishing(source, target, effect) {
  const context = target.getContext('2d', { alpha: false, colorSpace: 'srgb' }), { width, height } = target;
  context.save(); context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
  context.translate(width / 2, height / 2); context.scale(effect.zoom, effect.zoom);
  context.translate(effect.tx * width, effect.ty * width); context.rotate(effect.angle); context.scale(effect.scale, effect.scale);
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  context.drawImage(source, -width / 2, -height / 2); context.restore();
}
