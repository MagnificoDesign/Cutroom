import { descriptor } from './core.mjs?v=6';
import { check } from './vault.mjs?v=6';
import { Input, ALL_FORMATS, BlobSource, CanvasSink, AudioBufferSink } from './mediabunny.mjs?v=6';

export function guarded(promise, signal, message = 'This video took too long to process. Try a shorter clip.') {
  check(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(message)); }, 45000);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function describePixels(pixels, time, timestamp = time, duration = 0) {
  const frame = descriptor(pixels, 96, 54, time);
  frame.timestamp = timestamp; frame.duration = duration;
  frame.pixels = new Uint8Array(96 * 54);
  for (let i = 0; i < frame.pixels.length; i++) frame.pixels[i] = Math.round(pixels[i * 4] * .2126 + pixels[i * 4 + 1] * .7152 + pixels[i * 4 + 2] * .0722);
  frame.gray = new Float32Array(32 * 18);
  for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) {
    frame.gray[y * 32 + x] = frame.pixels[(y * 3 + 1) * 96 + x * 3 + 1] / 255;
  }
  return frame;
}

function waitFor(video, event, signal, start) {
  check(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, ready);
      video.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('This video could not be opened. Try saving it to Files and adding it again.')); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('This video took too long to open. Please try it again.')); }, 30000);
    video.addEventListener(event, ready, { once: true });
    video.addEventListener('error', failed, { once: true });
    signal?.addEventListener('abort', aborted, { once: true });
    try { start(); } catch (error) { cleanup(); reject(error); }
  });
}

async function withVideo(blob, signal, operation) {
  check(signal);
  const video = document.createElement('video');
  const url = URL.createObjectURL(blob);
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  try {
    await waitFor(video, 'loadeddata', signal, () => { video.src = url; video.load(); });
    check(signal);
    if (!(video.duration > 0) || !Number.isFinite(video.duration) || !video.videoWidth || !video.videoHeight) {
      throw new Error('This file does not contain a readable video.');
    }
    return await operation(video);
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export function probe(file, signal) {
  return withVideo(file, signal, async video => ({
    duration: video.duration, width: video.videoWidth, height: video.videoHeight
  }));
}

export function sample(blob, signal) {
  return withVideo(blob, signal, async video => {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 54;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const last = Math.max(0, video.duration - Math.min(.03, video.duration / 2));
    const step = Math.max(.25, video.duration / 99);
    const times = [];
    for (let time = 0; time < last; time += step) times.push(time);
    if (!times.length || last - times.at(-1) > .01) times.push(last);
    const out = [];
    for (let i = 0; i < times.length; i++) {
      check(signal);
      const time = times[i];
      // Seeking to the current position need not dispatch seeked on Safari.
      if (Math.abs(video.currentTime - time) > .00001) {
        await waitFor(video, 'seeked', signal, () => { video.currentTime = time; });
      }
      check(signal);
      context.drawImage(video, 0, 0, 96, 54);
      const pixels = context.getImageData(0, 0, 96, 54).data;
      out.push(describePixels(pixels, time));
    }
    return out;
  });
}

// Decode only requested windows. Keep small descriptors/PCM, never source URLs.
// Actual decoder timestamps prevent repeated requests for one frame from being
// mistaken for consecutive evidence of an overlap.
export async function inspectMedia(blob, times, signal, { audioRange } = {}) {
  check(signal);
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const abort = () => input.dispose();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const video = await guarded(input.getPrimaryVideoTrack(), signal);
    if (!video || !await guarded(video.canDecode(), signal)) throw new Error('This video format cannot be inspected on this browser.');
    const sink = new CanvasSink(video, { width: 96, height: 54, fit: 'fill', poolSize: 1 });
    const stream = sink.canvasesAtTimestamps(times);
    const frames = [];
    for (let i = 0; i < times.length; i++) {
      const next = await guarded(stream.next(), signal);
      check(signal);
      if (next.done || !next.value) throw new Error('A video frame could not be inspected.');
      const frame = next.value;
      frames.push(describePixels(frame.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 96, 54).data, times[i], frame.timestamp, frame.duration));
      if (i % 24 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    await guarded(stream.return(), signal);
    let audio;
    if (audioRange) {
      const [start, end] = audioRange, rate = 8000;
      audio = { start, rate, channels: [new Float32Array(Math.ceil((end - start) * rate)), new Float32Array(Math.ceil((end - start) * rate))], hasTrack: false };
      const track = await guarded(input.getPrimaryAudioTrack(), signal);
      if (track) {
        audio.hasTrack = true;
        if (!await guarded(track.canDecode(), signal)) throw new Error('The source sound could not be checked.');
        const buffers = new AudioBufferSink(track).buffers(start - .1, end);
        while (true) {
          const next = await guarded(buffers.next(), signal);
          check(signal);
          if (next.done) break;
          const { buffer, timestamp, duration } = next.value;
          const first = Math.max(0, Math.ceil((timestamp - start) * rate));
          const last = Math.min(audio.channels[0].length, Math.ceil((timestamp + duration - start) * rate));
          for (let c = 0; c < 2; c++) {
            const data = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
            for (let i = first; i < last; i++) {
              const sample = (start + i / rate - timestamp) * buffer.sampleRate;
              const left = Math.min(data.length - 1, Math.max(0, Math.floor(sample)));
              const right = Math.min(data.length - 1, left + 1), f = Math.max(0, Math.min(1, sample - left));
              audio.channels[c][i] = data[left] * (1 - f) + data[right] * f;
            }
          }
        }
      }
    }
    check(signal);
    return { frames, audio };
  } finally {
    signal?.removeEventListener('abort', abort);
    input.dispose();
  }
}
