import {
  createMnemonic,
  isValidMnemonic,
  normalizeMnemonic,
  isMnemonicWord,
  identityFromMnemonic,
  decodeId,
  shortId,
  safetyWords,
} from './identity.js';
import { Messenger, MAX_BODY, cleanName } from './messenger.js';
import { IdbStore } from './store-idb.js';
import { NostrTransport, DEFAULT_RELAYS } from './nostr.js';
import { DirectTransport, LocalLinkTransport, rtcSupported, SIGNAL_PREFIX } from './rtc.js';
import { LANGUAGES, detectLanguage, translate, languageInfo } from './i18n.js';
import { qrcode, jsQR } from '../vendor/qr.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const SESSION_KEY = 'ulak.session';
const LANG_KEY = 'ulak.lang';
const QR_MAX = 2200;

const state = {
  lang: localStorage.getItem(LANG_KEY) || detectLanguage(),
  words: null,
  identity: null,
  store: null,
  messenger: null,
  nostr: null,
  direct: null,
  lan: null,
  activePeer: null,
  pendingAdd: null,
  createWords: null,
  verifyIndexes: null,
};

const t = (key, vars) => translate(state.lang, key, vars);

// Language

function setLanguage(lang) {
  state.lang = LANGUAGES.some((l) => l.code === lang) ? lang : 'en';
  localStorage.setItem(LANG_KEY, state.lang);
  applyLanguage();
}

function applyLanguage() {
  const info = languageInfo(state.lang);
  document.documentElement.lang = state.lang;
  document.documentElement.dir = info.dir || 'ltr';
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of $$('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  }
  for (const select of $$('.lang-select')) {
    if (!select.options.length) {
      for (const { code, name } of LANGUAGES) select.add(new Option(name, code));
      select.addEventListener('change', () => setLanguage(select.value));
    }
    select.value = state.lang;
  }
  if (state.verifyIndexes) renderVerifyLabels();
  if (state.messenger) {
    renderNet();
    renderChatList();
    if (state.activePeer) renderChat();
  }
}

// Views

function show(view) {
  for (const section of $$('.view')) section.hidden = section.id !== `view-${view}`;
  window.scrollTo(0, 0);
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2800);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('copied'));
  } catch {
    prompt('', text);
  }
}

