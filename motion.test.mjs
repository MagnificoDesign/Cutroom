import test from 'node:test';
import assert from 'node:assert/strict';
import { trackMotion, refineMotion, predictPicture, motionVector } from './motion.mjs';
import { boundaryCost } from './planner.mjs';
import { describePixels } from './media.mjs';
import { chooseBridge, interpolateSmall, interpolateFrame, easeTime } from './transition-core.mjs';
import { canSmoothJoin } from './transitions.mjs';
import { renderTimeline } from './render-core.mjs';

const texture = (x, y) => 128 + 32 * Math.sin(x * .27) + 29 * Math.sin(y * .36) + 20 * Math.sin(x * .81 + y * .57) + 15 * Math.cos(x * .39 - y * .85);
function frame(dx, dy = 0, bias = 0) {
  const pixels = Uint8Array.from({ length: 96 * 54 }, (_, i) => texture(i % 96 - dx, Math.floor(i / 96) - dy) + bias);
  const data = new Uint8ClampedArray(96 * 54 * 4);
  for (let i = 0; i < pixels.length; i++) { for (let c = 0; c < 3; c++) data[i * 4 + c] = pixels[i]; data[i * 4 + 3] = 255; }
  return { pixels, image: { data, width: 96, height: 54 } };
}
function seam({ skip = 1, opposite = false } = {}) {
  const a = Array.from({ length: 6 }, (_, i) => ({ ...frame((i - 5) * .6), timestamp: i / 30, outputTime: i / 30 }));
  const b = Array.from({ length: 6 }, (_, i) => ({ ...frame((1 + skip + (opposite ? -i : i)) * .6), timestamp: i / 30, outputTime: (i + 6) / 30 }));
  return { a, b };
}

test('subpixel tracks recover known camera motion despite mild exposure change', () => {
  for (const [dx, dy] of [[.6, .3], [1.3, -.4], [-1.7, .8]]) {
    const field = trackMotion(frame(0).pixels, frame(dx, dy, 5).pixels);
    assert(field.confidence > .8);
    assert(Math.abs(field.x - dx) < .13 && Math.abs(field.y - dy) < .13, JSON.stringify(field.camera));
    assert(field.tracks.every(p => p.cycle <= .7));
  }
});

test('blank pictures and unrelated motion give no confident tracks', () => {
  assert.equal(trackMotion(new Uint8Array(5184), new Uint8Array(5184)).confidence, 0);
  const unrelated = Uint8Array.from({ length: 5184 }, (_, i) => Math.abs(Math.sin(i * 798.917)) * 255);
  assert(trackMotion(frame(0).pixels, unrelated).confidence < .3);
});

test('small coherent subject movement is retained against a still background', () => {
  const make = offset => Uint8Array.from({ length: 5184 }, (_, i) => {
    const x = i % 96, y = Math.floor(i / 96);
    return x >= 29 + offset && x < 53 + offset && y >= 13 && y < 39 ? texture(x - offset + 20, y + 10) : texture(x, y);
  });
  const field = trackMotion(make(0), make(1));
  assert.equal(field.local, true);
  assert(field.x > .7 && Math.abs(field.camera.x) < .1);
});

test('predicted continuation favors the next moving pose over replaying an identical still', () => {
  const a = frame(0), last = frame(.6), next = frame(1.2);
  const field = trackMotion(a.pixels, last.pixels); field.dt = 1 / 30;
  const describe = f => describePixels(f.image.data, 0);
  const out = { frame: describe(last), vector: motionVector(field, field.dt) };
  out.prediction = predictPicture(out.frame, field, field.dt);
  const duplicate = boundaryCost(out, { frame: describe(last), vector: out.vector });
  const continuation = boundaryCost(out, { frame: describe(next), vector: out.vector });
  assert(continuation.cost < duplicate.cost, JSON.stringify({ duplicate, continuation }));
});

