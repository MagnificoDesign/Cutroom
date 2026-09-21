import { clamp, frameSimilarity, motion } from './core.mjs?v=14';
import { soundAllowsCut, pauseCandidates } from './audio-cuts.mjs?v=14';
import { predictPicture } from './motion.mjs?v=14';

import { cutAt } from './cut-timing.mjs?v=14';

const minimumKeep = clip => Math.min(clip.duration, Math.max(.5, clip.duration * .45));
const closest = (frames, time) => frames.reduce((best, frame) => Math.abs(frame.t - time) < Math.abs(best.t - time) ? frame : best, frames[0]);

// Small, bounded block matching. Estimate camera motion from the median block,
// then retain the strongest local residual so a static background cannot mask it.
export function flow(a, b) {
  const unknown = { x: 0, y: 0, confidence: 0, local: false };
  if (!a?.gray || !b?.gray || b.t <= a.t) return unknown;
  const width = 32, height = 18, blocks = [];
  for (let by = 3; by < height - 5; by += 4) for (let bx = 3; bx < width - 5; bx += 4) {
    let sum = 0, sum2 = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const v = a.gray[(by + y) * width + bx + x]; sum += v; sum2 += v * v;
    }
    if (sum2 / 16 - (sum / 16) ** 2 < .001) continue;
    const errors = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      let error = 0;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const va = a.gray[(by + y) * width + bx + x] - a.mean;
        const vb = b.gray[(by + y + dy) * width + bx + x + dx] - b.mean;
        error += Math.abs(va - vb);
      }
      errors.push({ dx, dy, error: error / 16 });
    }
    errors.sort((x, y) => x.error - y.error || Math.hypot(x.dx, x.dy) - Math.hypot(y.dx, y.dy));
    const best = errors[0], zero = errors.find(item => !item.dx && !item.dy);
    const confidence = clamp((zero.error - best.error) * 8);
    blocks.push({ x: best.dx, y: best.dy, confidence, error: best.error });
  }
  if (!blocks.length) return unknown;
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const camera = { x: median(blocks.map(v => v.x)), y: median(blocks.map(v => v.y)) };
  const local = blocks.filter(v => v.confidence > .12 && Math.hypot(v.x - camera.x, v.y - camera.y) >= 1 && v.error < .12);
  const chosen = local.length >= 2 ? local : blocks;
  const x = median(chosen.map(v => v.x)), y = median(chosen.map(v => v.y));
  const confidence = local.length >= 2 ? Math.max(...local.map(v => v.confidence)) : clamp(chosen.filter(v => v.error < .08).length / Math.max(6, blocks.length));
  const dt = b.t - a.t;
  return { x: x / width / dt, y: y / height / dt, confidence, local: local.length >= 2 };
}

export function signature(clip, time, side) {
  const frames = clip.samples || [];
  if (!frames.length) return { frame: null, vector: { x: 0, y: 0, confidence: 0 } };
  // A cut timestamp is an exclusive end: score the last displayed source frame.
  const before = side === 'out' ? frames.filter(f => f.duration > 0 && f.timestamp < time - .00001).at(-1) : null;
  const frame = before && time - before.timestamp < Math.max(.08, before.duration + .002) ? before : closest(frames, Math.min(time, clip.duration));
  let window = frames.filter(f => side === 'out' ? f.t <= time + .001 && f.t >= time - .65 : f.t >= time - .001 && f.t <= time + .65);
  if (window.length < 2) window = frames.slice(Math.max(0, frames.indexOf(frame) - 1), frames.indexOf(frame) + 2);
  let vector = flow(window[0], window.at(-1));
  const tracked = side === 'out' ? frame.inMotion : frame.outMotion;
  if (tracked?.confidence > .55) vector = tracked;
  if (!window[0]?.gray) {
    const fallback = motion(window);
    vector.x = fallback.dx / Math.max(.01, (window.at(-1)?.t || 0) - (window[0]?.t || 0));
    vector.confidence = fallback.confidence;
  }
  const gap = Math.max(.000001, time - (frame.timestamp ?? frame.t));
  const prediction = side === 'out' ? Math.abs(gap - 1 / 30) < .000001 ? frame.nextPicture || predictPicture(frame, frame.inField, gap) : predictPicture(frame, frame.inField, gap) : null;
  return { frame, vector, prediction };
}

