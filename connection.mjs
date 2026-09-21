import { boundaryCost, signature } from './planner.mjs?v=14';
import { trackMotion } from './motion.mjs?v=14';
import { chooseBridge, motionGrid, validateBridgeImages, validateMatchImages } from './transition-core.mjs?v=14';
import { chooseFinishing } from './finish-core.mjs?v=14';

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

// Related takes need not be pixel-identical. Check a natural, small motion step
// plus several frames on each side, while allowing minor texture/light changes.
// Large gaps still require the independently validated interpolation path.
export async function checkSimilarConnection(a, b, end, start, signal) {
  signal?.throwIfAborted();
  const aa = a.samples.filter(f => f.timestamp < end - .00001).slice(-6);
  const bb = b.samples.filter(f => f.timestamp >= start - .00001).slice(0, 6);
  if (aa.length < 3 || bb.length < 3 || Math.abs(bb[0].timestamp - start) > .0011) return null;
  const left = aa.at(-1), right = bb[0], dt = end - left.timestamp;
  if (dt < .012 || dt > .105 || Math.min(left.variance, right.variance) < .001) return null;
  const score = boundaryCost(signature(a, end, 'out'), signature(b, start, 'in'));
  if (score.similarity < .87 || score.mismatch > .28 || score.continuation > .32) return null;
  const compatibleMotion = (x, y) => {
    if (!(x?.confidence >= .6 && y?.confidence >= .6)) return false;
    const xx = speed(x), yy = speed(y);
    if (xx < .014 && yy < .014) return true;
    return Math.min(xx, yy) >= .008 && Math.max(xx, yy) / Math.min(xx, yy) <= 2
      && (x.x * y.x + x.y * y.y) / (xx * yy) >= .88;
  };
  const va = left.inMotion, vb = right.outMotion;
  if (!compatibleMotion(va, vb) || !compatibleMotion(aa.at(-2).inMotion, va) || !compatibleMotion(vb, bb[1].outMotion)) return null;
  if ((va.local || vb.local) && !compatibleMotion({ ...va.camera, confidence: va.confidence }, { ...vb.camera, confidence: vb.confidence })) return null;
  const forward = trackMotion(left.pixels, right.pixels), backward = trackMotion(right.pixels, left.pixels);
  if (Math.min(forward.confidence, backward.confidence) < .68 || Math.min(forward.tracks.length, backward.tracks.length) < 24) return null;
  const expected = { x: (va.x + vb.x) / 2 * 96 * dt, y: (va.y + vb.y) / 2 * 54 * dt };
  const error = Math.hypot(forward.x - expected.x, forward.y - expected.y);
  const cameraError = Math.hypot(forward.camera.x - (va.camera.x + vb.camera.x) / 2 * 96 * dt, forward.camera.y - (va.camera.y + vb.camera.y) / 2 * 54 * dt);
  const bridge = { forward: motionGrid(forward), backward: motionGrid(backward), m0: 1, m1: 1 };
  if (error <= Math.max(.45, speed(expected) * .4) && cameraError <= Math.max(.45, speed(expected) * .4)
    && await validateMatchImages(bridge, grayImage(left), grayImage(right), signal)) {
    return { cost: Math.max(0, score.cost) + error * .06 + .08, bridge, left: left.timestamp, right: right.timestamp, native: true, similar: true };
  }
  // For a nearly still shot, a proven tiny framing/color correction may make the
  // connection viable. It becomes mandatory in the renderer, never a claim that
  // the uncorrected cut is seamless.
  if (aa.every(f => f.image) && bb.every(f => f.image)) {
    const finishing = chooseFinishing(aa, bb, a.width / a.height);
    if (finishing) return { cost: Math.max(0, score.cost) + .10, finishing, left: left.timestamp, right: right.timestamp, native: false };
  }
  return null;
}

function grayImage(frame) {
  const data = new Uint8ClampedArray(96 * 54 * 4);
  for (let i = 0; i < frame.pixels.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = frame.pixels[i]; data[i * 4 + 3] = 255;
  }
  return { data, width: 96, height: 54 };
}
