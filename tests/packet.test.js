import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFromSecretKey } from '../src/identity.js';
import { seal, open, encodePacket, decodePacket, packetId } from '../src/packet.js';
import { secp256k1 } from '../vendor/crypto.js';

const newIdentity = () => identityFromSecretKey(secp256k1.utils.randomSecretKey());
const alice = newIdentity();
const bob = newIdentity();
const eve = newIdentity();

test('sealed packets open only for the recipient', async () => {
  const packet = await seal(alice, bob.publicKey, { k: 'msg', body: 'merhaba 👋' });
  assert.deepEqual(await open(bob, packet), { k: 'msg', body: 'merhaba 👋' });
  assert.ok(!JSON.stringify(packet).includes('merhaba'));
  await assert.rejects(open(eve, packet), /not-for-me/);
  await assert.rejects(open(eve, { ...packet, t: eve.publicKey }));
});

test('tampering with ciphertext or addresses is detected', async () => {
  const packet = await seal(alice, bob.publicKey, { k: 'msg', body: 'hi' });
  const flipped = packet.c[0] === 'A' ? 'B' + packet.c.slice(1) : 'A' + packet.c.slice(1);
  await assert.rejects(open(bob, { ...packet, c: flipped }));
  await assert.rejects(open(bob, { ...packet, f: eve.publicKey }), 'sender cannot be swapped');
});

test('the hop budget can change in transit without breaking the packet', async () => {
  const packet = await seal(alice, bob.publicKey, { k: 'msg', body: 'hi' }, 4);
  assert.deepEqual(await open(bob, { ...packet, h: 1 }), { k: 'msg', body: 'hi' });
});

test('every packet uses a fresh nonce', async () => {
  const a = await seal(alice, bob.publicKey, { k: 'msg', body: 'same' });
  const b = await seal(alice, bob.publicKey, { k: 'msg', body: 'same' });
  assert.notEqual(a.n, b.n);
  assert.notEqual(a.c, b.c);
  assert.notEqual(packetId(a), packetId(b));
});

test('decodePacket validates structure', async () => {
  const packet = await seal(alice, bob.publicKey, { k: 'msg' });
  assert.deepEqual(decodePacket(encodePacket(packet)), packet);
  assert.equal(decodePacket('not json'), null);
  assert.equal(decodePacket(JSON.stringify({ ...packet, v: 2 })), null);
  assert.equal(decodePacket(JSON.stringify({ ...packet, f: 'xyz' })), null);
  assert.equal(decodePacket(JSON.stringify({ ...packet, t: packet.f })), null);
  assert.equal(decodePacket(JSON.stringify({ ...packet, n: 'short' })), null);
  assert.equal(decodePacket('x'.repeat(70000)), null);
  assert.equal(decodePacket(JSON.stringify({ ...packet, h: 99 })).h, 16);
  assert.equal(decodePacket(JSON.stringify({ ...packet, h: 'x' })).h, 0);
});
