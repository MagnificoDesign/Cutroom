import test from 'node:test';
import assert from 'node:assert/strict';
import { audioChunks, placeAudio, finishAudio, AUDIO_BLOCK_SAMPLES, SAMPLE_RATE } from './render-core.mjs';
import { encodingStep, ExportResourceError, saferProfile } from './export-recovery.mjs';

test('streamed PCM matches monolithic stereo resampling at every sample, including block splits and ramps', async () => {
  for (const rate of [44100, 48000]) for (const start of [0, .073713]) {
    const part = { start, samples: Math.round(2.413137 * SAMPLE_RATE) }, blocks = [];
    // Irregular decode blocks straddle output seconds and start after a silence.
    for (let offset = 0; offset < rate * 2.6; offset += 997) {
      const length = Math.min(997, Math.ceil(rate * 2.6) - offset);
      const channels = [0, 1].map(c => Float32Array.from({ length }, (_, i) => Math.sin((offset + i) / rate * Math.PI * 2 * (c ? 771 : 439)) * (c ? -.3 : .2)));
      blocks.push({ timestamp: .031 + offset / rate, duration: length / rate, buffer: { numberOfChannels: 2, sampleRate: rate, getChannelData: c => channels[c] } });
    }
    const expected = [new Float32Array(part.samples), new Float32Array(part.samples)];
    for (const block of blocks) placeAudio(expected, block, start);
    const peak = finishAudio(expected);
    let next = 0, actualPeak = 0, length = 0;
    for await (const chunk of audioChunks(async () => next < blocks.length ? { value: blocks[next++], done: false } : { done: true }, part)) {
      assert(chunk.channels[0].length <= AUDIO_BLOCK_SAMPLES);
      chunk.channels.forEach((channel, c) => assert.deepEqual(channel, expected[c].slice(chunk.offset, chunk.offset + channel.length)));
      actualPeak = Math.max(actualPeak, chunk.peak); length += chunk.channels[0].length;
    }
    assert.equal(length, part.samples); assert.equal(actualPeak, peak);
  }
});

test('a three-minute silent clip allocates only one-second output blocks and cancellation stops the next block', async () => {
  let chunks = 0, samples = 0, maximum = 0;
  for await (const { channels } of audioChunks(null, { start: 0, samples: 180 * SAMPLE_RATE })) {
    chunks++; samples += channels[0].length; maximum = Math.max(maximum, channels.reduce((n, c) => n + c.byteLength, 0));
  }
  assert.equal(chunks, 180); assert.equal(samples, 8640000); assert.equal(maximum, 384000);
  const controller = new AbortController(); let yielded = 0;
  await assert.rejects(async () => {
    for await (const chunk of audioChunks(null, { start: 0, samples: 180 * SAMPLE_RATE }, { signal: controller.signal })) { yielded++; controller.abort(); }
  }, { name: 'AbortError' });
  assert.equal(yielded, 1);
});

test('only resource/codec failures in an encoding operation qualify for bounded recovery', async () => {
  for (const name of ['OperationError', 'EncodingError', 'QuotaExceededError', 'NotSupportedError']) await assert.rejects(encodingStep(() => { throw new DOMException('injected encoder failure', name); }), ExportResourceError);
  const broken = new Error('Corrupt source data');
  await assert.rejects(encodingStep(() => { throw broken; }), error => error === broken);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(encodingStep(() => { throw new DOMException('aborted codec', 'OperationError'); }, controller.signal), { name: 'AbortError' });
  for (const profile of [{ width: 1920, height: 1080, frameRate: 60 }, { width: 1080, height: 1920, frameRate: 30 }, { width: 320, height: 180, frameRate: 24 }]) {
    const safer = saferProfile(profile);
    assert(safer.width * safer.height * safer.frameRate < profile.width * profile.height * profile.frameRate);
    assert(safer.frameRate <= profile.frameRate && safer.frameRate <= 30);
    assert(safer.width % 2 === 0 && safer.height % 2 === 0 && safer.reduced);
  }
});
