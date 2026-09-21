import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceTimes, cutAt, nearbyFrames, coarseFrames } from './cut-timing.mjs';
import { pauseCandidates } from './audio-cuts.mjs';
import { planEdit } from './planner.mjs';
import { describePixels } from './media.mjs';
import { refineMotion } from './motion.mjs';

test('cut neighborhoods retain native fractional-rate timestamps, including the intervening 60 fps frames', () => {
  for (const rate of [24, 24000 / 1001, 30000 / 1001, 60, 60000 / 1001]) {
    const packets = Array.from({ length: 240 }, (_, i) => ({ timestamp: i / rate }));
    const clip = { duration: 240 / rate, frameTimes: sourceTimes(packets.reverse(), 240 / rate) };
    const times = nearbyFrames(clip, 1, 1.2);
    assert(times.every(t => packets.some(p => p.timestamp === t)));
    assert.equal(times.length, packets.filter(p => p.timestamp >= 1 - 1e-7 && p.timestamp <= 1.2 + 1e-7).length);
    if (rate === 60) assert(times.includes(61 / 60));
    assert.equal(cutAt(clip, clip.duration), clip.duration);
  }
});

test('VFR search uses advancing PTS, keeps the last picture and bounds sparse/dense decoding', () => {
  const clip = { duration: .3, frameTimes: sourceTimes([.0, .017, .034, .05, .091, .14, .24, .24].map(timestamp => ({ timestamp })), .3) };
  assert.deepEqual(nearbyFrames(clip, .04, .15, { pad: 1 }), [.034, .05, .091, .14, .24]);
  assert.equal(cutAt(clip, .075), .091); assert.equal(cutAt(clip, .27, 0, .25), .24);
  assert.equal(cutAt(clip, .16, .15, .2), undefined, 'a gap cannot invent a cut timestamp');
  assert.equal(coarseFrames(clip).at(-1), .24);
  const long = { duration: 180, frameTimes: Array.from({ length: 21600 }, (_, i) => i / 120) };
  assert(coarseFrames(long).length <= 101);
  assert.equal(nearbyFrames(long, 0, 180).length, 1500);
});

test('acoustic pause candidates snap only to frames that remain inside the quiet window', () => {
  const clip = { duration: 4, frameTimes: [0, 1.95, 2.15, 2.2337, 2.5, 3.9], sound: { status: 'checked', windows: [{ start: 0, end: 4, step: .02, levels: new Float32Array(200), threshold: .001, pauses: [[2.05, 2.4]] }] } };
  assert.deepEqual(pauseCandidates(clip, 'out'), [2.2337]);
  clip.frameTimes = [0, 2.12, 2.34, 3.9];
  assert.deepEqual(pauseCandidates(clip, 'out'), [], 'do not snap beyond the safe acoustic margins');
});

test('the joint planner cannot select a coarse or refined cut between native pictures', () => {
  const frame = (t, shape) => ({ t, mean: .4, variance: .05, black: 0, white: 0, tile: Array.from({ length: 48 }, (_, i) => (Math.sin(i * 9.17 + shape * 33.13) * 10000) % 1 * .4 + .5), edge: Array(48).fill(.08) });
  const source = ['a', 'b'].map((id, index) => ({ id, duration: 4, frameTimes: Array.from({ length: 240 }, (_, i) => i / 60), fineIn: [.759], fineOut: [2.491], samples: Array.from({ length: 17 }, (_, i) => frame(i / 4, index ? i / 4 < .75 ? 3 : i / 4 < 2.75 ? 1 : 4 : i / 4 < 1 ? 0 : i / 4 < 2.75 ? 1 : 2)) }));
  const plan = planEdit(source); assert(plan.improved);
  for (const part of plan.segments) for (const time of [part.start, part.end]) assert(time === 0 || time === 4 || source.find(c => c.id === part.id).frameTimes.includes(time));
});

test('motion scoring uses the true final-frame interval instead of a nearby cached 30 fps prediction', async () => {
  for (const rate of [24, 25, 50, 60]) {
    const clips = ['a', 'b'].map((id, clipIndex) => ({ id, duration: 3 / rate, samples: Array.from({ length: 3 }, (_, n) => {
      const data = new Uint8ClampedArray(96 * 54 * 4), dx = (clipIndex * 3 + n) * .6;
      for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) {
        const xx = x - dx, v = 128 + 32 * Math.sin(xx * .27) + 29 * Math.sin(y * .36) + 20 * Math.sin(xx * .81 + y * .57) + 15 * Math.cos(xx * .39 - y * .85);
        data.fill(v, (y * 96 + x) * 4, (y * 96 + x) * 4 + 3); data[(y * 96 + x) * 4 + 3] = 255;
      }
      return describePixels(data, n / rate, n / rate, 1 / rate);
    }) }));
    await refineMotion(clips);
    const cached = planEdit(clips).baselineCost;
    clips.forEach(clip => clip.samples.forEach(frame => { delete frame.nextPicture; }));
    assert(Math.abs(cached - planEdit(clips).baselineCost) < 1e-12, `${rate} fps cached prediction must agree with the native interval`);
  }
});
