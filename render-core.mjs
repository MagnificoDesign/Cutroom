export const FRAME_RATE = 30;
export const SAMPLE_RATE = 48000;

export function outputSize(width, height) {
  if (!(width > 0 && height > 0)) throw new Error('This video has no readable picture size.');
  const scale = Math.min(1, 1280 / Math.max(width, height));
  return { width: Math.max(2, Math.round(width * scale / 2) * 2), height: Math.max(2, Math.round(height * scale / 2) * 2) };
}

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
export function placeAudio(channels, block, sourceStart) {
  const length = channels[0].length, rate = SAMPLE_RATE;
  const start = Math.max(0, Math.ceil((block.timestamp - sourceStart) * rate - 1e-6));
  const end = Math.min(length, Math.ceil((block.timestamp + block.duration - sourceStart) * rate - 1e-6));
  for (let channel = 0; channel < channels.length; channel++) {
    const data = block.buffer.getChannelData(Math.min(channel, block.buffer.numberOfChannels - 1));
    for (let i = start; i < end; i++) {
      const source = (sourceStart + i / rate - block.timestamp) * block.buffer.sampleRate;
      const left = Math.max(0, Math.min(data.length - 1, Math.floor(source)));
      const right = Math.min(data.length - 1, left + 1), fraction = Math.max(0, Math.min(1, source - left));
      channels[channel][i] = data[left] * (1 - fraction) + data[right] * fraction;
    }
  }
}

export function finishAudio(channels, { fadeIn = true, fadeOut = true } = {}) {
  const fade = Math.min(Math.round(SAMPLE_RATE * .005), Math.floor(channels[0].length / 2));
  let peak = 0;
  for (const data of channels) for (let i = 0; i < data.length; i++) {
    // Five-millisecond ramps prevent clicks; no speech/noise is overlapped.
    let gain = 1;
    if (fadeIn && i < fade) gain *= i / fade;
    if (fadeOut && i >= data.length - fade) gain *= (data.length - 1 - i) / fade;
    data[i] *= Math.max(0, gain);
    peak = Math.max(peak, Math.abs(data[i]));
  }
  return peak;
}
