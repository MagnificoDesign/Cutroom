import { isHdr } from './quality.mjs?v=15';

// Missing container hints must not overwrite the decoded frame's real color
// description. Decode metadata is authoritative for the exposed raw planes.
export function resolveColor(...colors) {
  return Object.assign({}, ...colors.map(color => Object.fromEntries(Object.entries(color?.toJSON?.() || color || {}).filter(([, value]) => value != null))));
}
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const srgbToLinear = v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
export const linearToSrgb = v => v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055;

// BT.2100 PQ and HLG inverse transfer functions. PQ returns absolute nits;
// HLG returns scene-linear light (the luminance-dependent OOTF follows below).
export function inverseTransfer(value, transfer) {
  const v = clamp(value);
  if (transfer === 'pq') {
    const p = v ** (1 / (2523 / 32));
    return 10000 * (Math.max(0, p - 3424 / 4096) / (2413 / 128 - 2392 / 128 * p)) ** (1 / (2610 / 16384));
  }
  if (transfer === 'hlg') return v <= .5 ? v * v / 3 : (Math.exp((v - .55991073) / .17883277) + .28466892) / 12;
  throw new Error('This HDR color format is not supported yet. Choose a standard-color copy from Photos.');
}

export function toneMapRgb(rgb, transfer, primaries = 'bt2020') {
  let [r, g, b] = rgb.map(v => inverseTransfer(v, transfer));
  if (transfer === 'hlg') {
    const scale = 1000 * Math.max(0, .2627 * r + .678 * g + .0593 * b) ** .2;
    r *= scale; g *= scale; b *= scale;
  }
  if (primaries === 'bt2020') [r, g, b] = [1.660491 * r - .587641 * g - .07285 * b,
    -.12455 * r + 1.1329 * g - .008349 * b, -.018151 * r - .100579 * g + 1.11873 * b];
  else if (primaries !== 'bt709') throw new Error('This HDR color space cannot be converted safely. Choose a standard-color copy from Photos.');
  const y = Math.max(0, (.2126 * r + .7152 * g + .0722 * b) / 203);
  // Fixed, temporally stable shoulder: preserve shadow contrast and roll off
  // highlights without per-frame exposure pumping. Output is standard sRGB.
  const mapped = y <= .75 ? y : .75 + .25 * (y - .75) / (y - .5);
  const ratio = y > 1e-9 ? mapped / (y * 203) : 0;
  const values = [r * ratio, g * ratio, b * ratio];
  let saturation = 1;
  for (const v of values) {
    if (v < 0) saturation = Math.min(saturation, mapped / (mapped - v));
    if (v > 1) saturation = Math.min(saturation, (1 - mapped) / (v - mapped));
  }
  return values.map(v => clamp(linearToSrgb(clamp(mapped + (v - mapped) * saturation))));
}

export function planeFormat(format) {
  if (format === 'NV12') return { depth: 8, bytes: 1, sx: 2, sy: 2, interleaved: true };
  const match = /^I(420|422|444)(?:P(10|12))?$/.exec(format || '');
  if (!match) throw new Error('This browser cannot expose this HDR picture safely. Choose a standard-color copy from Photos.');
  return { depth: Number(match[2] || 8), bytes: match[2] ? 2 : 1, sx: match[1] === '444' ? 1 : 2, sy: match[1] === '420' ? 2 : 1, interleaved: false };
}

function readPlane(raw, plane, x, y, channel = 0) {
  const { bytes, layout, format, width, height } = raw, p = format;
  const w = plane ? Math.ceil(width / p.sx) : width, h = plane ? Math.ceil(height / p.sy) : height;
  x = clamp(x, 0, w - 1); y = clamp(y, 0, h - 1);
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const at = (xx, yy) => {
    const i = layout[plane].offset + yy * layout[plane].stride + (xx * (p.interleaved && plane ? 2 : 1) + channel) * p.bytes;
    return p.bytes === 2 ? bytes[i] + 256 * bytes[i + 1] : bytes[i];
  };
  const jx = Math.min(ix + 1, w - 1), jy = Math.min(iy + 1, h - 1);
  return (at(ix, iy) * (1 - fx) + at(jx, iy) * fx) * (1 - fy) + (at(ix, jy) * (1 - fx) + at(jx, jy) * fx) * fy;
}

