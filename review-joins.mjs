import { pictures } from './transitions.mjs?v=15';
import { judgeJoin } from './join-quality.mjs?v=15';
import { outputSize } from './quality.mjs?v=15';
import { check } from './vault.mjs?v=15';
import { appearanceMatch } from './match-cut.mjs?v=15';

export async function reviewMatchedCuts({ result, plan, signal, onProgress = () => {} }) {
  const checks = [], size = outputSize(result.width, result.height, 384);
  for (let index = 0; index < (plan?.joins?.length || 0); index++) {
    if (plan.joins[index].kind !== 'match-cut') continue;
    check(signal);
    onProgress({ stage: `Checking finished connection ${index + 1} of ${plan.joins.length}…`, fraction: .99 });
    const a = result.timeline[index].slots.at(-1), b = result.timeline[index + 1].slots[0];
    const frames = await pictures(result.blob, [a, b].map(slot => ({ time: slot.time + Math.min(.005, slot.duration / 2) })), size, signal, false);
    check(signal);
    if (frames.length !== 2) throw new Error('A finished connection could not be decoded. Your clips are still ready.');
    const match = appearanceMatch(frames[0].image, frames[1].image);
    checks.push({ index, ok: match.accepted, reason: match.reason || 'matched-picture' });
    if (!match.accepted) throw new Error('A finished connection lost its picture match during export. Your clips are still ready.');
  }
  return checks;
}

// Read only a short sequence around one enhanced join at a time. This examines
// the actual encoded movie after full-size warping/color work, including the
// ramp back to untouched footage. Never retain full-resolution preview movies.
export async function reviewJoins({ result, ordered, getBlob, signal, onProgress = () => {} }) {
  const selected = [...result.smoothedJoins, ...result.finishedJoins].map(join => join.index).sort((a, b) => a - b);
  const checks = [], size = outputSize(result.width, result.height, 192);
  for (const index of selected) {
    check(signal);
    onProgress({ stage: `Checking connection ${index + 1} of ${result.timeline.length - 1}…`, fraction: .98 });
    try {
      const a = result.timeline[index], b = result.timeline[index + 1], seam = b.outputStart;
      const left = a.slots.filter(p => p.time >= seam - .45).slice(-30), right = b.slots.filter(p => p.time <= seam + .45).slice(0, 30);
      const read = async (clip, slots) => pictures(await getBlob(clip, signal), slots.map(p => ({ time: p.sourceTime, outputTime: p.time })), size, signal, false);
      const aa = await read(ordered[index], left); check(signal);
      const bb = await read(ordered[index + 1], right); check(signal);
      const rendered = await pictures(result.blob, [...left, ...right].map(p => ({ time: p.time + Math.min(.005, p.duration / 2), outputTime: p.time })), size, signal, false);
      checks.push({ index, ...await judgeJoin([...aa, ...bb], rendered, seam, signal) });
    } catch (error) { check(signal); checks.push({ index, ok: false, reason: 'could-not-check' }); }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  check(signal);
  return checks;
}
