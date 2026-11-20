import en from './locales/en.js';
import tr from './locales/tr.js';
import es from './locales/es.js';
import pt from './locales/pt.js';
import ru from './locales/ru.js';
import ar from './locales/ar.js';
import hi from './locales/hi.js';
import zh from './locales/zh.js';
import ja from './locales/ja.js';
import ko from './locales/ko.js';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'zh', name: '中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
];

export const STRINGS = { en, tr, es, pt, ru, ar, hi, zh, ja, ko };

export function languageInfo(code) {
  return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
}

export function detectLanguage(languages = globalThis.navigator?.languages || []) {
  for (const tag of languages) {
    const code = String(tag).slice(0, 2).toLowerCase();
    if (STRINGS[code]) return code;
  }
  return 'en';
}

export function translate(lang, key, vars = {}) {
  const template = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? vars[name] : `{${name}}`));
}
