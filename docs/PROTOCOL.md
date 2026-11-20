# ulak protocol, version 1

This document describes everything that goes over the wire, so that other clients (native apps,
bots, command-line tools) can talk to the reference web app.

## Identity

1. The account is a 12-word BIP39 mnemonic (English wordlist, empty passphrase).
2. `seed = BIP39-seed(mnemonic)` (PBKDF2-HMAC-SHA512, 2048 rounds, 64 bytes).
3. `secretKey = HKDF-SHA256(ikm = seed, salt = "ulak", info = "identity/v1/0", length = 32)`.
   If the result is not a valid secp256k1 secret key, increment the counter (`identity/v1/1`, ...).
   Words are normalized first: NFKD, lowercase, single spaces.
4. `publicKey` is the 32-byte x-only (BIP340) public key, written as 64 lowercase hex characters.
5. The human-facing ID is `bech32("ulak", publicKey)`, e.g. `ulak1jqu8m6kr…kegh`.
   Clients should also accept the raw hex form.

The same key pair is used as the Nostr key, so presence and packets are signed by the account itself.

**Safety words:** sort the two hex public keys as `a < b`, `h = sha256(utf8("ulak/safety/" + a + b))`.
For `i = 0..3`, word `i` is `wordlist[((h[2i] << 8) | h[2i+1]) mod 2048]` from the BIP39 English list.

**Contact link:** `https://<app>/#add=<ulak1…>&n=<url-encoded name>`. The name is a suggestion only.

## Encryption

```
shared   = x-coordinate of ECDH(mySecret, 0x02 || peerPublicKey)          (32 bytes)
key      = HKDF-SHA256(ikm = shared, salt = "ulak/v1", info = "dm/<lowerHex>/<higherHex>", 32)
aad      = utf8("ulak/v1|<fromHex>|<toHex>")
cipher   = AES-256-GCM(key, iv = 12 random bytes, aad, utf8(JSON(payload)))
```

Both directions use the same key; the random IV must never repeat (12 random bytes per packet).

## Packet

A packet is a UTF-8 JSON object, at most 64 KiB:

```json
{ "v": 1, "f": "<sender hex>", "t": "<recipient hex>", "n": "<iv, base64>", "c": "<ciphertext+tag, base64>", "h": 4 }
```

| field | meaning |
| --- | --- |
| `v` | protocol version, always `1` |
| `f`, `t` | sender and recipient public keys (hex) |
| `n` | IV, standard base64 (16 characters) |
| `c` | AES-GCM output including the 16-byte tag, standard base64 |
| `h` | hop budget for the mesh, 0 to 16. **Not authenticated.** |

The packet ID used for de-duplication is `f.slice(0, 16) + ":" + n`. Receivers drop packets whose
ID they have already seen (kept for 14 days).

## Payloads

The decrypted payload is a JSON object with a kind `k`:

| `k` | fields | meaning |
| --- | --- | --- |
| `msg` | `id` (string ≤ 64), `ts` (ms since epoch), `body` (≤ 4000 chars), `nm` (sender's display name, optional) | a chat message |
| `ack` | `ids` (array of message IDs) | these messages reached the device |
| `read` | `ids` | these messages were opened |
| `hello` | `nm` | sent when a direct link opens; carries the display name |
| `sig` | `d` (object) | WebRTC signaling, see below |

Rules:

- A message is resent with the **same `id`** (new IV, new packet) until an `ack` arrives.
  Receivers must treat a repeated `id` as a duplicate and answer it with another `ack`.
- `msg` packets are created with `h = 4`. Control payloads (`ack`, `read`, `hello`, `sig`) use `h = 0`
  so they are never carried by the mesh.
- A `msg` from an unknown sender creates a *message request*; the UI asks before replying.
- Receivers clamp `ts` to their own clock.

## Mesh carry

A device that receives a packet whose `t` is not itself may, if the user allows it:

1. drop it if `h == 0` or it was seen before,
2. store a copy with `h - 1` (at most 500 packets, 7 days),
3. hand it to the recipient when it becomes reachable over any transport, and
4. on a *local* link (nearby device), hand all carried packets to the neighbor, except those
   addressed to or sent by that neighbor.

When it meets a neighbor, a device also gives that neighbor fresh copies of its own undelivered messages.

## Transports

### Nostr relays

Standard [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) events signed with the account key.

| kind | type | tags | content | use |
| --- | --- | --- | --- | --- |
| `21211` | ephemeral | none | empty | presence beacon, every 40 s. A peer counts as online for 95 s after any event signed by them. |
| `21210` | ephemeral | `["p", <recipient hex>]` | packet JSON | live delivery |
| `4210` | regular | `["p", …]`, `["expiration", <unix s>]` (NIP-40, 7 days) | packet JSON | optional store-and-forward while the recipient is offline |

Clients subscribe to `{kinds:[21210], "#p":[me]}`, `{kinds:[4210], "#p":[me], since:<last seen>}` and
`{kinds:[21211], authors:[contacts]}`. A send counts as successful when at least one relay answers `OK true`.

### Direct WebRTC (`p2p`)

Signaling travels as `sig` payloads through any transport that already reaches the peer:

- `{ch:"p2p", t:"ask"}`: "please make me an offer", sent by the peer with the higher public key.
- `{ch:"p2p", t:"offer", sdp}`: sent by the peer with the lower public key (string comparison of hex).
- `{ch:"p2p", t:"answer", sdp}`

ICE is not trickled: each SDP contains all candidates. Public STUN servers are used. The data
channel is labeled `ulak`, ordered, and every message on it is one packet.

### Local link (`lan`), no internet

Same data channel, but signaling is done by the users by scanning QR codes, and no ICE servers are used,
so it works on a router or hotspot without internet.

```
code   = "ULAK1:" + mode + base64url(data)
mode   = "z" (data = deflate-raw(JSON)) | "j" (data = JSON)
JSON   = { "t": "o" | "a", "k": <sender public key hex>, "s": <sdp> }
```

`o` is the invite (offer) shown by the first device, `a` the answer shown back by the second.

### QR packets

With no network at all, each undelivered message can be shown as a QR code that contains the
packet JSON as-is. The recipient scans it and handles it like any received packet; when the two
devices can talk again, the `ack` flows back normally.

## Versioning

A future incompatible change will use `v: 2`, a new HKDF label (`ulak/v2`) and a new signal prefix (`ULAK2:`).
Clients must ignore packets with an unknown `v`.
