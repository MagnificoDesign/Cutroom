import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBank, MAX_EDIT_SECONDS } from './edit-policy.mjs';
import { compactFrames, proposeConnections, selectSequence } from './continuity-core.mjs';
import { checkConnection } from './connection.mjs';
import { validatePlan } from './planner.mjs';
import { describePixels } from './media.mjs';
import { refineMotion } from './motion.mjs';

const texture = (x, y) => 128 + 32 * Math.sin(x * .27) + 29 * Math.sin(y * .36) + 20 * Math.sin(x * .81 + y * .57) + 15 * Math.cos(x * .39 - y * .85);
function frame(dx, t, change = false) {
  const data = new Uint8ClampedArray(96 * 54 * 4);
  for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) {
    const at = (y * 96 + x) * 4, value = change && x > 42 && x < 48 && y > 23 && y < 29 ? 250 : texture(x - dx, y);
    data[at] = data[at + 1] = data[at + 2] = value; data[at + 3] = 255;
  }
  return describePixels(data, t, t, 1 / 30);
}
async function seam({ reverse = false, jump = 0, changed = false } = {}) {
  const a = { duration: 1, samples: Array.from({ length: 6 }, (_, i) => frame((i - 5) * .6, .8 + i / 30)) };
  const b = { duration: 1, samples: Array.from({ length: 6 }, (_, i) => frame((1 + jump + (reverse ? -i : i)) * .6, i / 30, changed)) };
  await refineMotion([a, b]); return { a, b };
}

test('375 four-second takes fit the bank; explicit bounds protect processing', () => {
  checkBank(Array.from({ length: 375 }, (_, i) => ({ id: String(i), duration: 4 })));
  assert.throws(() => checkBank(Array.from({ length: 501 }, () => ({ duration: 1 }))), /500/);
  assert.throws(() => checkBank([{ duration: 1801 }]), /30 minutes/);
  assert.throws(() => checkBank([{ duration: NaN }]), /readable/);
});

test('large bank uses a compatible subset, crosses 32-bit IDs and caps at four minutes', async () => {
  const clips = Array.from({ length: 375 }, (_, i) => ({ id: String(i), duration: 4 }));
  const edges = Array.from({ length: 149 }, (_, i) => ({ a: String(i * 2), b: String((i + 1) * 2), end: 3, start: 1, cost: .01, status: 'verified' }));
  const plan = await selectSequence(clips, edges, { confirmedOnly: true });
  assert(plan.segments.length > 32); assert(plan.segments.length < 150);
  assert.equal(plan.duration, MAX_EDIT_SECONDS);
  assert.equal(plan.segments[0].start, 0); assert.equal(plan.segments.at(-1).end, 4);
  assert.equal(new Set(plan.segments.map(p => p.id)).size, plan.segments.length);
  assert(plan.segments.every(p => Number(p.id) % 2 === 0));
  validatePlan(clips, plan.segments, { allowSubset: true });
  assert.throws(() => validatePlan(clips, plan.segments), /every/);
});

test('middle takes can contribute less than 45% while their two cuts remain compatible', async () => {
  const clips = ['a', 'b', 'c', 'unrelated'].map(id => ({ id, duration: 4 }));
  const edges = [
    { a: 'a', b: 'b', end: 3, start: 2, cost: .01, status: 'verified' },
    { a: 'b', b: 'c', end: 1, start: 0, cost: 0, status: 'verified' },
    { a: 'b', b: 'c', end: 2.6, start: .5, cost: .01, status: 'verified' }
  ];
  const plan = await selectSequence(clips, edges, { confirmedOnly: true });
  assert.deepEqual(plan.segments.map(p => p.id), ['a', 'b', 'c']);
  assert(Math.abs(plan.segments[1].end - plan.segments[1].start - .6) < 1e-6);
  validatePlan(clips, plan.segments, { allowSubset: true });
});

test('unverified, invalid and rejected edges never enter the delivered sequence', async () => {
  const clips = ['a', 'b', 'c'].map(id => ({ id, duration: 4 }));
  const edges = ['coarse', 'rejected'].map(status => ({ a: 'a', b: 'b', end: 4, start: 0, cost: 0, status }));
  edges.push({ a: 'a', b: 'c', end: 4, start: -1, cost: 0, status: 'verified' });
  edges.push({ a: 'b', b: 'c', end: 4, start: 0, cost: NaN, status: 'verified' });
  const plan = await selectSequence(clips, edges, { confirmedOnly: true });
  assert.equal(plan.segments.length, 1); assert.equal(plan.joins.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(selectSequence(clips, edges, { signal: controller.signal }), { name: 'AbortError' });
});

test('a middle interval keeps enough pictures for a required incoming bridge', async () => {
  const clips = ['a', 'b', 'c'].map(id => ({ id, duration: 4 }));
  const edges = [
    { a: 'a', b: 'b', end: 3, start: 2, cost: .01, status: 'verified', requiresBridge: true },
    { a: 'b', b: 'c', end: 2.5, start: 1, cost: 0, status: 'verified' },
    { a: 'b', b: 'c', end: 2.65, start: 1, cost: .01, status: 'verified' }
  ];
  const plan = await selectSequence(clips, edges, { confirmedOnly: true });
  assert.deepEqual(plan.segments.map(p => p.id), ['a', 'b', 'c']);
  assert.equal(plan.segments[1].end, 2.65);
});

test('four-minute ending stays on a native frame boundary', async () => {
  const clips = [{ id: 'a', duration: 300, frameTimes: [0, 100, 239.98, 240.02, 299.9] }];
  const plan = await selectSequence(clips, []);
  assert.equal(plan.segments[0].end, 239.98);
});

test('frame banks retain descriptors and motion, not thousands of decoded images', () => {
  const frames = compactFrames([frame(0, 0), frame(.6, 1 / 30)]);
  assert.equal(frames[0].pixels, undefined); assert.equal(frames[0].gray, undefined);
  assert(frames[0].tile instanceof Float32Array); assert(frames[0].chroma instanceof Float32Array);
  assert(frames[0].outMotion && frames[1].inMotion);
});

test('temporal admission accepts natural motion and rejects reversal, new subjects and large jumps', async () => {
  const natural = await seam();
  const good = await checkConnection(natural.a, natural.b, 1, 0);
  assert(good?.native, JSON.stringify(good));
  for (const options of [{ reverse: true }, { jump: 10 }, { changed: true }]) {
    const { a, b } = await seam(options);
    assert.equal(await checkConnection(a, b, 1, 0), null, JSON.stringify(options));
  }
});

test('flat images never create apparent connections in the candidate bank', async () => {
  const pixels = new Uint8ClampedArray(96 * 54 * 4).fill(127);
  const clips = ['a', 'b'].map(id => ({ id, duration: 1, width: 96, height: 54, samples: [.1, .5, .9].map(t => describePixels(pixels, t, t, .1)) }));
  assert.deepEqual(await proposeConnections(clips), []);
});

test('candidate exits follow variable native timing even when decoded frame durations are nominal', async () => {
  const times = Array.from({ length: 30 }, (_, i) => Math.round(i * 1000 / 30) / 1000);
  const clips = ['a', 'b'].map(id => ({ id, duration: 1, width: 96, height: 54, frameTimes: times,
    samples: compactFrames(times.map((t, i) => frame(i * .01, t))) }));
  const edges = await proposeConnections(clips);
  assert(edges.length > 0);
  assert(edges.every(e => e.end === 1 || times.includes(e.end)), JSON.stringify(edges));
});
