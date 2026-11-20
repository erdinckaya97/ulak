import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeInternet, FakeLocalLinks, makeMessenger, settle } from './helpers.js';

async function lastMessage(messenger, peer) {
  const messages = await messenger.store.listMessages(peer);
  return messages[messages.length - 1];
}

test('messages flow both ways with delivered and read receipts', async () => {
  const net = new FakeInternet();
  const a = makeMessenger('Ayşe');
  const b = makeMessenger('Burak');
  net.join(a);
  net.join(b);
  net.setOnline(a, true);
  net.setOnline(b, true);
  await a.addContact(b.publicKey, 'Burak');

  const sent = await a.sendMessage(b.publicKey, 'Selam!');
  await settle(a, b);

  const received = await lastMessage(b, a.publicKey);
  assert.equal(received.body, 'Selam!');
  assert.equal(received.id, sent.id);
  assert.equal((await a.store.getMessage(sent.id)).status, 'delivered');

  await b.markRead(a.publicKey);
  await settle(a, b);
  assert.equal((await a.store.getMessage(sent.id)).status, 'read');

  await b.sendMessage(a.publicKey, 'Aleyküm selam');
  await settle(a, b);
  assert.equal((await lastMessage(a, b.publicKey)).body, 'Aleyküm selam');
});

test('a message written while the recipient is offline waits and is delivered when they come online', async () => {
  const net = new FakeInternet();
  const a = makeMessenger('A');
  const b = makeMessenger('B');
  net.join(a);
  net.join(b);
  net.setOnline(a, true);
  await a.addContact(b.publicKey);

  const sent = await a.sendMessage(b.publicKey, 'Neredesin?');
  await settle(a, b);
  assert.equal((await a.store.getMessage(sent.id)).status, 'pending');
  assert.equal((await b.store.listMessages(a.publicKey)).length, 0);

  net.setOnline(b, true);
  await settle(a, b);
  assert.equal((await lastMessage(b, a.publicKey)).body, 'Neredesin?');
  assert.equal((await a.store.getMessage(sent.id)).status, 'delivered');
});

test('nothing is delivered while the sender is offline, then it catches up', async () => {
  const net = new FakeInternet();
  const a = makeMessenger('A');
  const b = makeMessenger('B');
  net.join(a);
  net.join(b);
  net.setOnline(b, true);

  await a.sendMessage(b.publicKey, 'one');
  await a.sendMessage(b.publicKey, 'two');
  await settle(a, b);
  assert.equal((await b.store.listMessages(a.publicKey)).length, 0);

  net.setOnline(a, true);
  await settle(a, b);
  assert.deepEqual((await b.store.listMessages(a.publicKey)).map((m) => m.body), ['one', 'two']);
});

test('an unknown sender shows up as a message request with their name', async () => {
  const net = new FakeInternet();
  const a = makeMessenger('Deniz');
  const b = makeMessenger('B');
  net.join(a);
  net.join(b);
  net.setOnline(a, true);
  net.setOnline(b, true);

  await a.sendMessage(b.publicKey, 'Merhaba, ben Deniz');
  await settle(a, b);
  const contact = await b.store.getContact(a.publicKey);
  assert.equal(contact.request, true);
  assert.equal(contact.name, 'Deniz');
  assert.equal(contact.unread, 1);

  await b.addContact(a.publicKey);
  assert.equal((await b.store.getContact(a.publicKey)).request, false);
});

test('duplicate deliveries are stored once and still acknowledged', async () => {
  const net = new FakeInternet();
  const a = makeMessenger('A');
  const b = makeMessenger('B');
  net.join(a);
  net.join(b);
  net.setOnline(b, true);
  const sent = await a.sendMessage(b.publicKey, 'tekrar');
  const [packet] = await a.exportPending(b.publicKey);
  const [packetAgain] = await a.exportPending(b.publicKey);

  assert.equal(await b.receivePacket(packet, 'qr'), 'message');
  assert.equal(await b.receivePacket(packet, 'qr'), 'duplicate');
  assert.equal(await b.receivePacket(packetAgain, 'qr'), 'duplicate');
  assert.equal((await b.store.listMessages(a.publicKey)).length, 1);

  net.setOnline(a, true);
  await settle(a, b);
  assert.equal((await a.store.getMessage(sent.id)).status, 'delivered');
});

test('QR export works with no network at all', async () => {
  const a = makeMessenger('A');
  const b = makeMessenger('B');
  await a.sendMessage(b.publicKey, 'İnternet yok, QR ile geldim');
  const packets = await a.exportPending(b.publicKey);
  assert.equal(packets.length, 1);
  assert.equal(await b.receivePacket(packets[0], 'qr'), 'message');
  const message = await lastMessage(b, a.publicKey);
  assert.equal(message.body, 'İnternet yok, QR ile geldim');
  assert.equal(message.via, 'qr');
});

