// Acoustic pauses, not speech recognition. A low-energy instant is insufficient:
// require quiet on both sides of an interior cut and never infer silence from
// an uninspected interval or an audio decoder failure.
export const SOUND_STEP = .02;
const MARGIN = .08;

export function soundWindow(audio) {
  if (!audio || !audio.channels?.length || !(audio.rate > 0)) throw new Error('Source sound could not be inspected.');
  const length = audio.channels[0].length;
  const stride = Math.max(1, Math.round(audio.rate * SOUND_STEP));
  const step = stride / audio.rate;
  const levels = new Float32Array(Math.ceil(length / stride));
  for (let bin = 0; bin < levels.length; bin++) {
    const start = bin * stride, end = Math.min(length, start + stride);
    for (const channel of audio.channels) {
      let sum = 0;
      for (let i = start; i < end; i++) sum += channel[i] ** 2;
      // Max channel energy prevents opposite stereo channels cancelling out.
      levels[bin] = Math.max(levels[bin], Math.sqrt(sum / Math.max(1, end - start)));
    }
  }
  const sorted = Array.from(levels).sort((a, b) => a - b);
  const reference = sorted[Math.floor((sorted.length - 1) * .85)] || 0;
  const threshold = Math.max(.0008, Math.min(.008, reference * .1));
  const start = audio.start, end = start + length / audio.rate;
  const pauses = [];
  let quietStart = null;
  for (let i = 0; i <= levels.length; i++) {
    if (i < levels.length && levels[i] <= threshold) {
      if (quietStart === null) quietStart = start + i * step;
    } else if (quietStart !== null) {
      const quietEnd = Math.min(end, start + i * step);
      if (quietEnd - quietStart >= .24 - 1e-6) pauses.push([quietStart, quietEnd]);
      quietStart = null;
    }
  }
  return { start, end, step, levels, threshold, pauses, hasTrack: audio.hasTrack };
}

export function soundAllowsCut(clip, time, side) {
  if (side === 'in' && time <= .001 || side === 'out' && time >= clip.duration - .001) return true;
  if (!clip.sound) return true; // Direct callers without analysis retain the legacy visual planner.
  if (clip.sound.status !== 'checked') return false;
  const from = time - MARGIN, to = time + MARGIN;
  return clip.sound.windows.some(window => {
    if (from < window.start - 1e-6 || to > window.end + 1e-6) return false;
    const first = Math.max(0, Math.floor((from - window.start) / window.step + 1e-6));
    const last = Math.min(window.levels.length, Math.ceil((to - window.start) / window.step - 1e-6));
    if (last <= first) return false;
    for (let i = first; i < last; i++) if (window.levels[i] > window.threshold) return false;
    return true;
  });
}

export function pauseCandidates(clip, side) {
  if (clip.sound?.status !== 'checked') return [];
  const keep = Math.min(clip.duration, Math.max(.5, clip.duration * .45));
  const points = [];
  for (const window of clip.sound.windows) for (const [start, end] of window.pauses) {
    // Completely quiet windows need no extra artificial cut in their center.
    if (end - start >= window.end - window.start - .001) continue;
    const low = Math.max(start + MARGIN, side === 'out' ? keep : .04);
    const high = Math.min(end - MARGIN, side === 'in' ? clip.duration - keep : clip.duration - .04);
    if (high < low) continue;
    const point = Math.round((low + high) / 2 * 30) / 30;
    if (point >= low - 1e-6 && point <= high + 1e-6 && soundAllowsCut(clip, point, side)) points.push(point);
  }
  const unique = [...new Set(points)].sort((a, b) => a - b);
  return unique.length <= 8 ? unique : Array.from({ length: 8 }, (_, i) => unique[Math.round(i * (unique.length - 1) / 7)]);
}

export function soundRanges(clip, visualPart) {
  if (clip.duration <= 24) return [[0, clip.duration]];
  const ranges = [[0, 6], [clip.duration - 6, clip.duration]];
  for (const time of [visualPart?.start, visualPart?.end]) {
    if (time > 0 && time < clip.duration) ranges.push([Math.max(0, time - 3), Math.min(clip.duration, time + 3)]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    if (merged.length && range[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
