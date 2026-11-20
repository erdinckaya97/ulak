import { seal, open, encodePacket, decodePacket, packetId, DEFAULT_HOPS } from './packet.js';
import { Emitter, randomId } from './util.js';

export const MAX_BODY = 4000;
export const MAX_NAME = 40;
const CARRY_LIMIT = 500;
const CARRY_TTL = 7 * 24 * 3600e3;
const SEEN_TTL = 14 * 24 * 3600e3;
const RESEND_AFTER = 15e3;
const RETRY_INTERVAL = 30e3;
const STATUS_RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };

export const cleanName = (name) => String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME);

/**
 * Transport-agnostic messaging core. Transports plug in with:
 *   name, priority (lower is tried first), local (true for links to physically nearby devices)
 *   attach(messenger), start(), stop()
 *   canReach(publicKey) -> boolean
 *   send(publicKey, packetText) -> Promise<boolean>
 *   sendStored?(publicKey, packetText) -> Promise<boolean>   (store-and-forward by a third party)
 * and report back through messenger.receivePacket(text, via) and messenger.peerAvailable(publicKey, via).
 */
export class Messenger extends Emitter {
  constructor({ identity, store, name = '', now = () => Date.now(), settings = {} }) {
    super();
    this.identity = identity;
    this.store = store;
    this.name = cleanName(name);
    this.now = now;
    this.settings = { storeOnRelays: false, carryForOthers: true, ...settings };
    this.transports = [];
    this.flushing = new Map();
    this.inflight = new Set();
    this.receiving = Promise.resolve();
  }

  get publicKey() {
    return this.identity.publicKey;
  }

  addTransport(transport) {
    this.transports.push(transport);
    this.transports.sort((a, b) => a.priority - b.priority);
    transport.attach?.(this);
    return transport;
  }

  transport(name) {
    return this.transports.find((t) => t.name === name);
  }

  async start() {
    await this.prune();
    for (const transport of this.transports) await transport.start?.();
    this.retryTimer = setInterval(() => this.retryReachable(), RETRY_INTERVAL);
  }

  async stop() {
    clearInterval(this.retryTimer);
    for (const transport of this.transports) await transport.stop?.();
  }

  /** Periodic safety net: re-attempt anything still owed to peers that are reachable right now. */
  async retryReachable() {
    for (const contact of await this.store.getContacts()) {
      if (this.transports.some((t) => t.canReach(contact.publicKey))) this.flush(contact.publicKey);
    }
  }

  /** Resolves once every queued delivery and receive has settled. */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  track(promise) {
    this.inflight.add(promise);
    promise.finally(() => this.inflight.delete(promise));
    return promise;
  }

  // Contacts

  async listContacts() {
    const contacts = await this.store.getContacts();
    return contacts.sort((a, b) => (b.lastTs || b.addedAt) - (a.lastTs || a.addedAt));
  }

  async addContact(publicKey, name = '') {
    if (publicKey === this.publicKey) throw new Error('self');
    const existing = await this.store.getContact(publicKey);
    const contact = existing || { publicKey, addedAt: this.now(), unread: 0 };
    if (cleanName(name)) contact.name = cleanName(name);
    contact.name = contact.name || '';
    contact.request = false;
    await this.store.putContact(contact);
    this.emit('contacts');
    for (const transport of this.transports) transport.contactsChanged?.();
    this.flush(publicKey);
    return contact;
  }

  async renameContact(publicKey, name) {
    const contact = await this.store.getContact(publicKey);
    if (!contact) return;
    contact.name = cleanName(name);
    await this.store.putContact(contact);
    this.emit('contacts');
  }

  async removeContact(publicKey) {
    await this.store.deleteContact(publicKey);
    this.emit('contacts');
    for (const transport of this.transports) transport.contactsChanged?.();
  }

  async touchContact(peer, message, unreadDelta = 0) {
    const contact = await this.store.getContact(peer);
    if (!contact) return;
    contact.lastTs = Math.max(contact.lastTs || 0, message.ts);
    contact.lastPreview = message.body.slice(0, 80);
    contact.unread = Math.max(0, (contact.unread || 0) + unreadDelta);
    await this.store.putContact(contact);
    this.emit('contacts');
  }

  // Sending

  async sendMessage(peer, text) {
    const body = String(text || '').trim();
    if (!body) return null;
    if (body.length > MAX_BODY) throw new Error('too-long');
    if (!(await this.store.getContact(peer))) await this.addContact(peer);
    const message = { id: randomId(), peer, dir: 'out', body, ts: this.now(), status: 'pending', via: null };
    await this.store.putMessage(message);
    await this.touchContact(peer, message);
    this.emit('message', message);
    this.flush(peer, { force: true });
    return message;
  }

