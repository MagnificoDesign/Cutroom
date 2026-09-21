import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { deriveKey, seal, unseal, bytes, CHUNK_SIZE } from './vault.mjs';

const key = await deriveKey('harmless regression password', new Uint8Array(16));

test('multi-megabyte ciphertext round trips as binary without Base64 calls', async () => {
  const original = globalThis.btoa;
  globalThis.btoa = () => { throw new Error('Binary writes must not use Base64'); };
  try {
    for (const size of [0, 1, CHUNK_SIZE, CHUNK_SIZE * 3 + 173]) {
      const payload = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 17) % 256);
      const encrypted = await seal(key, payload, 'chunk/test/0');
      assert(encrypted.iv instanceof Uint8Array);
      assert(encrypted.data instanceof ArrayBuffer);
      assert.equal(encrypted.data.byteLength, size + 16);
      assert.deepEqual(await unseal(key, structuredClone(encrypted), 'chunk/test/0'), payload);
    }
  } finally { globalThis.btoa = original; }
});

test('existing Base64 records remain readable', async () => {
  const payload = new TextEncoder().encode('old encrypted metadata');
  const encrypted = await seal(key, payload, 'meta/old');
  const legacy = { iv: Buffer.from(encrypted.iv).toString('base64'), data: Buffer.from(encrypted.data).toString('base64') };
  assert.deepEqual(await unseal(key, legacy, 'meta/old'), payload);
  assert.deepEqual(bytes(Buffer.from([1, 2, 3]).toString('base64')), new Uint8Array([1, 2, 3]));
});

test('ciphertext tampering and cross-chunk substitution fail authentication', async () => {
  const encrypted = await seal(key, new Uint8Array([1, 2, 3]), 'chunk/first/0');
  await assert.rejects(unseal(key, encrypted, 'chunk/second/0'), { name: 'OperationError' });
  new Uint8Array(encrypted.data)[0] ^= 1;
  await assert.rejects(unseal(key, encrypted, 'chunk/first/0'), { name: 'OperationError' });
});

test('runtime sources have no large-byte spread/apply or Base64 writer', async () => {
  for (const file of ['app.js', 'vault.mjs', 'media.mjs', 'core.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /fromCharCode\s*(?:\(\s*\.\.\.|\.apply\s*\()/);
    assert.doesNotMatch(source, /\bbtoa\s*\(/);
  }
});
