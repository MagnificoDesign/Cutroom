import test from 'node:test';
import assert from 'node:assert/strict';
import { soundWindow, soundAllowsCut, pauseCandidates, soundRanges } from './audio-cuts.mjs';
import { planEdit } from './planner.mjs';

function audio(pauses = [], { gain = 1, stereo = false, noTrack = false } = {}) {
  const rate = 8000, duration = 4;
  const data = Float32Array.from({ length: rate * duration }, (_, i) => {
    const t = i / rate;
    if (noTrack || pauses.some(([start, end]) => t >= start && t < end)) return 0;
    return gain * .12 * Math.sin(2 * Math.PI * (220 * t + 23 * t * t));
  });
  return { start: 0, rate, channels: [data, stereo ? data.map(v => -v) : data], hasTrack: !noTrack };
}
const checked = (pauses, options) => ({ duration: 4, sound: { status: 'checked', windows: [soundWindow(audio(pauses, options))] } });
const frame = (t, shape) => ({ t, mean: .4, variance: .05, black: 0, white: 0, tile: Array.from({ length: 48 }, (_, i) => (Math.sin(i * 9.17 + shape * 33.13) * 10000) % 1 * .4 + .5), edge: Array(48).fill(.08) });
const clips = () => [
  { id: 'a', duration: 4, samples: Array.from({ length: 17 }, (_, i) => frame(i / 4, i / 4 < 1 ? 0 : i / 4 < 2.75 ? 1 : 2)) },
  { id: 'b', duration: 4, samples: Array.from({ length: 17 }, (_, i) => frame(i / 4, i / 4 < .75 ? 3 : i / 4 < 2.75 ? 1 : 4)) }
];

test('an interior cut needs quiet on both sides, not a momentary waveform zero', () => {
  const clip = checked([[1, 1.06], [2, 2.4]]);
  assert.equal(soundAllowsCut(clip, 1.03, 'in'), false);
  assert.equal(soundAllowsCut(clip, 1.5, 'in'), false);
  assert.equal(soundAllowsCut(clip, 2.2, 'out'), true);
  assert.equal(soundAllowsCut(clip, 2.04, 'out'), false);
  assert(pauseCandidates(clip, 'out').some(t => Math.abs(t - 2.2) < .04));
});

test('pause evidence survives volume changes without treating opposite stereo as silence', () => {
  for (const gain of [.1, 1, 3]) {
    const clip = checked([[1, 1.4]], { gain, stereo: true });
    assert.equal(soundAllowsCut(clip, .6, 'in'), false);
    assert.equal(soundAllowsCut(clip, 1.2, 'in'), true);
  }
});

test('failed or uninspected sound preserves original boundaries', () => {
  const unavailable = { duration: 4, sound: { status: 'unavailable', windows: [] } };
  assert.equal(soundAllowsCut(unavailable, 2, 'out'), false);
  assert.equal(soundAllowsCut(unavailable, 0, 'in'), true);
  assert.equal(soundAllowsCut(unavailable, 4, 'out'), true);
  const clip = checked([[1, 1.4]]);
  clip.sound.windows[0].start = .5;
  assert.equal(soundAllowsCut(clip, .4, 'in'), false);
});

test('silent clips allow visual cuts but supply no artificial pause preference', () => {
  const clip = checked([], { noTrack: true });
  assert.equal(soundAllowsCut(clip, 1, 'in'), true);
  assert.deepEqual(pauseCandidates(clip, 'in'), []);
});

test('joint planning moves attractive visual cuts into actual acoustic pauses', () => {
  const source = clips();
  assert.deepEqual(planEdit(source).segments, [{ id: 'a', start: 0, end: 2.5 }, { id: 'b', start: .75, end: 4 }]);
  source[0].sound = checked([[2.05, 2.55]]).sound;
  source[1].sound = checked([[.85, 1.25]]).sound;
  const plan = planEdit(source);
  assert.equal(plan.improved, true);
  assert.deepEqual(plan.segments.map(p => p.id), ['a', 'b']);
  assert(plan.segments[0].end >= 2.13 && plan.segments[0].end <= 2.47);
  assert(plan.segments[1].start >= .93 && plan.segments[1].start <= 1.17);
  assert(plan.segments.every(p => soundAllowsCut(source.find(c => c.id === p.id), p.start, 'in') && soundAllowsCut(source.find(c => c.id === p.id), p.end, 'out')));
});

test('continuous audible material is kept instead of being trimmed for a visual match', () => {
  const source = clips().map(clip => ({ ...clip, sound: checked([]).sound }));
  assert(planEdit(source).segments.every(p => p.start === 0 && p.end === 4));
});

test('long-clip sound inspection stays within a 24-second budget with merged ranges', () => {
  assert.deepEqual(soundRanges({ duration: 4 }, { start: 1, end: 3 }), [[0, 4]]);
  for (const part of [{ start: 0, end: 180 }, { start: 50, end: 100 }, { start: 2, end: 178 }, { start: 50, end: 52 }]) {
    const ranges = soundRanges({ duration: 180 }, part);
    assert(ranges.reduce((sum, [a, b]) => sum + b - a, 0) <= 24);
    assert(ranges.every(([a, b], i) => a >= 0 && b <= 180 && b > a && (!i || a > ranges[i - 1][1])));
  }
});
