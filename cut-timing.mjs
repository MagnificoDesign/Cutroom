// Presentation timestamps, not an assumed 30 fps clock. The final clip end is
// a valid exclusive boundary even when the last frame is shorter than its peers.
export function sourceTimes(packets, duration) {
  return [...new Set(packets.map(p => p.timestamp).filter(t => Number.isFinite(t) && t >= 0 && t < duration - 1e-7))].sort((a, b) => a - b);
}

function lowerBound(times, time) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] < time) lo = mid + 1; else hi = mid; }
  return lo;
}

export function cutAt(clip, time, low = 0, high = clip.duration) {
  if (!clip.frameTimes) return Math.max(low, Math.min(high, time));
  const times = clip.frameTimes, i = lowerBound(times, time);
  const options = [0, clip.duration, times[i - 1], times[i], times[lowerBound(times, low)], times[lowerBound(times, high + 1e-7) - 1]]
    .filter(t => Number.isFinite(t) && t >= low - 1e-7 && t <= high + 1e-7);
  return options.sort((a, b) => Math.abs(a - time) - Math.abs(b - time) || a - b)[0];
}

export function nearbyFrames(clip, start, end, { pad = 0, limit = 1500 } = {}) {
  const times = clip.frameTimes;
  const first = Math.max(0, lowerBound(times, Math.max(0, start) - 1e-7) - pad);
  const last = Math.min(times.length, lowerBound(times, Math.min(clip.duration, end) + 1e-7) + pad);
  const selected = times.slice(first, last);
  // This is an inspection budget, never permission to discard source intervals.
  return selected.length <= limit ? selected : Array.from({ length: limit }, (_, i) => selected[Math.round(i * (selected.length - 1) / (limit - 1))]);
}

export function coarseFrames(clip, { interval = .25, limit = 100 } = {}) {
  const times = clip.frameTimes, requested = [times[0]], step = Math.max(interval, clip.duration / Math.max(1, limit - 1));
  for (let time = step; time < clip.duration; time += step) requested.push(times[Math.max(0, lowerBound(times, time) - 1)]);
  requested.push(times.at(-1));
  return [...new Set(requested)].filter(Number.isFinite);
}
