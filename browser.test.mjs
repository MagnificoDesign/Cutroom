import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('./', import.meta.url));
const output = resolve(root, 'test-results');
await mkdir(output, { recursive: true });
// Synthetic picture and sound only. No personal media is used or uploaded.
const fixture = resolve(output, 'harmless.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', fixture]);
const video = await readFile(fixture);
const largeVideo = Buffer.concat([video, Buffer.alloc(12 * 1024 * 1024)]);
for (const [color, frequency] of [['red', 440], ['lime', 660], ['blue', 880]]) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:size=160x90:rate=30`, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=44100`, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', resolve(output, `${color}.mp4`)]);
}
// One eight-second event, split into overlapping 0–4, 2–6 and 4–8 clips.
// A visible binary frame number lets an independent decoder prove that the
// merged result contains each original frame once, without skipped/replayed time.
const master = resolve(output, 'overlap-master.mp4');
const raw = Buffer.alloc(240 * 160 * 90 * 3);
for (let frame = 0; frame < 240; frame++) for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) {
  const at = ((frame * 90 + y) * 160 + x) * 3;
  let color = [60 + (x * 13 ^ y * 7) % 70, 70 + (x * 3 ^ y * 17) % 55, 60 + (x * 5 ^ y * 11) % 65];
  const left = 8 + frame * .5, top = 25 + Math.sin(frame / 15) * 7;
  if (x >= left && x < left + 22 && y >= top && y < top + 19) color = [230, 215, 90];
  if (y >= 80 && y < 88 && x >= 8 && x < 152) color = Array(3).fill(frame & 1 << Math.floor((x - 8) / 16) ? 225 : 25);
  for (let c = 0; c < 3; c++) raw[at + c] = color[c];
}
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '160x90', '-framerate', '30', '-i', 'pipe:0', '-f', 'lavfi', '-i', 'aevalsrc=0.12*sin(2*PI*(220*t+15*t*t))+0.03*sin(2*PI*713*t):s=48000', '-t', '8', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', master], { input: raw });
// Keep the independently decoded reference immutable across asynchronous runs.
const masterSound = execFileSync('ffmpeg', ['-v', 'error', '-i', master, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-']);
for (const [name, offset, quality, filter] of [['overlap-a', 0, 19, 'null'], ['overlap-b', 2, 26, 'eq=brightness=0.015:contrast=1.025'], ['overlap-c', 4, 23, 'null']]) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(offset), '-i', master, '-t', '4', '-vf', filter, '-c:v', 'libx264', '-crf', String(quality), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', resolve(output, `${name}.mp4`)]);
}
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/harness') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Cutroom tests</title>'); return; }
  const target = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  if (!target.startsWith(root)) { response.writeHead(403); response.end(); return; }
  try {
    const body = await readFile(target);
    response.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.webmanifest': 'application/manifest+json' })[extname(target)] || 'application/octet-stream' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let failures = 0;
const password = 'harmless test password';
async function unlock(page) {
  await page.locator('#p').fill(password);
  await page.locator('#u').click();
  await page.locator('#add').waitFor();
}
async function choose(page, files) {
  const chosen = page.waitForEvent('filechooser');
  await page.locator('#add').click();
  const chooser = await chosen;
  await chooser.setFiles(files);
}
async function visibility(page, state) {
  await page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}
try {
  for (const name of (process.env.CUTROOM_TEST_BROWSERS || 'chromium,webkit').split(',')) {
    const engine = { chromium, webkit }[name];
    const launch = { headless: true };
    if (name === 'chromium' && process.env.CUTROOM_CHROMIUM_PATH) {
      launch.executablePath = process.env.CUTROOM_CHROMIUM_PATH;
      launch.args = ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
    }
    const browser = await engine.launch(launch);
    console.log(`${name} ${browser.version()}`);
    async function run(title, action) {
      if (process.env.CUTROOM_TEST_MATCH && !title.includes(process.env.CUTROOM_TEST_MATCH)) return;
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors = [], unexpectedRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (/^https?:/.test(request.url()) && (!request.url().startsWith(base + '/') || request.method() !== 'GET')) unexpectedRequests.push(request.url());
      });
      try {
        await action(page, context);
        assert.deepEqual(errors, []);
        assert.deepEqual(unexpectedRequests, []);
        console.log(`PASS ${name}: ${title}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${name}: ${title}\n${error.stack}`);
        await page.screenshot({ path: resolve(output, `${name}-${title.replace(/\W+/g, '-')}.png`) }).catch(() => {});
      } finally { await context.close(); }
    }

    await run('binary IndexedDB round trip, legacy unlock, and recovery', async page => {
      await page.goto(base + '/harness');
      const result = await page.evaluate(async password => {
        const { openVault, deriveKey, seal, read, CHUNK_SIZE } = await import('/vault.mjs');
        const vault = await openVault();
        const key = await deriveKey(password, new Uint8Array(16));
        const b64 = value => { let text = ''; for (const byte of new Uint8Array(value)) text += String.fromCharCode(byte); return btoa(text); };
        const sentinel = await seal(key, new TextEncoder().encode('ok'), 'sentinel');
        await new Promise((resolve, reject) => {
          const tx = vault.db.transaction(['meta', 'chunks'], 'readwrite');
          tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
          tx.objectStore('meta').put({ salt: b64(new Uint8Array(16)), sent: { iv: b64(sentinel.iv), data: b64(sentinel.data) } }, 'header');
          tx.objectStore('chunks').put(sentinel, 'interrupted:0');
        });
        await vault.unlock(password);
        const payload = Uint8Array.from({ length: CHUNK_SIZE * 3 + 173 }, (_, i) => (i * 13) % 256);
        const progress = [];
        const clip = await vault.importFile(new File([payload], 'synthetic.bin', { type: 'video/mp4' }), { duration: 1, width: 160, height: 90 }, { onProgress: saved => progress.push(saved) });
        const record = await read(vault.db, 'chunks', `${clip.id}:0`);
        const metadata = await read(vault.db, 'clips', clip.id);
        const hash = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data))).join(',');
        const roundTrip = await (await vault.blob(clip)).arrayBuffer();
        vault.lock();
        const restored = await vault.unlock(password);
        return {
          binary: record.data instanceof ArrayBuffer && record.iv instanceof Uint8Array,
          metadataEncrypted: metadata.data instanceof ArrayBuffer && !('name' in metadata),
          equal: await hash(payload) === await hash(roundTrip),
          orphanGone: (await read(vault.db, 'chunks', 'interrupted:0')) === undefined,
          count: restored.length, name: restored[0].name, progress
        };
      }, password);
      assert.equal(result.binary, true);
      assert.equal(result.metadataEncrypted, true);
      assert.equal(result.equal, true);
      assert.equal(result.orphanGone, true);
      assert.equal(result.count, 1);
      assert.equal(result.name, 'synthetic.bin');
      assert.equal(result.progress.length, 4);
    });

    await run('abort and quota failures remove partial chunks', async page => {
      await page.goto(base + '/harness');
      const result = await page.evaluate(async password => {
        const { openVault, CHUNK_SIZE } = await import('/vault.mjs');
        const vault = await openVault();
        await vault.unlock(password);
        const info = { duration: 1, width: 160, height: 90 };
        const good = await vault.importFile(new File(['saved'], 'keep.mp4'), info);
        const counts = () => new Promise(resolve => {
          const tx = vault.db.transaction(['clips', 'chunks']);
          const counts = {};
          for (const name of ['clips', 'chunks']) tx.objectStore(name).count().onsuccess = event => { counts[name] = event.target.result; };
          tx.oncomplete = () => resolve(counts);
        });
        const controller = new AbortController();
        let aborted;
        try {
          await vault.importFile(new File([new Uint8Array(CHUNK_SIZE + 1)], 'cancel.mp4'), info, {
            signal: controller.signal,
            onProgress: () => { vault.lock(); controller.abort(); }
          });
        } catch (error) { aborted = error.name; }
        await vault.unlock(password);
        const original = IDBObjectStore.prototype.put;
        let writes = 0, quota;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === 'chunks' && ++writes === 2) throw new DOMException('Synthetic full disk', 'QuotaExceededError');
          return original.apply(this, args);
        };
        try { await vault.importFile(new File([new Uint8Array(CHUNK_SIZE + 1)], 'fail.mp4'), info); }
        catch (error) { quota = error.name; }
        finally { IDBObjectStore.prototype.put = original; }
        return { aborted, quota, counts: await counts(), keep: (await vault.blob(good)).size };
      }, password);
      assert.deepEqual(result, { aborted: 'AbortError', quota: 'QuotaExceededError', counts: { clips: 1, chunks: 1 }, keep: 5 });
    });

    await run('picker session, three videos, offline reload, render, play, save and lock', async (page, context) => {
      await page.goto(base);
      await unlock(page);
      const choice = page.waitForEvent('filechooser');
      await page.locator('#add').click();
      const chooser = await choice;
      await visibility(page, 'hidden');
      assert.equal(await page.locator('#p').count(), 0);
      await chooser.setFiles([
        { name: 'one.mp4', mimeType: 'video/mp4', buffer: video },
        { name: 'two.mp4', mimeType: 'video/mp4', buffer: video },
        { name: 'large.mp4', mimeType: 'video/mp4', buffer: largeVideo }
      ]);
      await visibility(page, 'visible');
      await page.getByText('3 videos ready.', { exact: true }).waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.clip').count(), 3);
      assert.match(await page.locator('.clip').last().innerText(), /1\.0 sec · 12\./);
      await page.screenshot({ path: resolve(output, `${name}-imported.png`) });
      await page.evaluate(() => navigator.serviceWorker.ready);
      await context.setOffline(true);
      await page.reload();
      await unlock(page);
      assert.equal(await page.locator('.clip').count(), 3);
      assert.deepEqual(await page.locator('.clip b').allTextContents(), ['one.mp4', 'two.mp4', 'large.mp4']);
      await page.locator('#create').click();
      await page.getByText('Ready to watch.', { exact: true }).waitFor({ timeout: 90000 });
      const resultUrl = await page.locator('#finished').getAttribute('src');
      await page.locator('#finished').evaluate(async video => { await video.play(); });
      await page.waitForFunction(() => document.querySelector('#finished').currentTime > .15);
      const download = page.waitForEvent('download');
      await page.locator('#save').click();
      const saved = await download;
      const exported = resolve(output, `${name}-ui-${saved.suggestedFilename()}`);
      await saved.saveAs(exported);
      const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', exported], { encoding: 'utf8' })).streams;
      assert.ok(streams.some(stream => stream.codec_type === 'video'));
      assert.ok(streams.some(stream => stream.codec_type === 'audio'));
      await page.screenshot({ path: resolve(output, `${name}-result.png`) });
      await page.locator('#lock').click();
      await page.locator('#p').waitFor();
      assert.equal(await page.locator('.clip').count(), 0);
      assert.doesNotMatch(await page.locator('#app').innerText(), /one\.mp4|large\.mp4/);
      assert.equal(await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, resultUrl), true);
    });

    await run('middle failure continues and retry keeps successful clips', async page => {
      await page.goto(base);
      await unlock(page);
      await choose(page, [
        { name: 'first.mp4', mimeType: 'video/mp4', buffer: video },
        { name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not a video') },
        { name: 'third.mp4', mimeType: 'video/mp4', buffer: video }
      ]);
      await page.getByText('Added 2 of 3 videos. Your successful imports are saved.', { exact: true }).waitFor();
      assert.equal(await page.locator('.clip').count(), 2);
      await page.locator('#retry').click();
      await page.getByText('Added 0 of 1 videos. Your successful imports are saved.', { exact: true }).waitFor();
      assert.equal(await page.locator('.clip').count(), 2);
    });

    await run('cancelled picker restores background locking', async page => {
      await page.goto(base);
      await unlock(page);
      const choice = page.waitForEvent('filechooser');
      await page.locator('#add').click();
      await choice;
      await page.locator('#file').dispatchEvent('cancel');
      await visibility(page, 'hidden');
      await page.locator('#p').waitFor();
      await visibility(page, 'visible');
      await unlock(page);
    });

    await run('lock during encryption prevents stale UI and metadata', async page => {
      await page.goto(base);
      await unlock(page);
      await page.evaluate(() => {
        const original = crypto.subtle.encrypt.bind(crypto.subtle);
        crypto.subtle.encrypt = async (...args) => {
          const encrypted = await original(...args);
          if (args[2].byteLength > 1000000) document.querySelector('#lock')?.click();
          return encrypted;
        };
      });
      await choose(page, [{ name: 'cancel-large.mp4', mimeType: 'video/mp4', buffer: largeVideo }]);
      await page.locator('#p').waitFor();
      await unlock(page); // Serializes behind the cancelled import's cleanup.
      assert.equal(await page.locator('.clip').count(), 0);
      const counts = await page.evaluate(async () => {
        const { openVault } = await import('/vault.mjs');
        const vault = await openVault();
        return new Promise(resolve => {
          const tx = vault.db.transaction(['clips', 'chunks']);
          const counts = {};
          for (const name of ['clips', 'chunks']) tx.objectStore(name).count().onsuccess = event => { counts[name] = event.target.result; };
          tx.oncomplete = () => resolve(counts);
        });
      });
      assert.deepEqual(counts, { clips: 0, chunks: 0 });
    });

    await run('trimmed reordered export preserves picture, final frame, timing and source sound', async page => {
      await page.goto(base + '/harness');
      const result = await page.evaluate(async () => {
        const { renderEdit } = await import('/renderer.mjs');
        const blobs = new Map(await Promise.all(['red', 'lime', 'blue'].map(async id => [id, await (await fetch(`/test-results/${id}.mp4`)).blob()])));
        const clips = [...blobs.keys()].map(id => ({ id, name: id, duration: 2, width: 160, height: 90 }));
        const segments = [{ id: 'blue', start: .25, end: 1.5 }, { id: 'lime', start: .5, end: 2 }, { id: 'red', start: .6, end: 1.7 }];
        const result = await renderEdit({ clips, segments, getBlob: clip => blobs.get(clip.id), signal: new AbortController().signal });
        return { extension: result.extension, videoCodec: result.videoCodec, audioCodec: result.audioCodec, duration: result.duration, bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())) };
      });
      const path = resolve(output, `${name}-trimmed.${result.extension}`);
      await writeFile(path, new Uint8Array(result.bytes));
      const expectedDuration = 3.85;
      assert(Math.abs(result.duration - expectedDuration) < .06);
      const frames = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=pts_time', '-of', 'json', path], { encoding: 'utf8' })).frames;
      const times = frames.map(frame => Number(frame.pts_time));
      assert.equal(times.length, 116, 'Every planned frame, including each final frame, is encoded');
      assert(times.every((time, index) => !index || time > times[index - 1]), 'Every output frame must advance time, including around cuts');
      // Decode the whole export using an independent decoder, not only its metadata.
      execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-fps_mode', 'passthrough', '-f', 'null', '-']);
      for (const [time, channel] of [[.4, 2], [2, 1], [3.3, 0], [expectedDuration - .04, 0]]) {
        const rgb = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', path, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
        assert.equal(rgb.length, 3);
        assert(rgb[channel] > 200, `Wrong picture at ${time}: ${[...rgb]}`);
        assert([...rgb].every((value, index) => index === channel || value < 45));
      }
      for (const [time, frequency] of [[.4, 880], [2, 660], [3.3, 440]]) {
        const pcm = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', path, '-t', '0.2', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
        let crossings = 0, peak = 0, prior = 0;
        for (let offset = 0; offset < pcm.length; offset += 4) {
          const value = pcm.readFloatLE(offset);
          if (value > 0 && prior <= 0) crossings++;
          peak = Math.max(peak, Math.abs(value)); prior = value;
        }
        assert(peak > .03, `Missing source sound at ${time}`);
        assert(Math.abs(crossings * 5 - frequency) <= 5, `Wrong source sound or changed pitch at ${time}: ${crossings * 5} Hz`);
      }
      console.log(`Verified export: ${result.extension}, ${result.videoCodec}/${result.audioCodec}, ${result.duration.toFixed(3)} sec`);
    });

    await run('overlap chain renders every unique frame and source sound exactly once', async page => {
      await page.goto(base + '/harness');
      const result = await page.evaluate(async () => {
        const { sample, probe } = await import('/media.mjs');
        const { analyzeJoins } = await import('/analyze.mjs');
        const { renderEdit } = await import('/renderer.mjs');
        const blobs = new Map(), clips = [];
        for (const id of ['overlap-c', 'overlap-a', 'overlap-b']) {
          const blob = await (await fetch(`/test-results/${id}.mp4`)).blob();
          blobs.set(id, blob);
          clips.push({ id, name: id, ...await probe(blob), samples: await sample(blob) });
        }
        const plan = await analyzeJoins({ clips, getBlob: clip => blobs.get(clip.id), signal: new AbortController().signal });
        if (plan.joins.filter(join => join.kind === 'overlap').length !== 2) {
          const { coarseCandidates, verifySequence, photoError, verifySound, refineAlignment } = await import('/overlap.mjs');
          const { inspectMedia } = await import('/media.mjs');
          const times = Array.from({ length: 120 }, (_, i) => i / 30);
          const aa = await inspectMedia(blobs.get('overlap-a'), times, undefined, { audioRange: [0, 4] });
          const bb = await inspectMedia(blobs.get('overlap-b'), times, undefined, { audioRange: [0, 4] });
          const a = clips.find(clip => clip.id === 'overlap-a'), b = clips.find(clip => clip.id === 'overlap-b');
          const candidates = coarseCandidates(a, b);
          return { plan, diagnostics: { durations: clips.map(clip => clip.duration), candidates, evidence: verifySequence(aa.frames, bb.frames, 2, 4, 4), sound: verifySound(aa.audio, bb.audio, 2, 2), refined: candidates.map(candidate => refineAlignment(aa.frames, bb.frames, candidate, 4, 4)), first: [aa.frames[60].timestamp, bb.frames[0].timestamp], photo: photoError(aa.frames[60], bb.frames[0], true), coarseTimes: a.samples.map(frame => frame.t) } };
        }
        const result = await renderEdit({ clips, segments: plan.segments, getBlob: clip => blobs.get(clip.id), signal: new AbortController().signal });
        return { plan, extension: result.extension, bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())) };
      });
      assert.equal(result.plan.joins.filter(join => join.kind === 'overlap').length, 2, JSON.stringify(result));
      assert.deepEqual(result.plan.segments.map(part => part.id), ['overlap-a', 'overlap-b', 'overlap-c']);
      assert(Math.abs(result.plan.segments.reduce((sum, part) => sum + part.end - part.start, 0) - 8) < .002);
      const path = resolve(output, `${name}-merged-overlap.${result.extension}`);
      await writeFile(path, new Uint8Array(result.bytes));
      const decoded = execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-an', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 20 * 1024 * 1024 });
      assert.equal(decoded.length / (160 * 90 * 3), 240);
      for (let index = 0; index < 240; index++) {
        let counter = 0;
        for (let bit = 0; bit < 9; bit++) {
          const at = ((index * 90 + 84) * 160 + 16 + bit * 16) * 3;
          if ((decoded[at] + decoded[at + 1] + decoded[at + 2]) / 3 > 128) counter |= 1 << bit;
        }
        assert.equal(counter, index, `Repeated or skipped source picture at output frame ${index}`);
      }
      const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-']);
      const reference = masterSound;
      for (let time = .2; time < 7.8; time += .2) {
        let best = -1;
        for (let lag = -24; lag <= 24; lag++) {
          let dot = 0, aa = 0, bb = 0;
          for (let i = 0; i < 800; i++) {
            const at = Math.round(time * 8000) + i;
            const a = reference.readFloatLE(at * 4), b = pcm.readFloatLE((at + lag) * 4);
            dot += a * b; aa += a * a; bb += b * b;
          }
          best = Math.max(best, dot / Math.sqrt(aa * bb));
        }
        assert(best > .94, `Repeated, missing or shifted source sound at ${time.toFixed(2)} sec: ${best}`);
      }
      console.log('Verified merged overlap: 12 input seconds → 8 unique seconds; all 240 frame numbers and the continuous source soundtrack checked.');
    });

    await run('cancel during encoding keeps clips and blocks stale results', async page => {
      await page.goto(base);
      await unlock(page);
      await choose(page, [{ name: 'cancel-render.mp4', mimeType: 'video/mp4', buffer: video }]);
      await page.getByText('1 video ready.', { exact: true }).waitFor();
      await page.evaluate(() => {
        const original = VideoEncoder.prototype.encode;
        let frames = 0;
        VideoEncoder.prototype.encode = function (...args) {
          const result = original.apply(this, args);
          if (++frames === 3) queueMicrotask(() => document.querySelector('#cancel')?.click());
          return result;
        };
      });
      await page.locator('#create').click();
      await page.getByText('Creation cancelled. Your videos are still ready.', { exact: true }).waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.clip').count(), 1);
      assert.equal(await page.locator('#finished').count(), 0);
      assert.equal(await page.locator('#p').count(), 0);
      // A fresh job must succeed after the encoder from the cancelled job closes.
      await page.locator('#create').click();
      await page.getByText('Ready to watch.', { exact: true }).waitFor({ timeout: 30000 });
      const url = await page.locator('#finished').getAttribute('src');
      await page.locator('#again').click();
      await page.getByText('Add your videos.', { exact: true }).waitFor();
      assert.equal(await page.locator('.clip').count(), 0);
      assert.equal(await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, url), true);
      assert.equal(await page.locator('#create').isDisabled(), true);
      assert.equal(await page.locator('#p').count(), 0);
      await page.screenshot({ path: resolve(output, `${name}-new-video.png`) });
      await page.reload();
      await unlock(page);
      assert.equal(await page.locator('.clip').count(), 0);
      await page.locator('#previous summary').click();
      await page.locator('#previous input').check();
      await page.locator('#reuse').click();
      await page.locator('.clip').waitFor();
      assert.equal(await page.locator('.clip b').innerText(), 'cancel-render.mp4');
    });

    await run('system share receives the correctly named rendered file', async page => {
      await page.goto(base);
      await unlock(page);
      await choose(page, [{ name: 'share.mp4', mimeType: 'video/mp4', buffer: video }]);
      await page.getByText('1 video ready.', { exact: true }).waitFor();
      await page.locator('#create').click();
      await page.getByText('Ready to watch.', { exact: true }).waitFor({ timeout: 30000 });
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: data => data.files[0] instanceof File });
        Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
          const file = data.files[0];
          window.sharedFile = { name: file.name, type: file.type, size: file.size, activation: navigator.userActivation.isActive };
        } });
      });
      await page.locator('#save').click();
      const shared = await page.evaluate(() => window.sharedFile);
      assert.match(shared.name, /^Cutroom-\d{4}-\d{2}-\d{2}\.(mp4|webm)$/);
      assert.equal(shared.type, shared.name.endsWith('.mp4') ? 'video/mp4' : 'video/webm');
      assert(shared.size > 1000);
      assert.equal(shared.activation, true);
      await page.getByRole('button', { name: 'Create New Video', exact: true }).click();
      await page.getByText('Add your videos.', { exact: true }).waitFor();
      assert.equal(await page.locator('.clip').count(), 0);
      await choose(page, [{ name: 'new-selection.mp4', mimeType: 'video/mp4', buffer: video }]);
      await page.getByText('1 video ready.', { exact: true }).waitFor();
      assert.deepEqual(await page.locator('.clip b').allTextContents(), ['new-selection.mp4']);
      await page.locator('#lock').click();
      await unlock(page);
      assert.deepEqual(await page.locator('.clip b').allTextContents(), ['new-selection.mp4']);
      // This verifies the app's invocation, not the native iOS Save Video sheet.
    });

    await run('lock during dense overlap inspection cannot restore a stale preview', async page => {
      await page.goto(base);
      await unlock(page);
      await choose(page, ['overlap-a', 'overlap-b'].map(id => resolve(output, `${id}.mp4`)));
      await page.getByText('2 videos ready.', { exact: true }).waitFor();
      await page.evaluate(() => {
        const original = VideoDecoder.prototype.decode;
        let count = 0;
        VideoDecoder.prototype.decode = function (...args) {
          const result = original.apply(this, args);
          if (++count === 5) queueMicrotask(() => document.querySelector('#lock')?.click());
          return result;
        };
      });
      await page.locator('#create').click();
      await page.locator('#p').waitFor({ timeout: 30000 });
      assert.equal(await page.locator('#finished').count(), 0);
      assert.doesNotMatch(await page.locator('#app').innerText(), /overlap-a|overlap-b/);
      await unlock(page);
      assert.equal(await page.locator('.clip').count(), 2);
      assert.equal(await page.locator('#finished').count(), 0);
    });
    await browser.close();
  }
} finally { await new Promise(resolve => server.close(resolve)); }
if (failures) process.exitCode = 1;
