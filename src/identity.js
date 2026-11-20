import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  wordlist,
  schnorr,
  secp256k1,
  hkdf,
  sha256,
  bech32,
  hex,
} from '../vendor/crypto.js';
import { utf8, HEX64 } from './util.js';

export const ID_PREFIX = 'ulak';
export const WORD_COUNT = 12;

export function createMnemonic() {
  return generateMnemonic(wordlist, 128);
}

export function normalizeMnemonic(input) {
  return String(input || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

export function isValidMnemonic(input) {
  const words = normalizeMnemonic(input);
  return words.split(' ').length === WORD_COUNT && validateMnemonic(words, wordlist);
}

export function isMnemonicWord(word) {
  return wordlist.includes(word);
}

export async function identityFromMnemonic(input) {
  const words = normalizeMnemonic(input);
  if (!isValidMnemonic(words)) throw new Error('invalid-mnemonic');
  return identityFromSeed(await mnemonicToSeed(words));
}

export function identityFromSeed(seed) {
  for (let counter = 0; counter < 256; counter++) {
    const secretKey = hkdf(sha256, seed, utf8('ulak'), utf8(`identity/v1/${counter}`), 32);
    if (secp256k1.utils.isValidSecretKey(secretKey)) return identityFromSecretKey(secretKey);
  }
  throw new Error('key-derivation-failed');
}

export function identityFromSecretKey(secretKey) {
  const publicKey = hex.encode(schnorr.getPublicKey(secretKey));
  return { secretKey, publicKey, id: encodeId(publicKey) };
}

export function encodeId(publicKey) {
  return bech32.encode(ID_PREFIX, bech32.toWords(hex.decode(publicKey)));
}

export function isValidPublicKey(publicKey) {
  if (!HEX64.test(publicKey)) return false;
  try {
    secp256k1.Point.fromHex('02' + publicKey);
    return true;
  } catch {
    return false;
  }
}

/** Accepts an `ulak1…` ID or a 64-char hex public key. Returns the hex public key or null. */
export function decodeId(input) {
  const text = String(input || '').trim().toLowerCase();
  let publicKey = null;
  if (HEX64.test(text)) {
    publicKey = text;
  } else {
    try {
      const { prefix, words } = bech32.decode(text);
      if (prefix !== ID_PREFIX) return null;
      publicKey = hex.encode(bech32.fromWords(words));
    } catch {
      return null;
    }
  }
  return isValidPublicKey(publicKey) ? publicKey : null;
}

export function shortId(publicKeyOrId) {
  const id = publicKeyOrId.startsWith(ID_PREFIX + '1') ? publicKeyOrId : encodeId(publicKeyOrId);
  return `${id.slice(0, 9)}…${id.slice(-4)}`;
}

/** Four words both people see identically; comparing them in person rules out a swapped ID. */
export function safetyWords(publicKeyA, publicKeyB) {
  const [first, second] = [publicKeyA, publicKeyB].sort();
  const digest = sha256(utf8(`ulak/safety/${first}${second}`));
  const words = [];
  for (let i = 0; i < 4; i++) {
    words.push(wordlist[((digest[i * 2] << 8) | digest[i * 2 + 1]) % wordlist.length]);
  }
  return words;
}