export function hdrPixel(raw, x, y) {
  const p = raw.format, factor = 2 ** (p.depth - 8), maximum = 2 ** p.depth - 1;
  const full = raw.color.fullRange === true;
  const yy = (readPlane(raw, 0, x, y) - (full ? 0 : 16 * factor)) / (full ? maximum : 219 * factor);
  const u = (readPlane(raw, 1, (x + .5) / p.sx - .5, (y + .5) / p.sy - .5) - 128 * factor) / (full ? maximum : 224 * factor);
  const v = (readPlane(raw, p.interleaved ? 1 : 2, (x + .5) / p.sx - .5, (y + .5) / p.sy - .5, p.interleaved ? 1 : 0) - 128 * factor) / (full ? maximum : 224 * factor);
  const [kr, kb] = raw.color.matrix === 'bt2020-ncl' ? [.2627, .0593] : [.2126, .0722];
  const r = yy + 2 * (1 - kr) * v, b = yy + 2 * (1 - kb) * u, g = (yy - kr * r - kb * b) / (1 - kr - kb);
  return toneMapRgb([r, g, b], raw.color.transfer, raw.color.primaries);
}

export async function readHdr(sample, signal, color = sample.colorSpace) {
  signal?.throwIfAborted();
  const info = resolveColor(color, sample.colorSpace);
  if (!isHdr(info) || !['bt2020-ncl', 'bt709'].includes(info.matrix) || !['bt2020', 'bt709'].includes(info.primaries)) {
    throw new Error('This HDR color space cannot be converted safely. Choose a standard-color copy from Photos.');
  }
  const format = planeFormat(sample.format);
  const options = { rect: { x: 0, y: 0, width: sample.codedWidth, height: sample.codedHeight } };
  const allocation = sample.allocationSize(options);
  if (allocation > 100 * 1048576) throw new Error('This HDR picture is too large for a safe phone conversion. Choose a smaller copy.');
  const bytes = new Uint8Array(allocation);
  const layout = await sample.copyTo(bytes, options);
  signal?.throwIfAborted();
  return { bytes, layout, format, width: sample.codedWidth, height: sample.codedHeight, color: info };
}

export function sampleCoordinates(sample, width, height, x, y, fit = 'contain') {
  const scale = Math.min(width / sample.displayWidth, height / sample.displayHeight);
  const w = fit === 'fill' ? width : sample.displayWidth * scale, h = fit === 'fill' ? height : sample.displayHeight * scale;
  let u = (x + .5 - (width - w) / 2) / w, v = (y + .5 - (height - h) / 2) / h;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  if (sample.flip) u = 1 - u;
  if (sample.rotation === 90) [u, v] = [v, 1 - u];
  else if (sample.rotation === 180) [u, v] = [1 - u, 1 - v];
  else if (sample.rotation === 270) [u, v] = [1 - v, u];
  const rect = sample.visibleRect || { left: 0, top: 0, width: sample.codedWidth, height: sample.codedHeight };
  return [rect.left + u * rect.width - .5, rect.top + v * rect.height - .5];
}

export async function paintSample(sample, canvas, signal, color = sample.colorSpace, fit = 'contain') {
  signal?.throwIfAborted();
  color = resolveColor(color, sample.colorSpace);
  const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
  if (!isHdr(color)) { sample.drawWithFit(context, { width: canvas.width, height: canvas.height, fit }); return false; }
  const raw = await readHdr(sample, signal, color);
  const output = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    if (!(y % 16)) { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 0)); }
    for (let x = 0; x < canvas.width; x++) {
      const coords = sampleCoordinates(sample, canvas.width, canvas.height, x, y, fit), at = (y * canvas.width + x) * 4;
      const rgb = coords ? hdrPixel(raw, ...coords) : [0, 0, 0];
      for (let c = 0; c < 3; c++) output.data[at + c] = Math.round(rgb[c] * 255);
      output.data[at + 3] = 255;
    }
  }
  signal?.throwIfAborted();
  context.putImageData(output, 0, 0);
  return true;
}

export async function applyColor(canvas, gains, signal) {
  if (!gains || gains.every(g => Math.abs(g - 1) < .0001)) return;
  const context = canvas.getContext('2d'), image = context.getImageData(0, 0, canvas.width, canvas.height);
  const tables = gains.map(gain => Uint8ClampedArray.from({ length: 256 }, (_, i) => 255 * linearToSrgb(clamp(srgbToLinear(i / 255) * gain))));
  for (let y = 0; y < canvas.height; y++) {
    if (!(y % 32)) { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 0)); }
    for (let i = y * canvas.width * 4; i < (y + 1) * canvas.width * 4; i += 4) for (let c = 0; c < 3; c++) image.data[i + c] = tables[c][image.data[i + c]];
  }
  signal?.throwIfAborted(); context.putImageData(image, 0, 0);
}
