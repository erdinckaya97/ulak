# Vendored libraries

`crypto.js` and `qr.js` are single-file ES module bundles, so the app runs without a build step.

| bundle | package | version | license |
| --- | --- | --- | --- |
| `crypto.js` | [@noble/curves](https://github.com/paulmillr/noble-curves) | 2.4.0 | MIT, (c) Paul Miller |
| `crypto.js` | [@noble/hashes](https://github.com/paulmillr/noble-hashes) | 2.4.0 | MIT, (c) Paul Miller |
| `crypto.js` | [@scure/bip39](https://github.com/paulmillr/scure-bip39) | 2.4.0 | MIT, (c) Paul Miller |
| `crypto.js` | [@scure/base](https://github.com/paulmillr/scure-base) | 2.4.0 | MIT, (c) Paul Miller |
| `qr.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 2.0.4 | MIT, (c) Kazuhiko Arase |
| `qr.js` | [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | Apache-2.0, (c) Cosmo Wolfe |

To rebuild (or audit) a bundle:

```sh
mkdir /tmp/ulak-vendor && cd /tmp/ulak-vendor
npm i esbuild @noble/curves@2.4.0 @noble/hashes@2.4.0 @scure/bip39@2.4.0 @scure/base@2.4.0 qrcode-generator@2.0.4 jsqr@1.4.0
cp <ulak>/vendor/entry-*.js .
npx esbuild entry-crypto.js --bundle --format=esm --minify --legal-comments=inline --outfile=crypto.js
npx esbuild entry-qr.js --bundle --format=esm --minify --legal-comments=inline --outfile=qr.js
```
