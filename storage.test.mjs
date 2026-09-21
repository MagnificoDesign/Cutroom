import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { openVault, read, CHUNK_SIZE, deriveKey, seal } from './vault.mjs';

const password = 'harmless regression password';
const info = { duration: 2, width: 160, height: 90 };
const video = (size = 20, name = 'synthetic.mp4') => new File([new Uint8Array(size).fill(71)], name, { type: 'video/mp4' });
async function fresh(t) {
  const vault = await openVault(crypto.randomUUID());
  t.after(() => vault.db.close());
  await vault.unlock(password);
  return vault;
}
function counts(vault) {
  return new Promise((resolve, reject) => {
    const tx = vault.db.transaction(['clips', 'chunks']);
    const result = {};
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error);
    for (const name of ['clips', 'chunks']) tx.objectStore(name).count().onsuccess = event => { result[name] = event.target.result; };
  });
}
function write(vault, store, key, value) {
  return new Promise((resolve, reject) => {
    const tx = vault.db.transaction(store, 'readwrite');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.objectStore(store).put(value, key);
  });
}

test('12 MB import commits encrypted binary, restores and decrypts after relock', async t => {
  const vault = await fresh(t);
  const file = video(CHUNK_SIZE * 3 + 17);
  const progress = [];
  const clip = await vault.importFile(file, info, { onProgress: saved => progress.push(saved) });
  assert.deepEqual(progress, [CHUNK_SIZE, CHUNK_SIZE * 2, CHUNK_SIZE * 3, file.size]);
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 4 });
  const encrypted = await read(vault.db, 'chunks', `${clip.id}:0`);
  assert(encrypted.data instanceof ArrayBuffer);
  assert(encrypted.iv instanceof Uint8Array);
  assert.equal(encrypted.data.byteLength, CHUNK_SIZE + 16);
  const meta = await read(vault.db, 'clips', clip.id);
  assert(meta.data instanceof ArrayBuffer);
  assert.equal(meta.name, undefined);
  vault.lock();
  assert.equal(vault.key, null);
  await assert.rejects(vault.blob(clip), { name: 'AbortError' });
  const restored = await vault.unlock(password);
  assert.deepEqual(restored, [clip]);
  assert.deepEqual(await (await vault.blob(clip)).arrayBuffer(), await file.arrayBuffer());
});

test('legacy header, metadata and media survive a binary-format update', async t => {
  const vault = await openVault(crypto.randomUUID());
  t.after(() => vault.db.close());
  const salt = new Uint8Array(16);
  const key = await deriveKey(password, salt);
  const legacy = encrypted => ({ iv: Buffer.from(encrypted.iv).toString('base64'), data: Buffer.from(encrypted.data).toString('base64') });
  const text = new TextEncoder();
  const meta = { name: 'old.mp4', size: 3, type: 'video/mp4', count: 1, ...info };
  await write(vault, 'meta', 'header', { salt: Buffer.from(salt).toString('base64'), sent: legacy(await seal(key, text.encode('ok'), 'sentinel')) });
  await write(vault, 'chunks', 'old:0', legacy(await seal(key, new Uint8Array([1, 2, 3]), 'chunk/old/0')));
  await write(vault, 'clips', 'old', legacy(await seal(key, text.encode(JSON.stringify(meta)), 'meta/old')));
  const [clip] = await vault.unlock(password);
  assert.equal(clip.name, 'old.mp4');
  assert.deepEqual(new Uint8Array(await (await vault.blob(clip)).arrayBuffer()), new Uint8Array([1, 2, 3]));
  await vault.importFile(video(), info);
  assert.equal((await vault.unlock(password)).length, 2);
});

test('wrong password never installs a key', async t => {
  const vault = await fresh(t);
  vault.lock();
  await assert.rejects(vault.unlock('incorrect password'), /doesn't unlock/);
  assert.equal(vault.key, null);
});

test('locking after the first chunk cancels and removes the partial copy', async t => {
  const vault = await fresh(t);
  const keep = await vault.importFile(video(), info);
  const controller = new AbortController();
  await assert.rejects(vault.importFile(video(CHUNK_SIZE + 1), info, {
    signal: controller.signal,
    onProgress: () => { vault.lock(); controller.abort(); }
  }), { name: 'AbortError' });
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 1 });
  assert.deepEqual(await vault.unlock(password), [keep]);
});

