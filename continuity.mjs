import { inspectMedia } from './media.mjs?v=15';
import { inspectSources } from './export-inspect.mjs?v=15';
import { check } from './vault.mjs?v=15';
import { checkBank, minimumPiece } from './edit-policy.mjs?v=15';
import { sourceTimes, coarseFrames, nearbyFrames } from './cut-timing.mjs?v=15';
import { compactFrames, proposeConnections, selectSequence, sourceEnd } from './continuity-core.mjs?v=15';
import { refineMotion } from './motion.mjs?v=15';
import { boundaryCost, signature, validatePlan } from './planner.mjs?v=15';
import { checkConnection, checkSimilarConnection } from './connection.mjs?v=15';
import { pictures } from './transitions.mjs?v=15';
import { validateBridgeImages, validateMatchImages } from './transition-core.mjs?v=15';
import { validateFinishing } from './finish-core.mjs?v=15';
import { assessMatchCut, appearanceMatch, cutMotion } from './match-cut.mjs?v=15';
import { analysisReport, reportError, rejectMatch, ConnectionSearchError } from './analysis-report.mjs?v=15';

export async function analyzeContinuity({ clips: originals, getBlob, signal, onProgress = () => {}, inspect = inspectMedia, readSources = inspectSources, readPictures = pictures }) {
  checkBank(originals);
  const clips = [], infos = new Map(), failures = [];
  const diagnostics = analysisReport(originals);
  const ordinal = id => originals.findIndex(c => c.id === id) + 1;
  const read = async (clip, times, blob, keepImages = false) => {
    const result = await inspect(blob || await getBlob(clip, signal), times.map(t => t + .000001), signal, { keepImages });
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
      // Four samples per second can miss the matching pose in short moving
      // takes before fine inspection ever gets a chance. Ten per second keeps
      // the initial search close to the motion, capped for long source clips.
      clip.samples = compactFrames(await read(clip, coarseFrames(clip, { interval: .1, limit: 240 }), blob));
      infos.set(clip.id, info); clips.push(clip);
    } catch (error) {
      check(signal);
      failures.push({ id: originals[i].id, reason: error?.message || 'This video could not be analyzed in this browser.' });
      reportError(diagnostics, 'source-analysis', [i + 1], error);
    }
  }
  diagnostics.analyzed = clips.length;
  if (!clips.length) { diagnostics.outcome = 'analysis-failed'; throw new ConnectionSearchError(diagnostics); }
  const byId = new Map(clips.map(c => [c.id, c]));
  let edges = await proposeConnections(clips, signal, (i, n) => onProgress({ stage: `Finding connections ${i + 1} of ${n}…`, fraction: .4 + i / n * .12 }));
  const candidateCount = edges.length;
  diagnostics.candidates = candidateCount;
  const windows = new Map(), decisions = new Map();
  const remember = (key, decision) => {
    decisions.set(key, decision);
    if (decisions.size > 2048) decisions.delete(decisions.keys().next().value);
  };
  const windowAt = async (clip, time) => {
    const bucket = Math.floor(time * 2), key = `${clip.id}/${bucket}`;
    if (windows.has(key)) { const value = windows.get(key); windows.delete(key); windows.set(key, value); return value; }
    const times = nearbyFrames(clip, bucket / 2 - .6, (bucket + 1) / 2 + .6, { limit: 120 });
    const value = { ...clip, samples: await read(clip, times, undefined, true) };
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
      if (score.similarity >= .72 && score.mismatch <= .8 && score.continuation <= .85) candidates.push({ end, start, cost: score.cost });
    }
    candidates.sort((x, y) => x.cost - y.cost || y.end - x.end || x.start - y.start);
    // Neighboring frames of one pose must not consume the entire fine search.
    const diverse = [];
    for (const candidate of candidates) {
      if (diverse.some(e => Math.abs(e.end - candidate.end) < .045 && Math.abs(e.start - candidate.start) < .045)) continue;
      diverse.push(candidate); if (diverse.length === 32) break;
    }
    const accepted = [];
    if (!diverse.length) rejectMatch(diagnostics, 'candidate-layout-or-motion');
    let fullChecks = 0;
    for (const candidate of diverse) {
      check(signal);
      if (accepted.some(e => Math.abs(e.end - candidate.end) < .09 && Math.abs(e.start - candidate.start) < .09)) continue;
      const key = `${a.id}/${b.id}/${candidate.end.toFixed(6)}/${candidate.start.toFixed(6)}/verified`;
      if (decisions.has(key)) {
        const decision = decisions.get(key); decisions.delete(key); decisions.set(key, decision);
        if (decision?.match) accepted.push({ ...edge, ...candidate, ...decision.match, key });
        if (decision?.fullChecked) fullChecks++;
        if (fullChecks >= 3 || accepted.length >= 2) break;
        continue;
      }
      const movement = cutMotion(aa, bb, candidate.end, candidate.start);
      if (movement.reversed) { rejectMatch(diagnostics, 'opposite-motion'); remember(key, null); continue; }
      let match = await checkConnection(aa, bb, candidate.end, candidate.start, signal)
        || await checkSimilarConnection(aa, bb, candidate.end, candidate.start, signal);
      let graded;
      if (!match) {
        graded = assessMatchCut(aa, bb, candidate.end, candidate.start, movement);
        if (graded.accepted) match = graded;
      }
      if (!match) { rejectMatch(diagnostics, graded.reason || 'connection'); remember(key, null); continue; }
      if ((!match.native || match.finishing) && (candidate.end < .6 - 1e-7 || b.duration - candidate.start < .6 - 1e-7)) continue;
      // One endpoint pair at a time, capped at the maximum encoded output edge.
      const scale = Math.min(1, 1920 / Math.max(a.width, a.height));
      const size = { width: Math.max(2, Math.round(a.width * scale)), height: Math.max(2, Math.round(a.height * scale)) };
      const left = await readPictures(await getBlob(a, signal), [{ time: match.left }], size, signal, false);
      const right = await readPictures(await getBlob(b, signal), [{ time: match.right }], size, signal, false);
      const validPictures = left[0] && right[0] && Math.abs(left[0].timestamp - match.left) <= .0011 && Math.abs(right[0].timestamp - match.right) <= .0011;
      if (!validPictures) throw new Error('The detailed matching pictures could not be decoded at the requested times.');
      let ok = match.kind === 'match-cut' ? appearanceMatch(left[0].image, right[0].image, { detailed: true }).accepted
        : (match.finishing ? validateFinishing(match.finishing, left[0].image, right[0].image)
          : await (match.similar ? validateMatchImages : validateBridgeImages)(match.bridge, left[0].image, right[0].image, signal));
      if (!ok && validPictures && match.native && !match.similar) {
        // A thumbnail can look exact while output-size texture differs slightly.
        // Give that native cut the same minor-difference check, reusing the two
        // images already decoded. Never relax a generated bridge this way.
        const similar = await checkSimilarConnection(aa, bb, candidate.end, candidate.start, signal);
        if (similar?.similar && await validateMatchImages(similar.bridge, left[0].image, right[0].image, signal)) { match = similar; ok = true; }
      }
      if (!ok && match.native) {
        graded ||= assessMatchCut(aa, bb, candidate.end, candidate.start, movement);
        if (graded.accepted && appearanceMatch(left[0].image, right[0].image, { detailed: true }).accepted) { match = graded; ok = true; }
      }
      const verified = ok ? { cost: match.cost, status: 'verified', kind: match.kind || 'continuity', grade: match.grade || 'close', similar: !!match.similar,
        requiresBridge: !match.native && !match.finishing, requiresFinishing: !!match.finishing } : null;
      if (!verified) rejectMatch(diagnostics, 'detailed-picture');
      // Keep only the decision, not decoded images or optical-flow fields. Many
      // coarse candidates refine to the same cut pair; inspect it once per job.
      remember(key, { match: verified, fullChecked: true });
      if (verified) accepted.push({ ...edge, ...candidate, ...verified, key });
      if (++fullChecks >= 3 || accepted.length >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return accepted;
  };
  // Verify only routes the joint planner actually wants. Rejecting/refining a
  // join triggers another whole-path search so cuts on a middle take agree.
  const budget = Math.min(1800, Math.max(96, clips.length * 8));
  let checked = 0, plan;
  const verify = async edge => {
    check(signal);
    onProgress({ stage: `Checking connection ${++checked}…`, fraction: .52 + checked / budget * .46 });
    let refined = [];
    try { refined = await refine(edge); }
    catch (error) { check(signal); reportError(diagnostics, 'connection-analysis', [ordinal(edge.a), ordinal(edge.b)], error); }
    diagnostics.checked = checked;
    diagnostics.accepted += refined.length;
    edges = [...new Map(edges.filter(e => e.key !== edge.key).concat(refined).map(e => [e.key, e])).values()];
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  // First give each source's strongest distinct neighbors a chance. Otherwise
  // an optimistic, long route through lookalikes can consume the whole budget
  // before short but real connections are ever checked.
  const seeds = clips.map(clip => {
    const neighbors = new Set();
    return edges.filter(e => e.a === clip.id).sort((a, b) => a.cost - b.cost).filter(e => {
      if (neighbors.has(e.b)) return false; neighbors.add(e.b); return true;
    }).slice(0, 2);
  });
  for (let rank = 0; rank < 2; rank++) for (const candidates of seeds) {
    if (checked >= Math.min(clips.length * 2, Math.floor(budget / 3))) break;
    if (candidates[rank]) await verify(candidates[rank]);
  }
  while (checked < budget) {
    check(signal);
    plan = await selectSequence(clips, edges, { signal });
    const pending = plan.joins.filter(edge => edge.status !== 'verified');
    if (!pending.length) break;
    // Batch the proposed path, then replan using actual refined frame times.
    for (const edge of pending) {
      if (checked >= budget) break;
      await verify(edge);
    }
  }
  windows.clear(); decisions.clear();
  plan = await selectSequence(clips, edges, { signal, confirmedOnly: true });
  validatePlan(originals, plan.segments, { allowSubset: true });
  const used = new Set(plan.segments.map(p => p.id));
  diagnostics.selected = used.size > 1 || originals.length === 1 ? used.size : 0;
  diagnostics.limited = checked >= budget;
  diagnostics.outcome = used.size > 1 || originals.length === 1 ? 'connected' : diagnostics.errorCount ? 'analysis-incomplete' : 'no-connections';
  onProgress({ stage: 'Sequence ready…', fraction: 1 });
  return { ...plan, diagnostics, continuity: true, improved: used.size > 1, reviewed: [], failures, checkedConnections: checked, candidateCount, analyzedCount: clips.length,
    searchLimited: checked >= budget, sourceCount: originals.length, inputSeconds: originals.reduce((n, c) => n + c.duration, 0),
    omitted: originals.filter(c => !used.has(c.id)).map(c => c.id), sourceInfos: [...used].map(id => infos.get(id)) };
}