  async markRead(peer) {
    const messages = await this.store.listMessages(peer);
    let changed = false;
    for (const message of messages) {
      if (message.dir === 'in' && !message.readAt) {
        message.readAt = this.now();
        await this.store.putMessage(message);
        changed = true;
      }
    }
    const contact = await this.store.getContact(peer);
    if (contact && contact.unread) {
      contact.unread = 0;
      await this.store.putContact(contact);
      this.emit('contacts');
    }
    if (changed) this.flush(peer);
  }

  /** Queues a delivery attempt for everything still owed to `peer`. Attempts for one peer never overlap. */
  flush(peer, { force = false } = {}) {
    const previous = this.flushing.get(peer) || Promise.resolve();
    const next = previous.then(() => this.deliver(peer, force)).catch((err) => console.error(err));
    this.flushing.set(peer, next);
    return this.track(next);
  }

  async deliver(peer, force) {
    const messages = await this.store.listMessages(peer);
    const now = this.now();
    for (const message of messages) {
      if (message.dir !== 'out' || STATUS_RANK[message.status] >= STATUS_RANK.delivered) continue;
      if (message.status === 'sent' && !force && now - (message.lastTry || 0) < RESEND_AFTER) continue;
      const packet = encodePacket(await seal(this.identity, peer, this.payloadFor(message)));
      message.lastTry = now;
      const via = await this.transmit(peer, packet);
      if (via) {
        if (message.status === 'pending') Object.assign(message, { status: 'sent', via });
      } else if (this.settings.storeOnRelays && !message.relayStored) {
        for (const transport of this.transports) {
          if (transport.sendStored && (await transport.sendStored(peer, packet))) {
            Object.assign(message, { relayStored: true, status: 'sent', via: `${transport.name}-stored` });
            break;
          }
        }
      }
      await this.store.putMessage(message);
      this.emit('status', message);
    }

    const unacked = messages.filter((m) => m.dir === 'in' && !m.ackSent);
    if (unacked.length && (await this.sendControl(peer, { k: 'ack', ids: unacked.map((m) => m.id) }))) {
      for (const message of unacked) {
        message.ackSent = true;
        await this.store.putMessage(message);
      }
    }

    const unsentReads = messages.filter((m) => m.dir === 'in' && m.readAt && !m.readSent);
    if (unsentReads.length && (await this.sendControl(peer, { k: 'read', ids: unsentReads.map((m) => m.id) }))) {
      for (const message of unsentReads) {
        message.readSent = true;
        await this.store.putMessage(message);
      }
    }

    await this.handOverCarried(peer);
  }

  payloadFor(message) {
    return { k: 'msg', id: message.id, ts: message.ts, body: message.body, nm: this.name };
  }

  async transmit(peer, packetText, only) {
    for (const transport of this.transports) {
      if (only && transport.name !== only) continue;
      if (!transport.canReach(peer)) continue;
      try {
        if (await transport.send(peer, packetText)) return transport.name;
      } catch (err) {
        console.warn(`[${transport.name}]`, err);
      }
    }
    return null;
  }

  async sendControl(peer, payload, only) {
    return this.transmit(peer, encodePacket(await seal(this.identity, peer, payload, 0)), only);
  }

  sendHello(peer, via) {
    return this.track(this.sendControl(peer, { k: 'hello', nm: this.name }, via));
  }

  sendSignal(peer, data, via) {
    return this.track(this.sendControl(peer, { k: 'sig', d: data }, via));
  }

  /** Fresh packets for every undelivered message to `peer`, for carrying out of band (QR codes). */
  async exportPending(peer) {
    const messages = await this.store.listMessages(peer);
    const packets = [];
    for (const message of messages) {
      if (message.dir === 'out' && STATUS_RANK[message.status] < STATUS_RANK.delivered) {
        packets.push(encodePacket(await seal(this.identity, peer, this.payloadFor(message))));
      }
    }
    return packets;
  }

  // Receiving

  /** Returns 'message' | 'control' | 'carried' | 'duplicate' | 'invalid'. */
  receivePacket(text, via) {
    const result = this.receiving.then(() => this.handlePacket(text, via));
    this.receiving = result.catch(() => {});
    return this.track(result);
  }

  async handlePacket(text, via) {
    const packet = decodePacket(text);
    if (!packet || packet.f === this.publicKey) return 'invalid';
    const id = packetId(packet);
    if (await this.store.hasSeen(id)) return 'duplicate';
    await this.store.markSeen(id, this.now());

    if (packet.t !== this.publicKey) return this.carry(packet, id);

    let payload;
    try {
      payload = await open(this.identity, packet);
    } catch {
      return 'invalid';
    }
    const peer = packet.f;
    switch (payload && payload.k) {
      case 'msg':
        return this.handleMessage(peer, payload, via);
      case 'ack':
      case 'read':
        await this.handleReceipt(peer, payload);
        return 'control';
      case 'hello': {
        const contact = await this.store.getContact(peer);
        if (contact && !contact.name && cleanName(payload.nm)) {
          contact.name = cleanName(payload.nm);
          await this.store.putContact(contact);
          this.emit('contacts');
        }
        this.peerAvailable(peer, via);
        return 'control';
      }
      case 'sig':
        this.emit('signal', { peer, data: payload.d, via });
        return 'control';
      default:
        return 'invalid';
    }
  }

