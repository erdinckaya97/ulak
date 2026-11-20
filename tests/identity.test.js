import test from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToSeed, hex } from '../vendor/crypto.js';
import {
  createMnemonic,
  isValidMnemonic,
  normalizeMnemonic,
  identityFromMnemonic,
  decodeId,
  encodeId,
  shortId,
  safetyWords,
} from '../src/identity.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('generated mnemonics have 12 valid words', () => {
  for (let i = 0; i < 20; i++) {
    const words = createMnemonic();
    assert.equal(words.split(' ').length, 12);
    assert.ok(isValidMnemonic(words));
  }
});

test('BIP39 seed matches the reference vector', async () => {
  assert.equal(
    hex.encode(await mnemonicToSeed(ABANDON)),
    '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
  );
});

test('mnemonic input is normalized and validated', () => {
  assert.equal(normalizeMnemonic(`  Abandon,abandon\nABANDON  ${'abandon '.repeat(8)}about. `), ABANDON);
  assert.ok(isValidMnemonic(ABANDON.toUpperCase()));
  assert.ok(!isValidMnemonic(ABANDON.replace('about', 'abandon')), 'bad checksum');
  assert.ok(!isValidMnemonic('abandon about'), 'too short');
  assert.ok(!isValidMnemonic(''));
});

test('the same words always give the same identity', async () => {
  const a = await identityFromMnemonic(ABANDON);
  const b = await identityFromMnemonic(`  ${ABANDON.toUpperCase()} `);
  assert.equal(a.publicKey, b.publicKey);
  assert.match(a.publicKey, /^[0-9a-f]{64}$/);
  assert.match(a.id, /^ulak1[02-9ac-hj-np-z]{58}$/);
  const other = await identityFromMnemonic(createMnemonic());
  assert.notEqual(other.publicKey, a.publicKey);
  await assert.rejects(identityFromMnemonic('hello world'), /invalid-mnemonic/);
});

test('IDs round-trip and reject garbage', async () => {
  const { publicKey, id } = await identityFromMnemonic(ABANDON);
  assert.equal(encodeId(publicKey), id);
  assert.equal(decodeId(id), publicKey);
  assert.equal(decodeId(` ${id.toUpperCase()} `), publicKey);
  assert.equal(decodeId(publicKey), publicKey);
  assert.equal(decodeId(id.slice(0, -1) + (id.endsWith('q') ? 'p' : 'q')), null, 'bad checksum');
  assert.equal(decodeId('npub1' + id.slice(5)), null, 'wrong prefix');
  assert.equal(decodeId('f'.repeat(64)), null, 'not a curve point');
  assert.equal(decodeId(''), null);
  assert.match(shortId(publicKey), /^ulak1.{4}….{4}$/);
});

test('safety words are symmetric and differ per pair', async () => {
  const a = await identityFromMnemonic(createMnemonic());
  const b = await identityFromMnemonic(createMnemonic());
  const c = await identityFromMnemonic(createMnemonic());
  assert.deepEqual(safetyWords(a.publicKey, b.publicKey), safetyWords(b.publicKey, a.publicKey));
  assert.equal(safetyWords(a.publicKey, b.publicKey).length, 4);
  assert.notDeepEqual(safetyWords(a.publicKey, b.publicKey), safetyWords(a.publicKey, c.publicKey));
});
