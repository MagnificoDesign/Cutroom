// Pyramidal Lucas–Kanade tracking with a reverse-track check. All work is
// bounded, local and model-free. No image buffers survive outside the caller.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = values => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0;

export function pixel(image, x, y) {
  x = clamp(x, 0, image.width - 1); y = clamp(y, 0, image.height - 1);
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const jx = Math.min(ix + 1, image.width - 1), jy = Math.min(iy + 1, image.height - 1);
  return (image.data[iy * image.width + ix] * (1 - fx) + image.data[iy * image.width + jx] * fx) * (1 - fy)
    + (image.data[jy * image.width + ix] * (1 - fx) + image.data[jy * image.width + jx] * fx) * fy;
}

function pyramid(data, width, height) {
  const out = [{ data: Float32Array.from(data, v => v / 255), width, height }];
  while (out.length < 3 && Math.min(width, height) >= 28) {
    const prev = out.at(-1); width = Math.floor(width / 2); height = Math.floor(height / 2);
    const next = { data: new Float32Array(width * height), width, height };
    // A small binomial low pass before decimation avoids checkerboard aliases.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += pixel(prev, x * 2 + dx, y * 2 + dy) * (dx ? 1 : 2) * (dy ? 1 : 2);
      next.data[y * width + x] = sum / 16;
    }
    out.push(next);
  }
  return out;
}

function track(a, b, x, y, radius) {
  let dx = 0, dy = 0, used = false, quality = 0;
  for (let level = a.length - 1; level >= 0; level--) {
    const aa = a[level], bb = b[level], scale = 2 ** level, xx = x / scale, yy = y / scale;
    dx *= 2; dy *= 2;
    if (xx < radius + 1 || yy < radius + 1 || xx >= aa.width - radius - 2 || yy >= aa.height - radius - 2) continue;
    const patch = []; let gxx = 0, gxy = 0, gyy = 0, mean = 0;
    for (let py = -radius; py <= radius; py++) for (let px = -radius; px <= radius; px++) {
      const v = pixel(aa, xx + px, yy + py);
      const gx = (pixel(aa, xx + px + 1, yy + py) - pixel(aa, xx + px - 1, yy + py)) / 2;
      const gy = (pixel(aa, xx + px, yy + py + 1) - pixel(aa, xx + px, yy + py - 1)) / 2;
      patch.push({ px, py, v, gx, gy }); gxx += gx * gx; gxy += gx * gy; gyy += gy * gy; mean += v;
    }
    const det = gxx * gyy - gxy * gxy;
    quality = (gxx + gyy - Math.hypot(gxx - gyy, 2 * gxy)) / (2 * patch.length);
    if (det < 1e-10 || quality < .000025) { if (!level) return null; continue; }
    mean /= patch.length; used = true;
    for (let iteration = 0; iteration < 16; iteration++) {
      if (xx + dx < radius || yy + dy < radius || xx + dx >= bb.width - radius - 1 || yy + dy >= bb.height - radius - 1) { if (level) break; return null; }
      let bx = 0, by = 0, nextMean = 0;
      for (const p of patch) nextMean += pixel(bb, xx + p.px + dx, yy + p.py + dy);
      nextMean /= patch.length;
      for (const p of patch) {
        const residual = p.v - mean - (pixel(bb, xx + p.px + dx, yy + p.py + dy) - nextMean);
        bx += p.gx * residual; by += p.gy * residual;
      }
      const ux = (gyy * bx - gxy * by) / det, uy = (gxx * by - gxy * bx) / det;
      if (!Number.isFinite(ux + uy) || Math.hypot(ux, uy) > 4) return null;
      dx += ux; dy += uy;
      if (ux * ux + uy * uy < .0001) break;
    }
  }
  if (!used || Math.hypot(dx, dy) > Math.min(a[0].width, a[0].height) * .22) return null;
  let error = 0, bias = 0, count = 0;
  for (let py = -radius; py <= radius; py++) for (let px = -radius; px <= radius; px++) { bias += pixel(a[0], x + px, y + py) - pixel(b[0], x + px + dx, y + py + dy); count++; }
  bias /= count;
  for (let py = -radius; py <= radius; py++) for (let px = -radius; px <= radius; px++) error += Math.abs(pixel(a[0], x + px, y + py) - pixel(b[0], x + px + dx, y + py + dy) - bias);
  return { dx, dy, error: error / count, bias, quality };
}

