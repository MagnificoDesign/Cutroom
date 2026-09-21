import { frameSimilarity } from './core.mjs?v=6';
import { flow } from './planner.mjs?v=13';
import { MAX_EDIT_SECONDS, minimumPiece } from './edit-policy.mjs?v=13';
import { cutAt } from './cut-timing.mjs?v=12';

export function sourceEnd(clip, frame) {
  if (!clip.frameTimes) return Math.min(clip.duration, frame.timestamp + frame.duration);
  let low = 0, high = clip.frameTimes.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (clip.frameTimes[mid] <= frame.t + 1e-7) low = mid + 1; else high = mid;
  }
  return clip.frameTimes[low] ?? clip.duration;
}

export function compactFrames(frames) {
  const compact = frames.map(({ pixels, gray, inField, nextPicture, ...frame }) => ({ ...frame, tile: Float32Array.from(frame.tile), edge: Float32Array.from(frame.edge) }));
  for (let i = 1; i < frames.length; i++) {
    const vector = flow(frames[i - 1], frames[i]);
    compact[i - 1].outMotion = vector; compact[i].inMotion = vector;
  }
  return compact;
}

function embedding(frame) {
  const values = new Float32Array(38);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) {
    const index = y * 4 + x;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const tile = (y * 2 + dy) * 8 + x * 2 + dx;
      values[index] += (frame.tile[tile] - frame.mean) / 4;
      values[12 + index] += frame.edge[tile] / 2;
    }
    values[24 + index] = frame.chroma?.[index] || 0;
  }
  values[36] = frame.mean * .25; values[37] = Math.sqrt(frame.variance) * .5;
  return values;
}

// A bounded nearest-neighbor index replaces the old all-clips/all-frames pair
// table. Search effort is capped even when hundreds of clips look alike.
export function makeIndex(items) {
  const build = list => {
    if (!list.length) return null;
    if (list.length <= 12) return { items: list };
    let axis = 0, spread = -1;
    for (let d = 0; d < 38; d++) {
      let low = Infinity, high = -Infinity;
      for (const item of list) { low = Math.min(low, item.vector[d]); high = Math.max(high, item.vector[d]); }
      if (high - low > spread) { axis = d; spread = high - low; }
    }
    list.sort((a, b) => a.vector[axis] - b.vector[axis] || a.ordinal - b.ordinal);
    const mid = list.length >>> 1;
    return { axis, split: list[mid].vector[axis], left: build(list.slice(0, mid)), right: build(list.slice(mid)) };
  };
  return build([...items]);
}

export function nearestFrames(tree, vector, { count = 64, visits = 256 } = {}) {
  const best = []; let visited = 0;
  const search = node => {
    if (!node || ++visited > visits) return;
    if (node.items) {
      for (const item of node.items) {
        let distance = 0;
        for (let i = 0; i < vector.length; i++) distance += (vector[i] - item.vector[i]) ** 2;
        if (best.length === count && distance >= best.at(-1).distance) continue;
        // Repeated poses from one take must not crowd out other takes.
        const same = item.index === undefined ? [] : best.filter(entry => entry.item.index === item.index);
        if (same.length >= 2) {
          const worst = same.at(-1);
          if (worst.distance <= distance) continue;
          best.splice(best.indexOf(worst), 1);
        }
        best.push({ item, distance }); best.sort((a, b) => a.distance - b.distance || a.item.ordinal - b.item.ordinal);
        if (best.length > count) best.pop();
      }
      return;
    }
    const delta = vector[node.axis] - node.split;
    search(delta <= 0 ? node.left : node.right);
    if (best.length < count || delta * delta <= best.at(-1).distance) search(delta <= 0 ? node.right : node.left);
  };
  search(tree);
  return best.map(entry => entry.item);
}

function coarseMotion(a, b) {
  if (!(a?.confidence > .35 && b?.confidence > .35)) return .3;
  const aa = Math.hypot(a.x, a.y), bb = Math.hypot(b.x, b.y);
  if (aa < .018 && bb < .018) return 0;
  if (aa < .018 || bb < .018) return .5;
  const cosine = (a.x * b.x + a.y * b.y) / (aa * bb);
  return .7 * (1 - cosine) / 2 + .3 * Math.abs(aa - bb) / Math.max(aa, bb);
}

