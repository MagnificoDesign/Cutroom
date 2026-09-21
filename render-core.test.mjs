import test from 'node:test';
import assert from 'node:assert/strict';
import { outputSize, renderTimeline, placeAudio, finishAudio, SAMPLE_RATE } from './render-core.mjs';

test('output keeps orientation and aspect with even bounded dimensions', () => {
  assert.deepEqual(outputSize(3840, 2160), { width: 1280, height: 720 });
  assert.deepEqual(outputSize(1080, 1920), { width: 720, height: 1280 });
  assert.deepEqual(outputSize(640, 360), { width: 640, height: 360 });
});

test('render timeline has no gaps and includes the final frame duration', () => {
  const parts = renderTimeline([{ id: 'a', start: .25, end: 2.26 }, { id: 'b', start: 1.01, end: 3.25 }]);
  assert.equal(parts[1].outputStart, parts[0].duration);
  assert.equal(parts[0].frames, 61);
  assert.equal(parts[1].frames, 68);
  assert.equal(parts[1].outputStart + parts[1].duration, 4.25);
  assert.equal(parts[0].samples + parts[1].samples, 4.25 * SAMPLE_RATE);
});

test('audio placement crops negative priming timestamps without shifting sound', () => {
  const output = [new Float32Array(SAMPLE_RATE / 10), new Float32Array(SAMPLE_RATE / 10)];
  const data = Float32Array.from({ length: SAMPLE_RATE / 5 }, (_, i) => i / SAMPLE_RATE);
  placeAudio(output, { timestamp: -.1, duration: .2, buffer: { numberOfChannels: 1, sampleRate: SAMPLE_RATE, getChannelData: () => data } }, 0, .1, .1);
  assert(Math.abs(output[0][0] - .1) < .00001);
  assert(Math.abs(output[0].at(-1) - .199979) < .00001);
  assert.deepEqual(output[0], output[1]);
});

test('audio placement preserves a delayed source start as silence', () => {
  const output = [new Float32Array(SAMPLE_RATE / 5), new Float32Array(SAMPLE_RATE / 5)];
  const data = new Float32Array(SAMPLE_RATE / 10).fill(.5);
  placeAudio(output, { timestamp: .1, duration: .1, buffer: { numberOfChannels: 1, sampleRate: SAMPLE_RATE, getChannelData: () => data } }, 0, .2, .2);
  assert(output[0].slice(0, SAMPLE_RATE / 10).every(v => v === 0));
  assert.equal(output[0][SAMPLE_RATE / 10], .5);
});

test('stereo channel identity survives resampling and boundary ramps are short', () => {
  const output = [new Float32Array(SAMPLE_RATE / 10), new Float32Array(SAMPLE_RATE / 10)];
  const channels = [new Float32Array(4410).fill(.5), new Float32Array(4410).fill(-.3)];
  placeAudio(output, { timestamp: 0, duration: .1, buffer: { numberOfChannels: 2, sampleRate: 44100, getChannelData: c => channels[c] } }, 0, .1, .1);
  finishAudio(output);
  assert.equal(output[0][0], 0);
  assert.equal(output[0].at(-1), 0);
  assert.equal(output[0][500], .5);
  assert(Math.abs(output[1][500] + .3) < .00001);
});
