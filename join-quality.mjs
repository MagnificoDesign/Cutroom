import { trackMotion } from './motion.mjs?v=14';

// A bounded temporal check of decoded pictures, not a claim of perceptual or
// semantic understanding. Original sequences are the reference: an enhancement
// must improve a measured seam without adding motion, flashes or detail loss.
function features(image) {
  const { width, height, data } = image, pixels = new Uint8Array(96 * 54);
  const gray = new Float32Array(width * height), means = [0, 0, 0], detail = new Float64Array(48), counts = new Uint32Array(48);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (data[i * 4] * .2126 + data[i * 4 + 1] * .7152 + data[i * 4 + 2] * .0722) / 255;
    for (let c = 0; c < 3; c++) means[c] += data[i * 4 + c] / (255 * gray.length);
  }
  for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) pixels[y * 96 + x] = Math.round(gray[Math.min(height - 1, Math.floor((y + .5) * height / 54)) * width + Math.min(width - 1, Math.floor((x + .5) * width / 96))] * 255);
  // Local gradient energy reveals soft/doubled edges hidden by a still background.
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    const at = y * width + x, tile = Math.floor(y * 6 / height) * 8 + Math.floor(x * 8 / width);
    detail[tile] += Math.hypot(gray[at + 1] - gray[at - 1], gray[at + width] - gray[at - width]); counts[tile]++;
  }
  return { pixels, gray, means, detail: detail.map((v, i) => v / Math.max(1, counts[i])) };
}

async function measure(frames, seam, signal) {
  const list = frames.map(frame => ({ ...features(frame.image), time: frame.outputTime }));
  let brightness = 0, motion = 0, jerk = 0, residual = 0, tracked = 0, seamError = 0, previous;
  for (let i = 1; i < list.length; i++) {
    signal?.throwIfAborted();
    const a = list[i - 1], b = list[i], dt = b.time - a.time;
    if (!(dt > 0)) throw new Error('The connection has invalid frame timing.');
    const lightChange = Math.max(...a.means.map((v, c) => Math.abs(v - b.means[c])));
    brightness = Math.max(brightness, lightChange);
    if (a.time < seam && b.time >= seam) {
      for (let p = 0; p < a.gray.length; p++) seamError += Math.abs(a.gray[p] - b.gray[p]) / a.gray.length;
    }
    const field = trackMotion(a.pixels, b.pixels);
    if (field.confidence > .55) {
      tracked++;
      const vector = [field.x / dt / 30, field.y / dt / 30, field.camera.x / dt / 30, field.camera.y / dt / 30];
      motion = Math.max(motion, Math.hypot(...vector.slice(0, 2)), Math.hypot(...vector.slice(2)));
      if (previous) jerk = Math.max(jerk, Math.hypot(vector[0] - previous[0], vector[1] - previous[1]), Math.hypot(vector[2] - previous[2], vector[3] - previous[3]));
      previous = vector;
      const errors = field.tracks.map(p => p.error).sort((a, b) => b - a);
      // Exposure easing changes local contrast too. Count spatial disagreement
      // beyond that global change here; the separate flash gate still checks it.
      residual = Math.max(residual, errors.slice(0, Math.max(1, Math.ceil(errors.length / 8))).reduce((sum, e) => sum + e, 0) / Math.max(1, Math.ceil(errors.length / 8)) - lightChange);
    } else previous = null;
    if (!(i % 4)) await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return { list, brightness, motion, jerk, residual, tracked, seamError };
}

export async function judgeJoin(original, rendered, seam, signal) {
  if (original.length < 6 || original.length !== rendered.length || !original.every((frame, i) => frame.image?.data?.length && rendered[i].image?.data?.length === frame.image.data.length && Math.abs(frame.outputTime - rendered[i].outputTime) < .00001)) return { ok: false, reason: 'could-not-check' };
  const before = await measure(original, seam, signal), after = await measure(rendered, seam, signal);
  let soft = 0, detailed = 0, worstDetail = 1;
  for (let i = 0; i < before.list.length; i++) {
    let bad = 0, textured = 0;
    for (let tile = 0; tile < 48; tile++) {
      const reference = before.list[i].detail[tile];
      if (reference < .018) continue;
      textured++;
      const ratio = after.list[i].detail[tile] / reference;
      if (ratio < .7) bad++;
      worstDetail = Math.min(worstDetail, ratio);
    }
    if (textured >= 8) { detailed++; if (bad >= Math.max(2, textured * .12)) soft++; }
  }
  const metrics = { before: Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'list')), after: Object.fromEntries(Object.entries(after).filter(([key]) => key !== 'list')), softFrames: soft, worstDetail };
  if (after.brightness > before.brightness * 1.12 + .012) return { ok: false, reason: 'brightness', metrics };
  if (after.motion > before.motion * 1.15 + .09 || after.jerk > before.jerk * 1.15 + .12) return { ok: false, reason: 'movement', metrics };
  if (soft > 0 || after.residual > before.residual * 1.25 + .012) return { ok: false, reason: 'detail', metrics };
  if (after.tracked < before.tracked * .85 || detailed < original.length * .6) return { ok: false, reason: 'could-not-check', metrics };
  const improves = after.seamError < before.seamError * .96 - .0003 || after.jerk < before.jerk * .9 - .015 || after.brightness < before.brightness * .85 - .001;
  return { ok: improves, reason: improves ? 'improved' : 'no-measured-improvement', metrics };
}
