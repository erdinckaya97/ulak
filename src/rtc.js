import { toBase64, fromBase64, utf8, fromUtf8 } from './util.js';

export const INTERNET_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const CONNECT_TIMEOUT = 20e3;
const RETRY_COOLDOWN = 120e3;
export const SIGNAL_PREFIX = 'ULAK1:';

export const rtcSupported = () => typeof globalThis.RTCPeerConnection === 'function';

/** Waits until ICE gathering finishes (or `timeout`), so one offer/answer carries every candidate. */
function gathered(pc, timeout) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, timeout);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/** Shared bookkeeping for transports built on RTCDataChannel links, keyed by peer public key. */
class LinkTransport {
  constructor({ name, local, iceServers, gatherTimeout }) {
    this.name = name;
    this.priority = 0;
    this.local = local;
    this.iceServers = iceServers;
    this.gatherTimeout = gatherTimeout;
    this.links = new Map();
    this.onChange = () => {};
  }

  attach(messenger) {
    this.messenger = messenger;
  }

  canReach(peer) {
    return this.links.get(peer)?.channel?.readyState === 'open';
  }

  async send(peer, text) {
    const channel = this.links.get(peer)?.channel;
    if (channel?.readyState !== 'open') return false;
    channel.send(text);
    return true;
  }

  connectedPeers() {
    return [...this.links.keys()].filter((peer) => this.canReach(peer));
  }

  newConnection(peer) {
    this.close(peer);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const link = { pc, channel: null, startedAt: Date.now() };
    this.links.set(peer, link);
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed'].includes(pc.connectionState) && this.links.get(peer) === link) this.drop(peer, link);
    });
    pc.addEventListener('datachannel', (event) => this.bindChannel(peer, link, event.channel));
    return link;
  }

  bindChannel(peer, link, channel) {
    link.channel = channel;
    channel.addEventListener('open', () => this.opened(peer));
    channel.addEventListener('message', (event) => {
      if (typeof event.data === 'string') this.messenger.receivePacket(event.data, this.name);
    });
    channel.addEventListener('close', () => this.links.get(peer) === link && this.drop(peer, link));
  }

  opened(peer) {
    this.messenger.peerAvailable(peer, this.name);
    this.messenger.sendHello(peer, this.name);
    this.onChange();
  }

  drop(peer, link) {
    try {
      link.pc.close();
    } catch {}
    if (this.links.get(peer) === link) this.links.delete(peer);
    this.onChange();
  }

  close(peer) {
    const link = this.links.get(peer);
    if (link) this.drop(peer, link);
  }

  stop() {
    for (const peer of [...this.links.keys()]) this.close(peer);
  }
}

/**
 * Direct browser-to-browser links over the internet. Offers and answers travel as encrypted
 * signals through whatever transport already reaches the peer (normally Nostr). The peer with the
 * lower public key always makes the offer, so both sides never offer at once.
 */
export class DirectTransport extends LinkTransport {
  constructor({ iceServers = INTERNET_ICE } = {}) {
    super({ name: 'p2p', local: false, iceServers, gatherTimeout: 3000 });
    this.cooldown = new Map();
  }

  attach(messenger) {
    super.attach(messenger);
    messenger.on('presence', ({ peer, via }) => via === 'nostr' && this.maybeConnect(peer));
    messenger.on('signal', ({ peer, data }) => data?.ch === 'p2p' && this.onSignal(peer, data));
  }

  isInitiator(peer) {
    return this.messenger.publicKey < peer;
  }

  maybeConnect(peer) {
    if (!rtcSupported() || this.links.has(peer)) return;
    if (Date.now() - (this.cooldown.get(peer) || 0) < RETRY_COOLDOWN) return;
    this.cooldown.set(peer, Date.now());
    if (this.isInitiator(peer)) this.offer(peer);
    else this.messenger.sendSignal(peer, { ch: 'p2p', t: 'ask' });
  }

  async offer(peer) {
    const link = this.newConnection(peer);
    this.bindChannel(peer, link, link.pc.createDataChannel('ulak', { ordered: true }));
    this.expire(peer, link);
    await link.pc.setLocalDescription(await link.pc.createOffer());
    await gathered(link.pc, this.gatherTimeout);
    this.messenger.sendSignal(peer, { ch: 'p2p', t: 'offer', sdp: link.pc.localDescription.sdp });
  }

