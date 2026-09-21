// Output decisions use the source pictures and measured cadence, never a device
// name. Capability checks happen against these exact profiles in the renderer.
export const MAX_EXPORT_BYTES = 192 * 1024 * 1024;
export const MAX_FRAME_RATE = 60;
export const near = (a, b, tolerance = .000025) => Math.abs(a - b) <= tolerance;

export function outputSize(width, height, edge = 1920) {
  if (!(width > 0 && height > 0)) throw new Error('This video has no readable picture size.');
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) };
}

export function cadence(packets) {
  const times = packets.map(p => p.timestamp).sort((a, b) => a - b);
  const deltas = times.slice(1).map((t, i) => t - times[i]).filter(dt => dt > .0001 && dt < 1);
  if (!deltas.length) {
    const duration = packets.find(p => p.duration > 0)?.duration;
    return { rate: duration ? Math.min(240, 1 / duration) : 30, variable: false };
  }
  deltas.sort((a, b) => a - b);
  const step = deltas[Math.floor(deltas.length / 2)];
  const snap = rate => {
    const standards = [12, 15, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60, 120];
    const closest = standards.reduce((a, b) => Math.abs(rate - a) < Math.abs(rate - b) ? a : b);
    return Math.abs(rate / closest - 1) < .001 ? closest : rate;
  };
  const variable = deltas.some(dt => Math.abs(dt / step - 1) > .08);
  // A WebM millisecond timebase alternates 33/34ms for 30fps. Its average
  // cadence is more accurate than the median of those quantized intervals.
  const meanStep = deltas.reduce((sum, dt) => sum + dt, 0) / deltas.length;
  return { rate: snap(1 / (variable ? step : meanStep)), peakRate: snap(1 / deltas[0]), variable };
}

export function videoBitrate(size, rate, codec = 'avc') {
  const efficiency = codec === 'vp9' || codec === 'hevc' ? .8 : 1;
  return Math.round(Math.max(4e6, Math.min(18e6, size.width * size.height * Math.min(60, rate) * .17 * efficiency)) / 100000) * 100000;
}

export function outputProfiles(infos, duration) {
  const first = infos[0], ratio = first.width / first.height;
  const reference = infos.filter(p => Math.abs(p.width / p.height / ratio - 1) < .01)
    .reduce((a, b) => a.width * a.height > b.width * b.height ? a : b, first);
  const rate = Math.min(60, Math.max(...infos.map(p => p.peakRate || p.rate || 30)));
  const profiles = [];
  for (const edge of [1920, 1280]) for (const frameRate of [rate, Math.min(rate, 30)]) {
    const size = outputSize(reference.width, reference.height, edge);
    if (profiles.some(p => p.width === size.width && p.height === size.height && p.frameRate === frameRate)) continue;
    // Leave room for audio/container overhead. A long, complex edit may need a
    // smaller output, instead of allocating an unbounded in-memory export.
    const bitrate = videoBitrate(size, frameRate);
    if ((bitrate + 192000) * duration / 8 > MAX_EXPORT_BYTES * .9) continue;
    profiles.push({ ...size, frameRate, bitrate, reduced: edge < 1920 || frameRate < rate });
  }
  // Preserve a longer usable sequence instead of silently stopping at four
  // minutes. If normal profiles exceed the encoded-file budget, fit a smaller
  // picture and bitrate to the complete duration. Do not allocate a larger file.
  if (!profiles.length && Number.isFinite(duration) && duration > 0) {
    const bitrateCap = Math.floor((MAX_EXPORT_BYTES * .9 * 8 / duration - 192000) / 1000) * 1000;
    for (const edge of [1280, 960, 640, 480]) for (const frameRate of [rate, Math.min(rate, 30)]) {
      const size = outputSize(reference.width, reference.height, edge);
      if (profiles.some(p => p.width === size.width && p.height === size.height && p.frameRate === frameRate)) continue;
      // A floor proportional to picture size prevents forcing a large, muddy
      // picture into an inadequate bitrate merely to keep its resolution label.
      if (bitrateCap < Math.max(180000, size.width * size.height * frameRate * .1)) continue;
      const bitrate = Math.min(videoBitrate(size, frameRate), bitrateCap);
      profiles.push({ ...size, frameRate, bitrate, bitrateCap, reduced: true });
    }
  }
  return profiles;
}

