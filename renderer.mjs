import {
  Input, ALL_FORMATS, BlobSource, Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat,
  CanvasSource, VideoSampleSink, AudioBufferSink, AudioBufferSource, EncodedVideoPacketSource, Quality,
  canEncodeVideo, canEncodeAudio
} from './mediabunny.mjs?v=6';
import { check } from './vault.mjs?v=14';
import { MAX_EDIT_SECONDS } from './edit-policy.mjs?v=14';
import { validatePlan } from './planner.mjs?v=14';
import { FRAME_RATE, SAMPLE_RATE, renderTimeline } from './render-core.mjs?v=14';
import { audioChunks } from './render-core.mjs?v=14';
import { guarded } from './media.mjs?v=14';
import { canSmoothJoin, inspectJoin, prepareBridge } from './transitions.mjs?v=14';
import { interpolateFrame } from './transition-core.mjs?v=14';
import { inspectSources } from './export-inspect.mjs?v=14';
import { outputProfiles, videoBitrate, frameSlots, MAX_EXPORT_BYTES } from './quality.mjs?v=14';
import { createPainter } from './color-gpu.mjs?v=14';
import { applyColor } from './color.mjs?v=14';
import { finishingAt, drawFinishing } from './finish-core.mjs?v=14';
import { copyPlan, copyPictures } from './packet-copy.mjs?v=14';

import { reviewJoins } from './review-joins.mjs?v=14';
import { encodingStep, ExportResourceError, saferProfile } from './export-recovery.mjs?v=14';

export async function selectFormat(size) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') return null;
  const audio = { sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 192000 };
  for (const candidate of [
    { video: 'avc', audio: 'aac', mime: 'video/mp4', extension: 'mp4' },
    { video: 'vp9', audio: 'opus', mime: 'video/webm', extension: 'webm' },
    { video: 'vp8', audio: 'opus', mime: 'video/webm', extension: 'webm' }
  ]) {
    const bitrate = Math.round(Math.min(size.bitrateCap || Infinity, videoBitrate(size, size.frameRate || 30, candidate.video)));
    const video = { width: size.width, height: size.height, frameRate: size.frameRate || 30, bitrate, latencyMode: 'quality' };
    if (await canEncodeVideo(candidate.video, video) && await canEncodeAudio(candidate.audio, audio)) return { ...candidate, bitrate };
  }
  return null;
}

export async function verifyExport(blob, expectedDuration, expectedSound, signal, timeline = []) {
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
    const lastDuration = timeline.at(-1)?.slots?.at(-1)?.duration || 1 / FRAME_RATE;
    if (Math.abs(duration - expectedDuration) > .15 || videoEnd < expectedDuration - lastDuration - .01) throw new Error('The finished video has an incorrect duration. Please try again.');
    const frames = new VideoSampleSink(video);
    // Decode every join, as well as the endpoints. This also checks spliced GOPs.
    const times = [0, ...timeline.slice(1).flatMap(part => [Math.max(0, part.outputStart - .001), part.outputStart + .001]), Math.max(0, expectedDuration - .001)];
    for (const time of times) {
      const sample = await guarded(frames.getSample(time), signal);
      if (!sample) throw new Error('The finished video could not be decoded.');
      sample.close();
    }
    let peak = 0, buffers = 0;
    const decoded = new AudioBufferSink(audio).buffers();
    try {
      while (true) {
        const next = await guarded(decoded.next(), signal);
        if (next.done) break;
        check(signal); buffers++;
        for (let c = 0; c < next.value.buffer.numberOfChannels; c++) {
          const channel = next.value.buffer.getChannelData(c);
          for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
        }
      }
    } finally { await guarded(decoded.return(), signal); }
    if (!buffers || expectedSound && peak < .0001) throw new Error('Audio did not come through in the finished video. Please try again.');
    return { duration, audioPeak: peak };
  } finally { signal?.removeEventListener('abort', abort); input.dispose(); }
}

