// Checks which relays forward Ulak's event kinds: node scripts/check-relays.js [wss://relay ...]
import { secp256k1 } from '../vendor/crypto.js';
import { identityFromSecretKey } from '../src/identity.js';
import { DEFAULT_RELAYS, KIND_PACKET, KIND_PRESENCE, KIND_STORED, signEvent, verifyEvent } from '../src/nostr.js';

const relays = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_RELAYS;
const sender = identityFromSecretKey(secp256k1.utils.randomSecretKey());
const receiver = identityFromSecretKey(secp256k1.utils.randomSecretKey());

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('timeout')), 8000);
    socket.onopen = () => (clearTimeout(timer), resolve(socket));
    socket.onerror = () => (clearTimeout(timer), reject(new Error('connect failed')));
  });
}

async function check(url) {
  const result = { url, connect: false, packet: false, presence: false, stored: false };
  let listener, publisher;
  try {
    [listener, publisher] = await Promise.all([open(url), open(url)]);
    result.connect = true;
    const got = new Set();
    listener.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg[0] === 'EVENT' && verifyEvent(msg[2])) got.add(msg[2].kind);
    };
    const since = Math.floor(Date.now() / 1000) - 10;
    listener.send(JSON.stringify(['REQ', 'p', { kinds: [KIND_PACKET, KIND_STORED], '#p': [receiver.publicKey], since }]));
    listener.send(JSON.stringify(['REQ', 'a', { kinds: [KIND_PRESENCE], authors: [sender.publicKey], since }]));
    await new Promise((r) => setTimeout(r, 800));
    const expiration = String(Math.floor(Date.now() / 1000) + 600);
    for (const template of [
      { kind: KIND_PACKET, tags: [['p', receiver.publicKey]], content: 'ulak-relay-check' },
      { kind: KIND_PRESENCE, content: '' },
      { kind: KIND_STORED, tags: [['p', receiver.publicKey], ['expiration', expiration]], content: 'ulak-relay-check' },
    ]) {
      publisher.send(JSON.stringify(['EVENT', signEvent(template, sender)]));
    }
    await new Promise((r) => setTimeout(r, 3000));
    result.packet = got.has(KIND_PACKET);
    result.presence = got.has(KIND_PRESENCE);
    result.stored = got.has(KIND_STORED);
  } catch (err) {
    result.error = err.message;
  } finally {
    listener?.close();
    publisher?.close();
  }
  return result;
}

const results = await Promise.all(relays.map(check));
const mark = (ok) => (ok ? 'yes' : 'no ');
console.log('relay                              connect packet presence stored');
for (const r of results) {
  console.log(`${r.url.padEnd(34)} ${mark(r.connect)}     ${mark(r.packet)}    ${mark(r.presence)}      ${mark(r.stored)}  ${r.error || ''}`);
}
process.exit(0);
