const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text) => encoder.encode(text);
export const fromUtf8 = (bytes) => decoder.decode(bytes);

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomId() {
  return Array.from(randomBytes(12), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const HEX64 = /^[0-9a-f]{64}$/;

export class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }

  emit(type, detail) {
    for (const fn of this.listeners.get(type) || []) {
      try {
        fn(detail);
      } catch (err) {
        console.error(err);
      }
    }
  }
}
