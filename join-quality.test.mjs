import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeJoin } from './join-quality.mjs';

function picture(position, { flash = 0, ghost = 0, warp = 0 } = {}) {
  const width = 96, height = 54, data = new Uint8ClampedArray(width * height * 4);
  const texture = (x, y) => 128 + 32 * Math.sin(x * .27) + 29 * Math.sin(y * .36) + 20 * Math.sin(x * .81 + y * .57) + 15 * Math.cos(x * .39 - y * .85);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x - position + warp * Math.sin(y / 3);
    const value = (texture(px - ghost, y) + texture(px + ghost, y)) / 2 + flash;
    for (let c = 0; c < 3; c++) data[(y * width + x) * 4 + c] = value;
    data[(y * width + x) * 4 + 3] = 255;
  }
  return { width, height, data };
}
const original = () => Array.from({ length: 12 }, (_, i) => ({ image: picture(i * .6 + (i >= 6 ? .6 : 0)), outputTime: i / 30 }));
const smooth = () => Array.from({ length: 12 }, (_, i) => ({ image: picture(i >= 4 && i <= 8 ? 2.4 + (i - 4) * .75 : i * .6 + (i >= 6 ? .6 : 0)), outputTime: i / 30 }));

test('temporal review accepts a real movement improvement and rejects unhelpful changes', async () => {
  const result = await judgeJoin(original(), smooth(), .2);
  assert(result.ok, JSON.stringify(result));
  assert(result.metrics.after.motion < result.metrics.before.motion);
  assert(result.metrics.after.jerk < result.metrics.before.jerk);
  assert.equal((await judgeJoin(original(), original(), .2)).reason, 'no-measured-improvement');
});

test('rendered flashes, ghosted detail and rubbery movement fail even when the seam itself improves', async () => {
  for (const defect of [{ flash: 24 }, { ghost: 3 }, { warp: 2 }]) {
    const changed = smooth(); changed[7].image = picture(4.65, defect);
    const result = await judgeJoin(original(), changed, .2);
    assert.equal(result.ok, false, JSON.stringify({ defect, result }));
  }
});

test('review never uses missing, flat or mis-timed output as proof of a good enhancement', async () => {
  assert.equal((await judgeJoin(original(), [], .2)).ok, false);
  const mistimed = smooth(); mistimed[3].outputTime += .001;
  assert.equal((await judgeJoin(original(), mistimed, .2)).ok, false);
  const flat = original().map(frame => ({ ...frame, image: { width: 96, height: 54, data: new Uint8ClampedArray(96 * 54 * 4).fill(128) } }));
  assert.equal((await judgeJoin(flat, flat, .2)).ok, false);
});

test('cancelling during decoded-sequence review stops its remaining motion checks', async () => {
  const controller = new AbortController();
  const job = judgeJoin(original(), smooth(), .2, controller.signal);
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(job, { name: 'AbortError' });
});