test('aborted unlock cannot restore the vault key after its asynchronous work', async t => {
  const vault = await fresh(t);
  vault.lock();
  const controller = new AbortController();
  const pending = vault.unlock(password, controller.signal);
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(vault.key, null);
});

test('an IndexedDB transaction abort is rejected and cleaned, then the next import works', async t => {
  const vault = await fresh(t);
  const keep = await vault.importFile(video(), info);
  const put = IDBObjectStore.prototype.put;
  let writes = 0;
  IDBObjectStore.prototype.put = function (...args) {
    const request = put.apply(this, args);
    if (this.name === 'chunks' && ++writes === 2) request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try { await assert.rejects(vault.importFile(video(CHUNK_SIZE + 1), info)); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 1 });
  const next = await vault.importFile(video(25, 'next.mp4'), info);
  assert.deepEqual(await vault.unlock(password), [keep, next]);
});

test('quota failure after a committed chunk preserves other videos and cleans the failed copy', async t => {
  const vault = await fresh(t);
  await vault.importFile(video(), info);
  const put = IDBObjectStore.prototype.put;
  let writes = 0;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'chunks' && ++writes === 2) throw new DOMException('Synthetic full disk', 'QuotaExceededError');
    return put.apply(this, args);
  };
  try { await assert.rejects(vault.importFile(video(CHUNK_SIZE + 1), info), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 1 });
});

test('reload recovery removes orphaned chunks but keeps complete videos', async t => {
  const vault = await fresh(t);
  const keep = await vault.importFile(video(), info);
  await write(vault, 'chunks', 'interrupted:0', await seal(vault.key, new Uint8Array(20), 'chunk/interrupted/0'));
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 2 });
  vault.lock();
  assert.deepEqual(await vault.unlock(password), [keep]);
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 1 });
});

test('recovery in a second connection waits for an active import', async t => {
  const vault = await fresh(t);
  const second = await openVault(vault.db.name);
  t.after(() => second.db.close());
  let started;
  const atFirstChunk = new Promise(resolve => { started = resolve; });
  const pending = vault.importFile(video(CHUNK_SIZE * 3), info, { onProgress: started });
  await atFirstChunk;
  const restored = second.unlock(password);
  const clip = await pending;
  assert.deepEqual(await restored, [clip]);
  assert.equal((await second.blob(clip)).size, CHUNK_SIZE * 3);
});

test('deletion removes only the selected clip and all its chunks', async t => {
  const vault = await fresh(t);
  const remove = await vault.importFile(video(CHUNK_SIZE + 1), info);
  const keep = await vault.importFile(video(), info);
  await vault.purge(remove.id);
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 1 });
  assert.deepEqual(await vault.unlock(password), [keep]);
});

test('a new video deletes every clip and chunk while retaining the password and an empty encrypted selection', async t => {
  const vault = await fresh(t);
  const old = await vault.importFile(video(CHUNK_SIZE + 1), info);
  await vault.importFile(video(), info);
  const header = await read(vault.db, 'meta', 'header');
  assert.deepEqual(await vault.selection([old.id]), [old.id]);
  await vault.select([]);
  const record = await read(vault.db, 'meta', 'edit-selection');
  assert(record.data instanceof ArrayBuffer);
  assert.equal(record.ids, undefined);
  assert.deepEqual(await counts(vault), { clips: 0, chunks: 0 });
  assert.deepEqual(await read(vault.db, 'meta', 'header'), header);
  vault.lock();
  assert.deepEqual(await vault.unlock(password), []);
  assert.deepEqual(await vault.selection([old.id]), []);
  const next = await vault.importFile(video(25, 'new.mp4'), info, { selectedIds: [] });
  assert.deepEqual(await vault.selection([]), [next.id]);
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 1 });
  vault.lock();
  assert.deepEqual(await vault.unlock(password), [next]);
});

