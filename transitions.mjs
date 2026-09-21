import { Input, ALL_FORMATS, BlobSource, VideoSampleSink } from './mediabunny.mjs?v=6';
import { guarded, describePixels } from './media.mjs?v=14';
import { check } from './vault.mjs?v=14';
import { chooseBridge, validateBridgeImages } from './transition-core.mjs?v=14';
import { FRAME_RATE } from './render-core.mjs?v=14';
import { createPainter } from './color-gpu.mjs?v=14';
import { chooseFinishing, validateFinishing } from './finish-core.mjs?v=14';

export function canSmoothJoin(clips, timeline, index, plan) {
  if (!plan || index + 1 >= timeline.length || timeline[index].duration < .6 || timeline[index + 1].duration < .6) return false;
  const a = timeline[index], b = timeline[index + 1];
  if (plan.joins?.some(join => join.a === a.id && join.b === b.id && join.kind === 'overlap')) return false;
  if (plan.reviewed?.some(join => [join.a, join.b].includes(a.id) || [join.a, join.b].includes(b.id))) return false;
  const aa = clips.find(clip => clip.id === a.id), bb = clips.find(clip => clip.id === b.id);
  return aa?.width > 0 && bb?.width > 0 && aa.height > 0 && bb.height > 0 && Math.abs(aa.width / aa.height / (bb.width / bb.height) - 1) < .01;
}

export async function pictures(blob, requests, size, signal, small) {
  check(signal);
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const abort = () => input.dispose();
  const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
  const painter = createPainter(canvas, { fit: small ? 'fill' : 'contain' });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const video = await guarded(input.getPrimaryVideoTrack(), signal);
    if (!video || !await guarded(video.canDecode(), signal)) return [];
    const sink = new VideoSampleSink(video), color = await guarded(video.getColorSpace(), signal);
    const stream = sink.samplesAtTimestamps(requests.map(request => request.time + .000001)), result = [];
    try {
      for (const request of requests) {
        const next = await guarded(stream.next(), signal); check(signal);
        if (next.done || !next.value) return [];
        const sample = next.value;
        try {
          await painter.paint(sample, signal, color); check(signal);
          const image = canvas.getContext('2d').getImageData(0, 0, size.width, size.height);
          const frame = small ? describePixels(image.data, request.time, sample.timestamp, sample.duration) : {};
          result.push({ ...frame, timestamp: sample.timestamp, duration: sample.duration, image, outputTime: request.outputTime, sourceTime: request.time });
        } finally { sample.close(); }
      }
    } finally { await guarded(stream.return(), signal); }
    return result;
  } finally { signal?.removeEventListener('abort', abort); input.dispose(); painter.dispose(); canvas.width = canvas.height = 1; }
}

// At most two full-resolution endpoint images are retained for one bridge.
// Neighboring clips are opened sequentially and the analysis uses 96×54 images.
export async function inspectJoin({ clipA, clipB, partA, partB, size, getBlob, signal, requireFinishing = false }) {
  check(signal);
  try {
    const readClip = async (clip, requests, dimensions, small) => {
      const blob = await getBlob(clip, signal); check(signal);
      return await pictures(blob, requests, dimensions, signal, small);
    };
    const requestsA = partA.slots ? partA.slots.slice(-6).map(p => ({ time: p.sourceTime, outputTime: p.time })) : Array.from({ length: 6 }, (_, i) => {
      const frame = partA.frames - 6 + i;
      return { time: partA.start + frame / FRAME_RATE, outputTime: partA.outputStart + frame / FRAME_RATE };
    });
    const requestsB = partB.slots ? partB.slots.slice(0, 6).map(p => ({ time: p.sourceTime, outputTime: p.time })) : Array.from({ length: 6 }, (_, i) => ({ time: partB.start + i / FRAME_RATE, outputTime: partB.outputStart + i / FRAME_RATE }));
    if (requestsA.length < 6 || requestsB.length < 6) return null;
    // Release each decrypted source Blob before reading the other clip. Keeping
    // two long source movies alive together can exhaust Safari's media budget.
    const a = await readClip(clipA, requestsA, { width: 96, height: 54 }, true);
    const b = await readClip(clipB, requestsB, { width: 96, height: 54 }, true);
    const bridge = requireFinishing ? null : await chooseBridge(a, b, signal); check(signal);
    if (bridge) return { kind: 'bridge', bridge, requestsA, requestsB };
    const finishing = chooseFinishing(a, b, clipA.width / clipA.height);
    if (!finishing) return null;
    // Validate at output resolution before a small analysis match may affect
    // detail. These endpoint pictures are released immediately after validation.
    const [aa] = await readClip(clipA, [requestsA.at(-1)], size, false);
    const [bb] = await readClip(clipB, [requestsB[0]], size, false);
    check(signal);
    if (!aa || !bb || !validateFinishing(finishing, aa.image, bb.image)) return null;
    check(signal);
    return { kind: 'finishing', finishing };
  } catch (error) {
    check(signal);
    // An optional picture enhancement must never break a valid original edit.
    return null;
  }
}

export async function prepareBridge({ clipA, clipB, size, getBlob, signal, candidate }) {
  if (candidate?.kind !== 'bridge') return null;
  try {
    const { bridge, requestsA, requestsB } = candidate;
    const readClip = async (clip, request) => pictures(await getBlob(clip, signal), [request], size, signal, false);
    const [a] = await readClip(clipA, requestsA[requestsA.length - bridge.left - 1]); check(signal);
    const [b] = await readClip(clipB, requestsB[bridge.right]); check(signal);
    if (!a || !b || !await validateBridgeImages(bridge, a.image, b.image, signal)) return null;
    return { ...bridge, a: a.image, b: b.image };
  } catch { check(signal); return null; }
}
