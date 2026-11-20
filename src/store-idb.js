/** IndexedDB storage, one database per identity. Same interface as MemoryStore. */
export class IdbStore {
  static async open(publicKey) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(`ulak-${publicKey.slice(0, 20)}`, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('contacts', { keyPath: 'publicKey' });
        db.createObjectStore('messages', { keyPath: 'id' }).createIndex('peer', 'peer');
        db.createObjectStore('carried', { keyPath: 'id' });
        db.createObjectStore('seen');
        db.createObjectStore('settings');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new IdbStore(db);
  }

  static destroy(publicKey) {
    return new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(`ulak-${publicKey.slice(0, 20)}`);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }

  constructor(db) {
    this.db = db;
  }

  run(storeName, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, mode);
      const result = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  getContacts() {
    return this.run('contacts', 'readonly', (s) => s.getAll());
  }

  getContact(publicKey) {
    return this.run('contacts', 'readonly', (s) => s.get(publicKey));
  }

  putContact(contact) {
    return this.run('contacts', 'readwrite', (s) => void s.put(contact));
  }

  async deleteContact(publicKey) {
    await this.run('contacts', 'readwrite', (s) => void s.delete(publicKey));
    const ids = await this.run('messages', 'readonly', (s) => s.index('peer').getAllKeys(publicKey));
    await this.run('messages', 'readwrite', (s) => ids.forEach((id) => s.delete(id)));
  }

  getMessage(id) {
    return this.run('messages', 'readonly', (s) => s.get(id));
  }

  putMessage(message) {
    return this.run('messages', 'readwrite', (s) => void s.put(message));
  }

  async listMessages(peer) {
    const messages = await this.run('messages', 'readonly', (s) => s.index('peer').getAll(peer));
    return messages.sort((a, b) => a.ts - b.ts);
  }

  getCarried() {
    return this.run('carried', 'readonly', (s) => s.getAll());
  }

  putCarried(entry) {
    return this.run('carried', 'readwrite', (s) => void s.put(entry));
  }

  deleteCarried(id) {
    return this.run('carried', 'readwrite', (s) => void s.delete(id));
  }

  async hasSeen(id) {
    return (await this.run('seen', 'readonly', (s) => s.getKey(id))) !== undefined;
  }

  markSeen(id, at) {
    return this.run('seen', 'readwrite', (s) => void s.put(at, id));
  }

  pruneSeen(before) {
    return this.run('seen', 'readwrite', (s) => {
      s.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        if (cursor.value < before) cursor.delete();
        cursor.continue();
      };
    });
  }

  async getSetting(key, fallback) {
    const value = await this.run('settings', 'readonly', (s) => s.get(key));
    return value === undefined ? fallback : value;
  }

  setSetting(key, value) {
    return this.run('settings', 'readwrite', (s) => void s.put(value, key));
  }
}