export function trackMotion(from, to, { width = 96, height = 54, step = 7, radius = 3 } = {}) {
  if (from?.length !== width * height || to?.length !== width * height) return { tracks: [], confidence: 0, width, height, attempted: 0 };
  const a = pyramid(from, width, height), b = pyramid(to, width, height), tracks = [];
  let attempted = 0;
  for (let y = radius + 2; y < height - radius - 2; y += step) for (let x = radius + 2; x < width - radius - 2; x += step) {
    // Count textured sites, including sites that fail to track, in confidence.
    let gx = 0, gy = 0, cross = 0;
    for (let yy = -2; yy <= 2; yy++) for (let xx = -2; xx <= 2; xx++) {
      const ix = (pixel(a[0], x + xx + 1, y + yy) - pixel(a[0], x + xx - 1, y + yy)) / 2;
      const iy = (pixel(a[0], x + xx, y + yy + 1) - pixel(a[0], x + xx, y + yy - 1)) / 2;
      gx += ix * ix; gy += iy * iy; cross += ix * iy;
    }
    if ((gx + gy - Math.hypot(gx - gy, 2 * cross)) / 50 < .00004) continue;
    attempted++;
    const forward = track(a, b, x, y, radius);
    if (!forward || forward.error > .07) continue;
    const back = track(b, a, x + forward.dx, y + forward.dy, radius);
    if (!back) continue;
    const cycle = Math.hypot(forward.dx + back.dx, forward.dy + back.dy);
    if (cycle > .7 || back.error > .07) continue;
    tracks.push({ x, y, ...forward, cycle });
  }
  const confidence = Math.min(1, tracks.length / 18) * tracks.length / Math.max(1, attempted);
  const camera = { x: median(tracks.map(p => p.dx)), y: median(tracks.map(p => p.dy)) };
  // Keep coherent foreground motion instead of averaging it into the background.
  const residual = tracks.filter(p => Math.hypot(p.dx - camera.x, p.dy - camera.y) > .65);
  let group = [];
  for (const p of residual) {
    const near = residual.filter(q => Math.hypot(p.dx - q.dx, p.dy - q.dy) < .65);
    if (near.length > group.length) group = near;
  }
  const local = group.length >= 3 && group.length >= tracks.length * .06;
  const selected = local ? group : tracks;
  return { tracks, attempted, confidence, width, height, camera,
    x: median(selected.map(p => p.dx)), y: median(selected.map(p => p.dy)), local };
}

export function motionVector(field, dt) {
  return { x: field.x / field.width / dt || 0, y: field.y / field.height / dt || 0,
    confidence: field.confidence, local: field.local,
    camera: { x: (field.camera?.x || 0) / field.width / dt, y: (field.camera?.y || 0) / field.height / dt } };
}

export function predictPicture(frame, field, seconds) {
  if (!frame?.pixels || !field?.tracks.length || field.confidence < .55 || !(field.dt > 0) || seconds <= 0 || seconds > .11) return null;
  const image = { data: frame.pixels, width: 96, height: 54 }, result = new Float32Array(32 * 18);
  const ratio = seconds / field.dt;
  for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) {
    const px = x * 3 + 1, py = y * 3 + 1;
    let nearest = null, distance = 100;
    for (const p of field.tracks) {
      const d = (p.x + p.dx - px) ** 2 + (p.y + p.dy - py) ** 2;
      if (d < distance) { distance = d; nearest = p; }
    }
    const dx = nearest?.dx ?? field.camera.x, dy = nearest?.dy ?? field.camera.y;
    result[y * 32 + x] = pixel(image, px - dx * ratio, py - dy * ratio) / 255;
  }
  return result;
}

export async function refineMotion(clips, signal) {
  let count = 0;
  for (const clip of clips) {
    const frames = clip.samples || [];
    for (let i = 1; i < frames.length; i++) {
      signal?.throwIfAborted();
      const a = frames[i - 1], b = frames[i], dt = (b.timestamp ?? b.t) - (a.timestamp ?? a.t);
      if (!a.pixels || !b.pixels || dt < .012 || dt > .105) continue;
      const field = trackMotion(a.pixels, b.pixels), vector = motionVector(field, dt);
      field.dt = dt;
      a.outMotion = vector; b.inMotion = vector;
      b.inField = field;
      b.nextPicture = predictPicture(b, field, 1 / 30);
      if (++count % 3 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  signal?.throwIfAborted();
}
