import { schnorr, sha256, hex } from '../vendor/crypto.js';
import { utf8 } from './util.js';

export const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://nostr.mom',
  'wss://relay.snort.social',
  'wss://relay.damus.io',
];

/** Ephemeral kinds (20000-29999) are forwarded to live subscribers and never stored by relays. */
export const KIND_PACKET = 21210;
export const KIND_PRESENCE = 21211;
/** Regular kind for the optional "keep it on relays while they're offline" mode. */
export const KIND_STORED = 4210;

const PRESENCE_INTERVAL = 40e3;
const ONLINE_WINDOW = 95e3;
const STORED_TTL = 7 * 24 * 3600;

export function eventId(event) {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return hex.encode(sha256(utf8(serialized)));
}

export function signEvent(template, identity) {
  const event = {
    pubkey: identity.publicKey,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
    kind: template.kind,
    tags: template.tags || [],
    content: template.content || '',
  };
  event.id = eventId(event);
  event.sig = hex.encode(schnorr.sign(hex.decode(event.id), identity.secretKey));
  return event;
}

export function verifyEvent(event) {
  try {
    if (!event || typeof event.id !== 'string' || eventId(event) !== event.id) return false;
    return schnorr.verify(hex.decode(event.sig), hex.decode(event.id), hex.decode(event.pubkey));
  } catch {
    return false;
  }
}

/** One WebSocket per relay with automatic reconnects; subscriptions are replayed after reconnecting. */
export class RelayPool {
  constructor(urls, { WebSocketImpl = globalThis.WebSocket } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.relays = new Map();
    this.subscriptions = new Map();
    this.pendingOk = new Map();
    this.seen = new Set();
    this.onStatus = () => {};
    this.closed = false;
    this.setRelays(urls);
  }

  setRelays(urls) {
    const wanted = new Set(urls.filter((url) => /^wss?:\/\//.test(url)));
    for (const [url, relay] of this.relays) {
      if (!wanted.has(url)) {
        relay.closed = true;
        relay.socket?.close();
        this.relays.delete(url);
      }
    }
    for (const url of wanted) {
      if (!this.relays.has(url)) {
        const relay = { url, socket: null, open: false, attempts: 0, closed: false };
        this.relays.set(url, relay);
        if (!this.closed) this.connect(relay);
      }
    }
    this.onStatus(this.status());
  }

  status() {
    const relays = [...this.relays.values()];
    return { total: relays.length, connected: relays.filter((r) => r.open).length };
  }

  connect(relay) {
    if (relay.closed || this.closed) return;
    let socket;
    try {
      socket = new this.WebSocketImpl(relay.url);
    } catch {
      this.scheduleReconnect(relay);
      return;
    }
    relay.socket = socket;
    socket.onopen = () => {
      relay.open = true;
      relay.attempts = 0;
      for (const [subId, filters] of this.subscriptions) socket.send(JSON.stringify(['REQ', subId, ...filters.filters]));
      this.onStatus(this.status());
    };
    socket.onmessage = (event) => this.handleMessage(relay, event.data);
    socket.onclose = () => {
      relay.open = false;
      this.onStatus(this.status());
      this.scheduleReconnect(relay);
    };
    socket.onerror = () => {};
  }

  scheduleReconnect(relay) {
    if (relay.closed || this.closed) return;
    const delay = Math.min(60e3, 1000 * 2 ** relay.attempts++) + Math.random() * 1000;
    setTimeout(() => this.connect(relay), delay);
  }

  /** Reconnect immediately, e.g. after the device comes back online. */
  reconnectNow() {
    for (const relay of this.relays.values()) {
      if (!relay.open && relay.socket?.readyState !== 0) {
        relay.attempts = 0;
        this.connect(relay);
      }
    }
  }

  handleMessage(relay, data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const [type] = message;
    if (type === 'EVENT') {
      const [, subId, event] = message;
      const sub = this.subscriptions.get(subId);
      if (!sub || this.seen.has(event?.id) || !verifyEvent(event)) return;
      this.seen.add(event.id);
      if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
      sub.onEvent(event, relay.url);
    } else if (type === 'OK') {
      const [, id, accepted] = message;
      const pending = this.pendingOk.get(id);
      if (pending && accepted) pending(true);
    }
  }

  subscribe(subId, filters, onEvent) {
    this.subscriptions.set(subId, { filters, onEvent });
    for (const relay of this.relays.values()) {
      if (relay.open) relay.socket.send(JSON.stringify(['REQ', subId, ...filters]));
    }
  }

  unsubscribe(subId) {
    this.subscriptions.delete(subId);
    for (const relay of this.relays.values()) {
      if (relay.open) relay.socket.send(JSON.stringify(['CLOSE', subId]));
    }
  }

  /** Resolves true as soon as one relay accepts the event, false after `timeout` ms. */
  publish(event, timeout = 5000) {
    const openRelays = [...this.relays.values()].filter((r) => r.open);
    if (!openRelays.length) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer);
        this.pendingOk.delete(event.id);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeout);
      this.pendingOk.set(event.id, done);
      const frame = JSON.stringify(['EVENT', event]);
      for (const relay of openRelays) {
        try {
          relay.socket.send(frame);
        } catch {}
      }
    });
  }

  close() {
    this.closed = true;
    for (const relay of this.relays.values()) {
      relay.closed = true;
      relay.socket?.close();
    }
  }
}

