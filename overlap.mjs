import { frameSimilarity } from './core.mjs?v=6';

export const MIN_OVERLAP = .8;
export const MAX_OVERLAP = 12;
export const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
export function nearest(frames, time) {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (frames[mid].t < time) lo = mid + 1; else hi = mid; }
  return lo && Math.abs(frames[lo - 1].t - time) < Math.abs(frames[lo].t - time) ? frames[lo - 1] : frames[lo];
}
const textured = frame => frame && frame.variance >= .001 && frame.black < .93 && frame.white < .93;
const sampleStep = clip => Math.max(.05, median((clip.samples || []).slice(1).map((frame, i) => frame.t - clip.samples[i].t)) || .25);

// Exposure-normalized spatial errors. The worst local tiles receive separate
// scrutiny: a large static background must not hide different foreground action.
export function photoError(a, b, dense = false) {
  if (!textured(a) || !textured(b)) return { mean: 1, local: 1, cost: 1 };
  const aa = dense ? a.pixels : a.gray, bb = dense ? b.pixels : b.gray;
  if (!aa || !bb || aa.length !== bb.length) return { mean: 1, local: 1, cost: 1 };
  const scale = dense ? 1 / 255 : 1, width = dense ? 96 : 32, height = dense ? 54 : 18;
  const sa = Math.max(.04, Math.sqrt(a.variance)), sb = Math.max(.04, Math.sqrt(b.variance));
  const blocks = new Float64Array(48);
  let error = 0;
  for (let i = 0; i < aa.length; i++) {
    const d = Math.abs((aa[i] * scale - a.mean) / sa - (bb[i] * scale - b.mean) / sb);
    error += d;
    blocks[Math.floor(Math.floor(i / width) * 6 / height) * 8 + Math.floor(i % width * 8 / width)] += d;
  }
  const worst = Array.from(blocks, value => value * 48 / aa.length).sort((a, b) => b - a);
  const mean = error / aa.length, local = worst.slice(0, 6).reduce((a, b) => a + b, 0) / 6;
  return { mean, local, cost: .55 * mean + .45 * local };
}

export function coarseCandidates(a, b) {
  if (a.width && b.width && Math.abs(a.width / a.height / (b.width / b.height) - 1) > .015) return [];
  const step = Math.max(sampleStep(a), sampleStep(b)), bucket = Math.max(.08, step * .55);
  const groups = new Map();
  for (let i = 0; i < a.samples.length; i++) for (let j = 0; j < b.samples.length; j++) {
    const x = a.samples[i], y = b.samples[j], offset = x.t - y.t;
    const similarity = frameSimilarity(x, y);
    if (offset < -bucket || offset > a.duration - .35 || similarity < .86) continue;
    const error = photoError(x, y);
    // Sparse samples can straddle fast action by up to half the scan interval.
    // This broad gate only proposes a search; dense verification below stays strict.
    if (error.mean > .42 || error.local > 1.1) continue;
    const key = Math.round(offset / bucket);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ i, j, offset, error: .5 * (1 - similarity) + .3 * error.mean + .2 * Math.min(.4, error.local) });
  }
  const candidates = [];
  for (const group of groups.values()) {
    const perFrame = new Map();
    for (const item of group) if (!perFrame.has(item.i) || item.error < perFrame.get(item.i).error) perFrame.set(item.i, item);
    const hits = [...perFrame.values()].sort((a, b) => a.i - b.i);
    const monotonic = hits.filter((hit, i) => !i || hit.j > hits[i - 1].j);
    if (monotonic.length < 3) continue;
    const span = a.samples[monotonic.at(-1).i].t - a.samples[monotonic[0].i].t;
    if (span < .35) continue;
    const offset = median(monotonic.map(item => item.offset));
    const error = monotonic.reduce((sum, item) => sum + item.error, 0) / monotonic.length;
    const kind = offset < .15 || offset + b.duration <= a.duration + .15 ? 'contained' : 'continuation';
    candidates.push({ a: a.id, b: b.id, offset, error, span, step, kind, priority: span / Math.min(a.duration, b.duration) - error * 2 });
  }
  const out = [];
  for (const item of candidates.sort((x, y) => x.error + .025 / x.span - (y.error + .025 / y.span))) {
    if (!out.some(other => Math.abs(other.offset - item.offset) < Math.max(.18, step))) out.push(item);
    if (out.length === 3) break;
  }
  return out;
}

function alignedPairs(a, b, offset, end) {
  const pairs = [];
  for (const frame of b) {
    if (frame.t < 0 || frame.t > end - .012) continue;
    const other = nearest(a, frame.t + offset);
    if (!other || Math.abs(other.t - frame.t - offset) > .035) continue;
    const prior = pairs.at(-1);
    if (prior && (other.timestamp <= prior.a.timestamp + .00001 || frame.timestamp <= prior.b.timestamp + .00001)) continue;
    pairs.push({ a: other, b: frame });
  }
  return pairs;
}

