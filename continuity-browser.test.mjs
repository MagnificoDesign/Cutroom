import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const root = resolve(new URL('./', import.meta.url).pathname), directory = resolve(root, 'test-results/continuity');
await mkdir(directory, { recursive: true });
const fixtures = new Map();
const world = (x, y) => 128 + 32 * Math.sin(x * .27) + 29 * Math.sin(y * .36) + 20 * Math.sin(x * .81 + y * .57) + 15 * Math.cos(x * .39 - y * .85);
for (let take = 0; take < 6; take++) {
  const width = 320, height = 180, raw = Buffer.alloc(120 * width * height * 3);
  for (let frame = 0; frame < 120; frame++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = ((frame * height + y) * width + x) * 3;
    const bad = take > 0 && frame < 30 || take < 5 && frame >= 90;
    const value = bad ? 45 + take * 25 : world(x * 96 / width - (take * 24 + frame) * .6, y * 54 / height);
    raw[at] = raw[at + 1] = raw[at + 2] = Math.round(value);
  }
  const name = `take-${take}.mp4`, path = resolve(directory, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '320x180', '-framerate', '30', '-i', 'pipe:0', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-crf', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path], { input: raw });
  fixtures.set('/fixtures/' + name, readFileSync(path));
}
const longSource = resolve(directory, 'five-minute.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '300', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', longSource]);
fixtures.set('/fixtures/five-minute.mp4', readFileSync(longSource));
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') { response.end('<!doctype html><title>Continuity tests</title>'); return; }
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + '/')) { response.writeHead(403); response.end(); return; }
  try {
    response.writeHead(200, { 'Content-Type': extname(file) === '.mjs' ? 'text/javascript' : 'video/mp4' });
    response.end(fixtures.get(path) || await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CUTROOM_CHROMIUM_PATH, headless: true,
  args: ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && (!request.url().startsWith(base + '/') || request.method() !== 'GET')) requests.push(request.url()); });
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { analyzeContinuity } = await import('/continuity.mjs?v=14');
    const { probe } = await import('/media.mjs?v=14');
    const { renderEdit } = await import('/renderer.mjs?v=14');
    const clips = [], blobs = new Map();
    // Deliberately shuffled: the bank is not already a timeline.
    for (const take of [3, 0, 5, 1, 4, 2]) {
      const id = `take-${take}`, blob = await (await fetch(`/fixtures/${id}.mp4`)).blob();
      blobs.set(id, blob); clips.push({ id, name: id, ...await probe(blob) });
    }
    const getBlob = clip => blobs.get(clip.id), signal = new AbortController().signal;
    const begin = performance.now();
    const plan = await analyzeContinuity({ clips, getBlob, signal });
    const selectedMs = performance.now() - begin;
    const output = await renderEdit({ clips, segments: plan.segments, plan, getBlob, signal });
    return { segments: plan.segments, joins: plan.joins, omitted: plan.omitted, checked: plan.checkedConnections, searchLimited: plan.searchLimited,
      selectedMs, duration: output.duration, extension: output.extension, timeline: output.timeline, bytes: Array.from(new Uint8Array(await output.blob.arrayBuffer())) };
  });
  await writeFile(resolve(directory, 'plan.json'), JSON.stringify({ ...result, bytes: undefined }, null, 2));
  assert(result.segments.length >= 3, JSON.stringify(result.segments));
  assert.equal(result.segments[0].id, 'take-0'); assert.equal(result.segments[0].start, 0);
  assert.equal(result.segments.at(-1).id, 'take-5'); assert.equal(result.segments.at(-1).end, 4);
  assert(result.duration > 7.5 && result.duration <= 8.1, `Expected one approximately 8s traversal, got ${result.duration}`);
  assert(result.segments.slice(1, -1).some(part => part.end - part.start < 1.8));
  assert(result.joins.every(j => j.status === 'verified'));
  for (let i = 1; i < result.segments.length; i++) {
    const a = result.segments[i - 1], b = result.segments[i];
    const outgoing = Number(a.id.at(-1)) * 24 + a.end * 30;
    const incoming = Number(b.id.at(-1)) * 24 + b.start * 30;
    assert(Math.abs(incoming - outgoing) < .001, `Skipped/repeated world time at ${a.id}/${b.id}: ${outgoing} → ${incoming}`);
  }
  const path = resolve(directory, `alternate-takes.${result.extension}`);
  await writeFile(path, new Uint8Array(result.bytes));
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-an', '-vf', 'scale=96:54', '-pix_fmt', 'gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 16 * 1048576 });
  assert.equal(raw.length, 240 * 96 * 54);
  const shifts = [];
  // Independent geometry check: fit every decoded picture to the known moving
  // texture. This does not use Cutroom's descriptors, tracker or seam scores.
  for (let frame = 0; frame < 240; frame++) {
    let best = Infinity, fitted = NaN;
    for (let shift = frame * .6 - .6; shift <= frame * .6 + .6; shift += .025) {
      let error = 0;
      for (let y = 5; y < 49; y += 3) for (let x = 5; x < 91; x += 3) error += (raw[(frame * 54 + y) * 96 + x] - world(x - shift, y)) ** 2;
      if (error < best) { best = error; fitted = shift; }
    }
    shifts.push(fitted);
  }
  const steps = shifts.slice(1).map((shift, i) => shift - shifts[i]);
  assert(Math.min(...steps) > .25 && Math.max(...steps) < .95, `Motion step range ${Math.min(...steps)}…${Math.max(...steps)}`);
  const sound = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-']);
  for (let start = .2; start < result.duration - .2; start += .2) {
    let energy = 0, crossings = 0, prior = 0;
    for (let i = Math.round(start * 8000); i < Math.round((start + .1) * 8000); i++) {
      const value = sound.readFloatLE(i * 4); energy += value * value;
      if (prior <= 0 && value > 0) crossings++; prior = value;
    }
    assert(energy > 1 && Math.abs(crossings * 10 - 440) <= 10);
  }
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  console.log(`PASS continuity: 6 shuffled four-second takes → ${result.duration.toFixed(3)}s, ${result.segments.length} pieces, ${result.checked} candidate connections checked in ${(result.selectedMs / 1000).toFixed(2)}s. All 240 world frames appear once; source tone is audible throughout. Motion steps ${Math.min(...steps).toFixed(3)}–${Math.max(...steps).toFixed(3)}px.`);
  const long = await page.evaluate(async () => {
    const { renderEdit } = await import('/renderer.mjs?v=14');
    const { AudioBufferSource } = await import('/mediabunny.mjs?v=6');
    const add = AudioBufferSource.prototype.add; let blocks = 0, maximum = 0;
    AudioBufferSource.prototype.add = function(buffer) { blocks++; maximum = Math.max(maximum, buffer.length); return add.call(this, buffer); };
    const blob = await (await fetch('/fixtures/five-minute.mp4')).blob();
    const clip = { id: 'long', name: 'five-minute.mp4', duration: 300, width: 160, height: 90 };
    try {
      const result = await renderEdit({ clips: [clip], segments: [{ id: 'long', start: 0, end: 300 }], getBlob: () => blob, signal: new AbortController().signal });
      return { blocks, maximum, duration: result.duration, extension: result.extension, bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())) };
    } finally { AudioBufferSource.prototype.add = add; }
  });
  assert.equal(long.blocks, 300); assert.equal(long.maximum, 48000); assert(Math.abs(long.duration - 300) < .03);
  const longPath = resolve(directory, `five-minute-export.${long.extension}`);
  await writeFile(longPath, new Uint8Array(long.bytes));
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,duration:format=duration', '-of', 'json', longPath], { encoding: 'utf8' }));
  assert.equal(Number(info.streams.find(s => s.codec_type === 'video').nb_read_frames), 3600);
  assert(info.streams.some(s => s.codec_type === 'audio')); assert(Math.abs(Number(info.format.duration) - 300) < .03);
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', longPath, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 16 * 1048576 });
  for (const time of [.2, 150, 299.5]) {
    let energy = 0, crossings = 0, prior = 0;
    for (let i = Math.round(time * 8000); i < Math.round((time + .2) * 8000); i++) {
      const value = pcm.readFloatLE(i * 4); energy += value * value;
      if (prior <= 0 && value > 0) crossings++; prior = value;
    }
    assert(energy > 2 && Math.abs(crossings * 5 - 440) <= 5);
  }
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  console.log('PASS continuity: real five-minute export retains all 3600 pictures, audible source tone at beginning/middle/end and 300 bounded one-second audio blocks.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
