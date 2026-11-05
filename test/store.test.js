import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { WhatsApp, makeReadOnly } from '../src/whatsapp.js';

const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };
const now = () => Math.floor(Date.now() / 1000);
const ME = '5215500000000@s.whatsapp.net';
const ANA = '5215511111111@s.whatsapp.net';
const BETO = '5215522222222@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa24-'));
  const store = new Store({ dataDir: path.join(root, 'data'), stateDir: path.join(root, 'state'), logger: silent });
  await store.load();
  store.setMe({ jid: ME, name: 'Yo' });
  const wa = new WhatsApp({ store, sessionDir: path.join(root, 'session'), logger: silent });
  wa.queueMedia = (msg, rec) => (rec.media.status = 'pending'); // no network in tests
  return { root, store, wa };
}

const msg = (o) => ({
  key: { remoteJid: o.chat, id: o.id, fromMe: !!o.fromMe, participant: o.participant },
  messageTimestamp: o.ts ?? now(),
  pushName: o.pushName,
  message: o.message,
});

test('saves texts, replies, reactions, edits, deletes, groups and read state', async () => {
  const { root, store, wa } = await setup();
  const live = (m) => wa.onEvents({ 'messages.upsert': { type: 'notify', messages: [m] } });

  wa.onEvents({ 'chats.upsert': [{ id: GROUP, name: 'Familia', archived: true }] });
  live(msg({ chat: ANA, id: 'A1', pushName: 'Ana', message: { conversation: 'Hola' } }));
  live(msg({ chat: ANA, id: 'A2', fromMe: true, message: { extendedTextMessage: { text: '¿Qué tal?', contextInfo: { stanzaId: 'A1', participant: ANA, quotedMessage: { conversation: 'Hola' } } } } }));
  live(msg({ chat: ANA, id: 'A3', pushName: 'Ana', message: { reactionMessage: { key: { id: 'A2', remoteJid: ANA, fromMe: true }, text: '❤️', senderTimestampMs: Date.now() } } }));
  live(msg({ chat: ANA, id: 'A4', pushName: 'Ana', message: { conversation: 'tpyo' } }));
  live(msg({ chat: ANA, id: 'A5', pushName: 'Ana', message: { protocolMessage: { type: 14, key: { id: 'A4' }, editedMessage: { conversation: 'typo' } } } }));
  live(msg({ chat: GROUP, id: 'G1', participant: BETO, pushName: 'Beto', message: { imageMessage: { mimetype: 'image/jpeg', caption: 'foto', fileLength: 1000 } } }));
  live(msg({ chat: GROUP, id: 'G2', participant: BETO, pushName: 'Beto', message: { conversation: 'borrar' } }));
  live(msg({ chat: GROUP, id: 'G3', participant: BETO, pushName: 'Beto', message: { protocolMessage: { type: 0, key: { id: 'G2' } } } }));
  live(msg({ chat: 'status@broadcast', id: 'S1', participant: BETO, pushName: 'Beto', message: { conversation: 'mi estado' } }));
  // too old: ignored
  live(msg({ chat: ANA, id: 'OLD', ts: now() - 25 * 3600, message: { conversation: 'viejo' } }));

  const ana = store.listMessages(ANA);
  assert.deepEqual(ana.map((m) => m.id), ['A1', 'A2', 'A4']);
  assert.equal(ana[0].readByMe, true, 'replying marks earlier messages as read');
  assert.equal(ana[1].replyTo.id, 'A1');
  assert.equal(ana[1].replyTo.senderName, 'Ana');
  assert.deepEqual(ana[1].reactions.map((r) => r.emoji), ['❤️']);
  assert.equal(ana[2].text, 'typo');
  assert.deepEqual(ana[2].edited.previous, ['tpyo']);
  assert.equal(ana[2].readByMe, false);

  const g = store.listMessages(GROUP);
  assert.equal(g[0].type, 'image');
  assert.equal(g[0].text, 'foto');
  assert.equal(g[0].senderName, 'Beto');
  assert.ok(g[1].deleted);
  const chat = store.publicChat(GROUP);
  assert.equal(chat.isGroup, true);
  assert.equal(chat.archived, true);
  assert.equal(store.publicChat('status@broadcast').type, 'status');

  // phone reads Ana's chat
  wa.onEvents({ 'chats.update': [{ id: ANA, unreadCount: 0 }] });
  assert.equal(store.getMessage(ANA, 'A4').readByMe, true);
  // read-self receipt on a group message
  wa.onEvents({ 'message-receipt.update': [{ key: { remoteJid: GROUP, id: 'G1', fromMe: false }, receipt: { userJid: BETO, readTimestamp: now() } }] });
  assert.equal(store.getMessage(GROUP, 'G1').readByMe, true);

  await store.flush();
  const data = path.join(root, 'data');
  const index = JSON.parse(fs.readFileSync(path.join(data, 'index.json'), 'utf8'));
  assert.equal(index.chats.length, 3);
  const familia = index.chats.find((c) => c.id === GROUP);
  assert.match(familia.folder, /Familia/);
  const txt = fs.readFileSync(path.join(data, familia.folder, 'conversation.txt'), 'utf8');
  assert.match(txt, /Archivado: sí/);
  assert.match(txt, /eliminado para todos/);
  assert.ok(fs.existsSync(path.join(data, 'estados', 'messages.json')));
  assert.ok(fs.existsSync(path.join(data, 'LEEME.txt')));
});

