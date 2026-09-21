import test from 'node:test';
import assert from 'node:assert/strict';
import { planEdit, planEditAsync, validatePlan, boundaryCost, flow } from './planner.mjs';
import { makePlan } from './core.mjs';

const frame = (t, shape = 0, blank = false) => ({ t, mean: blank ? 0 : .4, variance: blank ? 0 : .05, black: blank ? 1 : 0, white: 0, tile: Array.from({ length: 48 }, (_, i) => blank ? 0 : (Math.sin(i * 9.17 + shape * 33.13) * 10000) % 1 * .4 + .5), edge: Array(48).fill(blank ? 0 : .08) });
const clip = (id, shape) => ({ id, duration: 4, samples: Array.from({ length: 17 }, (_, i) => frame(i / 4, shape(i / 4))) });

test('joint plan selects useful interior cuts in two four-second clips', () => {
  const clips = [clip('a', t => t < 1 ? 0 : t < 2.75 ? 1 : 2), clip('b', t => t < .75 ? 3 : t < 2.75 ? 1 : 4)];
  const edit = planEdit(clips);
  assert.equal(edit.improved, true);
  assert.deepEqual(edit.segments, [{ id: 'a', start: 0, end: 2.5 }, { id: 'b', start: .75, end: 4 }]);
  assert(edit.cost < edit.baselineCost - .06);
});

test('middle-clip incoming and outgoing cuts leave a valid meaningful interval', () => {
  const clips = Array.from({ length: 6 }, (_, i) => clip(String(i), t => t < 1 ? i : t < 2.75 ? i + 1 : i + 2));
  const edit = planEdit(clips);
  assert.equal(new Set(edit.segments.map(part => part.id)).size, 6);
  validatePlan(clips, edit.segments);
  assert(edit.segments.every(part => part.end - part.start >= 1.8 - .0001));
  assert(edit.cost <= edit.baselineCost);
});

test('blank frames cannot justify reordering or trimming', () => {
  const clips = ['a', 'b', 'c'].map(id => ({ id, duration: 4, samples: Array.from({ length: 17 }, (_, i) => frame(i / 4, 0, true)) }));
  const edit = planEdit(clips);
  assert.equal(edit.improved, false);
  assert.deepEqual(edit.segments, clips.map(clip => ({ id: clip.id, start: 0, end: 4 })));
});

test('no objective improvement preserves the original order and full durations', () => {
  const clips = ['a', 'b', 'c'].map(id => clip(id, () => 1));
  assert.equal(planEdit(clips).improved, false);
  assert.deepEqual(planEdit(clips).segments, clips.map(clip => ({ id: clip.id, start: 0, end: 4 })));
});

test('opposite movement costs more than continuing movement at identical stills', () => {
  const out = { frame: frame(0), vector: { x: .1, y: 0, confidence: 1 } };
  const same = boundaryCost(out, out);
  const opposite = boundaryCost(out, { frame: frame(0), vector: { x: -.1, y: 0, confidence: 1 } });
  assert(opposite.cost > same.cost + .25);
});

test('bounded block matching detects signed camera movement', () => {
  const a = frame(0), b = frame(.25);
  a.gray = Float32Array.from({ length: 32 * 18 }, (_, i) => (Math.sin(i * 23.45) * 999 % 1 + 1) / 2);
  b.gray = Float32Array.from({ length: 32 * 18 }, (_, i) => i % 32 ? a.gray[i - 1] : 0);
  const movement = flow(a, b);
  assert(movement.x > 0);
  assert(movement.confidence > .2);
});

test('sparse overlap candidates never silently discard unique leading material', () => {
  const clips = [{ id: 'a', duration: 4 }, { id: 'b', duration: 4 }];
  assert.deepEqual(makePlan(clips, ['a', 'b'], [{ a: 'a', b: 'b', match: { level: 'high', bStart: 2, bEnd: 3 } }]), [{ id: 'a', start: 0, end: 4 }, { id: 'b', start: 0, end: 4 }]);
});

test('invalid, duplicate, omitted and out-of-range segments are rejected', () => {
  const clips = [{ id: 'a', duration: 4 }];
  for (const plan of [[], [{ id: 'a', start: 3, end: 2 }], [{ id: 'a', start: -1, end: 2 }], [{ id: 'a', start: 0, end: 5 }], [{ id: 'b', start: 0, end: 4 }]]) assert.throws(() => validatePlan(clips, plan));
});

test('the cooperative planner preserves the joint result and cancels between search batches', async () => {
  const clips = Array.from({ length: 6 }, (_, i) => clip(String(i), t => t < 1 ? i : t < 2.75 ? i + 1 : i + 2));
  assert.deepEqual(await planEditAsync(clips), planEdit(clips));
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('Stopped', 'AbortError')), 0);
  await assert.rejects(planEditAsync(clips, {}, controller.signal), { name: 'AbortError' });
});
