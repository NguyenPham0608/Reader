// The browser's store of Claude's answers, as far as it runs outside a browser: node --test tests/*.test.mjs
// (Node has no IndexedDB, so shelves here last only as long as the process; the browser run keeps them.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shelf, hashKey, fingerprint } from '../cache.js';

test('a key is stable, short, and differs for different text', () => {
  const a = hashKey(JSON.stringify([2, 'The lattice is split into four blocks.']));
  assert.equal(a, hashKey(JSON.stringify([2, 'The lattice is split into four blocks.'])));
  assert.notEqual(a, hashKey(JSON.stringify([3, 'The lattice is split into four blocks.'])));
  assert.notEqual(a, hashKey(JSON.stringify([2, 'The lattice is split into four blocks!'])));
  assert.ok(a.length < 30);
  const many = new Set(Array.from({ length: 20000 }, (_, i) => hashKey(`sentence ${i}`)));
  assert.equal(many.size, 20000);
});

test('a shelf gives back what was put on it, and is the same shelf when asked for again', async () => {
  const s = await shelf('doc/4.3/translated-vi-VN-none');
  assert.equal(s.get('x'), undefined);
  s.set('x', 'một');
  s.set('empty', ''); // a piece with nothing to say is an answer too
  assert.equal((await shelf('doc/4.3/translated-vi-VN-none')).get('x'), 'một');
  assert.equal(s.get('empty'), '');
  assert.equal((await shelf('doc/4.3/translated-fr-none')).get('x'), undefined);
});

test('a fingerprint is the SHA-256 of the bytes, or of the text as UTF-8', async () => {
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(await fingerprint(new TextEncoder().encode('abc')), abc);
  assert.equal(await fingerprint('abc'), abc);
});