export async function proposeConnections(clips, signal, onProgress = () => {}) {
  const entries = [];
  clips.forEach((clip, index) => clip.samples.forEach(frame => {
    if (frame.t > clip.duration - minimumPiece(clip) + 1e-7 || frame.variance < .001 || frame.black > .93 || frame.white > .93) return;
    entries.push({ index, frame, vector: embedding(frame), ordinal: entries.length });
  }));
  const tree = makeIndex(entries), edges = [];
  for (let a = 0; a < clips.length; a++) {
    signal?.throwIfAborted();
    onProgress(a, clips.length);
    const clip = clips[a], pairs = new Map();
    for (const frame of clip.samples) {
      const end = sourceEnd(clip, frame);
      if (end < minimumPiece(clip) - 1e-7 || frame.variance < .001 || frame.black > .93 || frame.white > .93) continue;
      for (const match of nearestFrames(tree, embedding(frame))) {
        const b = match.index, other = clips[b];
        if (a === b || Math.abs(clip.width / clip.height / (other.width / other.height) - 1) > .01) continue;
        const similarity = frameSimilarity(frame, match.frame), movement = coarseMotion(frame.inMotion, match.frame.outMotion);
        if (similarity < .88 || movement > .58) continue;
        const cost = .7 * (1 - similarity) + .3 * movement;
        if (!pairs.has(b)) pairs.set(b, []);
        pairs.get(b).push({ a: clip.id, b: other.id, end, start: match.frame.t, cost, status: 'coarse' });
      }
    }
    const choices = [];
    for (const [b, candidates] of pairs) {
      candidates.sort((x, y) => x.cost - y.cost || y.end - x.end || x.start - y.start);
      const diverse = [];
      for (const candidate of candidates) {
        if (diverse.some(e => Math.abs(e.end - candidate.end) < .35 && Math.abs(e.start - candidate.start) < .35)) continue;
        diverse.push(candidate); if (diverse.length === 3) break;
      }
      choices.push({ b, score: diverse[0].cost, edges: diverse });
    }
    choices.sort((a, b) => a.score - b.score || a.b - b.b);
    for (const choice of choices.slice(0, 10)) for (const edge of choice.edges) edges.push({ ...edge, key: `${edge.a}/${edge.b}/${edge.end.toFixed(6)}/${edge.start.toFixed(6)}` });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return edges;
}

// A path carries its incoming cut. An outgoing edge is usable only if that
// middle clip still contributes a valid interval. BigInt masks support hundreds
// of clips without 32-bit aliasing; linked parents avoid copying whole paths.
export async function selectSequence(clips, edges, { signal, target = MAX_EDIT_SECONDS, confirmedOnly = false, beamWidth = 96 } = {}) {
  if (!(target > 0) || target > MAX_EDIT_SECONDS) throw new Error('The finished video must be four minutes or shorter.');
  const index = new Map(clips.map((clip, i) => [clip.id, i])), byId = new Map(clips.map(c => [c.id, c]));
  const outgoing = new Map(clips.map(c => [c.id, []]));
  for (const edge of edges) if ((!confirmedOnly || edge.status === 'verified') && edge.status !== 'rejected' && outgoing.has(edge.a) && byId.has(edge.b) && [edge.end, edge.start, edge.cost].every(Number.isFinite) && edge.start >= 0 && edge.end > 0) outgoing.get(edge.a).push(edge);
  const finish = state => {
    const clip = byId.get(state.id), limit = Math.min(clip.duration, state.start + target - state.elapsed);
    const end = cutAt(clip, limit, state.start, limit);
    if (end - state.start < Math.max(minimumPiece(clip), state.requiredKeep || 0) - 1e-7) return null;
    const duration = state.elapsed + end - state.start;
    return { state, end, duration, score: duration - state.penalty * 3 - state.depth * .12 };
  };
  let beam = clips.map((c, i) => ({ id: c.id, start: 0, elapsed: 0, penalty: 0, mask: 1n << BigInt(i), parent: null, depth: 0 }));
  let best = null;
  for (let depth = 0; depth < clips.length && beam.length; depth++) {
    signal?.throwIfAborted();
    const next = new Map();
    for (const state of beam) {
      const terminal = finish(state);
      if (terminal && (!best || terminal.score > best.score + 1e-8)) best = terminal;
      const clip = byId.get(state.id);
      for (const edge of outgoing.get(state.id)) {
        const b = index.get(edge.b), bit = 1n << BigInt(b), following = byId.get(edge.b);
        const requiredKeep = Math.max(minimumPiece(following), edge.requiresBridge ? .6 : 0);
        const currentKeep = Math.max(minimumPiece(clip), state.requiredKeep || 0, edge.requiresBridge ? .6 : 0);
        if (state.mask & bit || edge.end > clip.duration + 1e-7 || edge.end - state.start < currentKeep - 1e-7 || following.duration - edge.start < requiredKeep - 1e-7) continue;
        const elapsed = state.elapsed + edge.end - state.start;
        if (elapsed + requiredKeep > target + 1e-7) continue;
        const candidate = { id: edge.b, start: edge.start, elapsed, penalty: state.penalty + edge.cost, mask: state.mask | bit, parent: state, edge, requiredKeep, depth: state.depth + 1 };
        const terminal = finish(candidate); if (!terminal) continue;
        candidate.rank = terminal.score;
        const key = `${candidate.mask}/${candidate.id}/${candidate.start}/${candidate.requiredKeep}`;
        if (!next.has(key) || candidate.rank > next.get(key).rank) next.set(key, candidate);
      }
    }
    const perEnd = new Map();
    beam = [...next.values()].sort((a, b) => b.rank - a.rank).filter(state => {
      const count = perEnd.get(state.id) || 0; perEnd.set(state.id, count + 1); return count < 4;
    }).slice(0, beamWidth);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (!best) throw new Error('These clips could not supply a usable sequence. Your videos are still available.');
  const segments = [{ id: best.state.id, start: best.state.start, end: best.end }], joins = [];
  for (let state = best.state; state.parent; state = state.parent) {
    const edge = state.edge, parent = state.parent;
    segments.push({ id: parent.id, start: parent.start, end: edge.end }); joins.push(edge);
  }
  return { segments: segments.reverse(), joins: joins.reverse(), duration: best.duration, cost: best.state.penalty };
}