test('history sync keeps only the window and infers unread from unreadCount', async () => {
  const { store, wa } = await setup();
  wa.onEvents({
    'messaging-history.set': {
      chats: [{ id: BETO, unreadCount: 1 }],
      contacts: [{ id: BETO, name: 'Beto Pérez' }],
      messages: [
        msg({ chat: BETO, id: 'H1', ts: now() - 3600, message: { conversation: 'uno' } }),
        msg({ chat: BETO, id: 'H2', ts: now() - 60, message: { conversation: 'dos' } }),
        msg({ chat: BETO, id: 'H0', ts: now() - 48 * 3600, message: { conversation: 'viejo' } }),
      ],
    },
  });
  const ms = store.listMessages(BETO);
  assert.deepEqual(ms.map((m) => [m.id, m.readByMe]), [['H1', true], ['H2', false]]);
  assert.equal(ms[0].senderName, 'Beto Pérez');
});

test('prune deletes old messages, their attachments and empty chat folders', async () => {
  const { root, store } = await setup();
  const t = now();
  store.putMessage({ id: 'X1', chatId: ANA, fromMe: false, sender: ANA, ts: t, time: new Date(t * 1000).toISOString(), type: 'image', media: { file: 'media/x1.jpg', status: 'downloaded' } });
  await store.flush();
  const folder = store.chats.get(ANA).folder;
  const media = path.join(root, 'data', folder, 'media');
  fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, 'x1.jpg'), 'img');
  fs.writeFileSync(path.join(media, 'stray.jpg'), 'img');
  await store.prune();
  assert.ok(fs.existsSync(path.join(media, 'x1.jpg')));
  assert.ok(!fs.existsSync(path.join(media, 'stray.jpg')), 'unreferenced files are removed');

  store.getMessage(ANA, 'X1').ts = t - 25 * 3600; // age it past 24 h
  await store.prune();
  assert.ok(!fs.existsSync(path.join(root, 'data', folder)), 'chat folder gone');
  assert.equal(store.listChats().length, 0);
});

test('read-only guard blocks every write method', async () => {
  const sock = { sendMessage: async () => 'sent', readMessages: async () => 'read', chatModify: async () => 'x', sendPresenceUpdate: async () => 'p' };
  makeReadOnly(sock);
  await assert.rejects(sock.sendMessage('x', { text: 'hi' }), /read-only/);
  await assert.rejects(sock.readMessages([]), /read-only/);
  await assert.rejects(sock.chatModify({}, 'x'), /read-only/);
  assert.equal(await sock.sendPresenceUpdate('available'), undefined);
});

test('a @lid chat merges into the phone-number chat once the mapping is known', async () => {
  const { store, wa } = await setup();
  const LID = '99999999999@lid';
  wa.onEvents({ 'messages.upsert': { type: 'notify', messages: [msg({ chat: LID, id: 'L1', message: { conversation: 'hola' } })] } });
  assert.equal(store.listMessages(LID).length, 1);
  wa.onEvents({ 'lid-mapping.update': { lid: LID, pn: ANA } });
  assert.equal(store.listMessages(LID).length, 0);
  assert.equal(store.listMessages(ANA)[0].id, 'L1');
});
