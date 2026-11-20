import { secp256k1, hkdf, sha256, hex } from '../vendor/crypto.js';
import { utf8, fromUtf8, toBase64, fromBase64, randomBytes, HEX64 } from './util.js';

export const PROTOCOL_VERSION = 1;
export const MAX_PACKET_BYTES = 64 * 1024;
export const DEFAULT_HOPS = 4;

const keyCache = new Map();

function sharedSecret(identity, peerPublicKey) {
  const point = secp256k1.getSharedSecret(identity.secretKey, hex.decode('02' + peerPublicKey));
  const [first, second] = [identity.publicKey, peerPublicKey].sort();
  return hkdf(sha256, point.slice(1), utf8('ulak/v1'), utf8(`dm/${first}/${second}`), 32);
}

async function aesKey(identity, peerPublicKey) {
  const cacheKey = identity.publicKey + peerPublicKey;
  if (!keyCache.has(cacheKey)) {
    const raw = sharedSecret(identity, peerPublicKey);
    keyCache.set(cacheKey, crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return keyCache.get(cacheKey);
}

const additionalData = (from, to) => utf8(`ulak/v${PROTOCOL_VERSION}|${from}|${to}`);

/**
 * Encrypts a payload for one recipient. The outer packet only reveals sender and recipient
 * public keys; `h` is a hop budget that relaying devices decrement and is not authenticated.
 */
export async function seal(identity, to, payload, hops = DEFAULT_HOPS) {
  const iv = randomBytes(12);
  const key = await aesKey(identity, to);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(identity.publicKey, to) },
    key,
    utf8(JSON.stringify(payload)),
  );
  return { v: PROTOCOL_VERSION, f: identity.publicKey, t: to, n: toBase64(iv), c: toBase64(new Uint8Array(cipher)), h: hops };
}

/** Decrypts a packet addressed to `identity`. Throws if it was not, or if it was tampered with. */
export async function open(identity, packet) {
  if (packet.t !== identity.publicKey) throw new Error('not-for-me');
  const key = await aesKey(identity, packet.f);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(packet.n), additionalData: additionalData(packet.f, packet.t) },
    key,
    fromBase64(packet.c),
  );
  return JSON.parse(fromUtf8(new Uint8Array(plain)));
}

export function encodePacket(packet) {
  return JSON.stringify(packet);
}

export function decodePacket(text) {
  if (typeof text !== 'string' || text.length > MAX_PACKET_BYTES) return null;
  let packet;
  try {
    packet = JSON.parse(text);
  } catch {
    return null;
  }
  if (!packet || packet.v !== PROTOCOL_VERSION) return null;
  if (!HEX64.test(packet.f) || !HEX64.test(packet.t) || packet.f === packet.t) return null;
  if (typeof packet.n !== 'string' || packet.n.length !== 16) return null;
  if (typeof packet.c !== 'string' || !packet.c) return null;
  packet.h = Number.isInteger(packet.h) ? Math.max(0, Math.min(packet.h, 16)) : 0;
  return packet;
}

/** Stable identifier of a packet across hops, used to drop duplicates in the mesh. */
export function packetId(packet) {
  return `${packet.f.slice(0, 16)}:${packet.n}`;
}
