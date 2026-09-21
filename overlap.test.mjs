import test from 'node:test';
import assert from 'node:assert/strict';
import { descriptor } from './core.mjs';
import { coarseCandidates, verifySequence, refineAlignment, photoError, verifySound, overlapSeams } from './overlap.mjs';
import { planEdit } from './planner.mjs';
import { analyzeJoins } from './analyze.mjs';

function frame(t, sourceTime, { still = false, blank = false, small = false, other = false, gain = 1, exposure = 0, noise = 0 } = {}) {
  const rgba = new Uint8Array(96 * 54 * 4), pixels = new Uint8Array(96 * 54);
  const clock = still ? 0 : sourceTime;
  const left = Math.floor(5 + clock * 9.5), top = Math.floor(17 + Math.sin(clock * 1.9) * 5) + (other ? 10 : 0);
  for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) {
    const i = y * 96 + x;
    const subject = x >= left && x < left + (small ? 5 : 14) && y >= top && y < top + (small ? 5 : 12);
    let value = subject ? 225 : 65 + ((x * 13 ^ y * 7) % 70);
    value = blank ? 0 : Math.max(0, Math.min(255, Math.round(value * gain + exposure + noise * ((i * 7 + Math.round(t * 30) * 11) % 3 - 1))));
    pixels[i] = value;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = value; rgba[i * 4 + 3] = 255;
  }
  const out = { ...descriptor(rgba, 96, 54, t), pixels, timestamp: t, duration: 1 / 30, gray: new Float32Array(32 * 18) };
  for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) out.gray[y * 32 + x] = pixels[(y * 3 + 1) * 96 + x * 3 + 1] / 255;
  return out;
}
const frames = (offset, duration = 4, options = {}) => Array.from({ length: Math.round(duration * 30) }, (_, i) => frame(i / 30, offset + i / 30, options));
const clip = (id, offset, options = {}) => ({ id, duration: 4, width: 96, height: 54, samples: frames(offset, 4, options).filter((_, i) => i % 7 === 0) });
const quiet = () => ({ start: 0, rate: 8000, channels: [new Float32Array(32000), new Float32Array(32000)], hasTrack: false });
function sound(offset, { gain = 1, differentAt } = {}) {
  const data = Float32Array.from({ length: 32000 }, (_, i) => {
    const t = offset + i / 8000;
    const changed = differentAt && i / 8000 >= differentAt[0] && i / 8000 < differentAt[1];
    return gain * .15 * Math.sin(2 * Math.PI * (270 * t + 41 * t * t + (changed ? 100 * i / 8000 : 0)));
  });
  return { start: 0, rate: 8000, channels: [data, data], hasTrack: true };
}
function verified(a, b, offsetA, offsetB) {
  const aa = frames(offsetA), bb = frames(offsetB), offset = offsetB - offsetA;
  const match = verifySequence(aa, bb, offset, 4, 4);
  assert.equal(match.status, 'verified');
  return { ...match, a: a.id, b: b.id, seams: overlapSeams(aa, bb, quiet(), quiet(), match, 4, 4) };
}

test('coarse candidates and dense verification recover a real suffix/prefix overlap', () => {
  const a = clip('a', 0), b = clip('b', 2);
  const candidates = coarseCandidates(a, b);
  const results = candidates.map(candidate => refineAlignment(frames(0), frames(2), candidate, 4, 4));
  const found = results.find(result => result.status === 'verified');
  assert.ok(found, JSON.stringify({ candidates, results }));
  assert(Math.abs(found.offset - 2) < .001);
  assert.equal(found.duration, 2);
  assert(found.matches >= 50);
});

test('genuine overlap tolerates mild exposure and compression-like noise', () => {
  const result = verifySequence(frames(0), frames(2, 4, { gain: .92, exposure: 11, noise: 1 }), 2, 4, 4);
  assert.equal(result.status, 'verified', JSON.stringify(result));
});

test('coarse-to-fine search recovers offsets between sparse sample times', () => {
  const a = clip('a', 0), b = clip('b', 1.7);
  const found = coarseCandidates(a, b).map(candidate => refineAlignment(frames(0), frames(1.7), candidate, 4, 4)).find(result => result.status === 'verified');
  assert.ok(found);
  assert(Math.abs(found.offset - 1.7) < .001);
});

test('a tiny subject doing a different action is not masked by the same background', () => {
  const a = frames(0, 4, { small: true }), b = frames(2, 4, { small: true, other: true });
  assert(photoError(a[60], b[0], true).mean < .1, 'Most of these pictures deliberately match');
  assert.notEqual(verifySequence(a, b, 2, 4, 4).status, 'verified');
});

test('opposite motion with similar boundary stills cannot prove overlap', () => {
  const b = Array.from({ length: 120 }, (_, i) => frame(i / 30, 4 - i / 30));
  assert.notEqual(verifySequence(frames(0), b, 2, 4, 4).status, 'verified');
});

