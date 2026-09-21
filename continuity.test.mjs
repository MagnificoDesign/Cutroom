import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBank, MAX_EDIT_SECONDS } from './edit-policy.mjs';
import { compactFrames, proposeConnections, selectSequence } from './continuity-core.mjs';
import { checkConnection, checkSimilarConnection } from './connection.mjs';
import { validateMatchImages } from './transition-core.mjs';
import { validatePlan } from './planner.mjs';
import { describePixels } from './media.mjs';
import { refineMotion } from './motion.mjs';
import { coarseFrames } from './cut-timing.mjs';
import { analyzeContinuity } from './continuity.mjs';

const texture = (x, y) => 128 + 32 * Math.sin(x * .27) + 29 * Math.sin(y * .36) + 20 * Math.sin(x * .81 + y * .57) + 15 * Math.cos(x * .39 - y * .85);
function frame(dx, t, change = false, brightness = 0) {
  const data = new Uint8ClampedArray(96 * 54 * 4);
  for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) {
    const at = (y * 96 + x) * 4, value = change && x > 42 && x < 48 && y > 23 && y < 29 ? 250 : texture(x - dx, y);
    data[at] = data[at + 1] = data[at + 2] = value + brightness; data[at + 3] = 255;
  }
  return { ...describePixels(data, t, t, 1 / 30), image: { data, width: 96, height: 54 } };
}
async function seam({ reverse = false, jump = 0, changed = false, brightness = 0 } = {}) {
  const a = { duration: 1, samples: Array.from({ length: 6 }, (_, i) => frame((i - 5) * .6, .8 + i / 30)) };
  const b = { duration: 1, samples: Array.from({ length: 6 }, (_, i) => frame((1 + jump + (reverse ? -i : i)) * .6, i / 30, changed, brightness)) };
  await refineMotion([a, b]); return { a, b };
}

test('375 four-second takes fit the bank; explicit bounds protect processing', () => {
  checkBank(Array.from({ length: 375 }, (_, i) => ({ id: String(i), duration: 4 })));
  assert.throws(() => checkBank(Array.from({ length: 501 }, () => ({ duration: 1 }))), /500/);
  assert.throws(() => checkBank([{ duration: 1801 }]), /30 minutes/);
  assert.throws(() => checkBank([{ duration: NaN }]), /readable/);
});

