import { EncodedPacketSink, canEncodeAudio } from './mediabunny.mjs?v=6';
import { check } from './vault.mjs?v=14';
import { guarded } from './media.mjs?v=14';
import { sameConfig, copyRange, MAX_EXPORT_BYTES } from './quality.mjs?v=14';

// A complete edit may copy compressed pictures when every boundary is safe and
// all decoder/color/orientation settings agree. Mixed compressed/re-encoded GOPs
// are deliberately excluded: matching a codec name does not match its bitstream.
export async function copyPlan(infos, timeline, joins, signal) {
  const first = infos[0];
  if (joins.some(Boolean) || infos.some(info => !info.config || info.hdr || info.flip || info.rate > 60
    || !sameConfig(info.config, first.config) || info.rotation !== first.rotation
    || JSON.stringify(info.color) !== JSON.stringify(first.color)
    || info.width !== first.width || info.height !== first.height)) return null;
  // A copied picture may retain its original resolution, up to 4K; larger
  // pictures use the bounded renderer. No crop, resize, or color change occurs.
  if (Math.max(first.width, first.height) > 3840) return null;
  const format = ['avc', 'hevc'].includes(first.codec)
    ? { video: first.codec, audio: 'aac', mime: 'video/mp4', extension: 'mp4' }
    : ['vp9', 'vp8'].includes(first.codec) ? { video: first.codec, audio: 'opus', mime: 'video/webm', extension: 'webm' } : null;
  if (!format || !await guarded(canEncodeAudio(format.audio, { sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }), signal)) return null;
  const ranges = infos.map((info, index) => copyRange(info, timeline[index]));
  const duration = timeline.reduce((sum, part) => sum + part.duration, 0);
  if (ranges.some(range => !range) || ranges.reduce((sum, r) => sum + r.bytes, 0) + duration * 24000 > MAX_EXPORT_BYTES * .9) return null;
  check(signal);
  return { format, ranges, rotation: first.rotation, width: first.width, height: first.height };
}

export async function copyPictures(track, source, info, part, range, signal, onProgress, budget) {
  const stream = new EncodedPacketSink(track).packets(undefined, undefined, { verifyKeyPackets: true });
  let copied = 0;
  const metadataBySequence = new Map(info.packets.map(item => [item.sequenceNumber, item]));
  try {
    while (true) {
      const next = await guarded(stream.next(), signal); check(signal);
      if (next.done) break;
      const p = next.value;
      if (p.sequenceNumber < range.first) continue;
      if (p.sequenceNumber > range.last) break;
      if (!copied && p.type !== 'key') throw new Error('The chosen cut needs a newly encoded picture.');
      const metadata = metadataBySequence.get(p.sequenceNumber);
      if (!metadata) throw new Error('The source picture timing changed.');
      budget(p.byteLength);
      await guarded(source.add(p.clone({ timestamp: p.timestamp - part.start + part.outputStart, duration: Math.abs(p.timestamp + metadata.duration - part.end) <= .0011 ? part.duration - (p.timestamp - part.start) : metadata.duration }),
        copied ? undefined : { decoderConfig: info.config }), signal);
      copied++;
      if (!(copied % 24)) { onProgress(Math.max(0, p.timestamp - part.start)); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
  } finally { await guarded(stream.return(), signal); }
  if (copied !== range.count) throw new Error('The chosen cut needs a newly encoded picture.');
}