test('static texture, blank frames, short matches and contained clips remain review-only', () => {
  assert.notEqual(verifySequence(frames(0, 4, { still: true }), frames(2, 4, { still: true }), 2, 4, 4).status, 'verified');
  assert.notEqual(verifySequence(frames(0, 4, { blank: true }), frames(2, 4, { blank: true }), 2, 4, 4).status, 'verified');
  assert.equal(verifySequence(frames(0), frames(3.5), 3.5, 4, 4).status, 'review');
  assert.equal(verifySequence(frames(0), frames(0), 0, 4, 4).reason, 'contained');
  assert.equal(verifySequence(frames(0, 6), frames(2, 2), 2, 6, 2).reason, 'contained');
});

test('repeated captures of the same decoder frame are not consecutive evidence', () => {
  const b = frames(2).map(frame => ({ ...frame, timestamp: 0 }));
  assert.notEqual(verifySequence(frames(0), b, 2, 4, 4).status, 'verified');
});

test('matching source sound is accepted without confusing volume with different content', () => {
  assert.equal(verifySound(sound(0), sound(2, { gain: .8 }), 2, 2).ok, true);
  assert.equal(verifySound(quiet(), quiet(), 2, 2).ok, true);
  assert.equal(verifySound(sound(0), quiet(), 2, 2).ok, false);
});

test('different sound between the initial sample windows keeps the footage', () => {
  assert.equal(verifySound(sound(0), sound(2, { differentAt: [.7, .8] }), 2, 2).ok, false);
});

test('a shuffled three-clip overlap chain contains every unique interval exactly once', () => {
  const a = clip('a', 0), b = clip('b', 2), c = clip('c', 4);
  const plan = planEdit([c, a, b], { verified: [verified(a, b, 0, 2), verified(b, c, 2, 4)] });
  assert.deepEqual(plan.segments.map(part => part.id), ['a', 'b', 'c']);
  assert.equal(plan.joins.filter(join => join.kind === 'overlap').length, 2);
  const offsets = { a: 0, b: 2, c: 4 };
  const global = plan.segments.map(part => ({ start: offsets[part.id] + part.start, end: offsets[part.id] + part.end }));
  assert.equal(global[0].start, 0); assert.equal(global.at(-1).end, 8);
  for (let i = 1; i < global.length; i++) assert(Math.abs(global[i].start - global[i - 1].end) < .000001);
  assert(Math.abs(plan.segments.reduce((sum, part) => sum + part.end - part.start, 0) - 8) < .000001);
});

test('joint seams remain compatible when most of three clips is shared', () => {
  const a = clip('a', 0), b = clip('b', .5), c = clip('c', 1);
  const plan = planEdit([a, b, c], { verified: [verified(a, b, 0, .5), verified(b, c, .5, 1)] });
  assert.equal(plan.joins.filter(join => join.kind === 'overlap').length, 2);
  assert(plan.segments.every(part => part.end - part.start >= .12 - .00001));
  assert(Math.abs(plan.segments.reduce((sum, part) => sum + part.end - part.start, 0) - 5) < .000001);
});

test('uncertain overlaps preserve complete clips instead of receiving creative trims', () => {
  const a = clip('a', 0), b = clip('b', 2);
  const plan = planEdit([a, b], { reviewed: [{ a: 'a', b: 'b', reason: 'different-sound' }] });
  assert(plan.segments.every(part => part.start === 0 && part.end === 4));
  assert.equal(plan.joins.filter(join => join.kind === 'overlap').length, 0);
});

test('a repeating action with two valid timeline alignments remains intact', async () => {
  const loop = Array.from({ length: 60 }, (_, i) => frame(i / 30, i % 30 / 30));
  const clips = ['a', 'b'].map(id => ({ id, duration: 2, width: 96, height: 54, samples: loop.filter((_, i) => i % 3 === 0) }));
  const plan = await analyzeJoins({ clips, getBlob: clip => clip.id,
    readSources: async () => clips.map(clip => ({ id: clip.id, packets: loop.map(frame => ({ timestamp: frame.t, duration: 1 / 30 })) })),
    inspect: async (_, times) => ({ frames: times.map(time => ({ ...loop[Math.min(59, Math.floor(time * 30 + .0001))], t: time })), audio: quiet() }) });
  assert(plan.reviewed.length > 0);
  assert.equal(plan.joins.filter(join => join.kind === 'overlap').length, 0);
  assert(plan.segments.every(part => part.start === 0 && part.end === 2));
});

test('six heavily overlapping clips keep one valid interval per clip and no repeated time', () => {
  const clips = Array.from({ length: 6 }, (_, i) => clip(String(i), i * .7));
  const joins = clips.slice(0, -1).map((a, i) => verified(a, clips[i + 1], i * .7, (i + 1) * .7));
  const plan = planEdit([...clips].reverse(), { verified: joins });
  assert.deepEqual(plan.segments.map(part => part.id), ['0', '1', '2', '3', '4', '5']);
  assert.equal(plan.joins.filter(join => join.kind === 'overlap').length, 5);
  assert(Math.abs(plan.segments.reduce((sum, part) => sum + part.end - part.start, 0) - 7.5) < .000001);
  assert(plan.segments.every(part => part.end - part.start >= .12 - .00001));
});
