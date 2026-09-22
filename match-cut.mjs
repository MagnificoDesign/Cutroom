// Graded source-frame matching. This admits an edit, never proves duplicate
// footage and never authorizes invented frames. Structural statistics follow
// the contrast/structure idea in Wang et al. (2004); this is our own bounded,
// box-window implementation, not a learned model or a semantic scene detector.
import { trackMotion, motionVector } from './motion.mjs?v=15';
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] || 0;
const speed = v => Math.hypot(v?.x || 0, v?.y || 0);

function reduce(image, width = 96, height = 54) {
  const gray = new Float32Array(width * height), rgb = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = Math.floor(x * image.width / width), x1 = Math.max(x0 + 1, Math.floor((x + 1) * image.width / width));
    const y0 = Math.floor(y * image.height / height), y1 = Math.max(y0 + 1, Math.floor((y + 1) * image.height / height));
    // Up to sixteen samples per cell keeps full-size checking bounded. Multiple
    // subpixels avoid comparing aliased single-point texture fingerprints.
    const sx = Math.max(1, Math.ceil((x1 - x0) / 4)), sy = Math.max(1, Math.ceil((y1 - y0) / 4));
    let n = 0;
    for (let yy = y0; yy < y1; yy += sy) for (let xx = x0; xx < x1; xx += sx) {
      const p = (Math.min(image.height - 1, yy) * image.width + Math.min(image.width - 1, xx)) * 4;
      for (let c = 0; c < 3; c++) rgb[(y * width + x) * 3 + c] += image.data[p + c] / 255;
      n++;
    }
    const at = (y * width + x) * 3;
    for (let c = 0; c < 3; c++) rgb[at + c] /= n;
    gray[y * width + x] = .2126 * rgb[at] + .7152 * rgb[at + 1] + .0722 * rgb[at + 2];
  }
  return { gray, rgb, width, height };
}

function structural(a, b, block) {
  let total = 0, weights = 0, worst = 1, worstError = 0;
  const scores = [], { width, height } = a;
  for (let y = 0; y <= height - block; y += Math.max(2, block / 2)) for (let x = 0; x <= width - block; x += Math.max(2, block / 2)) {
    let ma = 0, mb = 0, aa = 0, bb = 0, ab = 0, error = 0;
    const count = block * block;
    for (let dy = 0; dy < block; dy++) for (let dx = 0; dx < block; dx++) {
      const at = (y + dy) * width + x + dx, va = a.gray[at], vb = b.gray[at];
      ma += va; mb += vb; aa += va * va; bb += vb * vb; ab += va * vb; error += Math.abs(va - vb);
    }
    ma /= count; mb /= count;
    const va = Math.max(0, aa / count - ma * ma), vb = Math.max(0, bb / count - mb * mb);
    const score = clamp((2 * (ab / count - ma * mb) + .0009) / (va + vb + .0009), -1, 1);
    const weight = .02 + Math.sqrt(va + vb);
    total += score * weight; weights += weight;
    // Textured foreground receives its own check, regardless of background size.
    if (Math.max(va, vb) > .001) { worst = Math.min(worst, score); scores.push(score); }
    worstError = Math.max(worstError, error / count);
  }
  scores.sort((x, y) => x - y);
  return { mean: total / Math.max(.0001, weights), low: scores[Math.floor(scores.length * .1)] ?? 1, worst, worstError };
}

export function appearanceMatch(left, right, { detailed = false } = {}) {
  if (!left?.data || !right?.data) throw new Error('The matching pictures could not be read.');
  const a = reduce(left, detailed ? 192 : 48, detailed ? 108 : 27);
  const b = reduce(right, a.width, a.height), bias = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const differences = [];
    for (let i = c; i < a.rgb.length; i += 3) differences.push(a.rgb[i] - b.rgb[i]);
    bias[c] = median(differences);
  }
  const light = Math.max(...bias.map(Math.abs)), tint = Math.max(...bias) - Math.min(...bias);
  const brightness = .2126 * bias[0] + .7152 * bias[1] + .0722 * bias[2];
  let residual = 0, chroma = 0;
  for (let i = 0; i < a.gray.length; i++) {
    b.gray[i] += brightness;
    residual += Math.abs(a.gray[i] - b.gray[i]);
    const r = a.rgb[i * 3] - b.rgb[i * 3], g = a.rgb[i * 3 + 1] - b.rgb[i * 3 + 1], bl = a.rgb[i * 3 + 2] - b.rgb[i * 3 + 2];
    chroma += (Math.abs(r - g) + Math.abs(bl - g)) / 2;
  }
  residual /= a.gray.length; chroma /= a.gray.length;
  const structure = structural(a, b, detailed ? 12 : 6);
  const metrics = { structure: structure.mean, lowStructure: structure.low, worstStructure: structure.worst,
    localDifference: structure.worstError, residual, light, tint, chroma };
  // These are edit-quality bounds, not overlap or optical-flow proof. A changed
  // small object can fail locally even when almost all of the picture matches.
  const reason = light > .11 || tint > .09 || chroma > .105 ? 'color'
    : structure.mean < (detailed ? .60 : .72) || structure.low < (detailed ? .15 : .28) || residual > .095 ? 'composition'
    : structure.worstError > .24 || structure.worst < -.35 ? 'local-change' : null;
  const cost = clamp(.48 * (1 - structure.mean) + .22 * residual * 4 + .15 * chroma * 4 + .15 * light * 4);
  return { accepted: !reason, reason, cost, metrics };
}

