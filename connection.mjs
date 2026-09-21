import { boundaryCost, signature } from './planner.mjs?v=13';
import { trackMotion } from './motion.mjs?v=9';
import { chooseBridge, motionGrid, validateBridgeImages } from './transition-core.mjs?v=13';

const speed = v => Math.hypot(v.x, v.y);
const compatible = (a, b) => {
  if (!(a?.confidence >= .72 && b?.confidence >= .72)) return false;
  const aa = speed(a), bb = speed(b);
  if (aa < .014 && bb < .014) return true;
  if (Math.min(aa, bb) < .008 || Math.max(aa, bb) / Math.min(aa, bb) > 1.65) return false;
  return (a.x * b.x + a.y * b.y) / (aa * bb) > .88;
};

// Admission is about a playable connection, not proof that two clips duplicate
// one event. Three consecutive pictures on each side establish motion. Fine
// detail/color checks below reject a new subject against an unchanged background.
export async function checkConnection(a, b, end, start, signal) {
  signal?.throwIfAborted();
  const aa = a.samples.filter(f => f.timestamp < end - .00001).slice(-6);
  const bb = b.samples.filter(f => f.timestamp >= start - .00001).slice(0, 6);
  if (aa.length < 3 || bb.length < 3 || Math.abs(bb[0].timestamp - start) > .0011) return null;
  const last = aa.at(-1), first = bb[0];
  const dt = end - last.timestamp;
  if (dt < .012 || dt > .105) return null;
  const score = boundaryCost(signature(a, end, 'out'), signature(b, start, 'in'));
  if (score.similarity < .91 || score.mismatch > .19 || score.continuation > .20) return null;
  const va = last.inMotion, vb = first.outMotion;
  if (!compatible(va, vb) || !compatible(aa.at(-2).inMotion, va) || !compatible(vb, bb[1].outMotion)) return null;
  if ((va.local || vb.local) && !compatible({ ...va.camera, confidence: va.confidence }, { ...vb.camera, confidence: vb.confidence })) return null;
  const forward = trackMotion(last.pixels, first.pixels), backward = trackMotion(first.pixels, last.pixels);
  if (Math.min(forward.confidence, backward.confidence) < .8 || Math.min(forward.tracks.length, backward.tracks.length) < 24) return null;
  const expected = { x: (va.x + vb.x) / 2 * 96 * dt, y: (va.y + vb.y) / 2 * 54 * dt };
  const error = Math.hypot(forward.x - expected.x, forward.y - expected.y);
  const cameraError = Math.hypot(forward.camera.x - (va.camera.x + vb.camera.x) / 2 * 96 * dt, forward.camera.y - (va.camera.y + vb.camera.y) / 2 * 54 * dt);
  let bridge, left = last, right = first;
  const native = error <= Math.max(.23, speed(expected) * .3) && cameraError <= Math.max(.23, speed(expected) * .3);
  if (native) bridge = { forward: motionGrid(forward), backward: motionGrid(backward), m0: 1, m1: 1 };
  else {
    if (aa.length < 6 || bb.length < 6) return null;
    // Existing interpolation must independently accept the small gap. No
    // invented motion or dissolve is used to excuse a failed source connection.
    const mappedA = aa.map(f => ({ ...f, outputTime: f.timestamp - end, image: f.image || grayImage(f) }));
    const mappedB = bb.map(f => ({ ...f, outputTime: f.timestamp - start, image: f.image || grayImage(f) }));
    bridge = await chooseBridge(mappedA, mappedB, signal);
    if (!bridge) return null;
    left = aa[aa.length - bridge.left - 1]; right = bb[bridge.right];
  }
  // This also catches small foreground changes in the 96-pixel sequence before
  // paying for the independent full-size endpoint check.
  if (!await validateBridgeImages(bridge, grayImage(left), grayImage(right), signal)) return null;
  return { cost: Math.max(0, score.cost) + Math.min(error, 2) * .06, bridge, left: left.timestamp, right: right.timestamp, native };
}

function grayImage(frame) {
  const data = new Uint8ClampedArray(96 * 54 * 4);
  for (let i = 0; i < frame.pixels.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = frame.pixels[i]; data[i * 4 + 3] = 255;
  }
  return { data, width: 96, height: 54 };
}