export function boundaryCost(out, entry) {
  const similarity = frameSimilarity(out.frame, entry.frame);
  const a = out.vector, b = entry.vector;
  const sa = Math.hypot(a.x, a.y), sb = Math.hypot(b.x, b.y);
  let mismatch = .35;
  if (a.confidence > .2 && b.confidence > .2) {
    if (sa < .018 && sb < .018) mismatch = .05;
    else if (sa < .018 || sb < .018) mismatch = .65;
    else {
      const cosine = clamp((a.x * b.x + a.y * b.y) / (sa * sb), -1, 1);
      mismatch = .72 * (1 - cosine) / 2 + .28 * Math.abs(sa - sb) / Math.max(sa, sb);
    }
  }
  // When the subject has its own motion, also check the camera trajectory.
  // A matching small subject must not excuse an abrupt reversed camera pan.
  if ((a.local || b.local) && a.camera && b.camera && a.confidence > .55 && b.confidence > .55) {
    const ca = Math.hypot(a.camera.x, a.camera.y), cb = Math.hypot(b.camera.x, b.camera.y);
    if (ca > .025 && cb > .025) {
      const cameraMismatch = (1 - clamp((a.camera.x * b.camera.x + a.camera.y * b.camera.y) / (ca * cb), -1, 1)) / 2;
      mismatch = Math.max(mismatch, cameraMismatch * .8);
    }
  }
  let continuation = .12;
  if (out.prediction && entry.frame?.gray) {
    const blocks = new Float32Array(48);
    let total = 0;
    for (let i = 0; i < out.prediction.length; i++) {
      const error = Math.abs(out.prediction[i] - out.frame.mean - (entry.frame.gray[i] - entry.frame.mean));
      total += error; blocks[Math.floor(Math.floor(i / 32) / 3) * 8 + Math.floor(i % 32 / 4)] += error / 12;
    }
    const worst = [...blocks].sort((a, b) => b - a).slice(0, 6).reduce((sum, value) => sum + value, 0) / 6;
    continuation = clamp((.55 * total / out.prediction.length + .45 * worst) * 4);
  }
  // Prefer the next natural pose over replaying an identical still. This small
  // reward cannot, by itself, authorize removing an otherwise uncertain span.
  return { cost: .58 * (1 - similarity) + .42 * mismatch + .24 * (continuation - .12), similarity, mismatch, continuation };
}

function times(clip, side) {
  const keep = minimumKeep(clip);
  const all = side === 'in' ? [0] : [clip.duration];
  for (const frame of clip.samples || []) {
    if (side === 'in' && frame.t > .04 && frame.t <= clip.duration - keep) all.push(frame.t);
    if (side === 'out' && frame.t >= keep && frame.t < clip.duration - .04) all.push(frame.t);
  }
  all.sort((a, b) => a - b);
  const coarse = all.length <= 16 ? all : Array.from(new Set(Array.from({ length: 16 }, (_, i) => all[Math.round(i * (all.length - 1) / 15)])));
  const low = side === 'out' ? keep : 0, high = side === 'in' ? clip.duration - keep : clip.duration;
  return [...new Set([...coarse, ...pauseCandidates(clip, side), ...(side === 'in' ? clip.fineIn || [] : clip.fineOut || [])]
    .map(time => cutAt(clip, time, low, high)).filter(Number.isFinite))].sort((a, b) => a - b);
}

export function validatePlan(clips, plan, { allowSubset = false } = {}) {
  const byId = new Map(clips.map(clip => [clip.id, clip]));
  const used = new Set();
  if (!plan.length || !allowSubset && plan.length !== clips.length) throw new Error('The edit must include every selected video.');
  for (const part of plan) {
    const clip = byId.get(part.id);
    if (!clip || used.has(part.id) || !Number.isFinite(part.start) || !Number.isFinite(part.end) || part.start < 0 || part.end > clip.duration + .0001 || part.end <= part.start) throw new Error('The edit contains an invalid clip range.');
    used.add(part.id);
  }
  return plan;
}

