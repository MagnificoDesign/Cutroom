import { inspectMedia } from './media.mjs?v=15';
import { check } from './vault.mjs?v=15';
import { planEditAsync } from './planner.mjs?v=15';
import { refineMotion } from './motion.mjs?v=15';
import { soundWindow, soundRanges, pauseCandidates } from './audio-cuts.mjs?v=15';
import { coarseCandidates, refineAlignment, overlapSeams, verifySound, MIN_OVERLAP, MAX_OVERLAP } from './overlap.mjs?v=15';

import { inspectSources } from './export-inspect.mjs?v=15';
import { sourceTimes, nearbyFrames, coarseFrames } from './cut-timing.mjs?v=15';

export async function analyzeJoins({ clips, getBlob, signal, onProgress = () => {}, inspect = inspectMedia, readSources = inspectSources }) {
  const sourceInfos = await readSources(clips, getBlob, signal, onProgress);
  const infoById = new Map(sourceInfos.map(info => [info.id, info]));
  clips = clips.map(clip => ({ ...clip, frameTimes: sourceTimes(infoById.get(clip.id).packets, clip.duration) }));
  // Request the actual picture, with a microsecond tolerance for decoder time
  // rounding. Candidate cut times remain the original presentation timestamps.
  const pictures = async (blob, times, options) => {
    const result = await inspect(blob, times.map(t => t + .000001), signal, options);
    check(signal);
    if (result.frames.length !== times.length || result.frames.some((f, i) => !Number.isFinite(f.timestamp) || Math.abs(f.timestamp - times[i]) > .0011)) throw new Error('This video could not supply its expected frames.');
    return { ...result, frames: result.frames.map((frame, i) => ({ ...frame, t: times[i] })) };
  };
  for (let index = 0; index < clips.length; index++) {
    check(signal);
    const clip = clips[index];
    if (!clip.frameTimes.length) throw new Error('This video has no readable frame timing.');
    onProgress({ stage: `Analyzing video ${index + 1} of ${clips.length}…`, fraction: index / clips.length * .15 });
    clip.samples = (await pictures(await getBlob(clip, signal), coarseFrames(clip))).frames;
  }
  const byId = new Map(clips.map(clip => [clip.id, clip]));
  const groups = [], reviewed = [], verified = [];
  for (const a of clips) {
    check(signal);
    for (const b of clips) {
      if (a.id === b.id) continue;
      const candidates = coarseCandidates(a, b);
      const useful = candidates.filter(item => item.kind === 'continuation' && a.duration - item.offset >= MIN_OVERLAP && a.duration - item.offset <= MAX_OVERLAP);
      const contained = candidates.filter(item => item.kind === 'contained' && item.error < .08);
      if (contained.length) reviewed.push({ a: a.id, b: b.id, reason: 'possibly-contained' });
      if (useful.length) groups.push({ a, b, candidates: useful, contained, priority: Math.max(...useful.map(item => item.priority)) });
      else if (candidates.some(item => item.error < .055)) reviewed.push({ a: a.id, b: b.id, reason: 'ambiguous-or-contained' });
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  // Dense decoding is bounded on a phone. Unchecked candidates are kept intact.
  groups.sort((a, b) => b.priority - a.priority);
  const selected = groups.slice(0, Math.min(24, Math.max(3, (clips.length - 1) * 3)));
  for (const group of groups.slice(selected.length)) reviewed.push({ a: group.a.id, b: group.b.id, reason: 'not-checked' });
  for (let index = 0; index < selected.length; index++) {
    check(signal);
    onProgress({ stage: `Checking matching footage ${index + 1} of ${selected.length}…`, fraction: .15 + index / Math.max(1, selected.length) * .35 });
    const { a, b, candidates, contained } = selected[index];
    const lo = Math.max(0, Math.min(...[...candidates, ...contained].map(item => item.offset - item.step * 1.3 - .1)));
    const hi = Math.min(b.duration, a.duration - lo + .1);
    if (a.duration - lo > MAX_OVERLAP + 1) {
      reviewed.push({ a: a.id, b: b.id, reason: 'not-checked' });
      continue;
    }
    let aa, bb;
    try {
      aa = await pictures(await getBlob(a, signal), nearbyFrames(a, lo, a.duration), { audioRange: [lo, a.duration] });
      check(signal);
      bb = await pictures(await getBlob(b, signal), nearbyFrames(b, 0, hi), { audioRange: [0, hi] });
      check(signal);
      const results = [], alternate = [];
      for (const candidate of candidates) {
        check(signal);
        results.push(refineAlignment(aa.frames, bb.frames, candidate, a.duration, b.duration));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const good = results.filter(result => result.status === 'verified').sort((a, b) => a.error - b.error);
      for (const candidate of contained) {
        check(signal);
        alternate.push(refineAlignment(aa.frames, bb.frames, candidate, a.duration, b.duration, { checkContainment: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (alternate.some(result => result.status === 'verified' && result.contained) || good.some(result => Math.abs(result.offset - good[0].offset) > .12)) {
        reviewed.push({ a: a.id, b: b.id, reason: 'repeating-pattern' });
      } else if (good.length) {
        const match = good[0];
        const sound = verifySound(aa.audio, bb.audio, match.offset, match.duration);
        if (sound.ok) {
          const seams = overlapSeams(aa.frames, bb.frames, aa.audio, bb.audio, match, a.duration, b.duration);
          if (seams.length) verified.push({ ...match, a: a.id, b: b.id, sound, seams });
        } else reviewed.push({ a: a.id, b: b.id, reason: sound.reason });
      } else if (results.some(result => result.status === 'review')) reviewed.push({ a: a.id, b: b.id, reason: 'uncertain' });
    } catch (error) {
      check(signal);
      // Failure to prove an overlap is never permission to omit footage.
      reviewed.push({ a: a.id, b: b.id, reason: 'could-not-check' });
    }
    aa = bb = null;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  // Remove redundant review notices for pairs whose sequence was fully verified.
  const uncertain = reviewed.filter(pair => !verified.some(match => match.a === pair.a && match.b === pair.b || match.a === pair.b && match.b === pair.a));
  const protectedIds = new Set([...verified, ...uncertain].flatMap(pair => [pair.a, pair.b]));
  const detailed = clips.map(clip => ({ ...clip }));
  const visual = await planEditAsync(detailed, { verified, reviewed: uncertain }, signal);
  const soundClips = detailed.filter(clip => detailed.length > 1 && !protectedIds.has(clip.id));
  for (let index = 0; index < soundClips.length; index++) {
    check(signal);
    const clip = soundClips[index];
    onProgress({ stage: `Checking sound ${index + 1} of ${soundClips.length}…`, fraction: .5 + index / soundClips.length * .22 });
    // Unavailable/unchecked sound cannot authorize a new interior trim.
    clip.sound = { status: 'unavailable', windows: [] };
    try {
      const blob = await getBlob(clip, signal), windows = [];
      check(signal);
      for (const range of soundRanges(clip, visual.segments.find(part => part.id === clip.id))) {
        const inspected = await inspect(blob, [], signal, { audioRange: range });
        check(signal);
        windows.push(soundWindow(inspected.audio));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      clip.sound = { status: 'checked', windows };
      // Quiet pauses can sit between sparse visual samples. Inspect those
      // moments before accepting them as candidates in the joint planner.
      const extraTimes = new Set();
      for (const time of [...pauseCandidates(clip, 'in'), ...pauseCandidates(clip, 'out')]) {
        for (const t of nearbyFrames(clip, time - .15, time + .16, { pad: 1 })) extraTimes.add(t);
      }
      if (extraTimes.size) {
        const extra = await pictures(blob, [...extraTimes].sort((a, b) => a - b));
        check(signal);
        const merged = new Map(clip.samples.map(frame => [frame.t.toFixed(6), frame]));
        for (const frame of extra.frames) merged.set(frame.t.toFixed(6), frame);
        clip.samples = [...merged.values()].sort((a, b) => a.t - b.t);
      }
    } catch (error) {
      check(signal);
      clip.sound = { status: 'unavailable', windows: [] };
    }
  }
  const first = await planEditAsync(detailed, { verified, reviewed: uncertain }, signal);
  const refine = new Map();
  for (let i = 0; i < first.segments.length; i++) {
    const part = first.segments[i];
    if (protectedIds.has(part.id)) continue;
    const clip = byId.get(part.id), keep = Math.min(clip.duration, Math.max(.5, clip.duration * .45));
    const fineIn = i ? nearbyFrames(clip, Math.max(0, part.start - .2), Math.min(clip.duration - keep, part.start + .2)) : [];
    const fineOut = i + 1 < first.segments.length ? nearbyFrames(clip, Math.max(keep, part.end - .2), Math.min(clip.duration, part.end + .2)) : [];
    const times = new Set();
    for (const time of [...fineIn, ...fineOut]) for (const nearby of nearbyFrames(clip, Math.max(0, time - .15), Math.min(clip.duration, time + .16), { pad: 1 })) times.add(nearby);
    if (times.size) refine.set(part.id, { fineIn: [...new Set([part.start, ...fineIn])], fineOut: [...new Set([part.end, ...fineOut])], times: [...times].sort((a, b) => a - b) });
  }
  let count = 0;
  for (const clip of detailed) {
    check(signal);
    if (!refine.has(clip.id)) continue;
    onProgress({ stage: `Refining the joins ${++count} of ${refine.size}…`, fraction: .72 + count / Math.max(1, refine.size) * .22 });
    const request = refine.get(clip.id);
    try {
      const dense = await pictures(await getBlob(clip, signal), request.times);
      check(signal);
      const merged = new Map(clip.samples.map(frame => [frame.t.toFixed(6), frame]));
      for (const frame of dense.frames) merged.set(frame.t.toFixed(6), frame);
      clip.samples = [...merged.values()].sort((a, b) => a.t - b.t);
      clip.fineIn = request.fineIn; clip.fineOut = request.fineOut;
    } catch (error) { check(signal); /* Retain the valid coarse plan if extra sampling fails. */ }
  }
  check(signal);
  onProgress({ stage: 'Matching movement across the joins…', fraction: .96 });
  await refineMotion(detailed, signal);
  const plan = await planEditAsync(detailed, { verified, reviewed: uncertain }, signal);
  return { ...plan, verifiedOverlaps: verified.length, sourceInfos };
}
