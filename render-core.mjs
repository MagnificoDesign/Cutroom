export const FRAME_RATE = 30;
export const SAMPLE_RATE = 48000;
export { outputSize } from './quality.mjs?v=11';

export function renderTimeline(segments) {
  let sample = 0;
  return segments.map(segment => {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start) throw new Error('The edit has an invalid clip range.');
    // Keep the edit's timing at audio-sample precision. A short final video frame
    // is preferable to changing the speed and pitch of source speech/music.
    const samples = Math.max(1, Math.round((segment.end - segment.start) * SAMPLE_RATE));
    const duration = samples / SAMPLE_RATE;
    const frames = Math.max(1, Math.ceil(duration * FRAME_RATE - 1e-7));
    const item = { ...segment, frames, samples, outputStart: sample / SAMPLE_RATE, duration };
    sample += samples;
    return item;
  });
}

// Resample each decoded block into its absolute position in this clip's output.
// Timestamp mapping preserves leading silence, channel layout and encoder priming.
export function placeAudio(channels, block, sourceStart, { offset = 0 } = {}) {
  const length = channels[0].length, rate = SAMPLE_RATE;
  const start = Math.max(offset, Math.ceil((block.timestamp - sourceStart) * rate - 1e-6));
  const end = Math.min(offset + length, Math.ceil((block.timestamp + block.duration - sourceStart) * rate - 1e-6));
  for (let channel = 0; channel < channels.length; channel++) {
    const data = block.buffer.getChannelData(Math.min(channel, block.buffer.numberOfChannels - 1));
    for (let i = start; i < end; i++) {
      const source = (sourceStart + i / rate - block.timestamp) * block.buffer.sampleRate;
      const left = Math.max(0, Math.min(data.length - 1, Math.floor(source)));
      const right = Math.min(data.length - 1, left + 1), fraction = Math.max(0, Math.min(1, source - left));
      channels[channel][i - offset] = data[left] * (1 - fraction) + data[right] * fraction;
    }
  }
}

export function finishAudio(channels, { fadeIn = true, fadeOut = true, offset = 0, totalSamples = channels[0].length } = {}) {
  const fade = Math.min(Math.round(SAMPLE_RATE * .005), Math.floor(totalSamples / 2));
  let peak = 0;
  for (const data of channels) for (let i = 0; i < data.length; i++) {
    // Five-millisecond ramps prevent clicks; no speech/noise is overlapped.
    let gain = 1;
    const position = offset + i;
    if (fadeIn && position < fade) gain *= position / fade;
    if (fadeOut && position >= totalSamples - fade) gain *= (totalSamples - 1 - position) / fade;
    data[i] *= Math.max(0, gain);
    peak = Math.max(peak, Math.abs(data[i]));
  }
  return peak;
}

export const AUDIO_BLOCK_SAMPLES = SAMPLE_RATE; // One second, regardless of clip length.

// Hold at most one decoded source block and one output block. Absolute sample
// indices keep resampling phase and ramps identical across chunk boundaries.
export async function* audioChunks(read, part, { signal, fadeIn = true, fadeOut = true } = {}) {
  let pending, ended = !read;
  const check = () => { if (signal?.aborted) throw signal.reason; };
  for (let offset = 0; offset < part.samples; offset += AUDIO_BLOCK_SAMPLES) {
    check();
    const length = Math.min(AUDIO_BLOCK_SAMPLES, part.samples - offset);
    const channels = [new Float32Array(length), new Float32Array(length)];
    const end = part.start + (offset + length) / SAMPLE_RATE;
    while (!ended) {
      if (!pending) { const next = await read(); check(); if (next.done) { ended = true; break; } pending = next.value; }
      if (pending.timestamp >= end - 1e-9) break;
      placeAudio(channels, pending, part.start, { offset });
      if (pending.timestamp + pending.duration > end + 1e-9) break;
      pending = null;
    }
    const peak = finishAudio(channels, { offset, totalSamples: part.samples, fadeIn, fadeOut });
    yield { channels, peak, offset };
  }
}