function renderQr(container, text) {
  const qr = qrcode(0, text.length > 600 ? 'L' : 'M');
  qr.addData(text, 'Byte');
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

// Entry: create account

function startCreate() {
  state.createWords = createMnemonic().split(' ');
  const grid = $('#word-grid');
  grid.replaceChildren(...state.createWords.map((word) => Object.assign(document.createElement('li'), { textContent: word })));
  $('#wrote-down').checked = false;
  $('#create-next').disabled = true;
  $('#create-step-words').hidden = false;
  $('#create-step-verify').hidden = true;
  show('create');
}

function renderVerifyLabels() {
  const [a, b] = state.verifyIndexes;
  $('#verify-label-a').textContent = t('verifyWord', { n: a + 1 });
  $('#verify-label-b').textContent = t('verifyWord', { n: b + 1 });
}

function goVerify() {
  const a = Math.floor(Math.random() * 6);
  const b = 6 + Math.floor(Math.random() * 6);
  state.verifyIndexes = [a, b];
  renderVerifyLabels();
  $('#verify-a').value = '';
  $('#verify-b').value = '';
  $('#create-error').hidden = true;
  $('#create-step-words').hidden = true;
  $('#create-step-verify').hidden = false;
  $('#verify-a').focus();
}

async function finishCreate(event) {
  event.preventDefault();
  const [a, b] = state.verifyIndexes;
  const ok =
    normalizeMnemonic($('#verify-a').value) === state.createWords[a] &&
    normalizeMnemonic($('#verify-b').value) === state.createWords[b];
  if (!ok) {
    $('#create-error').textContent = t('verifyFailed');
    $('#create-error').hidden = false;
    return;
  }
  await startSession(state.createWords.join(' '), {
    name: $('#create-name').value,
    remember: $('#create-remember').checked,
  });
  state.createWords = null;
  state.verifyIndexes = null;
}

// Entry: login

function updateLoginHint() {
  const words = normalizeMnemonic($('#login-words').value).split(' ').filter(Boolean);
  $('#login-count').textContent = t('wordCount', { n: words.length });
  const unknown = words.find((w) => !isMnemonicWord(w));
  $('#login-hint').textContent = unknown ? t('unknownWord', { w: unknown }) : '';
  $('#login-error').hidden = true;
}

async function submitLogin(event) {
  event.preventDefault();
  const words = normalizeMnemonic($('#login-words').value);
  if (!isValidMnemonic(words)) {
    $('#login-error').textContent = t('invalidWords');
    $('#login-error').hidden = false;
    return;
  }
  await startSession(words, { remember: $('#login-remember').checked });
  $('#login-words').value = '';
}

// Session

async function startSession(words, { name, remember }) {
  const identity = await identityFromMnemonic(words);
  const store = await IdbStore.open(identity.publicKey);
  if (name !== undefined) await store.setSetting('name', cleanName(name));
  const settings = await store.getSetting('settings', {});
  const relays = settings.relays?.length ? settings.relays : DEFAULT_RELAYS;

  const messenger = new Messenger({
    identity,
    store,
    name: await store.getSetting('name', ''),
    settings: { storeOnRelays: !!settings.storeOnRelays, carryForOthers: settings.carryForOthers !== false },
  });
  Object.assign(state, { words, identity, store, messenger });

  if (rtcSupported()) {
    state.lan = messenger.addTransport(new LocalLinkTransport());
    state.direct = messenger.addTransport(new DirectTransport());
    state.lan.onChange = state.direct.onChange = () => {
      renderPresence();
      renderLanPeers();
    };
  }
  state.nostr = messenger.addTransport(new NostrTransport({ relays }));
  state.nostr.onStatus = renderNet;

  messenger.on('contacts', scheduleChatList);
  messenger.on('presence', renderPresence);
  messenger.on('message', onMessage);
  messenger.on('status', (message) => message.peer === state.activePeer && scheduleMessages());
  messenger.on('carried', renderCarrying);

  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
  (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, JSON.stringify({ words }));

  await messenger.start();
  renderMe();
  renderNet();
  renderChatList();
  renderCarrying();
  show('app');
  setInterval(renderPresence, 15e3);

  if (state.pendingAdd) openAddDialog(state.pendingAdd);
}

function peerState(publicKey) {
  if (state.lan?.canReach(publicKey)) return 'lan';
  if (state.direct?.canReach(publicKey)) return 'p2p';
  if (state.nostr?.isOnline(publicKey)) return 'nostr';
  return null;
}

function hue(publicKey) {
  return parseInt(publicKey.slice(0, 4), 16) % 360;
}

function displayName(contact) {
  return contact?.name || shortId(contact.publicKey);
}

function paintAvatar(el, publicKey, name) {
  el.style.setProperty('--hue', hue(publicKey));
  el.textContent = (name && [...name][0]) || '#';
  const status = peerState(publicKey);
  el.classList.toggle('online', !!status);
  el.classList.toggle('nearby', status === 'lan');
}

function renderMe() {
  const name = state.messenger.name;
  paintAvatar($('#me-avatar'), state.identity.publicKey, name || 'ulak');
  $('#me-avatar').classList.remove('online', 'nearby');
  $('#me-name').textContent = name || t('you');
  $('#me-id').textContent = shortId(state.identity.publicKey);
}

function renderNet() {
  const el = $('#net-status');
  if (!state.nostr) return;
  const { connected, total } = state.nostr.pool.status();
  if (!navigator.onLine) {
    el.textContent = t('noInternet');
    el.className = 'net bad';
  } else {
    el.textContent = t('relaysStatus', { n: connected, m: total });
    el.className = connected ? 'net ok' : 'net';
  }
}

async function renderCarrying() {
  const count = (await state.store.getCarried()).length;
  $('#carrying').hidden = !count;
  $('#carrying').textContent = t('carrying', { n: count });
}

// Chat list

let listQueued = false;
function scheduleChatList() {
  if (listQueued) return;
  listQueued = true;
  requestAnimationFrame(() => {
    listQueued = false;
    renderChatList();
  });
}

const timeFormat = () => new Intl.DateTimeFormat(state.lang, { hour: '2-digit', minute: '2-digit' });

function dayLabel(ts) {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (date.toDateString() === today.toDateString()) return t('today');
  if (date.toDateString() === yesterday.toDateString()) return t('yesterday');
  return new Intl.DateTimeFormat(state.lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function shortTime(ts) {
  if (!ts) return '';
  return new Date(ts).toDateString() === new Date().toDateString()
    ? timeFormat().format(ts)
    : new Intl.DateTimeFormat(state.lang, { day: 'numeric', month: 'short' }).format(ts);
}

async function renderChatList() {
  const contacts = await state.messenger.listContacts();
  const list = $('#chat-list');
  const template = $('#tpl-chat-item');
  const build = (contact) => {
    const item = template.content.firstElementChild.cloneNode(true);
    item.dataset.peer = contact.publicKey;
    item.classList.toggle('active', contact.publicKey === state.activePeer);
    paintAvatar(item.querySelector('.avatar'), contact.publicKey, contact.name);
    item.querySelector('.chat-item-name').textContent = displayName(contact);
    item.querySelector('.chat-item-time').textContent = shortTime(contact.lastTs);
    item.querySelector('.chat-item-preview').textContent = contact.lastPreview || shortId(contact.publicKey);
    const badge = item.querySelector('.badge');
    badge.hidden = !contact.unread;
    badge.textContent = contact.unread > 99 ? '99+' : contact.unread;
    item.addEventListener('click', () => openChat(contact.publicKey));
    return item;
  };
  const heading = (key) => Object.assign(document.createElement('h4'), { textContent: t(key) });
  const requests = contacts.filter((c) => c.request);
  const chats = contacts.filter((c) => !c.request);
  const nodes = [];
  if (requests.length) nodes.push(heading('requests'), ...requests.map(build));
  if (chats.length) nodes.push(heading('chats'), ...chats.map(build));
  if (!contacts.length) nodes.push(Object.assign(document.createElement('p'), { className: 'empty', textContent: t('noChats') }));
  list.replaceChildren(...nodes);

  const unread = contacts.reduce((sum, c) => sum + (c.unread || 0), 0);
  document.title = unread ? `(${unread}) Ulak` : 'Ulak';
}

function renderPresence() {
  scheduleChatList();
  if (state.activePeer) renderChatHeader();
}

// Chat

async function openChat(publicKey) {
  state.activePeer = publicKey;
  document.body.classList.add('chat-open');
  $('#chat-empty').hidden = true;
  $('#chat-view').hidden = false;
  $('#chat-menu').hidden = true;
  await renderChat();
  await state.messenger.markRead(publicKey);
  if (matchMedia('(min-width: 761px)').matches) $('#composer-input').focus();
  scheduleChatList();
}

function closeChat() {
  state.activePeer = null;
  document.body.classList.remove('chat-open');
  $('#chat-view').hidden = true;
  $('#chat-empty').hidden = false;
  scheduleChatList();
}

async function renderChat() {
  await renderChatHeader();
  await renderMessages();
}

async function renderChatHeader() {
  const peer = state.activePeer;
  const contact = await state.store.getContact(peer);
  if (!contact) return closeChat();
  paintAvatar($('#chat-avatar'), peer, contact.name);
  $('#chat-name').textContent = displayName(contact);
  const status = peerState(peer);
  const statusEl = $('#chat-status');
  statusEl.className = status ? 'on' : '';
  statusEl.textContent = status
    ? t({ lan: 'onlineLan', p2p: 'onlineP2p', nostr: 'onlineRelay' }[status])
    : t('offlinePeer');
  $('#request-banner').hidden = !contact.request;
}

let messagesQueued = false;
function scheduleMessages() {
  if (messagesQueued) return;
  messagesQueued = true;
  requestAnimationFrame(() => {
    messagesQueued = false;
    renderMessages();
  });
}

const VIA_KEYS = { nostr: 'viaNostr', 'nostr-stored': 'viaNostr', p2p: 'viaP2p', lan: 'viaLan', qr: 'viaQr' };

function statusInfo(message) {
  if (message.status === 'pending') return { tick: '◷', cls: 'pending', text: t('statusPending') };
  if (message.status === 'sent') {
    return { tick: '✓', cls: '', text: message.relayStored ? t('statusStored') : t('statusSent') };
  }
  if (message.status === 'delivered') return { tick: '✓✓', cls: '', text: t('statusDelivered') };
  return { tick: '✓✓', cls: 'read', text: t('statusRead') };
}

async function renderMessages() {
  const peer = state.activePeer;
  if (!peer) return;
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const messages = await state.store.listMessages(peer);
  if (peer !== state.activePeer) return;
  const format = timeFormat();
  const nodes = [];
  let lastDay = '';
  for (const message of messages) {
    const day = dayLabel(message.ts);
    if (day !== lastDay) {
      nodes.push(Object.assign(document.createElement('div'), { className: 'day', textContent: day }));
      lastDay = day;
    }
    const el = document.createElement('div');
    el.className = `msg ${message.dir}`;
    el.append(Object.assign(document.createElement('div'), { dir: 'auto', textContent: message.body }));
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const time = document.createElement('time');
    time.textContent = format.format(message.ts);
    meta.append(time);
    const via = VIA_KEYS[message.via] ? t('via', { via: t(VIA_KEYS[message.via]) }) : '';
    if (message.dir === 'out') {
      const info = statusInfo(message);
      const tick = document.createElement('span');
      tick.className = `tick ${info.cls}`;
      tick.textContent = info.tick;
      meta.append(tick);
      el.title = [info.text, via].filter(Boolean).join(' · ');
    } else {
      el.title = via;
    }
    el.append(meta);
    nodes.push(el);
  }
  box.replaceChildren(...nodes);
  if (nearBottom || renderMessages.lastPeer !== peer) box.scrollTop = box.scrollHeight;
  renderMessages.lastPeer = peer;
}

async function sendFromComposer(event) {
  event?.preventDefault();
  const input = $('#composer-input');
  const text = input.value.trim();
  if (!text || !state.activePeer) return;
  if (text.length > MAX_BODY) return toast(t('tooLong'));
  input.value = '';
  autosize();
  await state.messenger.sendMessage(state.activePeer, text);
  scheduleMessages();
}

function autosize() {
  const input = $('#composer-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

async function onMessage(message) {
  if (message.dir !== 'in') {
    if (message.peer === state.activePeer) scheduleMessages();
    return;
  }
  const visible = message.peer === state.activePeer && !document.hidden;
  if (message.peer === state.activePeer) scheduleMessages();
  if (visible) {
    state.messenger.markRead(message.peer);
    return;
  }
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const contact = await state.store.getContact(message.peer);
    const note = new Notification(displayName(contact), { body: message.body.slice(0, 140), tag: message.peer, icon: 'icons/icon-192.png' });
    note.onclick = () => {
      window.focus();
      openChat(message.peer);
      note.close();
    };
  }
}

// Add contact

function contactLink() {
  const base = location.href.split('#')[0];
  const name = state.messenger.name ? `&n=${encodeURIComponent(state.messenger.name)}` : '';
  return `${base}#add=${state.identity.id}${name}`;
}

/** Accepts a bare ID or a contact link; returns { publicKey, name } or null. */
function parseContact(text) {
  const value = String(text || '').trim();
  const match = value.match(/[#&?]add=([a-z0-9]+)(?:&n=([^&]*))?/i);
  if (match) {
    const publicKey = decodeId(match[1]);
    let name = '';
    try {
      name = match[2] ? decodeURIComponent(match[2]) : '';
    } catch {}
    return publicKey ? { publicKey, name: cleanName(name) } : null;
  }
  const publicKey = decodeId(value);
  return publicKey ? { publicKey, name: '' } : null;
}

function openAddDialog(prefill) {
  state.pendingAdd = null;
  renderQr($('#my-qr'), contactLink());
  $('#my-id-full').textContent = state.identity.id;
  $('#share-link').hidden = !navigator.share;
  $('#add-id').value = prefill ? prefill.id || '' : '';
  $('#add-name').value = prefill ? prefill.name || '' : '';
  $('#add-error').hidden = true;
  $('#dlg-add').showModal();
}

async function submitAdd(event) {
  event.preventDefault();
  const parsed = parseContact($('#add-id').value);
  const error = $('#add-error');
  if (!parsed) {
    error.textContent = t('invalidId');
    error.hidden = false;
    return;
  }
  if (parsed.publicKey === state.identity.publicKey) {
    error.textContent = t('cannotAddSelf');
    error.hidden = false;
    return;
  }
  await state.messenger.addContact(parsed.publicKey, $('#add-name').value || parsed.name);
  $('#dlg-add').close();
  openChat(parsed.publicKey);
}

// Scanner

let scanSession = null;

async function openScanner(title, onResult) {
  stopScanner();
  const dialog = $('#dlg-scan');
  $('#scan-title').textContent = title;
  $('#scan-paste').value = '';
  $('#scan-note').textContent = '';
  const session = { onResult, stream: null, active: true };
  scanSession = session;
  dialog.showModal();

  const finish = (text) => {
    if (!session.active) return;
    stopScanner();
    dialog.close();
    onResult(text.trim());
  };
  session.finish = finish;

  try {
    session.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    if (!session.active) return session.stream.getTracks().forEach((track) => track.stop());
    const video = $('#scan-video');
    video.srcObject = session.stream;
    await video.play();
    const detector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (!session.active) return;
      if (video.readyState >= 2) {
        let text = null;
        if (detector) {
          try {
            text = (await detector.detect(video))[0]?.rawValue || null;
          } catch {}
        } else {
          const size = Math.min(video.videoWidth, video.videoHeight, 720);
          canvas.width = canvas.height = size;
          context.drawImage(video, (video.videoWidth - size) / 2, (video.videoHeight - size) / 2, size, size, 0, 0, size, size);
          text = jsQR(context.getImageData(0, 0, size, size).data, size, size, { inversionAttempts: 'dontInvert' })?.data || null;
        }
        if (text) return finish(text);
      }
      setTimeout(tick, 120);
    };
    tick();
  } catch {
    $('#scan-note').textContent = t('cameraUnavailable');
  }
}

function stopScanner() {
  if (!scanSession) return;
  scanSession.active = false;
  scanSession.stream?.getTracks().forEach((track) => track.stop());
  $('#scan-video').srcObject = null;
  scanSession = null;
}

// Nearby (offline)

function openNearby() {
  const supported = rtcSupported();
  $('#lan-invite').disabled = !supported;
  $('#lan-scan-invite').disabled = !supported;
  $('#lan-code').hidden = true;
  renderLanPeers();
  $('#dlg-nearby').showModal();
}

async function showLanCode(code, expectAnswer) {
  $('#lan-code').hidden = false;
  $('#lan-scan-answer').hidden = !expectAnswer;
  renderQr($('#lan-qr'), code);
  $('#lan-copy').onclick = () => copy(code);
}

async function createLanInvite() {
  $('#lan-code').hidden = false;
  $('#lan-qr').textContent = t('preparing');
  const code = await state.lan.createInvite();
  showLanCode(code, true);
}

function scanLanInvite() {
  openScanner(t('scanInvite'), async (code) => {
    try {
      $('#dlg-nearby').open || $('#dlg-nearby').showModal();
      $('#lan-code').hidden = false;
      $('#lan-qr').textContent = t('preparing');
      showLanCode(await state.lan.acceptInvite(code), false);
    } catch {
      $('#lan-code').hidden = true;
      toast(t('notForYou'));
    }
  });
}

function scanLanAnswer() {
  openScanner(t('scanAnswer'), async (code) => {
    try {
      $('#dlg-nearby').open || $('#dlg-nearby').showModal();
      await state.lan.completeInvite(code);
      $('#lan-code').hidden = true;
    } catch {
      toast(t('notForYou'));
    }
  });
}

async function renderLanPeers() {
  const list = $('#lan-peers');
  const peers = state.lan ? state.lan.connectedPeers() : [];
  if (!peers.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: t('noneConnected') }));
    return;
  }
  const items = [];
  for (const peer of peers) {
    const contact = await state.store.getContact(peer);
    const li = document.createElement('li');
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'link-btn', textContent: displayName(contact || { publicKey: peer }) });
    button.addEventListener('click', () => {
      $('#dlg-nearby').close();
      openChat(peer);
    });
    li.append(button);
    items.push(li);
  }
  list.replaceChildren(...items);
  if (peers.length > (renderLanPeers.lastCount || 0)) {
    const contact = await state.store.getContact(peers[peers.length - 1]);
    toast(t('connectedTo', { name: displayName(contact || { publicKey: peers[peers.length - 1] }) }));
  }
  renderLanPeers.lastCount = peers.length;
}