/**
 * Internet transport over public Nostr relays. Relays only ever see encrypted packets, the
 * recipient's public key (as a `p` tag) and, through presence beacons, when a user is online.
 */
export class NostrTransport {
  constructor({ relays = DEFAULT_RELAYS, WebSocketImpl, publishPresence = true } = {}) {
    this.name = 'nostr';
    this.priority = 2;
    this.local = false;
    this.pool = new RelayPool(relays, { WebSocketImpl });
    this.lastSeen = new Map();
    this.publishPresence = publishPresence;
    this.onStatus = () => {};
    this.pool.onStatus = (status) => {
      this.onStatus(status);
      if (status.connected && !this.announcedOnce) {
        this.announcedOnce = true;
        this.announce();
      }
    };
  }

  attach(messenger) {
    this.messenger = messenger;
    this.identity = messenger.identity;
  }

  async start() {
    const me = this.identity.publicKey;
    const since = Math.floor(Date.now() / 1000) - 120;
    this.pool.subscribe('ulak-in', [{ kinds: [KIND_PACKET], '#p': [me], since }], (event) => {
      this.markSeen(event.pubkey);
      this.messenger.receivePacket(event.content, 'nostr');
    });
    const storedSince = await this.messenger.store.getSetting('nostrStoredSince', Math.floor(Date.now() / 1000) - STORED_TTL);
    this.pool.subscribe('ulak-stored', [{ kinds: [KIND_STORED], '#p': [me], since: storedSince }], (event) => {
      this.messenger.receivePacket(event.content, 'nostr-stored');
      this.messenger.store.setSetting('nostrStoredSince', Math.max(storedSince, event.created_at - 60));
    });
    await this.contactsChanged();
    this.timer = setInterval(() => this.announce(), PRESENCE_INTERVAL);
  }

  async contactsChanged() {
    if (!this.messenger) return;
    const authors = (await this.messenger.store.getContacts()).map((c) => c.publicKey);
    if (!authors.length) {
      this.pool.unsubscribe('ulak-presence');
      return;
    }
    const since = Math.floor(Date.now() / 1000) - Math.ceil(ONLINE_WINDOW / 1000);
    this.pool.subscribe('ulak-presence', [{ kinds: [KIND_PRESENCE], authors, since }], (event) => {
      this.markSeen(event.pubkey);
    });
  }

  /** Anything signed by a peer just now (beacon or packet) proves they are online. */
  markSeen(publicKey) {
    const wasOnline = this.isOnline(publicKey);
    this.lastSeen.set(publicKey, Date.now());
    if (!wasOnline) {
      this.messenger.peerAvailable(publicKey, 'nostr');
      this.announceSoon();
    }
  }

  /** Answer a contact who just came online so they see us without waiting for our next beacon. */
  announceSoon() {
    if (this.announceTimer) return;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      this.announce();
    }, 1500);
  }

  announce() {
    if (!this.publishPresence || !this.identity) return;
    this.pool.publish(signEvent({ kind: KIND_PRESENCE, content: '' }, this.identity));
  }

  isOnline(publicKey) {
    return Date.now() - (this.lastSeen.get(publicKey) || 0) < ONLINE_WINDOW;
  }

  canReach(publicKey) {
    return this.pool.status().connected > 0 && this.isOnline(publicKey);
  }

  send(publicKey, packetText) {
    const event = signEvent({ kind: KIND_PACKET, tags: [['p', publicKey]], content: packetText }, this.identity);
    return this.pool.publish(event);
  }

  sendStored(publicKey, packetText) {
    if (!this.pool.status().connected) return Promise.resolve(false);
    const expiration = String(Math.floor(Date.now() / 1000) + STORED_TTL);
    const tags = [['p', publicKey], ['expiration', expiration]];
    return this.pool.publish(signEvent({ kind: KIND_STORED, tags, content: packetText }, this.identity));
  }

  setRelays(urls) {
    this.pool.setRelays(urls);
  }

  stop() {
    clearInterval(this.timer);
    this.pool.close();
  }
}