function temporalEvidence(pairs) {
  let dot = 0, a2 = 0, b2 = 0, difference = 0, magnitude = 0, active = 0;
  for (let i = 3; i < pairs.length; i++) {
    const now = pairs[i], before = pairs[i - 3];
    const sa = Math.max(.04, Math.sqrt(now.a.variance)), sb = Math.max(.04, Math.sqrt(now.b.variance));
    const pa = Math.max(.04, Math.sqrt(before.a.variance)), pb = Math.max(.04, Math.sqrt(before.b.variance));
    let pixels = 0;
    for (let p = 0; p < now.a.pixels.length; p++) {
      const da = (now.a.pixels[p] / 255 - now.a.mean) / sa - (before.a.pixels[p] / 255 - before.a.mean) / pa;
      const db = (now.b.pixels[p] / 255 - now.b.mean) / sb - (before.b.pixels[p] / 255 - before.b.mean) / pb;
      if (Math.max(Math.abs(da), Math.abs(db)) < .06) continue;
      pixels++; dot += da * db; a2 += da * da; b2 += db * db;
      difference += Math.abs(da - db); magnitude += Math.max(Math.abs(da), Math.abs(db));
    }
    if (pixels >= 8) active++;
  }
  return { active, correlation: dot / Math.max(1e-12, Math.sqrt(a2 * b2)), error: difference / Math.max(1e-12, magnitude), energy: Math.min(a2, b2) };
}

export function verifySequence(a, b, offset, durationA, durationB, { checkContainment = false } = {}) {
  const end = Math.min(durationB, durationA - offset);
  const result = { status: 'review', offset, duration: end, reason: 'uncertain' };
  const contained = offset < .15 || offset + durationB <= durationA + .15;
  if (contained && !checkContainment) return { ...result, reason: 'contained' };
  if (end < MIN_OVERLAP || end > MAX_OVERLAP) return { ...result, reason: 'short-or-long' };
  const pairs = alignedPairs(a, b, offset, end);
  if (pairs.length < 12 || pairs[0].b.t > .065 || pairs.at(-1).b.t < end - .075) return { ...result, reason: 'incomplete' };
  if (pairs.some((pair, i) => i && (pair.a.timestamp - pairs[i - 1].a.timestamp > .085 || pair.b.timestamp - pairs[i - 1].b.timestamp > .085))) return { ...result, reason: 'missing-frames' };
  if (pairs.some(pair => pair.a.duration > 0 && pair.a.duration < 1 / 65 || pair.b.duration > 0 && pair.b.duration < 1 / 65)) return { ...result, reason: 'higher-frame-rate' };
  const errors = pairs.map(pair => photoError(pair.a, pair.b, true));
  if (errors.some(error => error.mean > .10 || error.local > .24)) return { ...result, status: 'rejected', reason: 'different-picture' };
  const motion = temporalEvidence(pairs);
  if (motion.active < 6 || motion.energy < 1) return { ...result, reason: 'still-or-ambiguous' };
  if (motion.correlation < .82 || motion.error > .4) return { ...result, status: 'rejected', reason: 'different-action', motion };
  const offsets = pairs.map(pair => pair.a.timestamp - pair.b.timestamp);
  const precise = median(offsets);
  if (offsets.some(value => Math.abs(value - precise) > .036)) return { ...result, reason: 'timing-drift' };
  return { ...result, status: 'verified', reason: 'matched-sequence', contained, offset: precise, duration: Math.min(durationB, durationA - precise), matches: pairs.length, motion, error: errors.reduce((sum, value) => sum + value.cost, 0) / errors.length };
}

export function refineAlignment(a, b, candidate, durationA, durationB, { checkContainment = false } = {}) {
  const margin = Math.max(.12, candidate.step * 1.2), tested = [];
  for (let offset = Math.max(checkContainment ? 0 : .15, candidate.offset - margin); offset <= candidate.offset + margin + .001; offset += 1 / 60) {
    const end = Math.min(durationB, durationA - offset);
    if (end < MIN_OVERLAP || end > MAX_OVERLAP) continue;
    let cost = 0;
    for (let i = 0; i < 9; i++) cost += photoError(nearest(a, offset + (.03 + (end - .06) * i / 8)), nearest(b, .03 + (end - .06) * i / 8)).cost;
    tested.push({ offset, cost: cost / 9 });
  }
  const best = tested.sort((x, y) => x.cost - y.cost).slice(0, 5);
  let review;
  const verified = [];
  for (const item of best) {
    let result = verifySequence(a, b, item.offset, durationA, durationB, { checkContainment });
    if (result.status === 'verified') result = verifySequence(a, b, result.offset, durationA, durationB, { checkContainment });
    if (result.status === 'verified' && !verified.some(other => Math.abs(other.offset - result.offset) < .05)) verified.push(result);
    else if (result.status === 'review') review = result;
  }
  verified.sort((x, y) => x.error - y.error);
  if (verified.length > 1 && Math.abs(verified[0].offset - verified[1].offset) > .12 && verified[1].error < verified[0].error + .015) return { status: 'review', reason: 'repeating-pattern' };
  return verified[0] || review || { status: 'rejected', reason: 'unverified' };
}