test('large bank retains a connected sequence beyond four minutes without repeated IDs', async () => {
  const clips = Array.from({ length: 375 }, (_, i) => ({ id: String(i), duration: 4 }));
  const edges = Array.from({ length: 149 }, (_, i) => ({ a: String(i * 2), b: String((i + 1) * 2), end: 3, start: 1, cost: .01, status: 'verified' }));
  const plan = await selectSequence(clips, edges, { confirmedOnly: true });
  assert.equal(plan.segments.length, 150);
  assert.equal(plan.duration, 302); assert(plan.duration < MAX_EDIT_SECONDS);
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

test('an explicit search target stays on a native frame boundary', async () => {
  const clips = [{ id: 'a', duration: 300, frameTimes: [0, 100, 239.98, 240.02, 299.9] }];
  const plan = await selectSequence(clips, [], { target: 240 });
  assert.equal(plan.segments[0].end, 239.98);
});

test('frame banks retain descriptors and motion, not thousands of decoded images', () => {
  const frames = compactFrames([frame(0, 0), frame(.6, 1 / 30)]);
  assert.equal(frames[0].pixels, undefined); assert.equal(frames[0].gray, undefined);
  assert.equal(frames[0].image, undefined);
  assert(frames[0].tile instanceof Float32Array); assert(frames[0].chroma instanceof Float32Array);
  assert(frames[0].outMotion && frames[1].inMotion);
});

test('a short connected route beats a full untouched clip and reaches verification', async () => {
  const clips = [{ id: 'opening', duration: 4 }, { id: 'ending', duration: 4 }, { id: 'unrelated', duration: 30 }];
  for (const status of ['coarse', 'verified']) {
    const edge = { a: 'opening', b: 'ending', end: 1, start: 3, cost: .01, status };
    const plan = await selectSequence(clips, [edge], { confirmedOnly: status === 'verified' });
    assert.deepEqual(plan.segments.map(p => p.id), ['opening', 'ending']); assert.equal(plan.duration, 2);
  }
  const unverified = await selectSequence(clips, [{ a: 'opening', b: 'ending', end: 1, start: 3, cost: .01, status: 'coarse' }], { confirmedOnly: true });
  assert.deepEqual(unverified.segments.map(p => p.id), ['unrelated']);
});

test('related takes tolerate a small light difference while retaining temporal and local checks', async () => {
  const { a, b } = await seam({ brightness: 8 });
  assert.equal(await checkConnection(a, b, 1, 0), null);
  const match = await checkSimilarConnection(a, b, 1, 0);
  assert(match?.similar && match.native);
  assert(await validateMatchImages(match.bridge, a.samples.at(-1).image, b.samples[0].image));
  for (const options of [{ reverse: true }, { jump: 10 }, { changed: true }, { brightness: 40 }]) {
    const pair = await seam(options);
    assert.equal(await checkSimilarConnection(pair.a, pair.b, 1, 0), null, JSON.stringify(options));
  }
  const colored = { ...b.samples[0].image, data: new Uint8ClampedArray(b.samples[0].image.data) };
  for (let y = 23; y < 30; y++) for (let x = 42; x < 49; x++) { const i = (y * 96 + x) * 4; colored.data[i] = 255; colored.data[i + 2] = 0; }
  assert.equal(await validateMatchImages(match.bridge, a.samples.at(-1).image, colored), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(checkSimilarConnection(a, b, 1, 0, controller.signal), { name: 'AbortError' });
});

test('a tiny static framing discrepancy needs an actual finishing correction', async () => {
  const a = { duration: 1, width: 96, height: 54, samples: Array.from({ length: 6 }, (_, i) => frame(0, .8 + i / 30)) };
  const b = { duration: 1, width: 96, height: 54, samples: Array.from({ length: 6 }, (_, i) => frame(.8, i / 30)) };
  await refineMotion([a, b]);
  assert.equal(await checkConnection(a, b, 1, 0), null);
  const match = await checkSimilarConnection(a, b, 1, 0);
  assert(match?.finishing && !match.native);
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

test('denser short-take scan ranks the actual moving pose ahead of repetitive-looking alternatives', async () => {
  const world = (x, y) => 128 + 28 * Math.sin(x * .27182818) + 21 * Math.sin(y * .36)
    + 18 * Math.sin(x * .811803 + y * .57) + 17 * Math.cos(x * .393729 - y * .85)
    + 13 * Math.sin(x * .141421 + y * .11272) + 10 * Math.cos(x * .074 + Math.sin(y * .6));
  const clips = Array.from({ length: 3 }, (_, take) => {
    const clip = { id: String(take), duration: 4, width: 96, height: 54, frameTimes: Array.from({ length: 120 }, (_, i) => i / 30) };
    clip.samples = compactFrames(coarseFrames(clip, { interval: .1, limit: 240 }).map(t => {
      const data = new Uint8ClampedArray(96 * 54 * 4);
      for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) {
        const i = (y * 96 + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = world(x - (take * 72 + t * 30) * .6, y) + (take % 2 ? 8 : 0); data[i + 3] = 255;
      }
      return describePixels(data, t, t, 1 / 30);
    }));
    assert(clip.samples.length >= 40); assert(clip.samples.every(f => f.detail.length === 144 && !f.pixels));
    return clip;
  });
  const edges = await proposeConnections(clips);
  for (const a of ['0', '1']) {
    const best = edges.filter(e => e.a === a).sort((a, b) => a.cost - b.cost)[0];
    assert.equal(best.b, String(Number(a) + 1));
    assert(Math.abs(best.end - best.start - 2.4) < .1);
  }
});

test('output-size minor texture differences get a matched-cut check even when thumbnails look exact', async () => {
  const clips = ['a', 'b'].map(id => ({ id, duration: 1, width: 192, height: 108 }));
  const picture = (id, changedSubject) => {
    const data = new Uint8ClampedArray(192 * 108 * 4);
    for (let y = 0; y < 108; y++) for (let x = 0; x < 192; x++) {
      const i = (y * 192 + x) * 4;
      const detail = id === 'b' ? (x + y) % 2 ? 8 : -8 : 0;
      const value = id === 'b' && changedSubject && x > 85 && x < 102 && y > 45 && y < 62 ? 250 : texture(x / 2, y / 2) + detail;
      data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
    }
    return { data, width: 192, height: 108 };
  };
  for (const changedSubject of [false, true]) {
    const plan = await analyzeContinuity({ clips, getBlob: clip => clip, signal: new AbortController().signal,
      readSources: async clips => clips.map(clip => ({ id: clip.id, packets: Array.from({ length: 30 }, (_, i) => ({ timestamp: i / 30, duration: 1 / 30 })) })),
      inspect: async (_, times) => ({ frames: times.map(t => frame(0, Math.floor(t * 30) / 30)) }),
      readPictures: async (clip, requests) => requests.map(request => ({ timestamp: request.time, image: picture(clip.id, changedSubject) })) });
    assert.equal(plan.segments.length, changedSubject ? 1 : 2);
    if (!changedSubject) assert(plan.joins[0].similar && !plan.joins[0].requiresBridge);
  }
});

test('interior-pose search retains a promising complete boundary for motion bridging', async () => {
  const clips = [0, 61, 122].map((offset, index) => {
    const clip = { id: String(index), duration: 2, width: 96, height: 54, frameTimes: Array.from({ length: 60 }, (_, i) => i / 30) };
    clip.samples = compactFrames(coarseFrames(clip, { interval: .1, limit: 240 }).map(t => frame((offset + t * 30) * .6, t)));
    return clip;
  });
  const edges = await proposeConnections(clips);
  for (const [a, b] of [['0', '1'], ['1', '2']]) assert(edges.some(e => e.a === a && e.b === b && e.end === 2 && e.start === 0));
});
