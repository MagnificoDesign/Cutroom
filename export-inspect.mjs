import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink, VideoSampleSink } from './mediabunny.mjs?v=6';
import { guarded } from './media.mjs?v=8';
import { check } from './vault.mjs?v=10';
import { resolveColor } from './color.mjs?v=11';
import { cadence, isHdr } from './quality.mjs?v=11';

export async function inspectSources(clips, getBlob, signal, onProgress) {
  const infos = [];
  for (let index = 0; index < clips.length; index++) {
    check(signal);
    onProgress?.({ stage: `Checking video quality ${index + 1} of ${clips.length}…`, fraction: 0 });
    const input = new Input({ source: new BlobSource(await getBlob(clips[index], signal)), formats: ALL_FORMATS });
    const abort = () => input.dispose();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      check(signal);
      const video = await guarded(input.getPrimaryVideoTrack(), signal);
      const audio = await guarded(input.getPrimaryAudioTrack(), signal);
      if (!video || !await guarded(video.canDecode(), signal)) throw new Error(`“${clips[index].name}” uses a video format this browser cannot edit. Try a Most Compatible copy from Photos.`);
      if (audio && !await guarded(audio.canDecode(), signal)) throw new Error(`Audio in “${clips[index].name}” cannot be read. Your edit was stopped to preserve its sound.`);
      const config = await guarded(video.getDecoderConfig(), signal);
      let color = resolveColor(config?.colorSpace, await guarded(video.getColorSpace(), signal));
      if (!color.transfer || !color.primaries || !color.matrix) {
        const frame = await guarded(new VideoSampleSink(video).getSample(await guarded(video.getFirstTimestamp(), signal)), signal);
        if (frame) { try { color = resolveColor(color, frame.colorSpace); } finally { frame.close(); } }
      }
      const packets = [], stream = new EncodedPacketSink(video).packets(undefined, undefined, { metadataOnly: true });
      try {
        while (true) {
          const next = await guarded(stream.next(), signal); check(signal);
          if (next.done) break;
          const p = next.value;
          packets.push({ timestamp: p.timestamp, duration: p.duration, type: p.type, sequenceNumber: p.sequenceNumber, byteLength: p.byteLength });
          if (packets.length > 100000) throw new Error('This source is too long for this phone edit. Choose a shorter copy.');
          if (!(packets.length % 120)) await new Promise(resolve => setTimeout(resolve, 0));
        }
      } finally { await stream.return(); }
      // Some WebM packets omit duration. Next presentation timestamp determines
      // every interior duration; the container end supplies the final one.
      const ordered = [...packets].sort((a, b) => a.timestamp - b.timestamp);
      const duration = await guarded(input.computeDuration(), signal);
      for (let i = 0; i < ordered.length; i++) {
        const nextDuration = Math.max(0, (ordered[i + 1]?.timestamp ?? duration) - ordered[i].timestamp);
        // Cluster boundaries may use a nominal duration rather than the rounded
        // next PTS. Keep the actual picture sequence contiguous within one tick.
        if (!ordered[i].duration || i + 1 < ordered.length && Math.abs(ordered[i].duration - nextDuration) <= .0011) ordered[i].duration = nextDuration;
      }
      infos.push({ id: clips[index].id, config, color, hdr: isHdr(color), packets, ...cadence(packets),
        codec: await guarded(video.getCodec(), signal), rotation: await guarded(video.getRotation(), signal),
        flip: await guarded(video.getFlip(), signal), width: await guarded(video.getDisplayWidth(), signal), height: await guarded(video.getDisplayHeight(), signal) });
    } finally { signal?.removeEventListener('abort', abort); input.dispose(); }
  }
  check(signal);
  return infos;
}