async function renderAttempt({ ordered, infos, timeline, total, size, format, joins, copy, getBlob, signal, onProgress }) {
  const canvas = document.createElement('canvas'), working = document.createElement('canvas');
  canvas.width = working.width = copy ? 1 : size.width; canvas.height = working.height = copy ? 1 : size.height;
  const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
  const painter = createPainter(working);
  const output = new Output({
    format: format.extension === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget()
  });
  const parentSignal = signal, job = new AbortController();
  const parentAbort = () => job.abort(parentSignal.reason);
  signal = job.signal;
  let bytes = 0;
  // Encoder output callbacks must not throw: route a size limit through the
  // same guarded cancellation path as Lock/Cancel, including delayed packets.
  const budget = count => { bytes += count; if (bytes > MAX_EXPORT_BYTES * .96) job.abort(new ExportResourceError(new Error('The export exceeded its memory budget.'))); };
  const videoSource = copy ? new EncodedVideoPacketSource(format.video) : new CanvasSource(canvas, {
    codec: format.video, quality: new Quality({ bitrate: format.bitrate, bitrateMode: 'variable' }), keyFrameInterval: 2, latencyMode: 'quality',
    // Give the encoder its true maximum cadence without the muxer's fixed-rate
    // timestamp snapping. Each output packet keeps its native presentation time.
    onEncoderConfig: config => { config.framerate = size.frameRate; }, onEncodedPacket: packet => budget(packet.byteLength)
  });
  const audioSource = new AudioBufferSource({ codec: format.audio, bitrate: 192000, onEncodedPacket: packet => budget(packet.byteLength) });
  output.addVideoTrack(videoSource, copy ? { rotation: copy.rotation } : {});
  output.addAudioTrack(audioSource);
  let currentInput = null, sourcePeak = 0, withAudio = 0, completed = false, incoming = null, outgoing = null;
  const smoothedJoins = [], finishedJoins = [], hdrClips = new Set();
  const abort = () => { currentInput?.dispose(); void output.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  parentSignal?.addEventListener('abort', parentAbort, { once: true });
  if (parentSignal?.aborted) parentAbort();
  try {
    check(signal); await encodingStep(() => output.start(), signal);
    for (let index = 0; index < timeline.length; index++) {
      check(signal);
      const part = timeline[index], clip = ordered[index], info = infos[index];
      outgoing = null;
      if (!copy && joins[index]?.kind === 'bridge') {
        onProgress({ stage: `Smoothing connection ${index + 1} of ${timeline.length - 1}…`, fraction: part.outputStart / total * .92 });
        outgoing = await prepareBridge({ clipA: clip, clipB: ordered[index + 1], size, getBlob, signal, candidate: joins[index] });
        check(signal);
        if (outgoing) smoothedJoins.push({ index, start: outgoing.start, end: outgoing.end, frames: outgoing.left + outgoing.right });
      }
      if (!copy && joins[index]?.kind === 'finishing') {
        const f = joins[index].finishing;
        finishedJoins.push({ index, aligned: f.align, colorMatched: f.color, zoom: f.zoom });
      }
      const progress = time => onProgress({ stage: `${copy ? 'Keeping original picture' : 'Making video'} ${index + 1} of ${timeline.length}…`, fraction: (part.outputStart + time) / total * .92 });
      progress(0);
      const blob = await getBlob(clip, signal); check(signal);
      currentInput = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      const video = await guarded(currentInput.getPrimaryVideoTrack(), signal);
      const audio = await guarded(currentInput.getPrimaryAudioTrack(), signal);
      if (copy) await copyPictures(video, videoSource, info, part, copy.ranges[index], signal, progress, budget);
      else {
        const stream = new VideoSampleSink(video).samplesAtTimestamps(part.slots.map(slot => slot.sourceTime + .000001));
        try {
          for (let frame = 0; frame < part.slots.length; frame++) {
            const slot = part.slots[frame], next = await guarded(stream.next(), signal); check(signal);
            if (next.done || !next.value) throw new Error(`A frame in “${clip.name}” could not be read.`);
            const sample = next.value;
            try { if (await painter.paint(sample, signal, info.color)) hdrClips.add(clip.id); } finally { sample.close(); }
            check(signal);
            const bridge = incoming && slot.time > incoming.start + .00001 && slot.time < incoming.end - .00001 ? incoming
              : outgoing && slot.time > outgoing.start + .00001 && slot.time < outgoing.end - .00001 ? outgoing : null;
            if (bridge) {
              const image = await interpolateFrame(bridge, bridge.a, bridge.b, (slot.time - bridge.start) / (bridge.end - bridge.start), signal); check(signal);
              context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
            } else {
              let effect = null;
              const ramp = Math.min(.35, part.duration / 3), tail = part.slots.at(-1).start;
              if (joins[index - 1]?.kind === 'finishing' && slot.start < ramp) effect = finishingAt(joins[index - 1].finishing.in, 1 - slot.start / ramp);
              else if (joins[index]?.kind === 'finishing' && slot.start > tail - ramp) effect = finishingAt(joins[index].finishing.out, 1 - (tail - slot.start) / ramp);
              if (effect) { drawFinishing(working, canvas, effect); await applyColor(canvas, effect.gains, signal); }
              else context.drawImage(working, 0, 0);
            }
            if (incoming && slot.time >= incoming.end - .00001) incoming = null;
            await encodingStep(() => videoSource.add(slot.time, slot.duration, { keyFrame: frame === 0 }), signal);
            if (!(frame % 12)) { progress(slot.start); await new Promise(resolve => setTimeout(resolve, 0)); }
          }
        } finally { await guarded(stream.return(), signal); }
      }
      if (audio) withAudio++;
      const buffers = audio ? new AudioBufferSink(audio).buffers(part.start - .25, part.end) : null;
      try {
        const read = buffers ? () => guarded(buffers.next(), signal) : null;
        for await (const chunk of audioChunks(read, part, { signal, fadeIn: index > 0, fadeOut: index < timeline.length - 1 })) {
          check(signal);
          sourcePeak = Math.max(sourcePeak, chunk.peak);
          const buffer = new AudioBuffer({ numberOfChannels: 2, length: chunk.channels[0].length, sampleRate: SAMPLE_RATE });
          for (let c = 0; c < 2; c++) buffer.copyToChannel(chunk.channels[c], c);
          await encodingStep(() => audioSource.add(buffer), signal);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } finally { if (buffers) await guarded(buffers.return(), signal); }
      currentInput.dispose(); currentInput = null;
      incoming = outgoing; outgoing = null;
    }
    check(signal); onProgress({ stage: 'Finishing your video…', fraction: .93 });
    await encodingStep(() => output.finalize(), signal); completed = true; check(signal);
    const blob = new Blob([output.target.buffer], { type: format.mime });
    if (blob.size > MAX_EXPORT_BYTES) throw new ExportResourceError(new Error('The export exceeded its memory budget.'));
    return { blob, extension: format.extension, width: size.width, height: size.height, duration: total, withAudio, timeline, smoothedJoins, finishedJoins, expectedSound: sourcePeak > .001,
      videoCodec: format.video, audioCodec: format.audio, copiedPicture: !!copy, reduced: !copy && size.reduced,
      hdrConverted: hdrClips.size, frameRate: Math.min(copy ? 60 : size.frameRate, Math.max(...infos.map(info => info.rate))),
      mixedCadence: infos.some(info => info.variable || Math.abs(info.rate - infos[0].rate) > .01) };
  } finally {
    signal.removeEventListener('abort', abort); parentSignal?.removeEventListener('abort', parentAbort); currentInput?.dispose(); incoming = outgoing = null;
    painter.dispose();
    if (!completed) await output.cancel().catch(() => {});
    canvas.width = canvas.height = working.width = working.height = 1;
  }
}

// Leave the encoder/muxer scope before decoding the finished movie, so its
// packet lists, writer buffers and canvases can be released before verification.
async function verifiedAttempt(options) {
  const { expectedSound, ...result } = await renderAttempt(options);
  check(options.signal);
  if (options.requiredBridges?.some(index => !result.smoothedJoins.some(join => join.index === index))) throw new Error('A selected connection could not be smoothed reliably. Your clips are still ready; try removing one of the similar takes.');
  if (options.requiredFinishing?.some(index => !result.finishedJoins.some(join => join.index === index))) throw new Error('A selected framing or color match could not be finished reliably. Your clips are still ready.');
  options.onProgress({ stage: 'Checking picture and audio…', fraction: .97 });
  const verified = await verifyExport(result.blob, options.total, expectedSound, options.signal, options.timeline);
  check(options.signal);
  return { ...result, duration: verified.duration };
}

export async function renderEdit({ clips, segments, plan, getBlob, signal, onProgress = () => {} }) {
  validatePlan(clips, segments, { allowSubset: !!plan?.continuity });
  const timeline = renderTimeline(segments), total = timeline.reduce((sum, part) => sum + part.duration, 0);
  if (total > MAX_EDIT_SECONDS + .02) throw new Error('Choose up to 30 minutes for one edit.');
  const byId = new Map(clips.map(clip => [clip.id, clip])), ordered = timeline.map(part => byId.get(part.id));
  const requiredBridges = plan?.continuity ? timeline.slice(1).flatMap((part, index) => plan.joins?.some(join => join.a === timeline[index].id && join.b === part.id && join.requiresBridge) ? [index] : []) : [];
  const requiredFinishing = plan?.continuity ? timeline.slice(1).flatMap((part, index) => plan.joins?.some(join => join.a === timeline[index].id && join.b === part.id && join.requiresFinishing) ? [index] : []) : [];
  const requiredEffects = new Set([...requiredBridges, ...requiredFinishing]);
  check(signal); onProgress({ stage: 'Preparing your video…', fraction: 0 });
  const cached = new Map((plan?.sourceInfos || []).map(info => [info.id, info]));
  const infos = ordered.every(clip => cached.has(clip.id)) ? ordered.map(clip => cached.get(clip.id)) : await inspectSources(ordered, getBlob, signal, onProgress);
  const profiles = outputProfiles(infos, total);
  let size, format;
  for (const profile of profiles) { format = await guarded(selectFormat(profile), signal); if (format) { size = profile; break; } }
  const prepare = async (profile, simple = false) => {
    timeline.forEach((part, index) => { part.slots = frameSlots(infos[index].packets, part, profile.frameRate); part.frames = part.slots.length; });
    const joins = [];
    for (let index = 0; index < timeline.length - 1; index++) {
      check(signal);
      if (simple && !requiredEffects.has(index) || !canSmoothJoin(clips, timeline, index, plan)) { joins.push(null); continue; }
      onProgress({ stage: `Checking connection ${index + 1} of ${timeline.length - 1}…`, fraction: 0 });
      joins.push(await inspectJoin({ clipA: ordered[index], clipB: ordered[index + 1], partA: timeline[index], partB: timeline[index + 1], size: profile, getBlob, signal, requireFinishing: requiredFinishing.includes(index) }));
    }
    if (requiredBridges.some(index => joins[index]?.kind !== 'bridge')) throw new Error('A selected connection could not be smoothed reliably. Your clips are still ready; try removing one of the similar takes.');
    if (requiredFinishing.some(index => joins[index]?.kind !== 'finishing')) throw new Error('A selected framing or color match could not be finished reliably. Your clips are still ready.');
    return joins;
  };
  // A copy-only browser can still use the original dimensions for join checks.
  let joins = await prepare(size || profiles[0] || { width: infos[0].width, height: infos[0].height, frameRate: 60 });
  const copy = await copyPlan(infos, timeline, joins, signal);
  const parameters = { ordered, infos, timeline, total, getBlob, signal, onProgress, requiredBridges, requiredFinishing };
  if (copy) {
    try {
      return await verifiedAttempt({ ...parameters, joins, copy, format: copy.format, size: { width: copy.width, height: copy.height } });
    } catch (error) { check(signal); if (!format) throw error; }
    onProgress({ stage: 'Preparing a compatible export…', fraction: 0 });
  }
  if (!format) throw new Error('Your browser cannot create this video with sound locally. Update Safari or Chrome and try again. On iPhone, local export requires iOS 26 or later.');
  let recovered = false, simplified = false, qualityChecks = [], simplifiedJoins = [];
  while (true) {
    check(signal);
    let result;
    try { result = await verifiedAttempt({ ...parameters, size, format, joins }); }
    catch (error) {
      check(signal);
      if (!(error instanceof ExportResourceError) || recovered) throw error;
      const safer = saferProfile({ ...size, bitrate: format.bitrate });
      const supported = safer && await guarded(selectFormat(safer), signal);
      check(signal);
      if (!supported) throw error;
      recovered = true; size = safer; format = supported;
      onProgress({ stage: 'Retrying with a lighter export…', fraction: 0 });
      await new Promise(resolve => setTimeout(resolve, 0)); check(signal);
      joins = await prepare(size, simplified);
      continue;
    }
    const checked = await reviewJoins({ result, ordered, getBlob, signal, onProgress });
    qualityChecks = qualityChecks.concat(checked);
    const rejected = checked.filter(join => !join.ok);
    if (rejected.some(join => requiredEffects.has(join.index))) throw new Error('A matched connection did not pass the finished-picture check. Your clips are still ready; try removing one of the similar takes.');
    if (rejected.length && !simplified) {
      // Retry once with original pictures at the same chosen cuts. Removing all
      // optional effects prevents a second enhancement/review loop, and never
      // changes footage selection, duration, order or sound.
      simplified = true; simplifiedJoins = joins.flatMap((join, index) => join && !requiredEffects.has(index) ? [{ index, reason: rejected.find(item => item.index === index)?.reason || 'simpler-export' }] : []);
      result.blob = null; result = null; joins = joins.map((join, index) => requiredEffects.has(index) ? join : null);
      onProgress({ stage: 'Using cleaner original-frame connections…', fraction: 0 });
      await new Promise(resolve => setTimeout(resolve, 0));
      continue;
    }
    check(signal);
    return { ...result, recovered, simplifiedJoins, qualityChecks };
  }
}
