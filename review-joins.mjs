import { pictures } from './transitions.mjs?v=14';
import { judgeJoin } from './join-quality.mjs?v=14';
import { outputSize } from './quality.mjs?v=14';
import { check } from './vault.mjs?v=14';

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
