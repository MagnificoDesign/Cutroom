export const DB_NAME = 'cutroom-independent-v1';
export const CHUNK_SIZE = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Read v0.1-v0.3 records without rewriting or resetting an existing vault.
export function bytes(value) {
  if (typeof value === 'string') {
    const text = atob(value);
    const result = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) result[i] = text.charCodeAt(i);
    return result;
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('The encrypted record could not be read.');
}

export async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bytes(salt), iterations: 350000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export async function seal(key, data, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, data
  );
  // IndexedDB structured-clones these buffers. Never stringify media bytes.
  return { version: 2, iv, data: ciphertext };
}

export async function unseal(key, record, context) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes(record.iv), additionalData: encoder.encode(context) },
    key, bytes(record.data)
  ));
}

export function check(signal) { signal?.throwIfAborted(); }

// Resolve only after commit, and observe abort as well as request errors.
function transaction(db, stores, mode, schedule, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result, scheduleError;
    const abort = () => { try { tx.abort(); } catch { /* Already committed. */ } };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(result); };
    tx.onabort = () => { cleanup(); reject(scheduleError || signal?.reason || tx.error || new Error('Storage was interrupted.')); };
    tx.onerror = () => {}; // Default IndexedDB behavior aborts on request errors.
    signal?.addEventListener('abort', abort, { once: true });
    try { schedule(tx, value => { result = value; }); }
    catch (error) { scheduleError = error; abort(); }
  });
}

export function read(db, store, key, signal) {
  return transaction(db, [store], 'readonly', (tx, result) => {
    tx.objectStore(store).get(key).onsuccess = event => result(event.target.result);
  }, signal);
}

function put(db, store, key, value, signal) {
  return transaction(db, [store], 'readwrite', tx => tx.objectStore(store).put(value, key), signal);
}

export async function openVault(name = DB_NAME) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      for (const store of ['meta', 'clips', 'chunks']) request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.onversionchange = () => db.close();
  return new Vault(db);
}

export class Vault {
  constructor(db) { this.db = db; this.key = null; }
  lock() { this.key = null; }
  assertUnlocked(signal) {
    check(signal);
    if (!this.key) throw new DOMException('Vault locked.', 'AbortError');
  }
  // Hold this across chunk writes so another tab cannot mistake them for orphans.
  exclusive(signal, operation) {
    if (!globalThis.navigator?.locks) throw new Error('Please update Safari to use local video storage.');
    return navigator.locks.request(`${this.db.name}:write`, { signal }, operation);
  }
  async unlock(password, signal) {
    return this.exclusive(signal, async () => {
      check(signal);
      let header = await read(this.db, 'meta', 'header', signal);
      if (!header && password.length < 12) throw new Error('Use at least 12 characters for your new password.');
      const salt = header?.salt || crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(password, salt);
      check(signal);
      if (header) {
        try {
          const sentinel = decoder.decode(await unseal(key, header.sent, 'sentinel'));
          if (sentinel !== 'ok') throw new Error('Invalid sentinel');
        } catch { throw new Error("That password doesn't unlock this vault."); }
      } else {
        header = { salt, sent: await seal(key, encoder.encode('ok'), 'sentinel') };
        check(signal);
        await put(this.db, 'meta', 'header', header, signal);
      }
      check(signal);
      await this.recover(signal);
      const records = await transaction(this.db, ['clips'], 'readonly', (tx, result) => {
        const out = [];
        tx.objectStore('clips').openCursor().onsuccess = event => {
          const cursor = event.target.result;
          if (!cursor) return result(out);
          out.push([cursor.key, cursor.value]);
          cursor.continue();
        };
      }, signal);
      const clips = [];
      for (const [id, record] of records) {
        check(signal);
        const meta = JSON.parse(decoder.decode(await unseal(key, record, `meta/${id}`)));
        clips.push({ ...meta, id });
      }
      // v0.4 records had no import timestamp; retain their stable existing order.
      // New imports keep selection order across a lock/reload instead of UUID order.
      clips.sort((a, b) => (a.importedAt || 0) - (b.importedAt || 0));
      check(signal);
      this.key = key;
      return clips;
    });
  }
  // Call only while holding the cross-tab write lock. Metadata is the commit marker.
  recover(signal) {
    return transaction(this.db, ['clips', 'chunks'], 'readwrite', tx => {
      tx.objectStore('clips').getAllKeys().onsuccess = event => {
        const committed = new Set(event.target.result);
        tx.objectStore('chunks').openKeyCursor().onsuccess = event => {
          const cursor = event.target.result;
          if (!cursor) return;
          const id = String(cursor.key).split(':')[0];
          if (!committed.has(id)) tx.objectStore('chunks').delete(cursor.key);
          cursor.continue();
        };
      };
    }, signal);
  }
  purge(id) {
    return transaction(this.db, ['clips', 'chunks'], 'readwrite', tx => {
      tx.objectStore('clips').delete(id);
      tx.objectStore('chunks').delete(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`));
    });
  }
  async importFile(file, info, { signal, onProgress = () => {} } = {}) {
    this.assertUnlocked(signal);
    return this.exclusive(signal, async () => {
      const id = crypto.randomUUID();
      const count = Math.ceil(file.size / CHUNK_SIZE);
      if (!count) throw new Error('This video is empty.');
      try {
        for (let i = 0; i < count; i++) {
          this.assertUnlocked(signal);
          const data = await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer();
          this.assertUnlocked(signal);
          const encrypted = await seal(this.key, data, `chunk/${id}/${i}`);
          this.assertUnlocked(signal);
          await put(this.db, 'chunks', `${id}:${i}`, encrypted, signal);
          this.assertUnlocked(signal);
          onProgress(Math.min(file.size, (i + 1) * CHUNK_SIZE), file.size);
        }
        const meta = { name: file.name, size: file.size, type: file.type || 'video/mp4', count, ...info, importedAt: Date.now() };
        const encrypted = await seal(this.key, encoder.encode(JSON.stringify(meta)), `meta/${id}`);
        this.assertUnlocked(signal);
        await put(this.db, 'clips', id, encrypted, signal);
        this.assertUnlocked(signal);
        return { ...meta, id };
      } catch (error) {
        // Cleanup is deliberately not cancelled by the vault-session signal.
        try { await this.purge(id); }
        catch { throw new Error('Import stopped. Reopen Cutroom to clean up the interrupted copy.'); }
        throw error;
      }
    });
  }
  async blob(clip, signal) {
    const parts = [];
    for (let i = 0; i < clip.count; i++) {
      this.assertUnlocked(signal);
      const record = await read(this.db, 'chunks', `${clip.id}:${i}`, signal);
      this.assertUnlocked(signal);
      if (!record) throw new Error('This saved copy is incomplete. Add the original video again.');
      parts.push(await unseal(this.key, record, `chunk/${clip.id}/${i}`));
      this.assertUnlocked(signal);
    }
    return new Blob(parts, { type: clip.type });
  }
}