test('good native joins stay original; a small temporal jump gets a bounded bridge', async () => {
  const natural = seam({ skip: 0 });
  assert.equal(await chooseBridge(natural.a, natural.b), null);
  const { a, b } = seam();
  const bridge = await chooseBridge(a, b);
  assert(bridge, 'Expected a bridge for a one-frame gap in consistent motion');
  assert(bridge.left + bridge.right <= 8 && bridge.left > 0);
  const aa = a[a.length - bridge.left - 1], bb = b[bridge.right];
  let prior = aa, largestStep = 0;
  for (const source of [...a.slice(a.length - bridge.left), ...b.slice(0, bridge.right), bb]) {
    const t = (source.outputTime - bridge.start) / (bridge.end - bridge.start);
    const image = interpolateSmall(bridge, aa.image, bb.image, t);
    const gray = Uint8Array.from({ length: 5184 }, (_, i) => image.data[i * 4]);
    const movement = trackMotion(prior.pixels, gray);
    assert(movement.x > .3 && movement.x < 1.05, `Abrupt generated movement: ${movement.x}`);
    largestStep = Math.max(largestStep, movement.x);
    prior = { pixels: gray };
    // Independently known scene geometry: the warped picture should follow
    // the eased trajectory, rather than double-exposing the two end frames.
    const expectedX = (a.length - bridge.left - 1 - 5) * .6 + (bb.image ? (1 + bridge.right + 1) * .6 - (a.length - bridge.left - 1 - 5) * .6 : 0) * easeTime(t, bridge.m0, bridge.m1);
    const truth = frame(expectedX).image;
    let error = 0, blendError = 0;
    for (let y = 4; y < 50; y++) for (let x = 4; x < 92; x++) {
      const i = (y * 96 + x) * 4;
      error += Math.abs(image.data[i] - truth.data[i]);
      blendError += Math.abs((aa.image.data[i] * (1 - t) + bb.image.data[i] * t) - truth.data[i]);
    }
    if (t > .1 && t < .9) assert(error < blendError * .65, `Warp ${error}; dissolve ${blendError}`);
  }
  assert(largestStep < 1.05, 'The original jump is 1.2 pixels');
});

test('opposite motion, large gaps, flashes and changed subjects do not get bridges', async () => {
  for (const options of [{ opposite: true }, { skip: 8 }]) {
    const { a, b } = seam(options); assert.equal(await chooseBridge(a, b), null);
  }
  const { a, b } = seam();
  for (const f of b) { for (let i = 0; i < f.pixels.length; i++) f.pixels[i] = Math.min(255, f.pixels[i] + 40); for (let i = 0; i < f.image.data.length; i += 4) for (let c = 0; c < 3; c++) f.image.data[i + c] = f.pixels[i / 4]; }
  assert.equal(await chooseBridge(a, b), null);
  const changed = seam();
  // A tiny unique foreground event occupies less than 0.5% of the image.
  // The still background must not justify painting that event away.
  for (const f of changed.b) for (let y = 23; y < 27; y++) for (let x = 45; x < 49; x++) {
    f.pixels[y * 96 + x] = 250;
    for (let c = 0; c < 3; c++) f.image.data[(y * 96 + x) * 4 + c] = 250;
  }
  assert.equal(await chooseBridge(changed.a, changed.b), null);
});

test('verified overlaps, uncertain footage and full-clip versions bypass synthesis', () => {
  const clips = ['a', 'b'].map(id => ({ id, width: 160, height: 90 }));
  const timeline = renderTimeline(clips.map(clip => ({ id: clip.id, start: 0, end: 2 })));
  assert.equal(canSmoothJoin(clips, timeline, 0), false);
  assert.equal(canSmoothJoin(clips, timeline, 0, { joins: [] }), true);
  assert.equal(canSmoothJoin(clips, timeline, 0, { joins: [{ a: 'a', b: 'b', kind: 'overlap' }] }), false);
  assert.equal(canSmoothJoin(clips, timeline, 0, { reviewed: [{ a: 'b', b: 'other' }] }), false);
  assert.equal(canSmoothJoin(clips, timeline, 0, { reviewed: [{ a: 'other', b: 'a' }] }), false);
});

test('cancellation interrupts tracking and generated frames before publishing pixels', async () => {
  const controller = new AbortController(), { a, b } = seam();
  const bridge = await chooseBridge(a, b);
  assert(bridge);
  setTimeout(() => controller.abort(new DOMException('Stopped', 'AbortError')), 0);
  await assert.rejects(interpolateFrame(bridge, a[0].image, b[0].image, .5, controller.signal), { name: 'AbortError' });
  await assert.rejects(refineMotion([{ samples: [] }], controller.signal), { name: 'AbortError' });
  await assert.rejects(chooseBridge(a, b, controller.signal), { name: 'AbortError' });
});