// Native source timestamps are kept, including VFR and fractional-rate clips.
// The containing frame supplies a cut between source timestamps; no source time
// is added or removed. Only rates above the selected capability cap are sampled.
export function frameSlots(packets, part, maximumRate = 60) {
  const sorted = packets.filter(p => p.timestamp < part.end - 1e-7).sort((a, b) => a.timestamp - b.timestamp);
  const unique = sorted.filter((p, i) => !i || !near(p.timestamp, sorted[i - 1].timestamp, 1e-7));
  if (!unique.length) throw new Error('This video has no frames at the chosen cut point.');
  let preceding = 0;
  for (let i = 0; i < unique.length && unique[i].timestamp <= part.start + 1e-7; i++) preceding = i;
  const candidates = unique.slice(preceding), kept = [];
  let last = -Infinity;
  for (const p of candidates) {
    const start = Math.max(part.start, p.timestamp);
    if (start >= part.end - 1e-7) continue;
    if (kept.length && p.timestamp - last < 1 / maximumRate - Math.min(.0011, .05 / maximumRate)) continue;
    kept.push({ sourceTime: p.timestamp, start: start - part.start }); last = p.timestamp;
  }
  if (!kept.length) throw new Error('This video could not supply a readable frame.');
  // Hold the first picture for any tiny leading timestamp offset, as before.
  kept[0].start = 0;
  return kept.map((p, i) => ({ ...p, time: part.outputStart + p.start,
    duration: (kept[i + 1]?.start ?? part.duration) - p.start })).filter(p => p.duration > .000001);
}

export function isHdr(color = {}) { return color.transfer === 'pq' || color.transfer === 'hlg'; }

export function sameConfig(a, b) {
  const view = value => value == null ? [] : Array.from(new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength));
  const normalized = c => ({ codec: c.codec, codedWidth: c.codedWidth, codedHeight: c.codedHeight,
    displayAspectWidth: c.displayAspectWidth, displayAspectHeight: c.displayAspectHeight,
    colorSpace: Object.fromEntries(['primaries', 'transfer', 'matrix', 'fullRange'].map(k => [k, c.colorSpace?.[k] ?? null])),
    description: view(c.description) });
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

export function copyRange(info, part) {
  const all = info.packets, selected = all.filter(p => p.timestamp >= part.start - 1e-7 && p.timestamp < part.end - 1e-7);
  if (!selected.length || selected[0].type !== 'key' || !near(selected[0].timestamp, part.start)) return null;
  const full = selected.length === all.length, endTolerance = full ? .0011 : .000025;
  if (selected.some(p => p.duration <= 0 || p.timestamp + p.duration > part.end + endTolerance)) return null;
  const ordered = [...selected].sort((a, b) => a.timestamp - b.timestamp);
  if (!near(ordered.at(-1).timestamp + ordered.at(-1).duration, part.end, endTolerance)) return null;
  if (ordered.some((p, i) => i && !near(ordered[i - 1].timestamp + ordered[i - 1].duration, p.timestamp))) return null;
  // The final duration may differ by one container tick; pictures are copied
  // unchanged and that last duration is clamped to the audio-sample timeline.
  // Arbitrary partial GOPs are not safe to copy. Partial ranges additionally
  // reject reordering/open-GOP dependencies; full clips may retain B-frames.
  if (!full && (all.some((p, i) => i && p.timestamp < all[i - 1].timestamp)
    || !all.some(p => p.type === 'key' && near(p.timestamp, part.end)))) return null;
  return { first: selected[0].sequenceNumber, last: selected.at(-1).sequenceNumber, count: selected.length,
    bytes: selected.reduce((sum, p) => sum + p.byteLength, 0) };
}