export function audioEnergy(audio, time, radius = .02) {
  if (!audio) return 0;
  const lo = Math.max(0, Math.floor((time - radius - audio.start) * audio.rate));
  const hi = Math.min(audio.channels[0].length, Math.ceil((time + radius - audio.start) * audio.rate));
  let sum = 0, count = 0;
  for (const channel of audio.channels) for (let i = lo; i < hi; i++) { sum += channel[i] ** 2; count++; }
  return Math.sqrt(sum / Math.max(1, count));
}

export function verifySound(a, b, offset, end) {
  if (!a || !b) return { ok: false, reason: 'unchecked-sound' };
  if (!a.hasTrack && !b.hasTrack) return { ok: true, silent: true };
  const lags = [];
  for (const center of [end * .22, end * .5, end * .78]) {
    const ea = audioEnergy(a, offset + center, .075), eb = audioEnergy(b, center, .075);
    if (ea < .0015 && eb < .0015) continue;
    if (Math.min(ea, eb) < .0015 || ea / eb < .25 || ea / eb > 4) return { ok: false, reason: 'different-sound' };
    let best = { correlation: -1, lag: 0 };
    for (let lag = -32; lag <= 32; lag++) {
      let dot = 0, aa = 0, bb = 0;
      for (let c = 0; c < 2; c++) for (let i = -600; i < 600; i++) {
        const x = a.channels[c][Math.round((offset + center - a.start) * a.rate) + i] || 0;
        const y = b.channels[c][Math.round((center - b.start) * b.rate) + i + lag] || 0;
        dot += x * y; aa += x * x; bb += y * y;
      }
      const correlation = dot / Math.max(1e-12, Math.sqrt(aa * bb));
      if (correlation > best.correlation + 1e-6 || Math.abs(correlation - best.correlation) < 1e-6 && Math.abs(lag) < Math.abs(best.lag)) best = { correlation, lag };
    }
    if (best.correlation < .85 || Math.abs(best.lag) > 16) return { ok: false, reason: 'different-sound' };
    lags.push(best.lag);
  }
  if (lags.length && Math.max(...lags) - Math.min(...lags) > 16) return { ok: false, reason: 'sound-drift' };
  const lag = median(lags);
  // Check the entire shared soundtrack in overlapping windows. Matching only
  // three snippets must not hide a different word/noise between those snippets.
  for (let time = .015; time < end - .02; time += .1) {
    let dot = 0, aa = 0, bb = 0, count = 0;
    const length = Math.floor(Math.min(.15, end - .015 - time) * 8000);
    for (let c = 0; c < 2; c++) for (let i = 0; i < length; i++) {
      const x = a.channels[c][Math.round((offset + time - a.start) * a.rate) + i] || 0;
      const y = b.channels[c][Math.round((time - b.start) * b.rate) + i + lag] || 0;
      dot += x * y; aa += x * x; bb += y * y; count++;
    }
    const ea = Math.sqrt(aa / Math.max(1, count)), eb = Math.sqrt(bb / Math.max(1, count));
    if (ea < .0015 && eb < .0015) continue;
    if (Math.min(ea, eb) < .0015 || dot / Math.max(1e-12, Math.sqrt(aa * bb)) < .97 || ea / eb < .25 || ea / eb > 4) return { ok: false, reason: 'different-sound' };
  }
  return { ok: true, silent: !lags.length };
}

export function overlapSeams(a, b, audioA, audioB, match, durationA, durationB) {
  const lo = Math.max(.12, .12 - match.offset), hi = Math.min(match.duration - .12, durationB - .12, durationA - match.offset - .12);
  if (hi < lo) return [];
  const choices = [];
  for (const start of [...new Set(b.map(frame => frame.timestamp))].filter(time => time >= lo && time <= hi)) {
    const end = start + match.offset;
    const photo = photoError(nearest(a, end), nearest(b, start), true);
    const sound = Math.max(audioEnergy(audioA, end), audioEnergy(audioB, start));
    const center = Math.abs(start - (lo + hi) / 2) / Math.max(.01, hi - lo);
    choices.push({ end, start, cost: photo.cost * .6 + sound * .12 + center * .025, overlap: true, offset: match.offset });
  }
  // Retain options spread across the shared interval, not just one local minimum:
  // the next join of a middle clip may need a different compatible exit.
  const output = [];
  for (let bin = 0; bin < 10; bin++) {
    const items = choices.filter(item => Math.min(9, Math.floor((item.start - lo) / Math.max(.001, hi - lo) * 10)) === bin);
    if (items.length) output.push(items.sort((x, y) => x.cost - y.cost)[0]);
  }
  return output;
}
