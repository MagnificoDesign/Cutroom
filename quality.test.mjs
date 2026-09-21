import test from 'node:test';
import assert from 'node:assert/strict';
import { outputProfiles, frameSlots, cadence, copyRange, sameConfig, isHdr } from './quality.mjs';
import { inverseTransfer, toneMapRgb, planeFormat, sampleCoordinates, srgbToLinear, linearToSrgb } from './color.mjs';
import { fitTransform, transformPoint, inverseTransform, chooseFinishing, validateFinishing, finishingAt } from './finish-core.mjs';

const packets = (rate, count = rate) => Array.from({ length: count }, (_, i) => ({ timestamp: i / rate, duration: 1 / rate, type: i % rate ? 'delta' : 'key', sequenceNumber: i, byteLength: 100 }));
test('quality profiles use 1080p, preserve aspect/no upscale, and bound long exports', () => {
  const hd = { width: 3840, height: 2160, rate: 60 };
  const short = outputProfiles([hd], 12);
  assert.deepEqual([short[0].width, short[0].height, short[0].frameRate], [1920, 1080, 60]);
  assert(short[0].bitrate > short[1].bitrate);
  assert(outputProfiles([hd], 180).every(p => (p.bitrate + 192000) * 180 / 8 < 192 * 1048576));
  assert.equal(outputProfiles([{ width: 320, height: 180, rate: 24 }], 12)[0].width, 320);
  assert.equal(outputProfiles([{ ...hd, width: 1080, height: 1920 }], 12)[0].height, 1920);
});
test('source timing includes cuts between pictures, VFR and the entire last picture', () => {
  for (const rate of [24, 30, 60, 24000 / 1001, 60000 / 1001]) {
    const source = packets(rate, 60), end = 60 / rate;
    const slots = frameSlots(source, { start: 0, end, outputStart: 2, duration: end }, 60);
    assert.equal(slots.length, 60); assert.equal(slots[0].time, 2);
    assert(Math.abs(slots.reduce((s, p) => s + p.duration, 0) - end) < 1e-10);
    assert(Math.abs(cadence(source).rate - rate) < .0001);
  }
  const vfr = [0, .033, .05, .1, .15].map(timestamp => ({ timestamp, duration: .05 }));
  const slots = frameSlots(vfr, { start: .04, end: .18, duration: .14, outputStart: 0 }, 60);
  assert.deepEqual(slots.map(p => p.sourceTime), [.033, .05, .1, .15]); // A partial first slot must not discard the next native picture.
  assert.equal(slots.at(-1).time + slots.at(-1).duration, .14);
  assert(cadence(vfr).variable);
  const capped = frameSlots(packets(120), { start: 0, end: 1, duration: 1, outputStart: 0 }, 60);
  assert.equal(capped.length, 60);
});
test('compressed copying requires matching decoder settings and closed exact ranges', () => {
  const a = { codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080, description: Uint8Array.of(1, 2, 3) };
  assert(sameConfig(a, { ...a, description: new Uint8Array(a.description).buffer }));
  assert(!sameConfig(a, { ...a, description: Uint8Array.of(1, 2, 4) }));
  assert(!sameConfig(a, { ...a, colorSpace: { transfer: 'pq' } }));
  const info = { packets: packets(30, 90) };
  assert(copyRange(info, { start: 0, end: 3 }));
  assert(copyRange(info, { start: 1, end: 2 }));
  assert.equal(copyRange(info, { start: .1, end: 2 }), null);
  assert.equal(copyRange(info, { start: 0, end: 1.5 }), null);
  [info.packets[1], info.packets[2]] = [info.packets[2], info.packets[1]];
  assert(copyRange(info, { start: 0, end: 3 }), 'complete B-frame sequence is retained');
  assert.equal(copyRange(info, { start: 1, end: 2 }), null, 'partial reordered GOP is rejected');
});
test('HDR detection is explicit and PQ/HLG mapping preserves shadow and highlight distinctions', () => {
  assert(!isHdr({ primaries: 'smpte432', transfer: 'iec61966-2-1' }));
  assert(isHdr({ transfer: 'pq' })); assert(isHdr({ transfer: 'hlg' }));
  assert(Math.abs(inverseTransfer(.50807842, 'pq') - 100) < .0001);
  assert(Math.abs(inverseTransfer(.5, 'hlg') - 1 / 12) < 1e-9);
  assert(Math.abs(inverseTransfer(1, 'hlg') - 1) < 1e-7);
  for (const transfer of ['pq', 'hlg']) {
    const values = [0, .1, .3, .5, .7, .9, 1].map(v => toneMapRgb([v, v, v], transfer)[0]);
    assert(values.every((v, i) => v >= 0 && v <= 1 && (!i || v > values[i - 1])));
    assert(toneMapRgb([.9, .3, .1], transfer).every(v => v >= 0 && v <= 1));
  }
  assert.equal(planeFormat('I420P10').bytes, 2); assert.throws(() => planeFormat('RGBA'));
});
test('HDR coordinate mapping respects rotated, flipped and letterboxed source pictures', () => {
  const sample = { displayWidth: 2, displayHeight: 4, codedWidth: 4, codedHeight: 2, rotation: 90, visibleRect: { left: 0, top: 0, width: 4, height: 2 } };
  assert.deepEqual(sampleCoordinates(sample, 2, 4, 0, 0), [0, 1]);
  assert.deepEqual(sampleCoordinates({ ...sample, flip: true }, 2, 4, 0, 0), [0, 0]);
  assert.equal(sampleCoordinates(sample, 8, 4, 0, 0), null);
});
const texture = (x, y) => (128 + 32 * Math.sin(x * .27) + 29 * Math.sin(y * .36) + 20 * Math.sin(x * .81 + y * .57) + 15 * Math.cos(x * .39 - y * .85)) / 255;
function picture(dx = 0, gain = 1, change = false) {
  const data = new Uint8ClampedArray(96 * 54 * 4), pixels = new Uint8Array(96 * 54);
  for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) {
    const value = change && x > 44 && x < 49 && y > 22 && y < 27 ? .99 : linearToSrgb(srgbToLinear(texture(x - dx, y)) * gain);
    pixels[y * 96 + x] = value * 255;
    for (let c = 0; c < 3; c++) data[(y * 96 + x) * 4 + c] = value * 255;
    data[(y * 96 + x) * 4 + 3] = 255;
  }
  return { pixels, image: { data, width: 96, height: 54 } };
}
test('join finishing fits tiny transformations and improves a stable real-picture match', () => {
  const truth = { scale: 1.006, angle: .003, tx: .002, ty: -.001 };
  const tracks = [];
  for (let y = 5; y < 50; y += 5) for (let x = 5; x < 91; x += 5) {
    const [u, v] = transformPoint(truth, x / 96 - .5, (y / 54 - .5) / (16 / 9));
    tracks.push({ x, y, dx: (u + .5) * 96 - x, dy: (v * 16 / 9 + .5) * 54 - y });
  }
  const fitted = fitTransform(tracks); assert(fitted);
  for (const key of Object.keys(truth)) assert(Math.abs(fitted[key] - truth[key]) < 1e-10);
  const p = transformPoint(inverseTransform(truth), ...transformPoint(truth, .1, .2));
  assert(Math.abs(p[0] - .1) < 1e-9 && Math.abs(p[1] - .2) < 1e-9);
  const a = Array.from({ length: 6 }, () => picture()), b = Array.from({ length: 6 }, () => picture(.55, 1.1));
  const result = chooseFinishing(a, b); assert(result, 'small framing/exposure jump should be corrected');
  assert(result.align && result.color); assert(result.zoom < 1.035);
  assert(validateFinishing(result, a[0].image, b[0].image));
  assert.equal(finishingAt(result.out, 0).scale, 1);
});
test('join finishing rejects flashes, deliberate movement, tiny changed actions and blank footage', () => {
  const a = Array.from({ length: 6 }, () => picture());
  const moving = Array.from({ length: 6 }, (_, i) => picture(.5 + i * .3, 1.1));
  assert.equal(chooseFinishing(a, moving), null);
  const flash = Array.from({ length: 6 }, (_, i) => picture(.5, i === 2 ? 1.5 : 1.1));
  assert.equal(chooseFinishing(a, flash), null);
  assert.equal(chooseFinishing(a, Array.from({ length: 6 }, () => picture(.55, 1.1, true))), null);
  const blank = { pixels: new Uint8Array(5184), image: { data: new Uint8ClampedArray(5184 * 4), width: 96, height: 54 } };
  assert.equal(chooseFinishing([blank, blank, blank], [blank, blank, blank]), null);
});
