import { Input, ALL_FORMATS, BlobSource, CanvasSink } from './mediabunny.mjs?v=6';
import { guarded, describePixels } from './media.mjs?v=8';
import { check } from './vault.mjs?v=6';
import { chooseBridge, validateBridgeImages } from './transition-core.mjs?v=9';
import { FRAME_RATE } from './render-core.mjs?v=6';

export function canSmoothJoin(clips, timeline, index, plan) {
  if (!plan || index + 1 >= timeline.length || timeline[index].duration < .6 || timeline[index + 1].duration < .6) return false;
  const a = timeline[index], b = timeline[index + 1];
  if (plan.joins?.some(join => join.a === a.id && join.b === b.id && join.kind === 'overlap')) return false;
  if (plan.reviewed?.some(join => [join.a, join.b].includes(a.id) || [join.a, join.b].includes(b.id))) return false;
  const aa = clips.find(clip => clip.id === a.id), bb = clips.find(clip => clip.id === b.id);
  return aa?.width > 0 && bb?.width > 0 && aa.height > 0 && bb.height > 0 && Math.abs(aa.width / aa.height / (bb.width / bb.height) - 1) < .01;
}

async function pictures(blob, requests, size, signal, small) {
  check(signal);
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const abort = () => input.dispose();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const video = await guarded(input.getPrimaryVideoTrack(), signal);
    if (!video || !await guarded(video.canDecode(), signal)) return [];
    const sink = new CanvasSink(video, { ...size, fit: small ? 'fill' : 'contain', poolSize: 1 });
    const stream = sink.canvasesAtTimestamps(requests.map(request => request.time)), result = [];
    try {
      for (const request of requests) {
        const next = await guarded(stream.next(), signal); check(signal);
        if (next.done || !next.value) return [];
        const image = next.value.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size.width, size.height);
        const frame = small ? describePixels(image.data, request.time, next.value.timestamp, next.value.duration) : {};
        result.push({ ...frame, image, outputTime: request.outputTime, sourceTime: request.time });
      }
    } finally { await guarded(stream.return(), signal); }
    return result;
  } finally { signal?.removeEventListener('abort', abort); input.dispose(); }
}

// At most two full-resolution endpoint images are retained for one bridge.
// Neighboring clips are opened sequentially and the analysis uses 96×54 images.
export async function prepareBridge({ clipA, clipB, partA, partB, size, getBlob, signal }) {
  check(signal);
  try {
    const readClip = async (clip, requests, dimensions, small) => {
      const blob = await getBlob(clip, signal); check(signal);
      return await pictures(blob, requests, dimensions, signal, small);
    };
    const requestsA = Array.from({ length: 6 }, (_, i) => {
      const frame = partA.frames - 6 + i;
      return { time: partA.start + frame / FRAME_RATE, outputTime: partA.outputStart + frame / FRAME_RATE };
    });
    const requestsB = Array.from({ length: 6 }, (_, i) => ({ time: partB.start + i / FRAME_RATE, outputTime: partB.outputStart + i / FRAME_RATE }));
    // Release each decrypted source Blob before reading the other clip. Keeping
    // two long source movies alive together can exhaust Safari's media budget.
    const a = await readClip(clipA, requestsA, { width: 96, height: 54 }, true);
    const b = await readClip(clipB, requestsB, { width: 96, height: 54 }, true);
    const bridge = await chooseBridge(a, b, signal); check(signal);
    if (!bridge) return null;
    const [aa] = await readClip(clipA, [requestsA[requestsA.length - bridge.left - 1]], size, false);
    const [bb] = await readClip(clipB, [requestsB[bridge.right]], size, false);
    check(signal);
    if (!aa || !bb) return null;
    if (!await validateBridgeImages(bridge, aa.image, bb.image, signal)) return null;
    return { ...bridge, a: aa.image, b: bb.image };
  } catch (error) {
    check(signal);
    // An optional picture enhancement must never break a valid original edit.
    return null;
  }
}
