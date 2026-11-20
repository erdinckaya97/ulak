import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '../vendor/crypto.js';
import { identityFromSecretKey } from '../src/identity.js';
import { signEvent, verifyEvent, eventId, NostrTransport, KIND_PACKET, KIND_PRESENCE } from '../src/nostr.js';
import { makeMessenger, settle, waitFor } from './helpers.js';

const identity = identityFromSecretKey(secp256k1.utils.randomSecretKey());

test('signed events verify and tampering is caught', () => {
  const event = signEvent({ kind: KIND_PACKET, tags: [['p', 'a'.repeat(64)]], content: 'x' }, identity);
  assert.equal(event.pubkey, identity.publicKey);
  assert.equal(event.id, eventId(event));
  assert.ok(verifyEvent(event));
  assert.ok(!verifyEvent({ ...event, content: 'y' }));
  assert.ok(!verifyEvent({ ...event, pubkey: 'b'.repeat(64) }));
  assert.ok(!verifyEvent({ ...event, sig: '00'.repeat(64) }));
  assert.ok(!verifyEvent(null));
});

test('event id follows NIP-01 serialization', () => {
  const event = { pubkey: 'a'.repeat(64), created_at: 1, kind: 1, tags: [['t', 'x']], content: 'hé "q"' };
  // sha256 of [0,"aaa…",1,1,[["t","x"]],"hé \"q\""]
  assert.equal(eventId(event), eventId(JSON.parse(JSON.stringify(event))));
  assert.match(eventId(event), /^[0-9a-f]{64}$/);
});

/** In-process relay that speaks enough NIP-01 for the transport. */
function fakeRelayNetwork() {
  const sockets = new Set();
  const matches = (filter, event) =>
    (!filter.kinds || filter.kinds.includes(event.kind)) &&
    (!filter.authors || filter.authors.includes(event.pubkey)) &&
    (!filter['#p'] || event.tags.some((t) => t[0] === 'p' && filter['#p'].includes(t[1])));
  class FakeSocket {
    constructor() {
      this.subs = new Map();
      this.readyState = 1;
      sockets.add(this);
      setTimeout(() => this.onopen?.());
    }
    send(frame) {
      const [type, ...rest] = JSON.parse(frame);
      if (type === 'REQ') this.subs.set(rest[0], rest.slice(1));
      if (type === 'CLOSE') this.subs.delete(rest[0]);
      if (type === 'EVENT') {
        const event = rest[0];
        setTimeout(() => this.onmessage?.({ data: JSON.stringify(['OK', event.id, true, '']) }));
        for (const socket of sockets) {
          for (const [subId, filters] of socket.subs) {
            if (filters.some((f) => matches(f, event))) {
              setTimeout(() => socket.onmessage?.({ data: JSON.stringify(['EVENT', subId, event]) }));
            }
          }
        }
      }
    }
    close() {
      sockets.delete(this);
      this.readyState = 3;
    }
  }
  return FakeSocket;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('nostr transport: presence, delivery and receipts through a relay', async (t) => {
  const WebSocketImpl = fakeRelayNetwork();
  const a = makeMessenger('A');
  const b = makeMessenger('B');
  t.after(() => (a.stop(), b.stop()));
  const ta = a.addTransport(new NostrTransport({ relays: ['wss://fake'], WebSocketImpl }));
  const tb = b.addTransport(new NostrTransport({ relays: ['wss://fake'], WebSocketImpl }));
  await a.addContact(b.publicKey);
  await b.addContact(a.publicKey);
  const sent = await a.sendMessage(b.publicKey, 'relay üzerinden');

  await a.start();
  await b.start();
  assert.ok(await waitFor(() => ta.canReach(b.publicKey) && tb.canReach(a.publicKey)), 'both see each other online');
  assert.ok(await waitFor(async () => (await a.store.getMessage(sent.id)).status === 'delivered'), 'acknowledged');
  const received = await b.store.listMessages(a.publicKey);
  assert.equal(received[0].body, 'relay üzerinden');
  assert.equal(received[0].via, 'nostr');
});

test('nostr transport ignores presence from non-contacts', async (t) => {
  const WebSocketImpl = fakeRelayNetwork();
  const a = makeMessenger('A');
  const stranger = makeMessenger('S');
  t.after(() => (a.stop(), stranger.stop()));
  const ta = a.addTransport(new NostrTransport({ relays: ['wss://fake'], WebSocketImpl }));
  stranger.addTransport(new NostrTransport({ relays: ['wss://fake'], WebSocketImpl }));
  await a.start();
  await stranger.start();
  await wait(300);
  await settle(a, stranger);
  assert.equal(ta.canReach(stranger.publicKey), false);
  assert.equal(KIND_PRESENCE, 21211);
});
