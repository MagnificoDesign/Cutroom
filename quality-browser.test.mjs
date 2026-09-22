import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
const root = new URL('./', import.meta.url).pathname, directory = resolve(root, 'test-results/quality');
await mkdir(directory, { recursive: true });
const fixtures = new Map();
const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 64 * 1048576 });
const remember = name => fixtures.set(name, readFileSync(resolve(directory, name)));
const probe = (path, entries, select = 'v:0') => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', select, '-show_entries', entries, '-of', 'json', path], { encoding: 'utf8' }));
const frames = path => probe(path, 'frame=pts_time,pkt_duration_time').frames;
const picture = (path, frame = 0, extra = '') => ffmpeg(['-i', path, '-vf', `select=eq(n\\,${frame})${extra ? ',' + extra : ''}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
// High-frequency stripes and a moving numbered pattern expose downsampling and
// dropped frames. Synthetic sources are generated locally and never uploaded.
ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=1920x1080:r=60,geq=lum='if(lt(Y,800),if(mod(floor(X/2),2),210,40),80+mod(X+N*19,140))':cb=128:cr=128", '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000', '-t', '0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', resolve(directory, 'detail60.mp4')]);
remember('detail60.mp4');
for (const rate of [24, 30, 60]) {
  ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=192x108:r=${rate}`, '-f', 'lavfi', '-i', `sine=frequency=${400 + rate}:sample_rate=48000`, '-t', '1', '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', resolve(directory, `rate${rate}.mp4`)]);
  remember(`rate${rate}.mp4`);
}
ffmpeg(['-i', resolve(directory, 'rate60.mp4'), '-vf', 'select=lt(n\\,30)+not(mod(n\\,2))', '-fps_mode', 'vfr', '-c:v', 'libx264', '-crf', '18', '-c:a', 'copy', resolve(directory, 'vfr.mp4')]); remember('vfr.mp4');
for (const id of [0, 1]) {
  ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=192x108:r=30,rotate=${id}*0.02`, '-f', 'lavfi', '-i', `sine=frequency=${440 + id * 220}:sample_rate=48000`, '-t', '1', '-c:v', 'libvpx-vp9', '-g', '15', '-b:v', '0', '-crf', '20', '-c:a', 'libopus', resolve(directory, `copy${id}.webm`)]);
  remember(`copy${id}.webm`);
}
const srgb = v => v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055;
const linear = v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
for (const id of [0, 1]) {
  const width = 640, height = 360, raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x * 96 / width - id * .55, py = y * 54 / height;
    const v = (128 + 32 * Math.sin(px * .27) + 29 * Math.sin(py * .36) + 20 * Math.sin(px * .81 + py * .57) + 15 * Math.cos(px * .39 - py * .85)) / 255;
    raw.fill(Math.round(255 * srgb(linear(v) * (id ? 1.1 : 1))), (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '640x360', '-framerate', '30', '-i', 'pipe:0', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-vf', 'loop=loop=29:size=1:start=0', '-t', '1', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'aac', resolve(directory, `finish${id}.mp4`)], { input: raw }); remember(`finish${id}.mp4`);
}
// Known absolute gray levels in a real 10-bit YUV bitstream. These are not SDR
// pictures merely labelled HDR. PQ and HLG each encode the same display levels.
const nits = [0, 10, 50, 100, 203, 400, 1000, 4000];
for (const transfer of ['pq', 'hlg']) {
  const width = 256, height = 144, plane = width * height, raw = Buffer.alloc(plane * 3);
  for (let i = 0; i < plane; i++) {
    const light = Math.min(transfer === 'hlg' ? 1000 : 10000, nits[Math.floor((i % width) / 32)]);
    const normalized = light / 10000, p = normalized ** (2610 / 16384);
    const scene = (light / 1000) ** (1 / 1.2);
    const encoded = transfer === 'pq' ? ((3424 / 4096 + 2413 / 128 * p) / (1 + 2392 / 128 * p)) ** (2523 / 32)
      : scene <= 1 / 12 ? Math.sqrt(3 * scene) : .17883277 * Math.log(12 * scene - .28466892) + .55991073;
    raw.writeUInt16LE(Math.round(64 + 876 * encoded), i * 2);
  }
  for (let i = plane * 2; i < raw.length; i += 2) raw.writeUInt16LE(512, i);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'yuv420p10le', '-video_size', '256x144', '-framerate', '24', '-i', 'pipe:0', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-vf', 'loop=loop=11:size=1:start=0', '-t', '0.5', '-c:v', 'libvpx-vp9', '-lossless', '1', '-profile:v', '2', '-color_primaries', 'bt2020', '-color_trc', transfer === 'pq' ? 'smpte2084' : 'arib-std-b67', '-colorspace', 'bt2020nc', '-color_range', 'tv', '-c:a', 'libopus', resolve(directory, `${transfer}.webm`)], { input: raw }); remember(`${transfer}.webm`);
}
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=12', '-f', 'lavfi', '-i', 'aevalsrc=0.12*sin(2*PI*439*t)|0.09*sin(2*PI*771*t):s=44100', '-af', 'adelay=270|270', '-t', '33', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-c:a', 'aac', '-b:a', '160k', resolve(directory, 'long-stereo.mp4')]); remember('long-stereo.mp4');
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/harness') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Quality checks</title>'); return; }
  const target = resolve(root, '.' + path);
  if (!target.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try { const data = fixtures.get(basename(path)) || await readFile(target); res.setHeader('Content-Type', /\.(mjs|js)$/.test(path) ? 'text/javascript' : 'application/octet-stream'); res.end(data); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CUTROOM_CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let failures = 0;
async function run(name, action) {
  if (process.env.CUTROOM_TEST_MATCH && !name.includes(process.env.CUTROOM_TEST_MATCH)) return;
  const context = await browser.newContext(), page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(base + '/') && !request.url().startsWith('blob:' + base + '/')) requests.push(request.url()); });
  try { await page.goto(base + '/harness'); await action(page); assert.deepEqual(errors, []); assert.deepEqual(requests, []); console.log(`PASS quality: ${name}`); }
  catch (error) { failures++; console.error(`FAIL quality: ${name}\n${error.stack}`); }
  finally { await context.close(); }
}
async function render(page, names, options = {}) {
  const result = await page.evaluate(async ({ names, options }) => {
    const { renderEdit } = await import('/renderer.mjs');
    const { Input, BlobSource, ALL_FORMATS } = await import('/mediabunny.mjs?v=6');
    const blobs = new Map(), clips = [];
    for (const name of names) {
      const blob = await (await fetch('/test-results/quality/' + name)).blob(); blobs.set(name, blob);
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS }), track = await input.getPrimaryVideoTrack();
      clips.push({ id: name, name, duration: await track.computeDuration(), width: await track.getDisplayWidth(), height: await track.getDisplayHeight() }); input.dispose();
    }
    const segments = options.segments || clips.map(clip => ({ id: clip.id, start: 0, end: clip.duration }));
    const output = await renderEdit({ clips, segments, plan: options.finish ? { joins: [], reviewed: [] } : undefined, getBlob: clip => blobs.get(clip.id), signal: new AbortController().signal });
    window.qualityOutput = output;
    const { blob, timeline, ...metadata } = output;
    return { ...metadata, times: timeline.flatMap(part => part.slots.map(slot => slot.time)), bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  }, { names, options });
  const path = resolve(directory, `export-${names.map(name => name.split('.')[0]).join('-')}-${options.finish ? 'finished' : 'plain'}.${result.extension}`);
  await writeFile(path, new Uint8Array(result.bytes)); delete result.bytes;
  return { ...result, path };
}
try {
  await run('native cut inspection requests actual 24 60 and VFR pictures and reuses timing for export', async page => {
    const result = await page.evaluate(async () => {
      const { analyzeJoins } = await import('/analyze.mjs');
      const { inspectMedia, probe } = await import('/media.mjs?v=15');
      const { renderEdit } = await import('/renderer.mjs');
      const names = ['rate24.mp4', 'rate60.mp4', 'vfr.mp4'], blobs = new Map(), clips = [], requests = [];
      for (const name of names) { const blob = await (await fetch('/test-results/quality/' + name)).blob(); blobs.set(name, blob); clips.push({ id: name, name, ...await probe(blob) }); }
      const getBlob = clip => blobs.get(clip.id), signal = new AbortController().signal;
      const plan = await analyzeJoins({ clips, getBlob, signal, inspect: async (blob, times, signal, options) => {
        requests.push({ id: [...blobs].find(([, value]) => value === blob)[0], times });
        return inspectMedia(blob, times, signal, options);
      } });
      const stages = [], output = await renderEdit({ clips, segments: plan.segments, plan, getBlob, signal, onProgress: p => stages.push(p.stage) });
      return { requests, times: Object.fromEntries(plan.sourceInfos.map(info => [info.id, info.packets.map(p => p.timestamp)])), segments: plan.segments, rescanned: stages.some(stage => stage.startsWith('Checking video quality')), duration: output.duration };
    });
    for (const request of result.requests) for (const time of request.times) assert(result.times[request.id].some(t => Math.abs(t - (time - .000001)) < .000001), `${request.id}: ${time}`);
    assert(result.requests.some(r => r.id === 'rate60.mp4' && r.times.some(t => Math.abs((t - .000001) * 30 - Math.round((t - .000001) * 30)) > .1)), 'inspect the intervening 60 fps frame');
    assert(result.segments.every(p => p.start === 0 && p.end === 1), 'continuous audible material stays intact');
    assert.equal(result.rescanned, false); assert(Math.abs(result.duration - 3) < .03);
  });
  await run('long stereo export uses one-second PCM blocks with no seams or timing drift', async page => {
    await page.evaluate(async () => {
      const { AudioBufferSource } = await import('/mediabunny.mjs?v=6'), add = AudioBufferSource.prototype.add;
      window.audioBlocks = [];
      AudioBufferSource.prototype.add = function(buffer) { window.audioBlocks.push(buffer.length); return add.call(this, buffer); };
    });
    const start = .073713, end = 32.213137;
    const result = await render(page, ['long-stereo.mp4'], { segments: [{ id: 'long-stereo.mp4', start, end }] });
    const blocks = await page.evaluate(() => window.audioBlocks);
    assert.equal(blocks.length, 33); assert(Math.max(...blocks) <= 48000);
    assert.equal(blocks.reduce((a, b) => a + b, 0), Math.round((end - start) * 48000));
    assert(Math.abs(result.duration - (end - start)) < .03);
    const bytes = ffmpeg(['-i', result.path, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-']);
    const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    for (let second = 1; second <= 31; second++) for (const [channel, frequency] of [[0, 439], [1, 771]]) {
      let energy = 0, real = 0, imaginary = 0, jump = 0;
      for (let n = 0; n < 4800; n++) { const index = second * 48000 - 2400 + n, value = pcm[index * 2 + channel]; energy += value ** 2; real += value * Math.cos(2 * Math.PI * frequency * n / 48000); imaginary += value * Math.sin(2 * Math.PI * frequency * n / 48000); jump = Math.max(jump, Math.abs(value - pcm[(index - 1) * 2 + channel])); }
      assert(energy > 10); assert((real * real + imaginary * imaginary) / (energy * 4800) > .45, `tone changed near block ${second}`); assert(jump < .025, `audio discontinuity near ${second}s`);
    }
    console.log(`Long PCM: ${blocks.length} blocks, maximum ${Math.max(...blocks)} samples/channel; stereo tones continuous across all 31 interior seconds.`);
  });
  await run('a runtime encoder failure releases resources and retries once at a supported lighter profile', async page => {
    await page.evaluate(async () => {
      const { CanvasSource, Output } = await import('/mediabunny.mjs?v=6'), add = CanvasSource.prototype.add, cancel = Output.prototype.cancel;
      let calls = 0; window.retryEvents = [];
      CanvasSource.prototype.add = function(...args) { if (++calls === 5) { window.retryEvents.push('failure'); throw new DOMException('Injected hardware encoder exhaustion', 'OperationError'); } if (calls === 6) window.retryEvents.push('retry'); return add.apply(this, args); };
      Output.prototype.cancel = async function(...args) { const result = await cancel.apply(this, args); window.retryEvents.push('released'); return result; };
    });
    const result = await render(page, ['detail60.mp4']);
    assert(result.recovered && result.reduced);
    assert.deepEqual([result.width, result.height, result.frameRate], [1280, 720, 30]);
    assert.equal(frames(result.path).length, 15);
    const events = await page.evaluate(() => window.retryEvents);
    assert(events.indexOf('released') > events.indexOf('failure') && events.indexOf('released') < events.indexOf('retry'), JSON.stringify(events));
  });
  await run('a second encode failure stops and cancellation between attempts never retries', async page => {
    const result = await page.evaluate(async () => {
      const { CanvasSource } = await import('/mediabunny.mjs?v=6'), { renderEdit } = await import('/renderer.mjs');
      const blob = await (await fetch('/test-results/quality/detail60.mp4')).blob(), clip = { id: 'a', name: 'a', width: 1920, height: 1080, duration: .5 };
      let calls = 0, retries = 0;
      CanvasSource.prototype.add = () => { calls++; throw new DOMException('Injected encoder failure', 'OperationError'); };
      const run = async controller => { try { await renderEdit({ clips: [clip], segments: [{ id: 'a', start: 0, end: .5 }], getBlob: () => blob, signal: controller.signal, onProgress: p => { if (p.stage.startsWith('Retrying')) { retries++; if (window.cancelRetry) controller.abort(); } } }); return 'returned'; } catch (error) { return error.name; } };
      const failed = await run(new AbortController()), first = { calls, retries };
      calls = retries = 0; window.cancelRetry = true;
      const cancelled = await run(new AbortController()); return { failed, first, cancelled, calls, retries };
    });
    assert.equal(result.failed, 'ExportResourceError'); assert.deepEqual(result.first, { calls: 2, retries: 1 });
    assert.equal(result.cancelled, 'AbortError'); assert.equal(result.calls, 1); assert.equal(result.retries, 1);
  });
  await run('decoded transition damage discards the enhanced movie and returns an original-frame export', async page => {
    await page.evaluate(async () => {
      const { CanvasSource } = await import('/mediabunny.mjs?v=6'), add = CanvasSource.prototype.add;
      const encode = VideoEncoder.prototype.encode;
      window.renderRounds = 0;
      CanvasSource.prototype.add = function(...args) { if (args[0] === 0) window.renderRounds++; return add.apply(this, args); };
      // Corrupt one encoded picture after the enhancement passed its source
      // checks. This exercises actual decode/review/re-render, not a stub verdict.
      VideoEncoder.prototype.encode = function(frame, ...args) {
        if (window.renderRounds === 1 && frame.timestamp >= 1000000 && frame.timestamp < 1030000) {
          const canvas = document.createElement('canvas'); canvas.width = frame.displayWidth; canvas.height = frame.displayHeight;
          const context = canvas.getContext('2d'); context.drawImage(frame, 0, 0); context.fillStyle = 'rgba(255,255,255,0.4)'; context.fillRect(0, 0, canvas.width, canvas.height);
          const replacement = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration });
          try { return encode.call(this, replacement, ...args); } finally { replacement.close(); }
        }
        return encode.call(this, frame, ...args);
      };
    });
    const safe = await render(page, ['finish0.mp4', 'finish1.mp4'], { finish: true });
    assert(safe.qualityChecks.some(check => !check.ok && check.reason === 'brightness'), JSON.stringify(safe.qualityChecks));
    assert.equal(safe.simplifiedJoins.length, 1); assert.equal(safe.finishedJoins.length, 0); assert.equal(safe.smoothedJoins.length, 0);
    assert.equal(await page.evaluate(() => window.renderRounds), 2);
    const plain = await render(page, ['finish0.mp4', 'finish1.mp4']);
    assert.equal(frames(safe.path).length, 60); assert(Math.abs(safe.duration - plain.duration) < .001);
    assert.deepEqual(picture(safe.path, 30), picture(plain.path, 30));
    const sound = path => ffmpeg(['-i', path, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-']);
    assert.deepEqual(sound(safe.path), sound(plain.path));
  });
  await run('cancelling actual rendered-connection review publishes nothing and starts no simpler render', async page => {
    const result = await page.evaluate(async () => {
      const { renderEdit } = await import('/renderer.mjs'), { CanvasSource } = await import('/mediabunny.mjs?v=6');
      const { probe } = await import('/media.mjs?v=15');
      const blobs = new Map(), clips = [], controller = new AbortController(); let rounds = 0, encoded = false;
      const add = CanvasSource.prototype.add;
      CanvasSource.prototype.add = function(...args) { if (args[0] === 0) rounds++; encoded = true; return add.apply(this, args); };
      for (const name of ['finish0.mp4', 'finish1.mp4']) { const blob = await (await fetch('/test-results/quality/' + name)).blob(); blobs.set(name, blob); clips.push({ id: name, name, ...await probe(blob) }); }
      try { await renderEdit({ clips, segments: clips.map(clip => ({ id: clip.id, start: 0, end: 1 })), plan: { joins: [], reviewed: [] }, getBlob: clip => blobs.get(clip.id), signal: controller.signal, onProgress: p => { if (encoded && p.fraction === .98) controller.abort(); } }); return { returned: true }; }
      catch (error) { return { name: error.name, rounds }; }
    });
    assert.equal(result.name, 'AbortError'); assert.equal(result.rounds, 1);
  });
  await run('a required continuity bridge cannot silently become an unmatched cut', async page => {
    const result = await page.evaluate(async () => {
      const { renderEdit } = await import('/renderer.mjs');
      const { probe } = await import('/media.mjs?v=15');
      const { CanvasSource } = await import('/mediabunny.mjs?v=6');
      const blobs = new Map(), clips = []; let encoded = 0;
      const add = CanvasSource.prototype.add;
      CanvasSource.prototype.add = function(...args) { encoded++; return add.apply(this, args); };
      for (const name of ['finish0.mp4', 'finish1.mp4']) { const blob = await (await fetch('/test-results/quality/' + name)).blob(); blobs.set(name, blob); clips.push({ id: name, name, ...await probe(blob) }); }
      try {
        await renderEdit({ clips, segments: clips.map(c => ({ id: c.id, start: 0, end: 1 })),
          plan: { continuity: true, joins: [{ a: clips[0].id, b: clips[1].id, requiresBridge: true }] }, getBlob: c => blobs.get(c.id), signal: new AbortController().signal });
        return { returned: true, encoded };
      } catch (error) { return { message: error.message, encoded }; }
    });
    assert.match(result.message, /could not be smoothed reliably/); assert.equal(result.encoded, 0);
  });
  await run('a required framing correction cannot silently become an unmatched cut', async page => {
    const result = await page.evaluate(async () => {
      const { renderEdit } = await import('/renderer.mjs');
      const { probe } = await import('/media.mjs?v=15');
      const { CanvasSource } = await import('/mediabunny.mjs?v=6');
      const blobs = new Map(), clips = []; let encoded = 0;
      const add = CanvasSource.prototype.add;
      CanvasSource.prototype.add = function(...args) { encoded++; return add.apply(this, args); };
      for (const name of ['finish0.mp4', 'rate24.mp4']) { const blob = await (await fetch('/test-results/quality/' + name)).blob(); blobs.set(name, blob); clips.push({ id: name, name, ...await probe(blob) }); }
      try {
        await renderEdit({ clips, segments: clips.map(c => ({ id: c.id, start: 0, end: 1 })),
          plan: { continuity: true, joins: [{ a: clips[0].id, b: clips[1].id, requiresFinishing: true }] }, getBlob: c => blobs.get(c.id), signal: new AbortController().signal });
        return { returned: true, encoded };
      } catch (error) { return { message: error.message, encoded }; }
    });
    assert.match(result.message, /framing or color match could not be finished reliably/); assert.equal(result.encoded, 0);
  });
  await run('1080p60 retains measured detail, all native frames and audible sound', async page => {
    const result = await render(page, ['detail60.mp4']);
    assert.deepEqual([result.width, result.height, result.frameRate], [1920, 1080, 60]);
    assert.equal(result.copiedPicture, false); assert.equal(frames(result.path).length, 30);
    const source = picture(resolve(directory, 'detail60.mp4')), output = picture(result.path);
    const old = picture(resolve(directory, 'detail60.mp4'), 0, 'scale=1280:720,scale=1920:1080');
    const error = rgb => { let e = 0; for (let y = 50; y < 750; y += 11) for (let x = 40; x < 1880; x++) { const i = (y * 1920 + x) * 3; e += (rgb[i] - source[i]) ** 2; } return e; };
    assert(error(output) < error(old) * .1, `Detail error: ${error(output)} versus resized baseline ${error(old)}`);
    const audio = ffmpeg(['-i', result.path, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-']);
    assert(audio.length > 15000); assert(new Float32Array(audio.buffer, audio.byteOffset, audio.length / 4).some(v => Math.abs(v) > .03));
    console.log(`1080p60 detail error ${(error(output) / error(old) * 100).toFixed(2)}% of 720p resize baseline; 30/30 frames.`);
  });
  await run('mixed 24 30 60 and variable frame-rate source times survive encoding', async page => {
    const names = ['rate24.mp4', 'rate30.mp4', 'rate60.mp4', 'vfr.mp4'], result = await render(page, names);
    assert(result.mixedCadence); assert.equal(result.frameRate, 60);
    const actual = frames(result.path).map(f => Number(f.pts_time));
    assert.equal(actual.length, result.times.length);
    actual.forEach((time, i) => assert(Math.abs(time - result.times[i]) <= .0011, `${i}: ${time} versus ${result.times[i]}`));
    let offset = 0;
    const expected = names.flatMap(name => { const f = frames(resolve(directory, name)); const out = f.map(item => offset + Number(item.pts_time)); offset += 1; return out; });
    assert.equal(actual.length, expected.length);
    actual.forEach((time, i) => assert(Math.abs(time - expected[i]) < .0011));
    assert(Math.abs(result.duration - 4) < .03);
    console.log(`Native mixed cadence: ${actual.length}/${expected.length} frames, maximum timestamp difference ≤1.1ms.`);
  });
  await run('compressed pictures are copied byte-for-byte and unsafe cuts re-encode', async page => {
    const result = await render(page, ['copy0.webm', 'copy1.webm']);
    assert.equal(result.copiedPicture, true, JSON.stringify(result));
    // Use the same frozen WebM bytes as the browser, not a fixture file that
    // may be rewritten by workspace synchronization during an async test.
    const hashes = path => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json', fixtures.has(basename(path)) ? 'pipe:0' : path], { encoding: 'utf8', input: fixtures.get(basename(path)) })).packets.map(p => p.data_hash);
    assert.deepEqual(hashes(result.path), ['copy0.webm', 'copy1.webm'].flatMap(name => hashes(resolve(directory, name))));
    assert.equal(frames(result.path).length, 60);
    const trimmed = await render(page, ['copy0.webm'], { segments: [{ id: 'copy0.webm', start: .12, end: .85 }] });
    assert.equal(trimmed.copiedPicture, false); assert(Math.abs(trimmed.duration - .73) < .03);
  });
  await run('framing and exposure correction reduce a decoded seam without changing sound', async page => {
    const clean = await render(page, ['finish0.mp4', 'finish1.mp4'], { finish: true });
    const plain = await render(page, ['finish0.mp4', 'finish1.mp4']);
    assert.equal(clean.finishedJoins.length, 1, JSON.stringify({ finished: clean.finishedJoins, checked: clean.qualityChecks }));
    assert(clean.finishedJoins[0].aligned && clean.finishedJoins[0].colorMatched);
    const error = (a, b) => { let sum = 0; for (let y = 15; y < 345; y++) for (let x = 15; x < 625; x++) sum += Math.abs(a[(y * 640 + x) * 3] - b[(y * 640 + x) * 3]); return sum; };
    const before = error(picture(plain.path, 29), picture(plain.path, 30)), after = error(picture(clean.path, 29), picture(clean.path, 30));
    assert(after < before * .3, `Join error ${before} → ${after}`);
    assert.equal(frames(clean.path).length, 60);
    const audio = path => ffmpeg(['-i', path, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-']);
    assert.deepEqual(audio(clean.path), audio(plain.path));
    console.log(`Decoded framing/color seam error reduced ${(100 - after / before * 100).toFixed(1)}%; audio identical.`);
  });
  for (const transfer of ['pq', 'hlg']) await run(`${transfer} real 10-bit source maps to graded SDR with GPU CPU agreement`, async page => {
    const result = await render(page, [`${transfer}.webm`]);
    assert.equal(result.hdrConverted, 1); assert.equal(result.copiedPicture, false);
    const decoded = picture(result.path), levels = nits.map((_, i) => decoded[(72 * 256 + i * 32 + 16) * 3]);
    const expected = nits.map(nit => { const y = Math.min(nit, transfer === 'hlg' ? 1000 : 10000) / 203; const mapped = y <= .75 ? y : .75 + .25 * (y - .75) / (y - .5); return Math.round(255 * srgb(mapped)); });
    levels.forEach((v, i) => assert(Math.abs(v - expected[i]) < 6, `${transfer} ${nits[i]} nit: ${v} expected ${expected[i]}`));
    const agreement = await page.evaluate(async transfer => {
      const { Input, BlobSource, ALL_FORMATS, VideoSampleSink } = await import('/mediabunny.mjs?v=6');
      const { createPainter } = await import('/color-gpu.mjs?v=15'); const { paintSample } = await import('/color.mjs?v=15');
      const input = new Input({ source: new BlobSource(await (await fetch(`/test-results/quality/${transfer}.webm`)).blob()), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack(), sample = await new VideoSampleSink(track).getSample(.01), color = await track.getColorSpace();
      const a = document.createElement('canvas'), b = document.createElement('canvas'); a.width = b.width = 256; a.height = b.height = 144;
      const painter = createPainter(a); await painter.paint(sample, undefined, color); await paintSample(sample, b, undefined, color);
      const aa = a.getContext('2d').getImageData(0, 0, 256, 144).data, bb = b.getContext('2d').getImageData(0, 0, 256, 144).data;
      let maximum = 0; for (let i = 0; i < aa.length; i++) maximum = Math.max(maximum, Math.abs(aa[i] - bb[i]));
      const accelerated = painter.accelerated; painter.dispose(); sample.close(); input.dispose(); return { maximum, accelerated };
    }, transfer);
    assert(agreement.accelerated, 'WebGL path must actually execute'); assert(agreement.maximum <= 2, JSON.stringify(agreement));
    const metadata = probe(result.path, 'stream=color_transfer,color_primaries,color_space').streams[0];
    assert(!['smpte2084', 'arib-std-b67'].includes(metadata.color_transfer));
    console.log(`${transfer.toUpperCase()} output levels ${levels.join(', ')}; GPU/CPU max difference ${agreement.maximum}/255.`);
  });
  await run('browser capability fallback renders 720p at the supported cadence', async page => {
    await page.evaluate(() => {
      const original = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = async config => config.width > 1280 || config.height > 1280 || config.framerate > 30
        ? { supported: false, config } : original(config);
    });
    const result = await render(page, ['detail60.mp4']);
    assert.deepEqual([result.width, result.height, result.frameRate], [1280, 720, 30]);
    assert(result.reduced); assert.equal(frames(result.path).length, 15);
    assert(Math.abs(result.duration - .5) < .03);
  });
  await run('copy failure falls back to a complete newly encoded movie', async page => {
    await page.evaluate(async () => {
      const { EncodedVideoPacketSource } = await import('/mediabunny.mjs?v=6');
      EncodedVideoPacketSource.prototype.add = async () => { throw new Error('Injected unsupported compressed stream'); };
    });
    const result = await render(page, ['copy0.webm', 'copy1.webm']);
    assert.equal(result.copiedPicture, false); assert.equal(frames(result.path).length, 60);
    assert(Math.abs(result.duration - 2) < .03);
  });
  await run('cancelling compressed copying never starts a fallback or returns a movie', async page => {
    const result = await page.evaluate(async () => {
      const { renderEdit } = await import('/renderer.mjs');
      const { EncodedVideoPacketSource } = await import('/mediabunny.mjs?v=6');
      const controller = new AbortController(), blob = await (await fetch('/test-results/quality/copy0.webm')).blob();
      const original = EncodedVideoPacketSource.prototype.add, encode = VideoEncoder.prototype.encode;
      let copied = 0, encoded = 0;
      VideoEncoder.prototype.encode = function(...args) { encoded++; return encode.apply(this, args); };
      EncodedVideoPacketSource.prototype.add = async function(...args) { const result = await original.apply(this, args); if (++copied === 3) controller.abort(); return result; };
      const clip = { id: 'copy', name: 'copy', duration: 1, width: 192, height: 108 };
      try { await renderEdit({ clips: [clip], segments: [{ id: 'copy', start: 0, end: 1 }], getBlob: () => blob, signal: controller.signal }); return { returned: true }; }
      catch (error) { return { name: error.name, copied, encoded }; }
    });
    assert.equal(result.name, 'AbortError'); assert.equal(result.encoded, 0); assert.equal(result.copied, 3);
  });
  await run('HDR color, crop, rotation and flip agree across CPU GPU and cancellation', async page => {
    const result = await page.evaluate(async () => {
      const { VideoSample } = await import('/mediabunny.mjs?v=6');
      const { paintSample } = await import('/color.mjs?v=15');
      const { createPainter } = await import('/color-gpu.mjs?v=15');
      const width = 64, height = 32, pixels = width * height, raw = new Uint16Array(pixels * 3);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x; raw[i] = 100 + x * 7 + y * 4; raw[pixels + i] = 450 + x; raw[pixels * 2 + i] = 450 + y * 3;
      }
      const color = { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false };
      const sample = new VideoSample(raw, { format: 'I444P10', codedWidth: width, codedHeight: height, timestamp: 0, rotation: 90, flip: true,
        visibleRect: { left: 8, top: 4, width: 48, height: 24 }, colorSpace: color });
      const a = document.createElement('canvas'), b = document.createElement('canvas'); a.width = b.width = 48; a.height = b.height = 96;
      const painter = createPainter(a); await painter.paint(sample, undefined, color); await paintSample(sample, b, undefined, color);
      const aa = a.getContext('2d').getImageData(0, 0, 48, 96).data, bb = b.getContext('2d').getImageData(0, 0, 48, 96).data;
      let difference = 0; for (let i = 0; i < aa.length; i++) difference = Math.max(difference, Math.abs(aa[i] - bb[i]));
      const accelerated = painter.accelerated; painter.dispose();
      // Force the public fallback path, then abort while CPU rows are yielding.
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'webgl2' ? null : getContext.call(this, type, ...args); };
      const c = document.createElement('canvas'); c.width = 128; c.height = 256; const context = c.getContext('2d');
      const put = context.putImageData.bind(context); let published = 0;
      context.putImageData = (...args) => { published++; return put(...args); };
      const cpu = createPainter(c), controller = new AbortController();
      setTimeout(() => controller.abort(), 2);
      let cancelled = false;
      try { await cpu.paint(sample, controller.signal, color); } catch (error) { cancelled = error.name === 'AbortError'; }
      cpu.dispose(); sample.close();
      return { difference, accelerated, cancelled, published, varied: aa[500] !== aa[1000] };
    });
    assert(result.accelerated && result.varied); assert(result.difference <= 2, JSON.stringify(result));
    assert(result.cancelled); assert.equal(result.published, 0);
  });
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
process.exitCode = failures ? 1 : 0;
