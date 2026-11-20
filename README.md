# ulak

Serverless, end-to-end encrypted messaging that keeps working when the internet doesn't.

Your account is 12 words. No phone number, no email, no password, no server that owns your data.
If the person you write to is offline, the message waits on your device and leaves the moment they
come back. If there is no internet at all, two phones on the same Wi-Fi or hotspot can still talk,
and messages can be carried hand to hand by QR code.

*Ulak* is an old Turkish word for a courier who carries messages on foot or horseback.

This repository is the **reference code**, not a hosted product. It runs as a static web app (PWA)
with zero build step, and the core is written so that anyone can fork it into a mobile app,
a desktop app or their own web deployment, and plug in new transports such as Bluetooth.

## What it does

- **12-word account.** A standard BIP39 phrase. The same words open the same account on any device.
- **End-to-end encryption.** secp256k1 ECDH + HKDF-SHA256 + AES-256-GCM. Relays and anyone carrying
  a packet see only the sender and recipient public keys.
- **Offline outbox.** Messages are stored on the sender's device (IndexedDB) and delivered automatically
  when the recipient is reachable again. Delivered and read receipts (✓, ✓✓) flow back the same way.
- **Direct connections.** When both sides are online, ulak upgrades to a WebRTC data channel, so
  messages go device to device and relays only help the two find each other.
- **No internet, same network.** Two devices on one Wi-Fi router or one phone's hotspot connect
  by scanning each other's QR codes. No internet and no server are involved.
- **No network at all.** Undelivered messages can be shown as QR codes and scanned by the recipient.
- **Store-and-carry mesh.** Devices can carry encrypted packets for others (with a hop limit) and hand
  them over when they meet the recipient or another carrier. Useful after earthquakes, floods or outages.
- **10 languages.** English, Türkçe, Español, Português, Русский, العربية (RTL), हिन्दी, 中文, 日本語, 한국어.

## Run it

Requires Node.js 20 or newer. There are no dependencies to install.

```sh
git clone https://github.com/erdinckaya97/ulak.git
cd ulak
npm start          # http://localhost:8080
npm test           # unit + integration tests
```

Any static file server works too. For anything other than `localhost`, serve it over HTTPS:
the camera, WebCrypto and the service worker all require a secure context.

To try two accounts on one computer, open `http://localhost:8080` and `http://127.0.0.1:8080`
(different origins keep separate storage), create an account in each and add one another by ID.

### Deploy

Copy the folder to any static host: GitHub Pages, Netlify, Cloudflare Pages, an S3 bucket, a
Raspberry Pi. Nothing runs on the server side. The `tests`, `scripts` and `vendor/entry-*.js`
files are not needed in production.

## How delivery works

```
 you ──► outbox (your device) ──► best available path ──► recipient
                                   1. nearby link (Wi-Fi / hotspot, no internet)
                                   2. direct WebRTC (internet)
                                   3. Nostr relays (internet, ephemeral)
                                   4. optional: encrypted copy stored on relays for 7 days
                                   5. carried by other devices (mesh) or by QR code
```

Every path carries the same encrypted packet. A message stays in the outbox until the recipient's
device acknowledges it, so switching networks, closing the tab or losing power never loses it.

Relays are public [Nostr](https://nostr.com) relays used as a dumb mailbox: presence beacons,
WebRTC signaling and encrypted packets. They cannot read messages. You can change the list in
settings or run your own relay.

## Project layout

```
index.html, styles.css     UI (no framework)
src/app.js                 UI controller, storage and transport wiring
src/messenger.js           transport-agnostic core: outbox, receipts, dedup, mesh carry
src/packet.js              encryption and packet format
src/identity.js            12 words → keys → ulak1… IDs, safety words
src/nostr.js               relay pool + Nostr transport
src/rtc.js                 WebRTC transports (internet direct + offline local link)
src/store-idb.js           IndexedDB storage (store-memory.js for tests / native)
src/i18n.js, src/locales/  translations
vendor/                    bundled crypto and QR libraries
docs/PROTOCOL.md           wire format, for interoperable clients
docs/NATIVE.md             turning this into a mobile app, adding Bluetooth
```

## Fork it

The core does not know about the browser UI. To build an app:

1. Wrap the web app with [Capacitor](https://capacitorjs.com) or Tauri for a quick native shell, or
2. Reuse `src/messenger.js`, `src/packet.js` and `src/identity.js` in your own UI.

Browsers cannot advertise over Bluetooth or use Wi-Fi Direct, so true phone-to-phone mesh without
any router needs a native shell. The transport interface is small (`canReach`, `send`, and two
callbacks); [docs/NATIVE.md](docs/NATIVE.md) shows a Bluetooth LE transport skeleton and how to
test it.

To add a language, copy `src/locales/en.js`, translate the values, register it in `src/i18n.js`
and run `npm test`; the tests check that every key and placeholder is present.

## Security notes

- Anyone who has your 12 words is you. There is no recovery and no reset.
- Compare the four **safety words** in a chat with your contact in person or on a call. If they
  match, nobody swapped the ID in between.
- Message content, names and receipts are encrypted. Sender and recipient public keys, timing and
  packet sizes are visible to relays and carriers.
- There is no forward secrecy in v1: if a secret key leaks, past messages to and from it can be
  decrypted. Treat this as a resilient messenger, not as a tool against a targeted adversary.
- "Remember me" keeps the words in the browser's local storage. Leave it off on shared devices.
- The code has not been audited. Reviews are welcome.

## License

[MIT](LICENSE). Bundled libraries: `@noble/curves`, `@noble/hashes`, `@scure/bip39`,
`@scure/base`, `qrcode-generator` (MIT) and `jsQR` (Apache-2.0); versions and rebuild steps are in
[vendor/README.md](vendor/README.md).