test('upgrade deletes archived imports before reading their metadata and preserves the active edit', async t => {
  const vault = await fresh(t);
  const archive = await vault.importFile(video(CHUNK_SIZE + 1, 'archived.mp4'), info);
  const current = await vault.importFile(video(37, 'current.mp4'), info);
  const selected = await seal(vault.key, new TextEncoder().encode(JSON.stringify([current.id])), 'edit-selection');
  await write(vault, 'meta', 'edit-selection', selected); // A v0.7–v0.9 archive.
  await write(vault, 'clips', archive.id, { brokenOldMetadata: true });
  vault.lock();
  await assert.rejects(vault.unlock('incorrect password'), /doesn't unlock/);
  assert.deepEqual(await counts(vault), { clips: 2, chunks: 3 });
  assert.deepEqual(await vault.unlock(password), [current]);
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 1 });
  assert.deepEqual(await vault.selection([]), [current.id]);
  assert.equal((await vault.blob(current)).size, 37);
});

test('upgrade with an empty active selection removes the entire old archive', async t => {
  const vault = await fresh(t);
  await vault.importFile(video(CHUNK_SIZE + 1), info);
  await write(vault, 'meta', 'edit-selection', await seal(vault.key, new TextEncoder().encode('[]'), 'edit-selection'));
  vault.lock();
  assert.deepEqual(await vault.unlock(password), []);
  assert.deepEqual(await counts(vault), { clips: 0, chunks: 0 });
});

test('Undo only keeps the latest removed copy and restores order, while lock discards that copy', async t => {
  const vault = await fresh(t);
  const a = await vault.importFile(video(21, 'a.mp4'), info);
  const b = await vault.importFile(video(CHUNK_SIZE + 1, 'b.mp4'), info);
  const c = await vault.importFile(video(23, 'c.mp4'), info);
  await vault.select([a.id, c.id], undefined, { undoIds: [a.id, b.id, c.id] });
  assert.deepEqual(await vault.selection([]), [a.id, c.id]);
  assert.deepEqual(await counts(vault), { clips: 3, chunks: 4 });
  await vault.select([a.id, b.id, c.id]); // Undo.
  assert.deepEqual(await vault.selection([]), [a.id, b.id, c.id]);
  await vault.select([a.id, c.id], undefined, { undoIds: [a.id, b.id, c.id] });
  await vault.select([a.id], undefined, { undoIds: [a.id, c.id] });
  assert.deepEqual(await counts(vault), { clips: 2, chunks: 2 }); // b is gone.
  vault.lock();
  await vault.discardUndo([c.id]);
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 1 });
  assert.deepEqual(await vault.unlock(password), [a]);
});

test('reload cleans a removed copy even when background cleanup did not run', async t => {
  const vault = await fresh(t);
  const a = await vault.importFile(video(), info);
  const b = await vault.importFile(video(CHUNK_SIZE + 1), info);
  await vault.select([a.id], undefined, { undoIds: [a.id, b.id] });
  vault.lock(); // Simulate a page being terminated before discardUndo runs.
  assert.deepEqual(await vault.unlock(password), [a]);
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 1 });
});

test('a failed or cancelled new-video reset rolls back deletion and selection together', async t => {
  const vault = await fresh(t);
  const clip = await vault.importFile(video(CHUNK_SIZE + 1), info, { selectedIds: [] });
  const original = IDBObjectStore.prototype.clear;
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    IDBObjectStore.prototype.clear = function (...args) {
      if (this.name === 'chunks' && !cancel) throw new DOMException('Synthetic storage failure', 'UnknownError');
      const request = original.apply(this, args);
      if (this.name === 'clips' && cancel) request.addEventListener('success', () => controller.abort());
      return request;
    };
    try { await assert.rejects(vault.select([], controller.signal), { name: cancel ? 'AbortError' : 'UnknownError' }); }
    finally { IDBObjectStore.prototype.clear = original; }
    assert.deepEqual(await vault.selection([]), [clip.id]);
    assert.deepEqual(await counts(vault), { clips: 1, chunks: 2 });
    assert.equal((await vault.blob(clip)).size, CHUNK_SIZE + 1);
  }
});

test('selection and import metadata commit atomically on a storage failure', async t => {
  const vault = await fresh(t);
  const old = await vault.importFile(video(), info, { selectedIds: [] });
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'meta' && args[1] === 'edit-selection') throw new DOMException('Synthetic full disk', 'QuotaExceededError');
    return original.apply(this, args);
  };
  try { await assert.rejects(vault.importFile(video(), info, { selectedIds: [old.id] }), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.deepEqual(await vault.selection([]), [old.id]);
  assert.deepEqual(await counts(vault), { clips: 1, chunks: 1 });
});
