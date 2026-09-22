import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { takePicture } from './take-fixture.mjs';

const root = resolve(new URL('./', import.meta.url).pathname);
const output = resolve(root, 'test-results/matched'); mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(resolve(tmpdir(), 'cutroom-matched-'));
const files = new Map();
for (let take = 0; take < 30; take++) {
  const raw = Buffer.alloc(120 * 160 * 90 * 3);
  for (let f = 0; f < 120; f++) {
    const image = takePicture(f / 30, take, { width: 160, height: 90 });
    for (let i = 0; i < 160 * 90; i++) for (let c = 0; c < 3; c++) raw[(f * 160 * 90 + i) * 3 + c] = image.data[i * 4 + c];
  }
  const name = `take-${take}.mp4`, path = resolve(temporary, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '160x90', '-framerate', '30', '-i', 'pipe:0', '-f', 'lavfi', '-i', `sine=frequency=${330 + take * 11}:sample_rate=48000`, '-t', '4', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path], { input: raw });
  files.set('/' + name, readFileSync(path));
}
console.log('Generated 30 independent colored takes with different shapes, textures, light, phase, speed and source tones.');
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  try {
    if (path === '/') { response.end('<!doctype html><title>Independent take test</title>'); return; }
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + '/')) { response.writeHead(403); response.end(); return; }
    response.writeHead(200, { 'Content-Type': extname(path) === '.mjs' ? 'text/javascript' : 'video/mp4' });
    response.end(files.get(path) || await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CUTROOM_CHROMIUM_PATH, headless: true,
  args: ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage(), errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url()) && (!r.url().startsWith(base + '/') || r.method() !== 'GET')) requests.push(r.url()); });
  page.on('console', m => { if (m.text().startsWith('PROGRESS')) console.log(m.text()); });
  await page.goto(base);
  const result = await page.evaluate(async () => {
    const { analyzeContinuity } = await import('/continuity.mjs?v=15');
    const { requireConnectedEdit } = await import('/analysis-report.mjs?v=15');
    const { probe } = await import('/media.mjs?v=15');
    const { renderEdit } = await import('/renderer.mjs?v=15');
    const clips = [], blobs = new Map();
    for (let i = 0; i < 30; i++) {
      const id = String(i * 7 % 30), blob = await (await fetch(`/take-${id}.mp4`)).blob();
      blobs.set(id, blob); clips.push({ id, name: `take-${id}.mp4`, ...await probe(blob) });
    }
    const signal = new AbortController().signal, begin = performance.now(); let last = begin;
    const onProgress = ({ stage }) => { if (performance.now() - last > 10000) { console.log('PROGRESS ' + stage); last = performance.now(); } };
    const plan = requireConnectedEdit(await analyzeContinuity({ clips, getBlob: c => blobs.get(c.id), signal, onProgress }), clips.length);
    console.log(`PROGRESS selected ${plan.segments.length}/30, ${plan.duration}s, ${plan.checkedConnections} checks`);
    const selectedMs = performance.now() - begin;
    const output = await renderEdit({ clips, segments: plan.segments, plan, getBlob: c => blobs.get(c.id), signal, onProgress });
    const video = document.createElement('video'), url = URL.createObjectURL(output.blob);
    try {
      video.src = url; video.muted = true; await video.play();
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Playback did not advance')), 5000); video.ontimeupdate = () => { if (video.currentTime > .1) { clearTimeout(timer); resolve(); } }; });
    } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
    return { selectedMs, segments: plan.segments, joins: plan.joins, diagnostics: plan.diagnostics,
      timeline: output.timeline, duration: output.duration, extension: output.extension,
      smoothedJoins: output.smoothedJoins, finishedJoins: output.finishedJoins, qualityChecks: output.qualityChecks, matchedCutChecks: output.matchedCutChecks,
      bytes: Array.from(new Uint8Array(await output.blob.arrayBuffer())) };
  });
  const path = resolve(temporary, `independent-takes.${result.extension}`);
  writeFileSync(path, new Uint8Array(result.bytes));
  writeFileSync(resolve(output, 'result.json'), JSON.stringify({ ...result, bytes: undefined }, null, 2));
  assert(result.segments.length >= 20, `Only ${result.segments.length}/30 sources retained`);
  assert(result.duration > 50, `Only ${result.duration}s retained`);
  assert(result.joins.some(j => j.kind === 'match-cut'), 'Must exercise the new edit matching');
  assert.equal(result.matchedCutChecks.length, result.joins.filter(j => j.kind === 'match-cut').length);
  assert(result.matchedCutChecks.every(c => c.ok));
  assert.equal(result.diagnostics.errorCount, 0, JSON.stringify(result.diagnostics));
  assert.equal(new Set(result.segments.map(p => p.id)).size, result.segments.length);
  // Independent geometry checks. Pose and movement come from the scene generator,
  // not from the matcher being tested. A repeated pose with reverse travel fails.
  const pose = (id, time) => { const phase = time * (1.45 + Number(id) % 3 * .018) + Number(id) * .71;
    return { x: 48 + 12 * Math.sin(phase), y: 29 + 2 * Math.cos(phase * 2), direction: Math.cos(phase), arm: Math.sin(phase) }; };
  let largestJump = 0;
  for (let i = 1; i < result.segments.length; i++) {
    const a = result.segments[i - 1], b = result.segments[i];
    const left = pose(a.id, a.end - 1 / 30), right = pose(b.id, b.start);
    const jump = Math.hypot(left.x - right.x, left.y - right.y); largestJump = Math.max(largestJump, jump);
    assert(jump < 3.5, `Visible subject jump at join ${i}: ${jump}`);
    if (Math.min(Math.abs(left.direction), Math.abs(right.direction)) > .25) assert(left.direction * right.direction > 0, `Reversed travel at join ${i}`);
  }
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-an', '-pix_fmt', 'rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 200 * 1048576 });
  assert.equal(raw.length, Math.round(result.duration * 30) * 160 * 90 * 3);
  // Decode actual output and compare an unmodified interior picture in every
  // chosen interval to the independently synthesized colored source picture.
  for (const part of result.timeline) {
    const at = Math.round((part.outputStart + part.duration / 2) * 30);
    const sourceTime = part.start + at / 30 - part.outputStart;
    const expected = takePicture(sourceTime, Number(part.id), { width: 160, height: 90 });
    let error = 0;
    for (let i = 0; i < 160 * 90; i++) for (let c = 0; c < 3; c++) error += Math.abs(raw[(at * 160 * 90 + i) * 3 + c] - expected.data[i * 4 + c]);
    assert(error / (160 * 90 * 3) < 7, `Source picture changed in ${part.id}`);
  }
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 8 * 1048576 });
  for (const part of result.timeline) {
    const begin = Math.round((part.outputStart + part.duration / 2 - .1) * 8000);
    let energy = 0, crossings = 0, previous = 0;
    for (let i = begin; i < begin + 1600; i++) { const v = pcm.readFloatLE(i * 4); energy += v * v; if (previous <= 0 && v > 0) crossings++; previous = v; }
    assert(energy > 2 && Math.abs(crossings * 5 - (330 + Number(part.id) * 11)) < 12, `Wrong source sound for ${part.id}`);
  }
  const frames = result.timeline.slice(1, 9).flatMap(p => [Math.round(p.outputStart * 30) - 1, Math.round(p.outputStart * 30)]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path, '-vf', `select='${frames.map(f => `eq(n,${f})`).join('+')}',scale=320:180,tile=4x4`, '-frames:v', '1', resolve(output, 'joins.png')]);
  writeFileSync(resolve(output, `independent-takes.${result.extension}`), new Uint8Array(result.bytes));
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  console.log(`PASS independent takes: ${result.segments.length}/30, ${result.duration.toFixed(2)}s, largest subject step ${largestJump.toFixed(2)}/96 picture width, ${(result.selectedMs / 1000).toFixed(1)}s search. Every selected clip's picture and distinct sound decoded; playback advanced.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(temporary, { recursive: true, force: true }); }
