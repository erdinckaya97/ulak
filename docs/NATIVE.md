# Turning ulak into an app

The web app already works offline-first, but a browser has hard limits: it cannot advertise over
Bluetooth, cannot use Wi-Fi Direct, and stops running when the tab is closed. A native shell
removes those limits. This guide covers the two common routes and how to add a Bluetooth mesh.

## Route 1: wrap the web app (fastest)

[Capacitor](https://capacitorjs.com) puts the existing files into an Android/iOS app.

```sh
npm init -y                       # in a fresh folder, or keep ulak's package.json
npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init ulak com.example.ulak --web-dir .
npx cap add android
npx cap add ios
npx cap sync
npx cap open android              # build and run from Android Studio
```

Keep `--web-dir` pointing at a folder that contains only the app files (`index.html`, `styles.css`,
`sw.js`, `manifest.webmanifest`, `icons/`, `src/`, `vendor/`); copy them into `www/` if you prefer.
Camera permission is needed for QR scanning (`NSCameraUsageDescription` on iOS, `CAMERA` on Android).

Tauri (desktop) and Electron work the same way: load `index.html` and you are done.

## Route 2: reuse the core in your own UI

These files have no DOM dependencies and run in React Native (with a WebCrypto polyfill such as
`react-native-quick-crypto`), Node.js, Deno and Bun:

- `src/identity.js`: words → keys → IDs
- `src/packet.js`: encrypt / decrypt / validate packets
- `src/messenger.js`: outbox, receipts, de-duplication, mesh carry
- `src/nostr.js`: relays (needs a `WebSocket` implementation)
- `src/store-memory.js`: reference storage; implement the same methods over SQLite or MMKV

```js
import { identityFromMnemonic } from './src/identity.js';
import { Messenger } from './src/messenger.js';
import { NostrTransport, DEFAULT_RELAYS } from './src/nostr.js';
import { MemoryStore } from './src/store-memory.js';

const identity = await identityFromMnemonic('twelve words …');
const messenger = new Messenger({ identity, store: new MemoryStore(), name: 'Ayşe' });
messenger.addTransport(new NostrTransport({ relays: DEFAULT_RELAYS }));
messenger.on('message', (m) => console.log(m.dir, m.body));
messenger.on('status', (m) => console.log(m.id, m.status)); // pending → sent → delivered → read
await messenger.start();
await messenger.sendMessage(peerPublicKey, 'hello');
```

## The transport interface

A transport is any object with these members. The messenger tries transports in `priority` order
(lower first) and stops at the first `send` that returns `true`.

```js
class MyTransport {
  name = 'ble';        // shown in the UI as the delivery path
  priority = 0;        // 0 nearby links, 1 direct internet, 2 relays
  local = true;        // true if peers on this transport are physically nearby (enables mesh hand-over)

  attach(messenger) { this.messenger = messenger; }
  async start() {}
  async stop() {}

  canReach(publicKey) { /* is there an open link to this peer right now? */ }
  async send(publicKey, packetText) { /* deliver one packet; return true on success */ }

  // optional
  async sendStored(publicKey, packetText) {} // hand to a third party that stores it for later
  contactsChanged() {}                        // contact list changed
}
```

Report events back to the messenger:

- `messenger.receivePacket(packetText, this.name)` for every packet that arrives.
- `messenger.peerAvailable(publicKey, this.name)` when a link to a peer opens. This flushes the
  outbox for that peer and, for `local` transports, hands over carried mesh packets.

A packet is a JSON string up to 64 KiB, usually under 1 KiB for a chat message. Treat it as
opaque bytes; encryption and validation are already done by the messenger.

## Bluetooth LE mesh

Each phone acts as both a BLE peripheral (advertising a ulak service) and a central (scanning for it).
When two phones meet, they open a GATT connection, exchange public keys, and then swap packets.
The messenger handles the rest: it delivers the outbox, hands over carried packets, and the
receivers forward them further until the hop budget runs out.

Suggested GATT layout:

| item | UUID | notes |
| --- | --- | --- |
| service | `6c9a0001-8f2b-4e4b-9b1a-756c616b0001` | advertised; scan with this filter |
| `id` characteristic | `6c9a0002-8f2b-4e4b-9b1a-756c616b0001` | read: 32-byte public key |
| `rx` characteristic | `6c9a0003-8f2b-4e4b-9b1a-756c616b0001` | write without response: packet frames to this device |
| `tx` characteristic | `6c9a0004-8f2b-4e4b-9b1a-756c616b0001` | notify: packet frames from this device |

BLE writes are small (20 to 512 bytes depending on MTU), so split each packet into frames:

```
frame = [ msgId (2 bytes) | index (1 byte) | count (1 byte) | data … ]
```

Skeleton for Capacitor using [`@capacitor-community/bluetooth-le`](https://github.com/capacitor-community/bluetooth-le)
for the central role. The peripheral role (advertising and a GATT server) needs a small native plugin
on Android (`BluetoothLeAdvertiser` + `BluetoothGattServer`) and iOS (`CBPeripheralManager`).

```js
import { BleClient } from '@capacitor-community/bluetooth-le';
import { hex } from '../vendor/crypto.js';

const SERVICE = '6c9a0001-8f2b-4e4b-9b1a-756c616b0001';
const ID = '6c9a0002-8f2b-4e4b-9b1a-756c616b0001';
const RX = '6c9a0003-8f2b-4e4b-9b1a-756c616b0001';
const TX = '6c9a0004-8f2b-4e4b-9b1a-756c616b0001';
const FRAME = 180; // payload bytes per frame; stay under the negotiated MTU

export class BleTransport {
  name = 'ble';
  priority = 0;
  local = true;
  links = new Map(); // publicKey -> deviceId
  inbox = new Map(); // deviceId:msgId -> frames

  attach(messenger) { this.messenger = messenger; }

  async start() {
    await BleClient.initialize();
    await BleClient.requestLEScan({ services: [SERVICE], allowDuplicates: false }, (result) =>
      this.connect(result.device.deviceId).catch(() => {}),
    );
  }

  async connect(deviceId) {
    if ([...this.links.values()].includes(deviceId)) return;
    await BleClient.connect(deviceId, () => this.forget(deviceId));
    const peer = hex.encode(new Uint8Array((await BleClient.read(deviceId, SERVICE, ID)).buffer));
    if (peer === this.messenger.publicKey) return BleClient.disconnect(deviceId);
    await BleClient.startNotifications(deviceId, SERVICE, TX, (value) => this.onFrame(deviceId, value));
    this.links.set(peer, deviceId);
    this.messenger.peerAvailable(peer, this.name);
  }

  canReach(peer) { return this.links.has(peer); }

  async send(peer, packetText) {
    const deviceId = this.links.get(peer);
    if (!deviceId) return false;
    const bytes = new TextEncoder().encode(packetText);
    const count = Math.ceil(bytes.length / FRAME);
    if (count > 255) return false;
    const msgId = Math.floor(Math.random() * 65536);
    for (let i = 0; i < count; i++) {
      const chunk = bytes.subarray(i * FRAME, (i + 1) * FRAME);
      const frame = new Uint8Array(4 + chunk.length);
      frame.set([msgId >> 8, msgId & 255, i, count]);
      frame.set(chunk, 4);
      await BleClient.writeWithoutResponse(deviceId, SERVICE, RX, new DataView(frame.buffer));
    }
    return true;
  }

  onFrame(deviceId, view) {
    const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const key = `${deviceId}:${(data[0] << 8) | data[1]}`;
    const frames = this.inbox.get(key) || [];
    frames[data[2]] = data.slice(4);
    this.inbox.set(key, frames);
    if (frames.filter(Boolean).length !== data[3]) return;
    this.inbox.delete(key);
    const total = frames.reduce((n, f) => n + f.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const f of frames) bytes.set(f, (offset += f.length) - f.length);
    this.messenger.receivePacket(new TextDecoder().decode(bytes), this.name);
  }

  forget(deviceId) {
    for (const [peer, id] of this.links) if (id === deviceId) this.links.delete(peer);
  }

  async stop() {
    await BleClient.stopLEScan();
    for (const deviceId of this.links.values()) await BleClient.disconnect(deviceId).catch(() => {});
    this.links.clear();
  }
}
```

Register it next to the others in `src/app.js`:

```js
messenger.addTransport(new BleTransport());
```

Your native peripheral must do the mirror image: serve the `id` characteristic, reassemble frames
written to `rx` and pass them to `receivePacket`, and send outgoing frames as `tx` notifications.

### Other offline transports

The same interface fits:

- **Wi-Fi Aware / Wi-Fi Direct** (Android): higher bandwidth than BLE, longer range.
- **Multipeer Connectivity** (iOS): Bluetooth + peer-to-peer Wi-Fi in one API.
- **LoRa** (e.g. Meshtastic radios over serial/BLE): kilometers of range at very low bandwidth;
  keep messages short and raise `DEFAULT_HOPS` with care.

### Testing a transport

`tests/helpers.js` contains `FakeLocalLinks`, an in-memory local transport. Copy one of the mesh tests
in `tests/messenger.test.js` and swap in your transport (or a fake with the same timing and size limits)
to check that messages hop between three devices that never meet the recipient at the same time.

On real phones, test with Wi-Fi and mobile data turned off:

1. A and C are contacts; B is a stranger with "carry for others" on.
2. A meets B, then walks away. B meets C. C should receive A's message, and A should see ✓✓
   the next time it meets B or C.

## Background delivery

A closed app cannot deliver its outbox. Options, from simple to thorough:

- Run `messenger.flush(peer)` for all contacts when the app returns to the foreground.
- Use background fetch (iOS `BGAppRefreshTask`, Android `WorkManager`) to connect to relays for a few seconds.
- Keep a foreground service with the BLE scanner on Android for disaster mode.
- Turn on "store on relays" so recipients get messages even after the sender goes offline.