test('packets for someone else are carried and handed over when that person is met (mesh)', async () => {
  const links = new FakeLocalLinks();
  const a = makeMessenger('A');
  const b = makeMessenger('B');
  const c = makeMessenger('C (carrier)');
  for (const m of [a, b, c]) links.join(m);

  const sent = await a.sendMessage(b.publicKey, 'Enkazın yanındayım, iyiyim');
  links.connect(a, c);
  await settle(a, b, c);
  assert.equal((await c.store.getCarried()).length, 1, 'C carries the packet');
  assert.equal((await c.store.listMessages(a.publicKey)).length, 0, 'C cannot read it');
  links.disconnect(a, c);

  links.connect(c, b);
  await settle(a, b, c);
  assert.equal((await lastMessage(b, a.publicKey)).body, 'Enkazın yanındayım, iyiyim');
  assert.equal((await c.store.getCarried()).length, 0, 'handed over and dropped');

  links.disconnect(c, b);
  links.connect(a, b);
  await settle(a, b, c);
  assert.equal((await a.store.getMessage(sent.id)).status, 'delivered');
  assert.equal((await b.store.listMessages(a.publicKey)).length, 1);
});

test('carried packets run out of hops instead of circulating forever', async () => {
  const links = new FakeLocalLinks();
  const nodes = Array.from({ length: 7 }, (_, i) => makeMessenger(`N${i}`));
  const target = makeMessenger('target');
  for (const m of [...nodes, target]) links.join(m);
  await nodes[0].sendMessage(target.publicKey, 'far away');

  for (let i = 0; i < nodes.length - 1; i++) {
    links.connect(nodes[i], nodes[i + 1]);
    await settle(...nodes);
    links.disconnect(nodes[i], nodes[i + 1]);
  }
  const carrying = [];
  for (const node of nodes.slice(1)) carrying.push((await node.store.getCarried()).length);
  assert.deepEqual(carrying, [1, 1, 1, 1, 0, 0], 'four hops, then dropped');
});

test('carrying for others can be switched off', async () => {
  const links = new FakeLocalLinks();
  const a = makeMessenger('A');
  const b = makeMessenger('B');
  const c = makeMessenger('C', { settings: { carryForOthers: false } });
  for (const m of [a, b, c]) links.join(m);
  await a.sendMessage(b.publicKey, 'hi');
  links.connect(a, c);
  await settle(a, b, c);
  assert.equal((await c.store.getCarried()).length, 0);
});

test('relay storage is used only when enabled and nobody is reachable', async () => {
  const stored = [];
  const relay = {
    name: 'relay',
    priority: 2,
    canReach: () => false,
    send: async () => false,
    sendStored: async (peer, text) => (stored.push({ peer, text }), true),
  };
  const off = makeMessenger('A');
  off.addTransport(relay);
  await off.sendMessage('0'.repeat(63) + '1', 'x');
  await settle(off);
  assert.equal(stored.length, 0);

  const b = makeMessenger('B');
  const on = makeMessenger('A', { settings: { storeOnRelays: true } });
  on.addTransport(relay);
  const sent = await on.sendMessage(b.publicKey, 'kept for later');
  await settle(on);
  await on.flush(b.publicKey, { force: true });
  assert.equal(stored.length, 1, 'stored once, not on every retry');
  const message = await on.store.getMessage(sent.id);
  assert.equal(message.status, 'sent');
  assert.equal(message.via, 'relay-stored');
  assert.equal(await b.receivePacket(stored[0].text, 'relay'), 'message');
});

test('a forged packet claiming to be from someone else is rejected', async () => {
  const a = makeMessenger('A');
  const b = makeMessenger('B');
  const eve = makeMessenger('Eve');
  await eve.sendMessage(b.publicKey, 'I am A');
  const [packet] = await eve.exportPending(b.publicKey);
  const forged = JSON.stringify({ ...JSON.parse(packet), f: a.publicKey });
  assert.equal(await b.receivePacket(forged, 'qr'), 'invalid');
  assert.equal((await b.store.getContacts()).length, 0);
});

test('input limits are enforced', async () => {
  const a = makeMessenger('A');
  const b = makeMessenger('B');
  assert.equal(await a.sendMessage(b.publicKey, '   '), null);
  await assert.rejects(a.sendMessage(b.publicKey, 'x'.repeat(4001)), /too-long/);
  await assert.rejects(a.addContact(a.publicKey), /self/);
});
