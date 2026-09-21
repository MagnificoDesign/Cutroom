import { trackMotion } from './motion.mjs?v=14';

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 0;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const WIDTH = 96, HEIGHT = 54;

// Smoothly interpolate the measured motion field, keeping separate forward and
// backward maps. Endpoint warps are checked before any generated frame is used.
export function motionGrid(field) {
  const width = 25, height = 15, x = new Float32Array(width * height), y = new Float32Array(width * height);
  for (let gy = 0; gy < height; gy++) for (let gx = 0; gx < width; gx++) {
    const px = gx / (width - 1) * (WIDTH - 1), py = gy / (height - 1) * (HEIGHT - 1);
    const nearest = field.tracks.map(p => ({ p, d: (p.x - px) ** 2 + (p.y - py) ** 2 })).sort((a, b) => a.d - b.d).slice(0, 4);
    let sum = 0;
    for (const { p, d } of nearest) { const w = 1 / (2 + d); sum += w; x[gy * width + gx] += p.dx * w / WIDTH; y[gy * width + gx] += p.dy * w / HEIGHT; }
    if (sum) { x[gy * width + gx] /= sum; y[gy * width + gx] /= sum; }
  }
  return { width, height, x, y };
}

function fieldAt(field, x, y, component) {
  x = clamp(x) * (field.width - 1); y = clamp(y) * (field.height - 1);
  const ix = Math.floor(x), iy = Math.floor(y), jx = Math.min(ix + 1, field.width - 1), jy = Math.min(iy + 1, field.height - 1);
  const fx = x - ix, fy = y - iy, data = field[component];
  return (data[iy * field.width + ix] * (1 - fx) + data[iy * field.width + jx] * fx) * (1 - fy)
    + (data[jy * field.width + ix] * (1 - fx) + data[jy * field.width + jx] * fx) * fy;
}

function rgbaAt(image, x, y, c) {
  x = clamp(x, 0, image.width - 1); y = clamp(y, 0, image.height - 1);
  const ix = Math.floor(x), iy = Math.floor(y), jx = Math.min(ix + 1, image.width - 1), jy = Math.min(iy + 1, image.height - 1);
  const fx = x - ix, fy = y - iy, p = image.data;
  return (p[(iy * image.width + ix) * 4 + c] * (1 - fx) + p[(iy * image.width + jx) * 4 + c] * fx) * (1 - fy)
    + (p[(jy * image.width + ix) * 4 + c] * (1 - fx) + p[(jy * image.width + jx) * 4 + c] * fx) * fy;
}

export function easeTime(t, m0, m1) {
  return (-2 * t ** 3 + 3 * t ** 2) + m0 * (t ** 3 - 2 * t ** 2 + t) + m1 * (t ** 3 - t ** 2);
}

// Invert each forward map at the requested intermediate position. Two fixed
// point steps are sufficient only for the small, well-behaved motions admitted
// by chooseBridge; this is deliberately not a general scene morph.
function warpedCoordinates(bridge, x, y, width, height, t) {
  const nx = x / Math.max(1, width - 1), ny = y / Math.max(1, height - 1);
  let ax = nx, ay = ny, bx = nx, by = ny;
  for (let i = 0; i < 2; i++) {
    const adx = fieldAt(bridge.forward, ax, ay, 'x'), ady = fieldAt(bridge.forward, ax, ay, 'y');
    const bdx = fieldAt(bridge.backward, bx, by, 'x'), bdy = fieldAt(bridge.backward, bx, by, 'y');
    ax = nx - t * adx; ay = ny - t * ady;
    bx = nx - (1 - t) * bdx; by = ny - (1 - t) * bdy;
  }
  return { ax: ax * (width - 1), ay: ay * (height - 1), bx: bx * (width - 1), by: by * (height - 1),
    validA: ax >= 0 && ay >= 0 && ax <= 1 && ay <= 1, validB: bx >= 0 && by >= 0 && bx <= 1 && by <= 1 };
}

function warpRows(bridge, a, b, t, out, first, last) {
  const { width, height } = a;
  for (let y = first; y < last; y++) for (let x = 0; x < width; x++) {
    const p = warpedCoordinates(bridge, x, y, width, height, t), at = (y * width + x) * 4;
    const weight = !p.validA && p.validB ? 1 : p.validA && !p.validB ? 0 : t;
    for (let c = 0; c < 3; c++) out[at + c] = rgbaAt(a, p.ax, p.ay, c) * (1 - weight) + rgbaAt(b, p.bx, p.by, c) * weight;
    out[at + 3] = 255;
  }
}

export function interpolateSmall(bridge, a, b, fraction) {
  const out = new Uint8ClampedArray(a.width * a.height * 4);
  warpRows(bridge, a, b, easeTime(fraction, bridge.m0, bridge.m1), out, 0, a.height);
  return { data: out, width: a.width, height: a.height };
}