  async onSignal(peer, data) {
    if (!rtcSupported()) return;
    try {
      if (data.t === 'ask' && this.isInitiator(peer)) {
        if (!this.canReach(peer)) await this.offer(peer);
      } else if (data.t === 'offer' && !this.isInitiator(peer) && typeof data.sdp === 'string') {
        const link = this.newConnection(peer);
        this.expire(peer, link);
        await link.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await link.pc.setLocalDescription(await link.pc.createAnswer());
        await gathered(link.pc, this.gatherTimeout);
        this.messenger.sendSignal(peer, { ch: 'p2p', t: 'answer', sdp: link.pc.localDescription.sdp });
      } else if (data.t === 'answer' && typeof data.sdp === 'string') {
        const link = this.links.get(peer);
        if (link?.pc.signalingState === 'have-local-offer') {
          await link.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        }
      }
    } catch (err) {
      console.warn('[p2p]', err);
      this.close(peer);
    }
  }

  expire(peer, link) {
    setTimeout(() => {
      if (this.links.get(peer) === link && !this.canReach(peer)) this.drop(peer, link);
    }, CONNECT_TIMEOUT);
  }
}

/**
 * Links to nearby devices with no internet: both devices are on the same Wi-Fi or phone hotspot
 * and swap one offer and one answer by scanning each other's QR code (or pasting the text).
 */
export class LocalLinkTransport extends LinkTransport {
  constructor({ iceServers = [] } = {}) {
    super({ name: 'lan', local: true, iceServers, gatherTimeout: 2500 });
    this.invite = null;
  }

  /** Step 1 (device A): returns the code to show as a QR. */
  async createInvite() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const channel = pc.createDataChannel('ulak', { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, this.gatherTimeout);
    this.invite?.pc.close();
    this.invite = { pc, channel };
    return encodeSignal({ t: 'o', k: this.messenger.publicKey, s: pc.localDescription.sdp });
  }

  /** Step 2 (device B): scans A's code, returns the answer code to show back. */
  async acceptInvite(code) {
    const signal = await decodeSignal(code);
    if (signal.t !== 'o') throw new Error('not-an-invite');
    if (signal.k === this.messenger.publicKey) throw new Error('own-invite');
    const link = this.newConnection(signal.k);
    await link.pc.setRemoteDescription({ type: 'offer', sdp: signal.s });
    await link.pc.setLocalDescription(await link.pc.createAnswer());
    await gathered(link.pc, this.gatherTimeout);
    return encodeSignal({ t: 'a', k: this.messenger.publicKey, s: link.pc.localDescription.sdp });
  }

  /** Step 3 (device A): scans B's answer code; the link opens a moment later. */
  async completeInvite(code) {
    const signal = await decodeSignal(code);
    if (signal.t !== 'a') throw new Error('not-an-answer');
    if (!this.invite) throw new Error('no-invite');
    const { pc, channel } = this.invite;
    this.invite = null;
    this.close(signal.k);
    const link = { pc, channel: null, startedAt: Date.now() };
    this.links.set(signal.k, link);
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed'].includes(pc.connectionState) && this.links.get(signal.k) === link) this.drop(signal.k, link);
    });
    this.bindChannel(signal.k, link, channel);
    await pc.setRemoteDescription({ type: 'answer', sdp: signal.s });
    return signal.k;
  }

  async opened(peer) {
    if (!(await this.messenger.store.getContact(peer))) await this.messenger.addContact(peer);
    super.opened(peer);
  }

  stop() {
    this.invite?.pc.close();
    this.invite = null;
    super.stop();
  }
}

/** Compact text form of an offer/answer for QR codes: deflate + base64url when available. */
export async function encodeSignal(signal) {
  const json = JSON.stringify(signal);
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([utf8(json)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    return `${SIGNAL_PREFIX}z${toBase64Url(bytes)}`;
  }
  return `${SIGNAL_PREFIX}j${toBase64Url(utf8(json))}`;
}

export async function decodeSignal(code) {
  const text = String(code || '').trim();
  if (!text.startsWith(SIGNAL_PREFIX)) throw new Error('not-a-signal');
  const mode = text[SIGNAL_PREFIX.length];
  let bytes = fromBase64Url(text.slice(SIGNAL_PREFIX.length + 1));
  if (mode === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (mode !== 'j') {
    throw new Error('not-a-signal');
  }
  const signal = JSON.parse(fromUtf8(bytes));
  if (!['o', 'a'].includes(signal.t) || !/^[0-9a-f]{64}$/.test(signal.k) || typeof signal.s !== 'string') {
    throw new Error('not-a-signal');
  }
  return signal;
}

const toBase64Url = (bytes) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (text) => fromBase64(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