  async handleMessage(peer, payload, via) {
    const valid =
      typeof payload.id === 'string' && payload.id.length <= 64 &&
      typeof payload.body === 'string' && payload.body.length <= MAX_BODY &&
      Number.isFinite(payload.ts);
    if (!valid) return 'invalid';

    const existing = await this.store.getMessage(payload.id);
    if (existing && existing.peer !== peer) return 'invalid';
    if (!existing) {
      let contact = await this.store.getContact(peer);
      if (!contact) {
        contact = { publicKey: peer, name: cleanName(payload.nm), addedAt: this.now(), unread: 0, request: true };
        await this.store.putContact(contact);
        for (const transport of this.transports) transport.contactsChanged?.();
      } else if (!contact.name && cleanName(payload.nm)) {
        contact.name = cleanName(payload.nm);
        await this.store.putContact(contact);
      }
      const now = this.now();
      const message = {
        id: payload.id,
        peer,
        dir: 'in',
        body: payload.body,
        ts: Math.min(payload.ts, now),
        receivedAt: now,
        status: 'received',
        via,
      };
      await this.store.putMessage(message);
      await this.touchContact(peer, message, 1);
      this.emit('message', message);
    } else if (existing.ackSent) {
      existing.ackSent = false;
      await this.store.putMessage(existing);
    }
    this.flush(peer);
    return existing ? 'duplicate' : 'message';
  }

  async handleReceipt(peer, payload) {
    const target = payload.k === 'read' ? 'read' : 'delivered';
    for (const id of Array.isArray(payload.ids) ? payload.ids.slice(0, 500) : []) {
      const message = await this.store.getMessage(id);
      if (!message || message.dir !== 'out' || message.peer !== peer) continue;
      if (STATUS_RANK[message.status] >= STATUS_RANK[target]) continue;
      message.status = target;
      await this.store.putMessage(message);
      this.emit('status', message);
    }
  }

  /** A transport learned that `peer` is reachable right now: deliver what is owed to them. */
  peerAvailable(peer, via) {
    if (peer === this.publicKey) return;
    this.emit('presence', { peer, via, at: this.now() });
    this.flush(peer);
    if (this.transport(via)?.local) this.track(this.shareWithNeighbor(peer, via));
  }

  // Mesh: carrying packets for others

  async carry(packet, id) {
    if (!this.settings.carryForOthers || packet.h <= 0) return 'invalid';
    const entry = { id, to: packet.t, from: packet.f, packet: { ...packet, h: packet.h - 1 }, at: this.now() };
    await this.store.putCarried(entry);
    const carried = await this.store.getCarried();
    if (carried.length > CARRY_LIMIT) {
      carried.sort((a, b) => a.at - b.at);
      for (const old of carried.slice(0, carried.length - CARRY_LIMIT)) await this.store.deleteCarried(old.id);
    }
    this.emit('carried', { count: Math.min(carried.length, CARRY_LIMIT) });
    this.flush(packet.t);
    return 'carried';
  }

  async handOverCarried(peer) {
    for (const entry of await this.store.getCarried()) {
      if (entry.to !== peer) continue;
      if (await this.transmit(peer, encodePacket(entry.packet))) await this.store.deleteCarried(entry.id);
    }
  }

  /** On a direct local link, hand the neighbour everything we hold for other people so it can carry it on. */
  async shareWithNeighbor(neighbor, via) {
    const transport = this.transport(via);
    if (!transport || !transport.canReach(neighbor)) return;
    for (const entry of await this.store.getCarried()) {
      if (entry.to === neighbor || entry.from === neighbor || entry.packet.h <= 0) continue;
      await transport.send(neighbor, encodePacket(entry.packet));
    }
    for (const contact of await this.store.getContacts()) {
      if (contact.publicKey === neighbor) continue;
      for (const message of await this.store.listMessages(contact.publicKey)) {
        if (message.dir !== 'out' || STATUS_RANK[message.status] >= STATUS_RANK.delivered) continue;
        const packet = await seal(this.identity, contact.publicKey, this.payloadFor(message), DEFAULT_HOPS);
        await transport.send(neighbor, encodePacket(packet));
      }
    }
  }

  async prune() {
    const now = this.now();
    for (const entry of await this.store.getCarried()) {
      if (now - entry.at > CARRY_TTL) await this.store.deleteCarried(entry.id);
    }
    await this.store.pruneSeen(now - SEEN_TTL);
  }
}
