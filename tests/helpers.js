import { secp256k1 } from '../vendor/crypto.js';
import { identityFromSecretKey } from '../src/identity.js';
import { Messenger } from '../src/messenger.js';
import { MemoryStore } from '../src/store-memory.js';

/** A fake "internet": peers reach each other only while both are online. */
export class FakeInternet {
  constructor() {
    this.nodes = new Map();
    this.online = new Set();
    this.sent = 0;
  }

  join(messenger) {
    const net = this;
    const transport = {
      name: 'net',
      priority: 1,
      local: false,
      attach(m) {
        this.messenger = m;
      },
      canReach: (peer) => net.online.has(peer) && net.online.has(messenger.publicKey),
      async send(peer, text) {
        if (!this.canReach(peer)) return false;
        net.sent++;
        net.nodes.get(peer).receivePacket(text, 'net');
        return true;
      },
    };
    this.nodes.set(messenger.publicKey, messenger);
    messenger.addTransport(transport);
    return transport;
  }

  /** Brings a peer online and tells everyone who is online about each other, like presence would. */
  setOnline(messenger, isOnline) {
    if (isOnline) {
      this.online.add(messenger.publicKey);
      for (const key of this.online) {
        if (key === messenger.publicKey) continue;
        this.nodes.get(key).peerAvailable(messenger.publicKey, 'net');
        messenger.peerAvailable(key, 'net');
      }
    } else {
      this.online.delete(messenger.publicKey);
    }
  }
}

/** Direct device-to-device links, like a local Wi-Fi WebRTC connection or Bluetooth. */
export class FakeLocalLinks {
  constructor() {
    this.links = new Set();
    this.nodes = new Map();
  }

  key(a, b) {
    return [a, b].sort().join('|');
  }

  join(messenger) {
    const links = this;
    this.nodes.set(messenger.publicKey, messenger);
    return messenger.addTransport({
      name: 'lan',
      priority: 0,
      local: true,
      canReach: (peer) => links.links.has(links.key(messenger.publicKey, peer)),
      async send(peer, text) {
        if (!this.canReach(peer)) return false;
        links.nodes.get(peer).receivePacket(text, 'lan');
        return true;
      },
    });
  }

  connect(a, b) {
    this.links.add(this.key(a.publicKey, b.publicKey));
    a.peerAvailable(b.publicKey, 'lan');
    b.peerAvailable(a.publicKey, 'lan');
  }

  disconnect(a, b) {
    this.links.delete(this.key(a.publicKey, b.publicKey));
  }
}

export function makeMessenger(name, options = {}) {
  const identity = identityFromSecretKey(secp256k1.utils.randomSecretKey());
  return new Messenger({ identity, store: new MemoryStore(), name, ...options });
}

export async function waitFor(check, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

export async function settle(...messengers) {
  for (let i = 0; i < 5; i++) {
    for (const messenger of messengers) await messenger.idle();
  }
}