async function handleScannedPacket(text) {
  if (parseContact(text)) return openAddDialog({ id: text, name: '' });
  if (text.startsWith(SIGNAL_PREFIX)) {
    try {
      $('#dlg-nearby').open || $('#dlg-nearby').showModal();
      showLanCode(await state.lan.acceptInvite(text), false);
    } catch {
      toast(t('notForYou'));
    }
    return;
  }
  const result = await state.messenger.receivePacket(text, 'qr');
  if (result === 'message') {
    const packet = JSON.parse(text);
    const contact = await state.store.getContact(packet.f);
    toast(t('received', { name: displayName(contact) }));
    $('#dlg-nearby').open && $('#dlg-nearby').close();
    openChat(packet.f);
  } else if (result === 'carried') {
    toast(t('carriedForOthers'));
  } else if (result === 'duplicate') {
    toast(t('scanned'));
  } else {
    toast(t('notForYou'));
  }
}

// Give by QR

async function openGiveQr() {
  const packets = await state.messenger.exportPending(state.activePeer);
  if (!packets.length) return toast(t('qrGiveNone'));
  let index = 0;
  const render = () => {
    const packet = packets[index];
    if (packet.length > QR_MAX) $('#give-qr').textContent = t('qrGiveTooLong');
    else renderQr($('#give-qr'), packet);
    $('#give-count').textContent = `${index + 1} / ${packets.length}`;
    $('#give-prev').disabled = index === 0;
    $('#give-next').disabled = index === packets.length - 1;
  };
  $('#give-prev').onclick = () => (index--, render());
  $('#give-next').onclick = () => (index++, render());
  render();
  $('#dlg-qrgive').showModal();
}

