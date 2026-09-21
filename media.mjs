import { descriptor } from './core.mjs';
import { check } from './vault.mjs';

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
    const count = Math.max(8, Math.min(100, Math.ceil(video.duration * 4)));
    const last = Math.max(0, video.duration - Math.min(.03, video.duration / 2));
    const out = [];
    for (let i = 0; i < count; i++) {
      check(signal);
      const time = i * last / (count - 1);
      // Seeking to the current position need not dispatch seeked on Safari.
      if (Math.abs(video.currentTime - time) > .00001) {
        await waitFor(video, 'seeked', signal, () => { video.currentTime = time; });
      }
      check(signal);
      context.drawImage(video, 0, 0, 96, 54);
      out.push(descriptor(context.getImageData(0, 0, 96, 54).data, 96, 54, time));
    }
    return out;
  });
}