export async function interpolateFrame(bridge, a, b, fraction, signal) {
  signal?.throwIfAborted();
  const out = new Uint8ClampedArray(a.width * a.height * 4), t = easeTime(fraction, bridge.m0, bridge.m1);
  for (let y = 0; y < a.height; y += 16) {
    signal?.throwIfAborted();
    warpRows(bridge, a, b, t, out, y, Math.min(a.height, y + 16));
    // Lock/Cancel must interrupt even a high-resolution, software-only warp.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return { data: out, width: a.width, height: a.height };
}

export async function validateBridgeImages(bridge, a, b, signal) {
  // Inspect actual output-resolution color samples before accepting the warp.
  // Fine detail can disagree even when the 96×54 motion thumbnails agree.
  const step = Math.max(1, Math.floor(Math.max(a.width, a.height) / 384));
  const width = Math.ceil(a.width / step), height = Math.ceil(a.height / step), errors = new Float32Array(width * height);
  let sum = 0, count = 0, bad = 0;
  for (let y = 0; y < height; y++) {
    if (!(y % 12)) { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 0)); }
    for (let x = 0; x < width; x++) {
      const p = warpedCoordinates(bridge, x * step, y * step, a.width, a.height, .5);
      if (!p.validA || !p.validB) continue;
      let error = 0;
      for (let c = 0; c < 3; c++) error += Math.abs(rgbaAt(a, p.ax, p.ay, c) - rgbaAt(b, p.bx, p.by, c)) / (3 * 255);
      errors[y * width + x] = error; sum += error; count++; if (error > .09) bad++;
    }
  }
  signal?.throwIfAborted();
  return count > width * height * .85 && sum / count <= .025 && bad / count <= .012 && worstPatch(errors, width, height) <= .13;
}

// A matched source-frame cut may tolerate small appearance differences. This
// test never authorizes synthesizing pictures: interpolation retains its stricter
// validation above. Subtract only a small, global color offset when comparing;
// local subject changes must still pass the residual and worst-patch checks.
export async function validateMatchImages(field, a, b, signal) {
  if (a.width !== b.width || a.height !== b.height) return false;
  const step = Math.max(1, Math.floor(Math.max(a.width, a.height) / 384));
  const width = Math.ceil(a.width / step), height = Math.ceil(a.height / step);
  const differences = new Float32Array(width * height * 3), valid = new Uint8Array(width * height);
  const histograms = Array.from({ length: 3 }, () => new Uint32Array(511));
  let count = 0;
  for (let y = 0; y < height; y++) {
    if (!(y % 12)) { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 0)); }
    for (let x = 0; x < width; x++) {
      const p = warpedCoordinates(field, x * step, y * step, a.width, a.height, .5), i = y * width + x;
      if (!p.validA || !p.validB) continue;
      valid[i] = 1; count++;
      for (let c = 0; c < 3; c++) {
        const difference = rgbaAt(a, p.ax, p.ay, c) - rgbaAt(b, p.bx, p.by, c);
        differences[i * 3 + c] = difference / 255;
        histograms[c][Math.round(difference) + 255]++;
      }
    }
  }
  if (count <= width * height * .85) return false;
  const bias = histograms.map(histogram => {
    let n = 0;
    for (let i = 0; i < histogram.length; i++) { n += histogram[i]; if (n >= count / 2) return (i - 255) / 255; }
    return 0;
  });
  if (bias.some(value => Math.abs(value) > .05) || Math.max(...bias) - Math.min(...bias) > .04) return false;
  const errors = new Float32Array(width * height);
  let total = 0, bad = 0;
  for (let i = 0; i < valid.length; i++) if (valid[i]) {
    let error = 0;
    for (let c = 0; c < 3; c++) error += Math.abs(differences[i * 3 + c] - bias[c]) / 3;
    errors[i] = error; total += error; if (error > .14) bad++;
  }
  signal?.throwIfAborted();
  return total / count <= .04 && bad / count <= .025 && worstPatch(errors, width, height) <= .18;
}

function alignedError(bridge, a, b) {
  const errors = [], tiles = Array.from({ length: 48 }, () => []), patches = new Float32Array(a.width * a.height);
  for (let y = 2; y < a.height - 2; y++) for (let x = 2; x < a.width - 2; x++) {
    const p = warpedCoordinates(bridge, x, y, a.width, a.height, .5);
    if (!p.validA || !p.validB) continue;
    let error = 0;
    for (let c = 0; c < 3; c++) error += Math.abs(rgbaAt(a, p.ax, p.ay, c) - rgbaAt(b, p.bx, p.by, c)) / (3 * 255);
    errors.push(error); tiles[Math.floor(y * 6 / a.height) * 8 + Math.floor(x * 8 / a.width)].push(error);
    patches[y * a.width + x] = error;
  }
  return { mean: errors.reduce((a, b) => a + b, 0) / Math.max(1, errors.length),
    bad: errors.filter(e => e > .09).length / Math.max(1, errors.length),
    local: Math.max(...tiles.map(tile => tile.reduce((a, b) => a + b, 0) / Math.max(1, tile.length))), patch: worstPatch(patches, a.width, a.height) };
}

