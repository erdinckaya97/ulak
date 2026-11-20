import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSignal, decodeSignal, SIGNAL_PREFIX } from '../src/rtc.js';

const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2122260223 4f1d6a2b-7c1e-4d55-9f0b-0c7d1e2a9b31.local 54321 typ host generation 0',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:abcdefghijklmnopqrstuvwx',
  'a=fingerprint:sha-256 ' + Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':'),
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
].join('\r\n');

test('offer/answer codes round-trip and stay small enough for a QR code', async () => {
  const signal = { t: 'o', k: 'a'.repeat(64), s: SDP };
  const code = await encodeSignal(signal);
  assert.ok(code.startsWith(SIGNAL_PREFIX));
  assert.ok(code.length < 1200, `fits a QR code (${code.length})`);
  assert.deepEqual(await decodeSignal(code), signal);
  assert.deepEqual(await decodeSignal(`  ${code}\n`), signal);
});

test('malformed codes are rejected', async () => {
  await assert.rejects(decodeSignal('hello'));
  await assert.rejects(decodeSignal(`${SIGNAL_PREFIX}x123`));
  await assert.rejects(decodeSignal(`${SIGNAL_PREFIX}j${Buffer.from('{"t":"o","k":"bad","s":""}').toString('base64url')}`));
  await assert.rejects(decodeSignal(`${SIGNAL_PREFIX}j${Buffer.from('{"t":"x","k":"' + 'a'.repeat(64) + '","s":""}').toString('base64url')}`));
});
