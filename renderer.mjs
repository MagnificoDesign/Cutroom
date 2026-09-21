import {
  Input, ALL_FORMATS, BlobSource, Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat,
  CanvasSink, CanvasSource, VideoSampleSink, AudioBufferSink, AudioBufferSource,
  canEncodeVideo, canEncodeAudio
} from './mediabunny.mjs?v=6';
import { check } from './vault.mjs?v=6';
import { validatePlan } from './planner.mjs?v=9';
import { FRAME_RATE, SAMPLE_RATE, outputSize, renderTimeline, placeAudio, finishAudio } from './render-core.mjs?v=6';
import { guarded } from './media.mjs?v=8';
import { canSmoothJoin, prepareBridge } from './transitions.mjs?v=9';
import { interpolateFrame } from './transition-core.mjs?v=9';

export async function selectFormat(size) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
    throw new Error('Your browser cannot create video with sound locally. On iPhone, use iOS 26 or later; otherwise update your browser.');
  }
  const video = { ...size, frameRate: FRAME_RATE, bitrate: 4_000_000 };
  const audio = { sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 128_000 };
  for (const candidate of [
    { video: 'avc', audio: 'aac', mime: 'video/mp4', extension: 'mp4' },
    { video: 'vp9', audio: 'opus', mime: 'video/webm', extension: 'webm' },
    { video: 'vp8', audio: 'opus', mime: 'video/webm', extension: 'webm' }
  ]) {
    if (await canEncodeVideo(candidate.video, video) && await canEncodeAudio(candidate.audio, audio)) return candidate;
  }
  throw new Error('This browser cannot create a video with audio locally. Open Cutroom in the latest Safari or Chrome and try again.');
}

export async function verifyExport(blob, expectedDuration, expectedSound, signal) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const abort = () => input.dispose();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    check(signal);
    const video = await guarded(input.getPrimaryVideoTrack(), signal);
    const audio = await guarded(input.getPrimaryAudioTrack(), signal);
    if (!video || !audio) throw new Error('The finished file is missing picture or audio. Please try again.');
    const videoEnd = await guarded(video.computeDuration(), signal);
    const duration = await guarded(input.computeDuration(), signal);
    // WebM may omit the final packet's duration. Its picture stays on screen
    // through the container/audio end, rather than ending at that frame's PTS.
    if (Math.abs(duration - expectedDuration) > .15 || videoEnd < expectedDuration - 1 / FRAME_RATE - .01) throw new Error('The finished video has an incorrect duration. Please try again.');
    const frames = new VideoSampleSink(video);
    for (const time of [0, Math.max(0, expectedDuration - .02)]) {
      const sample = await guarded(frames.getSample(time), signal);
      if (!sample) throw new Error('The finished video could not be decoded.');
      sample.close();
    }
    let peak = 0, buffers = 0;
    const decoded = new AudioBufferSink(audio).buffers();
    while (true) {
      const next = await guarded(decoded.next(), signal);
      if (next.done) break;
      check(signal);
      buffers++;
      for (let c = 0; c < next.value.buffer.numberOfChannels; c++) {
        const channel = next.value.buffer.getChannelData(c);
        for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
      }
    }
    if (!buffers || expectedSound && peak < .0001) throw new Error('Audio did not come through in the finished video. Please try again.');
    return { duration, audioPeak: peak };
  } finally {
    signal?.removeEventListener('abort', abort);
    input.dispose();
  }
}