function openSafety() {
  const words = safetyWords(state.identity.publicKey, state.activePeer);
  $('#safety-words').replaceChildren(...words.map((word) => Object.assign(document.createElement('span'), { textContent: word })));
  $('#dlg-safety').showModal();
}

// Settings

async function openSettings() {
  const settings = await state.store.getSetting('settings', {});
  $('#set-name').value = state.messenger.name;
  $('#set-store').checked = state.messenger.settings.storeOnRelays;
  $('#set-carry').checked = state.messenger.settings.carryForOthers;
  $('#set-relays').value = (settings.relays?.length ? settings.relays : DEFAULT_RELAYS).join('\n');
  $('#set-words').hidden = true;
  $('#set-show-words').textContent = t('showWords');
  renderNotifyButton();
  $('#dlg-settings').showModal();
}

function renderNotifyButton() {
  const button = $('#set-notify');
  const granted = 'Notification' in window && Notification.permission === 'granted';
  button.textContent = t(granted ? 'notificationsOn' : 'enableNotifications');
  button.disabled = granted || !('Notification' in window);
}

async function saveSettings(event) {
  event.preventDefault();
  const name = cleanName($('#set-name').value);
  const relays = $('#set-relays').value.split(/\s+/).map((s) => s.trim()).filter((s) => /^wss?:\/\/\S+$/.test(s));
  const settings = {
    storeOnRelays: $('#set-store').checked,
    carryForOthers: $('#set-carry').checked,
    relays: relays.length ? relays : DEFAULT_RELAYS,
  };
  state.messenger.name = name;
  Object.assign(state.messenger.settings, { storeOnRelays: settings.storeOnRelays, carryForOthers: settings.carryForOthers });
  await state.store.setSetting('name', name);
  await state.store.setSetting('settings', settings);
  state.nostr.setRelays(settings.relays);
  renderMe();
  toast(t('saved'));
  $('#dlg-settings').close();
}

