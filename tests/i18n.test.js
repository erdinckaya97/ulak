import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANGUAGES, STRINGS, detectLanguage, translate, languageInfo } from '../src/i18n.js';

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every language has exactly the English keys and the same placeholders', () => {
  const keys = Object.keys(STRINGS.en).sort();
  assert.equal(LANGUAGES.length, 10);
  for (const { code } of LANGUAGES) {
    const strings = STRINGS[code];
    assert.ok(strings, `${code} is loaded`);
    assert.deepEqual(Object.keys(strings).sort(), keys, `${code} keys`);
    for (const key of keys) {
      assert.ok(strings[key].trim(), `${code}.${key} is not empty`);
      assert.deepEqual(placeholders(strings[key]), placeholders(STRINGS.en[key]), `${code}.${key} placeholders`);
    }
  }
});

test('every key used by the page and the app exists', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const used = new Set([
    ...[...html.matchAll(/data-i18n(?:-placeholder|-title)?="(\w+)"/g)].map((m) => m[1]),
    ...[...app.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]),
    ...[...app.matchAll(/(?:onlineLan|onlineP2p|onlineRelay|viaNostr|viaP2p|viaLan|viaQr|notificationsOn|enableNotifications)/g)].map((m) => m[0]),
  ]);
  for (const key of used) assert.ok(key in STRINGS.en, `missing key: ${key}`);
});

test('language detection and translation', () => {
  assert.equal(detectLanguage(['ar-EG', 'en']), 'ar');
  assert.equal(detectLanguage(['zh-Hant-TW']), 'zh');
  assert.equal(detectLanguage(['de-DE', 'pt-BR']), 'pt');
  assert.equal(detectLanguage(['xx']), 'en');
  assert.equal(languageInfo('ar').dir, 'rtl');
  assert.equal(languageInfo('nope').code, 'en');
  assert.equal(translate('tr', 'wordCount', { n: 7 }), '7/12 kelime');
  assert.equal(translate('ja', 'connectedTo', { name: 'Ali' }), 'Ali と接続しました');
  assert.equal(translate('xx', 'send'), 'Send');
  assert.equal(translate('en', 'no-such-key'), 'no-such-key');
});