function motionSummary(frames, side) {
  const last = frames.at(-1), first = frames.find(f => f.timestamp >= last.timestamp - .25 - 1e-7), dt = last.timestamp - first.timestamp;
  if (dt > .02 && dt <= .25 && first.pixels && last.pixels) {
    // A small foreground may move less than the tracker’s local-motion threshold
    // in one frame. Measure a short span as well so the background cannot hide it.
    let field = trackMotion(first.pixels, last.pixels);
    if (!field.local && field.confidence >= .4) {
      // Limbs can move by different amounts while agreeing on direction. A
      // spatially coherent foreground must not disappear just because it has
      // fewer near-identical flow vectors than the background's track count.
      const residuals = field.tracks.map(p => ({ ...p, rx: p.dx - field.camera.x, ry: p.dy - field.camera.y }))
        .filter(p => Math.hypot(p.rx, p.ry) > .5 && p.error < .06);
      let group = [];
      for (const p of residuals) {
        const nearby = residuals.filter(q => Math.hypot(p.x - q.x, p.y - q.y) <= 18
          && (p.rx * q.rx + p.ry * q.ry) / (Math.hypot(p.rx, p.ry) * Math.hypot(q.rx, q.ry)) >= .65);
        if (nearby.length > group.length) group = nearby;
      }
      if (group.length >= Math.max(3, field.tracks.length * .03)) field = { ...field, local: true,
        x: median(group.map(p => p.dx)), y: median(group.map(p => p.dy)) };
    }
    if (field.confidence >= .4) return motionVector(field, dt);
  }
  const vectors = frames.map(f => side === 'out' ? f.inMotion : f.outMotion).filter(v => v?.confidence >= .4);
  if (!vectors.length) return null;
  return { x: median(vectors.map(v => v.x)), y: median(vectors.map(v => v.y)),
    camera: { x: median(vectors.map(v => v.camera?.x || 0)), y: median(vectors.map(v => v.camera?.y || 0)) },
    local: vectors.some(v => v.local), confidence: median(vectors.map(v => v.confidence)) };
}

function motionDifference(a, b) {
  if (!a || !b) return { penalty: .22, reversed: false };
  const sa = speed(a), sb = speed(b);
  if (Math.max(sa, sb) < .025) return { penalty: 0, reversed: false };
  if (Math.min(sa, sb) < .012) return { penalty: .3, reversed: false };
  const cosine = clamp((a.x * b.x + a.y * b.y) / (sa * sb), -1, 1);
  return { penalty: .7 * (1 - cosine) / 2 + .3 * Math.abs(sa - sb) / Math.max(sa, sb), reversed: cosine < -.2 };
}

export function cutMotion(a, b, end, start) {
  const aa = a.samples.filter(f => f.timestamp < end - .00001).slice(-6);
  const bb = b.samples.filter(f => f.timestamp >= start - .00001).slice(0, 6);
  if (aa.length < 3 || bb.length < 3) return { reversed: false, penalty: .3, va: null, vb: null };
  const va = motionSummary(aa, 'out'), vb = motionSummary(bb, 'in');
  const movement = motionDifference(va, vb), camera = motionDifference(va?.camera, vb?.camera);
  return { reversed: movement.reversed || camera.reversed, penalty: Math.max(movement.penalty, camera.penalty), va, vb };
}

export function assessMatchCut(a, b, end, start, movement = cutMotion(a, b, end, start)) {
  const aa = a.samples.filter(f => f.timestamp < end - .00001).slice(-6);
  const bb = b.samples.filter(f => f.timestamp >= start - .00001).slice(0, 6);
  if (aa.length < 3 || bb.length < 3 || Math.abs(bb[0].timestamp - start) > .0011) return { accepted: false, reason: 'timing' };
  const left = aa.at(-1), right = bb[0];
  if (Math.min(left.variance, right.variance) < .001 || Math.max(left.black, right.black, left.white, right.white) > .93) return { accepted: false, reason: 'low-detail' };
  const visual = appearanceMatch(left.image, right.image);
  if (!visual.accepted) return visual;
  const { va, vb, penalty } = movement;
  if (movement.reversed) return { accepted: false, reason: 'opposite-motion', metrics: visual.metrics };
  // Check neighboring pictures too; an isolated lucky pose must not conceal
  // a flash or completely different picture immediately after the selected cut.
  const before = appearanceMatch(aa.at(-3).image, left.image), after = appearanceMatch(right.image, bb[2].image);
  if (Math.max(before.metrics.light, after.metrics.light) > .13) return { accepted: false, reason: 'unstable-light', metrics: visual.metrics };
  // If cross-shot tracking is reliable, reward the expected next motion step.
  // This keeps an identical pose that repeats a frame from beating a natural
  // continuation merely because its still-image score is perfect. Unreliable
  // cross-shot tracking is a modest uncertainty cost, not automatic rejection.
  const cross = trackMotion(left.pixels, right.pixels), dt = end - left.timestamp;
  let stepPenalty = .15;
  if (cross.confidence >= .5 && va && vb && dt > 0 && dt < .15) {
    const error = Math.hypot(cross.x - (va.x + vb.x) / 2 * 96 * dt, cross.y - (va.y + vb.y) / 2 * 54 * dt);
    stepPenalty = clamp(error / 2);
  }
  const cost = visual.cost + .18 * penalty + .14 * stepPenalty;
  // Keep cost scales comparable: a visually compatible cut has more uncertainty
  // than a proven natural step. Otherwise its cheap structural score can beat
  // an exact continuation simply by retaining a few extra frames.
  return { accepted: cost <= .34, reason: cost <= .34 ? null : 'weak-match', cost: cost + .16,
    metrics: { ...visual.metrics, movement: penalty, stepPenalty }, left: left.timestamp, right: right.timestamp,
    native: true, kind: 'match-cut', grade: cost < .13 ? 'close' : 'compatible' };
}
