import { inspectMedia } from './media.mjs?v=13';
import { inspectSources } from './export-inspect.mjs?v=11';
import { check } from './vault.mjs?v=10';
import { checkBank, minimumPiece } from './edit-policy.mjs?v=13';
import { sourceTimes, coarseFrames, nearbyFrames } from './cut-timing.mjs?v=12';
import { compactFrames, proposeConnections, selectSequence, sourceEnd } from './continuity-core.mjs?v=13';
import { refineMotion } from './motion.mjs?v=9';
import { boundaryCost, signature, validatePlan } from './planner.mjs?v=13';
import { checkConnection } from './connection.mjs?v=13';
import { pictures } from './transitions.mjs?v=13';
import { validateBridgeImages } from './transition-core.mjs?v=13';

export async function analyzeContinuity({ clips: originals, getBlob, signal, onProgress = () => {}, inspect = inspectMedia, readSources = inspectSources, readPictures = pictures }) {
  checkBank(originals);
  const clips = [], infos = new Map(), failures = [];
  const read = async (clip, times, blob) => {
    const result = await inspect(blob || await getBlob(clip, signal), times.map(t => t + .000001), signal);
    check(signal);
    if (result.frames.length !== times.length || result.frames.some((f, i) => !Number.isFinite(f.timestamp) || Math.abs(f.timestamp - times[i]) > .0011)) throw new Error('This video could not supply its expected frames.');
    return result.frames.map((frame, i) => ({ ...frame, t: times[i] }));
  };
  for (let i = 0; i < originals.length; i++) {
    check(signal);
    onProgress({ stage: `Analyzing video ${i + 1} of ${originals.length}…`, fraction: i / originals.length * .4 });
    try {
      // Only one decrypted source and one coarse image batch are held at once.
      const blob = await getBlob(originals[i], signal);
      const [info] = await readSources([originals[i]], () => blob, signal);
      const clip = { ...originals[i], frameTimes: sourceTimes(info.packets, originals[i].duration) };
      if (!clip.frameTimes.length) throw new Error('No readable picture timing.');
      clip.samples = compactFrames(await read(clip, coarseFrames(clip), blob));
      infos.set(clip.id, info); clips.push(clip);
    } catch (error) {
      check(signal);
      failures.push({ id: originals[i].id, reason: 'This video could not be analyzed in this browser.' });
    }
  }
  if (!clips.length) throw new Error('These videos could not be analyzed in this browser. Your imported copies are still available.');
  const byId = new Map(clips.map(c => [c.id, c]));
  let edges = await proposeConnections(clips, signal, (i, n) => onProgress({ stage: `Finding connections ${i + 1} of ${n}…`, fraction: .4 + i / n * .12 }));
  const windows = new Map();
  const windowAt = async (clip, time) => {
    const bucket = Math.floor(time * 2), key = `${clip.id}/${bucket}`;
    if (windows.has(key)) { const value = windows.get(key); windows.delete(key); windows.set(key, value); return value; }
    const times = nearbyFrames(clip, bucket / 2 - .45, (bucket + 1) / 2 + .45, { limit: 120 });
    const value = { ...clip, samples: await read(clip, times) };
    await refineMotion([value], signal);
    windows.set(key, value);
    if (windows.size > 8) windows.delete(windows.keys().next().value);
    return value;
  };
  const refine = async edge => {
    const a = byId.get(edge.a), b = byId.get(edge.b);
    const aa = await windowAt(a, edge.end), bb = await windowAt(b, edge.start);
    const ends = aa.samples.map(f => sourceEnd(a, f)).filter(t => t >= minimumPiece(a) && Math.abs(t - edge.end) <= .27);
    const starts = bb.samples.map(f => f.t).filter(t => t <= b.duration - minimumPiece(b) && Math.abs(t - edge.start) <= .27);
    const candidates = [];
    for (const end of ends) for (const start of starts) {
      const score = boundaryCost(signature(aa, end, 'out'), signature(bb, start, 'in'));
      if (score.similarity >= .91 && score.mismatch <= .19 && score.continuation <= .20) candidates.push({ end, start, cost: score.cost });
    }
    candidates.sort((x, y) => x.cost - y.cost || y.end - x.end || x.start - y.start);
    const accepted = [];
    let fullChecks = 0;
    for (const candidate of candidates.slice(0, 24)) {
      check(signal);
      if (accepted.some(e => Math.abs(e.end - candidate.end) < .09 && Math.abs(e.start - candidate.start) < .09)) continue;
      const match = await checkConnection(aa, bb, candidate.end, candidate.start, signal);
      if (!match) continue;
      // One endpoint pair at a time, capped at the maximum encoded output edge.
      const scale = Math.min(1, 1920 / Math.max(a.width, a.height));
      const size = { width: Math.max(2, Math.round(a.width * scale)), height: Math.max(2, Math.round(a.height * scale)) };
      const left = await readPictures(await getBlob(a, signal), [{ time: match.left }], size, signal, false);
      const right = await readPictures(await getBlob(b, signal), [{ time: match.right }], size, signal, false);
      const ok = left[0] && right[0] && Math.abs(left[0].timestamp - match.left) <= .0011 && Math.abs(right[0].timestamp - match.right) <= .0011
        && await validateBridgeImages(match.bridge, left[0].image, right[0].image, signal);
      if (ok) accepted.push({ ...edge, ...candidate, cost: match.cost, status: 'verified', kind: 'continuity', requiresBridge: !match.native, key: `${edge.key}/${candidate.end}/${candidate.start}` });
      if (++fullChecks >= 3 || accepted.length >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return accepted;
  };
  // Verify only routes the joint planner actually wants. Rejecting/refining a
  // join triggers another whole-path search so cuts on a middle take agree.
  const budget = Math.min(600, Math.max(48, clips.length * 3));
  let checked = 0, plan;
  while (checked < budget) {
    check(signal);
    plan = await selectSequence(clips, edges, { signal });
    const pending = plan.joins.filter(edge => edge.status !== 'verified');
    if (!pending.length) break;
    // Batch the proposed path, then replan using actual refined frame times.
    for (const edge of pending) {
      if (checked >= budget) break;
      check(signal);
      onProgress({ stage: `Checking connection ${++checked}…`, fraction: .52 + checked / budget * .46 });
      let refined = [];
      try { refined = await refine(edge); } catch (error) { check(signal); }
      edges = edges.filter(e => e.key !== edge.key).concat(refined);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  windows.clear();
  plan = await selectSequence(clips, edges, { signal, confirmedOnly: true });
  validatePlan(originals, plan.segments, { allowSubset: true });
  const used = new Set(plan.segments.map(p => p.id));
  onProgress({ stage: 'Sequence ready…', fraction: 1 });
  return { ...plan, continuity: true, improved: true, reviewed: [], failures, checkedConnections: checked,
    searchLimited: checked >= budget, sourceCount: originals.length, inputSeconds: originals.reduce((n, c) => n + c.duration, 0),
    omitted: originals.filter(c => !used.has(c.id)).map(c => c.id), sourceInfos: [...used].map(id => infos.get(id)) };
}