function toggleWords() {
  const grid = $('#set-words');
  if (grid.hidden) {
    grid.replaceChildren(...state.words.split(' ').map((word) => Object.assign(document.createElement('li'), { textContent: word })));
    $('#set-show-words').textContent = t('hideWords');
  } else {
    grid.replaceChildren();
    $('#set-show-words').textContent = t('showWords');
  }
  grid.hidden = !grid.hidden;
}

async function logout() {
  if (!confirm(t('logoutConfirm'))) return;
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  await state.messenger.stop();
  location.replace(location.pathname);
}

async function wipe() {
  if (!confirm(t('wipeConfirm'))) return;
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  await state.messenger.stop();
  state.store.db.close();
  await IdbStore.destroy(state.identity.publicKey);
  location.replace(location.pathname);
}

// Wiring

function readHash() {
  const parsed = parseContact(location.hash);
  if (!parsed) return;
  state.pendingAdd = { id: location.hash, name: parsed.name };
  history.replaceState(null, '', location.pathname + location.search);
  if (state.messenger) openAddDialog(state.pendingAdd);
}

function bind() {
  for (const button of $$('[data-go]')) {
    button.addEventListener('click', () => {
      const target = button.dataset.go;
      if (target === 'create') startCreate();
      else show(target);
      if (target === 'login') $('#login-words').focus();
    });
  }
  $('#wrote-down').addEventListener('change', (e) => ($('#create-next').disabled = !e.target.checked));
  $('#create-next').addEventListener('click', goVerify);
  $('#copy-words').addEventListener('click', () => copy(state.createWords.join(' ')));
  $('#create-back').addEventListener('click', () => {
    $('#create-step-verify').hidden = true;
    $('#create-step-words').hidden = false;
  });
  $('#create-step-verify').addEventListener('submit', finishCreate);
  $('#login-words').addEventListener('input', updateLoginHint);
  $('#login-form').addEventListener('submit', submitLogin);

  $('#open-add').addEventListener('click', () => openAddDialog());
  $('#me-button').addEventListener('click', () => openAddDialog());
  $('#open-nearby').addEventListener('click', openNearby);
  $('#open-settings').addEventListener('click', openSettings);
  $('#add-form').addEventListener('submit', submitAdd);
  $('#copy-id').addEventListener('click', () => copy(state.identity.id));
  $('#copy-link').addEventListener('click', () => copy(contactLink()));
  $('#share-link').addEventListener('click', () => navigator.share({ title: 'Ulak', url: contactLink() }).catch(() => {}));
  $('#add-scan').addEventListener('click', () =>
    openScanner(t('scanQr'), (text) => {
      const parsed = parseContact(text);
      $('#dlg-add').open || $('#dlg-add').showModal();
      $('#add-id').value = parsed ? text : text;
      if (parsed?.name) $('#add-name').value = parsed.name;
    }),
  );

  $('#composer').addEventListener('submit', sendFromComposer);
  $('#composer-input').addEventListener('input', autosize);
  $('#composer-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(hover: hover)').matches) {
      sendFromComposer(event);
    }
  });
  $('#chat-back').addEventListener('click', closeChat);
  $('#chat-qr').addEventListener('click', openGiveQr);
  $('#chat-safety').addEventListener('click', openSafety);
  $('#chat-more').addEventListener('click', (event) => {
    event.stopPropagation();
    $('#chat-menu').hidden = !$('#chat-menu').hidden;
  });
  document.addEventListener('click', () => ($('#chat-menu').hidden = true));
  $('#chat-rename').addEventListener('click', async () => {
    const contact = await state.store.getContact(state.activePeer);
    const name = prompt(t('rename'), contact?.name || '');
    if (name !== null) await state.messenger.renameContact(state.activePeer, name);
    renderChatHeader();
  });
  const deleteChat = async () => {
    if (!confirm(t('deleteConfirm'))) return;
    await state.messenger.removeContact(state.activePeer);
    closeChat();
  };
  $('#chat-delete').addEventListener('click', deleteChat);
  $('#request-delete').addEventListener('click', deleteChat);
  $('#request-accept').addEventListener('click', async () => {
    await state.messenger.addContact(state.activePeer);
    renderChatHeader();
  });

  $('#lan-invite').addEventListener('click', createLanInvite);
  $('#lan-scan-invite').addEventListener('click', scanLanInvite);
  $('#lan-scan-answer').addEventListener('click', scanLanAnswer);
  $('#qr-receive').addEventListener('click', () => openScanner(t('receiveByQr'), handleScannedPacket));

  $('#dlg-scan').addEventListener('close', stopScanner);
  $('#scan-use').addEventListener('click', () => scanSession?.finish($('#scan-paste').value));

  $('#settings-form').addEventListener('submit', saveSettings);
  $('#set-relays-reset').addEventListener('click', () => ($('#set-relays').value = DEFAULT_RELAYS.join('\n')));
  $('#set-notify').addEventListener('click', async () => {
    await Notification.requestPermission();
    renderNotifyButton();
  });
  $('#set-show-words').addEventListener('click', toggleWords);
  $('#set-logout').addEventListener('click', logout);
  $('#set-wipe').addEventListener('click', wipe);

  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', (event) => event.target === dialog && dialog.close());
  }

  window.addEventListener('hashchange', readHash);
  window.addEventListener('online', () => {
    state.nostr?.pool.reconnectNow();
    renderNet();
  });
  window.addEventListener('offline', renderNet);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !state.messenger) return;
    state.nostr.pool.reconnectNow();
    state.nostr.announce();
    if (state.activePeer) state.messenger.markRead(state.activePeer);
  });
}

async function boot() {
  bind();
  applyLanguage();
  readHash();
  const saved = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
  let words = null;
  try {
    words = JSON.parse(saved)?.words;
  } catch {}
  if (words && isValidMnemonic(words)) {
    await startSession(words, { remember: !!localStorage.getItem(SESSION_KEY) });
  } else {
    show('welcome');
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
