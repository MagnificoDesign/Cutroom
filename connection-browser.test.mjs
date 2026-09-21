import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const root = resolve(new URL('./', import.meta.url).pathname), directory = resolve(root, 'test-results/connections');
await mkdir(directory, { recursive: true });
// Generate outside the synchronized workspace, then serve immutable bytes.
// A partially synchronized fixture must never masquerade as a planner failure.
const temporary = mkdtempSync(resolve(tmpdir(), 'cutroom-connections-'));
const fixtures = new Map(), wanted = name => !process.env.CUTROOM_TEST_MATCH || name.includes(process.env.CUTROOM_TEST_MATCH);
// Avoid a repeating wallpaper: unrelated points along this world must remain
// visibly different, so the known 24-take chronology is independently testable.
const world = (x, y) => 128 + 28 * Math.sin(x * .27182818) + 21 * Math.sin(y * .36)
  + 18 * Math.sin(x * .811803 + y * .57) + 17 * Math.cos(x * .393729 - y * .85)
  + 13 * Math.sin(x * .141421 + y * .11272) + 10 * Math.cos(x * .074 + Math.sin(y * .6));
function movie(name, draw, duration = 4) {
  const width = 160, height = 90, raw = Buffer.alloc(Math.round(duration * 30) * width * height * 3);
  for (let frame = 0; frame < duration * 30; frame++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = ((frame * height + y) * width + x) * 3;
    raw[at] = raw[at + 1] = raw[at + 2] = Math.round(draw(x * 96 / width, y * 54 / height, frame));
  }
  const path = resolve(temporary, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '160x90', '-framerate', '30', '-i', 'pipe:0', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(duration), '-c:v', 'libx264', '-crf', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path], { input: raw });
  const bytes = readFileSync(path);
  const middle = Math.floor(duration * 30 / 2);
  const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', `select=eq(n\\,${middle})`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { input: bytes });
  assert.equal(decoded.length, width * height * 3);
  let error = 0, points = 0;
  for (let y = 5; y < height - 5; y += 7) for (let x = 5; x < width - 5; x += 7) {
    error += Math.abs(decoded[(y * width + x) * 3] - draw(x * 96 / width, y * 54 / height, middle)); points++;
  }
  assert(error / points < 4, `${name} does not contain the intended test picture: ${error / points}`);
  fixtures.set('/fixtures/' + name, bytes);
}
if (wanted('24 related takes')) for (let take = 0; take < 24; take++) {
  movie(`bank-${take}.mp4`, (x, y, frame) => world(x - (take * 72 + frame) * .6, y) + (take % 2 ? 8 : 0));
}
if (wanted('short connected route')) {
  movie('short-a.mp4', (x, y, frame) => frame < 30 ? world(x - frame * .6, y) : 20);
  movie('short-b.mp4', (x, y, frame) => frame >= 90 ? world(x - (frame - 60) * .6, y) : 235);
}
if (wanted('required finishing')) {
  movie('still-a.mp4', (x, y) => world(x, y), 1);
  movie('still-b.mp4', (x, y) => world(x - .8, y), 1);
}
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') { response.end('<!doctype html><title>Connection tests</title>'); return; }
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + '/')) { response.writeHead(403); response.end(); return; }
  try { response.writeHead(200, { 'Content-Type': extname(file) === '.mjs' ? 'text/javascript' : 'video/mp4' }); response.end(fixtures.get(path) || await readFile(file)); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CUTROOM_CHROMIUM_PATH, headless: true,
  args: ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let failures = 0;
async function run(name, names, inspect) {
  if (!wanted(name)) return;
  const page = await browser.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && (!request.url().startsWith(base + '/') || request.method() !== 'GET')) requests.push(request.url()); });
  page.on('console', message => { if (message.text().startsWith('PROGRESS')) console.log(message.text()); });
  try {
    await page.goto(base);
    const result = await page.evaluate(async names => {
      const { analyzeContinuity } = await import('/continuity.mjs?v=14');
      const { probe } = await import('/media.mjs?v=14');
      const { renderEdit } = await import('/renderer.mjs?v=14');
      const blobs = new Map(), clips = [];
      for (const name of names) {
        const blob = await (await fetch('/fixtures/' + name)).blob(); blobs.set(name, blob);
        clips.push({ id: name, name, ...await probe(blob) });
      }
      const getBlob = clip => blobs.get(clip.id), signal = new AbortController().signal, begin = performance.now();
      let last = begin;
      const onProgress = ({ stage }) => { if (performance.now() - last > 15000) { console.log('PROGRESS ' + stage); last = performance.now(); } };
      const plan = await analyzeContinuity({ clips, getBlob, signal, onProgress });
      console.log(`PROGRESS planned ${plan.segments.length}/${clips.length} clips, ${plan.duration.toFixed(3)}s, ${plan.checkedConnections} checks`);
      const selectedMs = performance.now() - begin;
      const output = await renderEdit({ clips, segments: plan.segments, plan, getBlob, signal, onProgress });
      const video = document.createElement('video'), url = URL.createObjectURL(output.blob);
      try {
        video.src = url; video.muted = true;
        await video.play();
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Playback did not advance.')), 5000); video.ontimeupdate = () => { if (video.currentTime > .1) { clearTimeout(timer); resolve(); } }; });
      } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
      return { segments: plan.segments, joins: plan.joins, omitted: plan.omitted, failures: plan.failures, checked: plan.checkedConnections,
        searchLimited: plan.searchLimited, selectedMs, duration: output.duration, extension: output.extension,
        timeline: output.timeline, finishedJoins: output.finishedJoins, qualityChecks: output.qualityChecks,
        bytes: Array.from(new Uint8Array(await output.blob.arrayBuffer())) };
    }, names);
    const file = name.replaceAll(' ', '-');
    await writeFile(resolve(directory, `${file}.json`), JSON.stringify({ ...result, bytes: undefined }, null, 2));
    const path = resolve(temporary, `${file}.${result.extension}`);
    await writeFile(path, new Uint8Array(result.bytes));
    assert.deepEqual(result.failures, []); assert(result.joins.every(j => j.status === 'verified'));
    await inspect(result, path);
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 8 * 1048576 });
    for (const part of result.timeline) {
      const time = part.outputStart + Math.min(.1, part.duration / 4);
      let energy = 0, crossings = 0, prior = 0;
      for (let i = Math.round(time * 8000); i < Math.round((time + .1) * 8000); i++) {
        const value = pcm.readFloatLE(i * 4); energy += value * value;
        if (prior <= 0 && value > 0) crossings++; prior = value;
      }
      assert(energy > 1 && Math.abs(crossings * 10 - 440) <= 10, `Source audio missing near ${time}s`);
    }
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    await writeFile(resolve(directory, `${file}.${result.extension}`), new Uint8Array(result.bytes));
    console.log(`PASS connections: ${name}: ${result.segments.length}/${names.length} clips, ${result.duration.toFixed(3)}s, ${result.checked} checks in ${(result.selectedMs / 1000).toFixed(1)}s; decoded picture, source tone and browser playback verified.`);
  } catch (error) { failures++; console.error(`FAIL connections: ${name}\n${error.stack}`); }
  finally { await page.close(); }
}
try {
  await run('24 related takes', Array.from({ length: 24 }, (_, i) => `bank-${i * 7 % 24}.mp4`), (result, path) => {
    assert.equal(result.segments.length, 24, JSON.stringify(result.segments));
    assert.deepEqual(result.segments.map(p => p.id), Array.from({ length: 24 }, (_, i) => `bank-${i}.mp4`));
    assert(result.joins.some(j => j.similar), 'The set must exercise tolerance, not only exact matches.');
    assert(Math.abs(result.duration - 59.2) < .1, String(result.duration));
    for (let i = 1; i < result.segments.length; i++) {
      const a = result.segments[i - 1], b = result.segments[i];
      assert(Math.abs(i * 72 + b.start * 30 - ((i - 1) * 72 + a.end * 30)) < .001, `Repeated or missing source time at join ${i}`);
    }
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-an', '-vf', 'scale=96:54', '-pix_fmt', 'gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 16 * 1048576 });
    assert.equal(raw.length, Math.round(result.duration * 30) * 96 * 54);
    // Independently fit every pair of decoded seam pictures to the known world,
    // allowing each source's small light offset. The join must keep moving in
    // the same direction by roughly one frame, never repeat an event or jump.
    for (let i = 1; i < result.timeline.length; i++) {
      const at = Math.round(result.timeline[i].outputStart * 30), fitted = [];
      for (const frame of [at - 1, at]) {
        const part = result.timeline[frame === at ? i : i - 1], take = Number(part.id.match(/bank-(\d+)/)[1]);
        const sourceTime = part.start + frame / 30 - part.outputStart, expected = (take * 72 + sourceTime * 30) * .6;
        let best = Infinity, shift;
        for (let x = expected - .6; x <= expected + .6; x += .025) {
          let error = 0;
          for (let y = 5; y < 49; y += 3) for (let column = 5; column < 91; column += 3) error += (raw[(frame * 54 + y) * 96 + column] - world(column - x, y) - (take % 2 ? 8 : 0)) ** 2;
          if (error < best) { best = error; shift = x; }
        }
        fitted.push(shift);
      }
      assert(fitted[1] - fitted[0] > .20 && fitted[1] - fitted[0] < 1.05, `Jump at join ${i}: ${fitted.join(' -> ')}`);
    }
  });
  await run('short connected route', ['short-a.mp4', 'short-b.mp4'], result => {
    assert.equal(result.segments.length, 2); assert(Math.abs(result.duration - 2) < .04);
    assert.equal(result.segments[0].id, 'short-a.mp4'); assert.equal(result.segments[1].id, 'short-b.mp4');
    assert.equal(result.segments[0].end, 1); assert.equal(result.segments[1].start, 3);
  });
  await run('required finishing', ['still-a.mp4', 'still-b.mp4'], result => {
    assert.equal(result.segments.length, 2);
    assert(result.joins[0].requiresFinishing); assert.equal(result.finishedJoins.length, 1);
    assert(result.qualityChecks.every(join => join.ok));
  });
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(temporary, { recursive: true, force: true }); }
if (failures) process.exitCode = 1;
