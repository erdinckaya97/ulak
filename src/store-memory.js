/**
 * In-memory implementation of the storage interface the messenger expects.
 * `store-idb.js` implements the same methods on IndexedDB; native forks can back it with SQLite.
 */
export class MemoryStore {
  constructor() {
    this.contacts = new Map();
    this.messages = new Map();
    this.carried = new Map();
    this.seen = new Map();
    this.settings = new Map();
  }

  async getContacts() {
    return [...this.contacts.values()].map(clone);
  }

  async getContact(publicKey) {
    return clone(this.contacts.get(publicKey));
  }

  async putContact(contact) {
    this.contacts.set(contact.publicKey, clone(contact));
  }

  async deleteContact(publicKey) {
    this.contacts.delete(publicKey);
    for (const [id, message] of this.messages) {
      if (message.peer === publicKey) this.messages.delete(id);
    }
  }

  async getMessage(id) {
    return clone(this.messages.get(id));
  }

  async putMessage(message) {
    this.messages.set(message.id, clone(message));
  }

  async listMessages(peer) {
    return [...this.messages.values()]
      .filter((m) => m.peer === peer)
      .sort((a, b) => a.ts - b.ts)
      .map(clone);
  }

  async getCarried() {
    return [...this.carried.values()].map(clone);
  }

  async putCarried(entry) {
    this.carried.set(entry.id, clone(entry));
  }

  async deleteCarried(id) {
    this.carried.delete(id);
  }

  async hasSeen(id) {
    return this.seen.has(id);
  }

  async markSeen(id, at) {
    this.seen.set(id, at);
  }

  async pruneSeen(before) {
    for (const [id, at] of this.seen) if (at < before) this.seen.delete(id);
  }

  async getSetting(key, fallback) {
    return this.settings.has(key) ? clone(this.settings.get(key)) : fallback;
  }

  async setSetting(key, value) {
    this.settings.set(key, clone(value));
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