function* planningSteps(clips, { beamWidth = 160, trimPenalty = .22, minimumImprovement = .06, verified = [], reviewed = [] } = {}) {
  if (!clips.length || clips.some(clip => !(clip.duration > 0) || !Number.isFinite(clip.duration))) throw new Error('Add readable videos before creating an edit.');
  if (clips.length > 12) throw new Error('For this version, choose up to 12 videos for one edit.');
  const full = clips.map(clip => ({ id: clip.id, start: 0, end: clip.duration }));
  if (clips.length === 1) return { segments: full, baselineCost: 0, cost: 0, improved: false, joins: [], reviewed };
  const protectedIds = new Set([...verified, ...reviewed].flatMap(pair => [pair.a, pair.b]));
  const overlaps = new Map(verified.filter(pair => pair.status === 'verified').map(pair => [`${pair.a}/${pair.b}`, pair]));
  const cache = new Map();
  const sig = (index, time, side) => {
    const key = `${index}/${time}/${side}`;
    if (!cache.has(key)) cache.set(key, signature(clips[index], time, side));
    return cache.get(key);
  };
  const joins = new Map();
  for (let a = 0; a < clips.length; a++) for (let b = 0; b < clips.length; b++) {
    if (a === b) continue;
    const natural = boundaryCost(sig(a, clips[a].duration, 'out'), sig(b, 0, 'in'));
    const options = [];
    for (const end of protectedIds.has(clips[a].id) ? [clips[a].duration] : times(clips[a], 'out')) for (const start of protectedIds.has(clips[b].id) ? [0] : times(clips[b], 'in')) {
      if (!soundAllowsCut(clips[a], end, 'out') || !soundAllowsCut(clips[b], start, 'in')) continue;
      const score = boundaryCost(sig(a, end, 'out'), sig(b, start, 'in'));
      const trimmed = end < clips[a].duration - .001 || start > .001;
      // Weak, blank or opposite-motion matches cannot justify throwing away time.
      if (trimmed && (score.similarity < .74 || score.mismatch > .58 || score.cost > natural.cost - .045)) continue;
      const cost = score.cost + trimPenalty * ((clips[a].duration - end) / clips[a].duration + start / clips[b].duration);
      options.push({ end, start, cost, similarity: score.similarity });
    }
    options.sort((x, y) => x.cost - y.cost);
    const candidates = options.slice(0, 18);
    if (!candidates.some(v => v.end === clips[a].duration && v.start === 0)) candidates.push({ end: clips[a].duration, start: 0, cost: natural.cost });
    const overlap = overlaps.get(`${clips[a].id}/${clips[b].id}`);
    if (overlap) for (const seam of overlap.seams) {
      if (seam.start < 0 || seam.end > clips[a].duration || seam.start >= clips[b].duration || Math.abs(seam.end - seam.start - overlap.offset) > .0001) continue;
      // Strong temporal + sound evidence authorizes using shared time once.
      // A reward per verified join favors a complete chain over skipping its middle.
      candidates.push({ ...seam, overlap: true, cost: seam.cost - 2 });
    }
    joins.set(`${a}/${b}`, candidates);
    yield;
  }
  let baselineCost = 0;
  for (let i = 0; i + 1 < clips.length; i++) baselineCost += boundaryCost(sig(i, clips[i].duration, 'out'), sig(i + 1, 0, 'in')).cost;
  let beam = clips.map((clip, index) => ({ mask: 1 << index, last: index, start: 0, cost: 0, done: [], joins: [], incomingOverlap: false }));
  for (let depth = 1; depth < clips.length; depth++) {
    const next = new Map();
    for (const state of beam) for (let b = 0; b < clips.length; b++) {
      if (state.mask & (1 << b)) continue;
      for (const join of joins.get(`${state.last}/${b}`)) {
        const keep = join.overlap || state.incomingOverlap ? Math.min(.12, clips[state.last].duration) : minimumKeep(clips[state.last]);
        if (join.end - state.start < keep - .0001) continue;
        const candidate = { mask: state.mask | (1 << b), last: b, start: join.start, cost: state.cost + join.cost, done: [...state.done, { id: clips[state.last].id, start: state.start, end: join.end }], incomingOverlap: !!join.overlap, joins: [...state.joins, { a: clips[state.last].id, b: clips[b].id, kind: join.overlap ? 'overlap' : 'cut', end: join.end, start: join.start }] };
        const key = `${candidate.mask}/${b}/${join.start}/${candidate.incomingOverlap}`;
        if (!next.has(key) || candidate.cost < next.get(key).cost) next.set(key, candidate);
      }
    }
    beam = [...next.values()].sort((a, b) => a.cost - b.cost).slice(0, beamWidth);
    yield;
  }
  const best = beam.sort((a, b) => a.cost - b.cost)[0];
  if (!best || best.cost >= baselineCost - minimumImprovement) return { segments: full, baselineCost, cost: baselineCost, improved: false, joins: [], reviewed };
  const segments = [...best.done, { id: clips[best.last].id, start: best.start, end: clips[best.last].duration }];
  validatePlan(clips, segments);
  return { segments, cost: best.cost, baselineCost, improved: true, joins: best.joins, reviewed };
}

export function planEdit(clips, options) {
  const steps = planningSteps(clips, options);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

export async function planEditAsync(clips, options, signal) {
  const steps = planningSteps(clips, options);
  while (true) {
    signal?.throwIfAborted();
    const result = steps.next();
    if (result.done) return result.value;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