export async function renderEdit({ clips, segments, plan, getBlob, signal, onProgress = () => {} }) {
  validatePlan(clips, segments);
  const timeline = renderTimeline(segments);
  const total = timeline.reduce((sum, part) => sum + part.duration, 0);
  if (total > 180) throw new Error('For this version, keep each finished edit under three minutes.');
  const byId = new Map(clips.map(clip => [clip.id, clip]));
  const first = byId.get(segments[0].id);
  const size = outputSize(first.width, first.height);
  check(signal);
  onProgress({ stage: 'Preparing your video…', fraction: 0 });
  const format = await guarded(selectFormat(size), signal);
  check(signal);
  const canvas = document.createElement('canvas');
  canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext('2d', { alpha: false });
  const output = new Output({
    format: format.extension === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget()
  });
  const videoSource = new CanvasSource(canvas, { codec: format.video, bitrate: 4_000_000, keyFrameInterval: 2 });
  const audioSource = new AudioBufferSource({ codec: format.audio, bitrate: 128_000 });
  // Cuts may end between nominal 30 fps ticks. Do not ask the muxer to round
  // their timestamps to a fixed cadence; that can duplicate timestamps.
  output.addVideoTrack(videoSource);
  output.addAudioTrack(audioSource);
  let currentInput = null, sourcePeak = 0, withAudio = 0, completed = false, incoming = null, outgoing = null;
  const smoothedJoins = [];
  const abort = () => { currentInput?.dispose(); void output.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await guarded(output.start(), signal);
    for (let index = 0; index < timeline.length; index++) {
      check(signal);
      const part = timeline[index], clip = byId.get(part.id);
      outgoing = null;
      if (canSmoothJoin(clips, timeline, index, plan)) {
        onProgress({ stage: `Smoothing connection ${index + 1} of ${timeline.length - 1}…`, fraction: part.outputStart / total * .92 });
        outgoing = await prepareBridge({ clipA: clip, clipB: byId.get(timeline[index + 1].id), partA: part, partB: timeline[index + 1], size, getBlob, signal });
        check(signal);
        if (outgoing) smoothedJoins.push({ index, start: outgoing.start, end: outgoing.end, frames: outgoing.left + outgoing.right });
      }
      onProgress({ stage: `Making video ${index + 1} of ${timeline.length}…`, fraction: part.outputStart / total * .92 });
      const blob = await getBlob(clip, signal);
      check(signal);
      currentInput = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      const video = await guarded(currentInput.getPrimaryVideoTrack(), signal);
      const audio = await guarded(currentInput.getPrimaryAudioTrack(), signal);
      if (!video || !await guarded(video.canDecode(), signal)) throw new Error(`“${clip.name}” uses a video format this browser cannot edit. Try a Most Compatible copy from your iPhone.`);
      if (audio && !await guarded(audio.canDecode(), signal)) throw new Error(`Audio in “${clip.name}” cannot be decoded on this browser. The edit was stopped to avoid losing its sound.`);
      const firstTimestamp = Math.max(0, await guarded(video.getFirstTimestamp(), signal));
      const endTimestamp = Math.max(clip.duration, await guarded(video.computeDuration(), signal));
      if (part.start >= endTimestamp) throw new Error('A clip ends before its chosen cut point.');
      const sink = new CanvasSink(video, { ...size, fit: 'contain', poolSize: 1 });
      const times = Array.from({ length: part.frames }, (_, frame) => Math.min(endTimestamp - .00001, Math.max(firstTimestamp, part.start + frame / FRAME_RATE)));
      const canvases = sink.canvasesAtTimestamps(times);
      for (let frame = 0; frame < part.frames; frame++) {
        const next = await guarded(canvases.next(), signal);
        check(signal);
        if (next.done || !next.value) throw new Error(`A frame in “${clip.name}” could not be read.`);
        context.fillStyle = '#000'; context.fillRect(0, 0, size.width, size.height);
        context.drawImage(next.value.canvas, 0, 0);
        const time = part.outputStart + frame / FRAME_RATE;
        const bridge = incoming && time > incoming.start + .00001 && time < incoming.end - .00001 ? incoming
          : outgoing && time > outgoing.start + .00001 && time < outgoing.end - .00001 ? outgoing : null;
        if (bridge) {
          const image = await interpolateFrame(bridge, bridge.a, bridge.b, (time - bridge.start) / (bridge.end - bridge.start), signal);
          check(signal);
          context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
        }
        if (incoming && time >= incoming.end - .00001) incoming = null;
        await guarded(videoSource.add(part.outputStart + frame / FRAME_RATE, Math.min(1 / FRAME_RATE, part.duration - frame / FRAME_RATE), { keyFrame: frame === 0 }), signal);
        if (frame % 12 === 0) {
          onProgress({ stage: `Making video ${index + 1} of ${timeline.length}…`, fraction: (part.outputStart + frame / FRAME_RATE) / total * .92 });
          // Yield so Lock and Cancel remain responsive even with fast encoders.
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      await guarded(canvases.return(), signal);
      const channels = [new Float32Array(part.samples), new Float32Array(part.samples)];
      if (audio) {
        withAudio++;
        const buffers = new AudioBufferSink(audio).buffers(part.start - .25, part.end);
        while (true) {
          const next = await guarded(buffers.next(), signal);
          if (next.done) break;
          check(signal);
          placeAudio(channels, next.value, part.start);
        }
      }
      sourcePeak = Math.max(sourcePeak, finishAudio(channels, { fadeIn: index > 0, fadeOut: index < timeline.length - 1 }));
      const buffer = new AudioBuffer({ numberOfChannels: 2, length: channels[0].length, sampleRate: SAMPLE_RATE });
      for (let c = 0; c < 2; c++) buffer.copyToChannel(channels[c], c);
      await guarded(audioSource.add(buffer), signal);
      currentInput.dispose(); currentInput = null;
      incoming = outgoing; outgoing = null;
    }
    check(signal);
    onProgress({ stage: 'Finishing your video…', fraction: .93 });
    await guarded(output.finalize(), signal);
    completed = true;
    check(signal);
    const blob = new Blob([output.target.buffer], { type: format.mime });
    onProgress({ stage: 'Checking picture and audio…', fraction: .97 });
    const verified = await verifyExport(blob, total, sourcePeak > .001, signal);
    check(signal);
    return { blob, extension: format.extension, ...size, duration: verified.duration, withAudio, timeline, smoothedJoins, videoCodec: format.video, audioCodec: format.audio };
  } finally {
    signal?.removeEventListener('abort', abort);
    currentInput?.dispose();
    incoming = outgoing = null;
    if (!completed) await output.cancel().catch(() => {});
    canvas.width = 1; canvas.height = 1;
  }
}