function worstPatch(errors, width, height) {
  let worst = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += errors[(y + dy) * width + x + dx];
    worst = Math.max(worst, sum / 9);
  }
  return worst;
}

function imageError(a, b) {
  let sum = 0, bad = 0; const patches = new Float32Array(a.width * a.height);
  for (let i = 0; i < a.data.length; i += 4) {
    let error = 0; for (let c = 0; c < 3; c++) error += Math.abs(a.data[i + c] - b.data[i + c]) / (3 * 255);
    sum += error; if (error > .22) bad++;
    patches[i / 4] = error;
  }
  return { mean: sum / (a.width * a.height), bad: bad / (a.width * a.height), patch: worstPatch(patches, a.width, a.height) };
}

const reliable = f => f.confidence >= .82 && f.tracks.length >= 32;
const cosine = (a, b) => (a.x * b.x + a.y * b.y) / Math.max(1e-8, Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));

// a/b contain sequential decoded source frames with output times, gray pixels
// and RGBA images. The bridge replaces existing output slots, never adds time.
// No overlap proof, clip trimming, or deduplication is performed by this code.
export async function chooseBridge(a, b, signal) {
  signal?.throwIfAborted();
  if (a.length < 6 || b.length < 6) return null;
  const last = a.at(-1), first = b[0], stepA = last.timestamp - a.at(-2).timestamp, stepB = b[1].timestamp - first.timestamp;
  if (stepA < .012 || stepB < .012 || stepA > .05 || stepB > .05) return null;
  const va = trackMotion(a.at(-2).pixels, last.pixels), vb = trackMotion(first.pixels, b[1].pixels);
  if (!reliable(va) || !reliable(vb) || cosine(va, vb) < .94) return null;
  const speedA = Math.hypot(va.x, va.y) / stepA, speedB = Math.hypot(vb.x, vb.y) / stepB;
  if (Math.min(speedA, speedB) < 3 || Math.max(speedA, speedB) > 55 || Math.max(speedA, speedB) / Math.min(speedA, speedB) > 1.45) return null;
  const across = trackMotion(last.pixels, first.pixels);
  if (!reliable(across)) return null;
  const velocity = { x: (va.x / stepA + vb.x / stepB) / 2, y: (va.y / stepA + vb.y / stepB) / 2 };
  const gap = first.outputTime - last.outputTime, speed = Math.hypot(velocity.x, velocity.y);
  const jump = Math.hypot(across.x - velocity.x * gap, across.y - velocity.y * gap);
  const parallel = (across.x * velocity.x + across.y * velocity.y) / speed;
  const perpendicular = Math.abs(across.x * velocity.y - across.y * velocity.x) / speed;
  if (jump < .22 || jump > 2.2 || parallel < -.08 || parallel > speed * gap + 2.2 || perpendicular > .3) return null;
  let best = null;
  for (let half = 1; half <= 4; half++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    signal?.throwIfAborted();
    const aa = a[a.length - half - 1], bb = b[half], span = bb.outputTime - aa.outputTime;
    const f = trackMotion(aa.pixels, bb.pixels, { step: 5 }), back = trackMotion(bb.pixels, aa.pixels, { step: 5 });
    if (!reliable(f) || !reliable(back) || cosine(f, velocity) < .98) continue;
    const distance = Math.hypot(f.x, f.y);
    const m0 = speedA * span / distance, m1 = speedB * span / distance;
    // Reject sudden speed-ups, reversals and invented long gaps. A cubic timing
    // curve matches the incoming/outgoing speeds instead of starting abruptly.
    if (m0 < .72 || m0 > 1.3 || m1 < .72 || m1 > 1.3 || distance > 8) continue;
    const bridge = { left: half, right: half, start: aa.outputTime, end: bb.outputTime, m0, m1,
      forward: motionGrid(f), backward: motionGrid(back), jump, confidence: Math.min(f.confidence, back.confidence) };
    const error = alignedError(bridge, aa.image, bb.image);
    if (error.mean > .018 || error.local > .05 || error.bad > .012 || error.patch > .10) continue;
    let acceptable = true;
    for (const source of [...a.slice(a.length - half), ...b.slice(0, half)]) {
      const fraction = (source.outputTime - bridge.start) / span;
      const generated = interpolateSmall(bridge, aa.image, bb.image, fraction);
      const changed = imageError(source.image, generated);
      if (changed.mean > .055 || changed.bad > .012 || changed.patch > .16) { acceptable = false; break; }
    }
    if (acceptable) {
      const score = Math.abs(1 - m0) + Math.abs(1 - m1) + error.mean * 12 + half * .055;
      if (!best || score < best.score) best = { ...bridge, error, score };
    }
  }
  signal?.throwIfAborted();
  return best;
}
