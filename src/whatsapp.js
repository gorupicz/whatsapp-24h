// WhatsApp connection (Baileys), strictly READ-ONLY: it links as a companion device, listens,
// and saves. It never sends messages, read receipts, presence or any chat change.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { classify, toNum } from './parse.js';
import { sanitize } from './store.js';

// Every public method that would change something on WhatsApp. Calling one throws.
const WRITE_METHODS = [
  'sendMessage', 'readMessages', 'chatModify', 'sendPresenceUpdate', 'presenceSubscribe', 'star',
  'updateProfileStatus', 'updateProfileName', 'updateProfilePicture', 'removeProfilePicture', 'updateBlockStatus',
  'updateLastSeenPrivacy', 'updateOnlinePrivacy', 'updateProfilePicturePrivacy', 'updateStatusPrivacy',
  'updateReadReceiptsPrivacy', 'updateGroupsAddPrivacy', 'updateDefaultDisappearingMode', 'updateMessagesPrivacy',
  'groupCreate', 'groupLeave', 'groupUpdateSubject', 'groupUpdateDescription', 'groupParticipantsUpdate',
  'groupSettingUpdate', 'groupToggleEphemeral', 'groupRevokeInvite', 'groupAcceptInvite', 'groupAcceptInviteV4',
  'groupRequestParticipantsUpdate', 'groupMemberAddMode', 'groupJoinApprovalMode', 'rejectCall', 'sendStatusMentions',
  'addChatLabel', 'removeChatLabel', 'addMessageLabel', 'removeMessageLabel', 'addLabel', 'addOrEditContact',
  'removeContact', 'addOrEditQuickReply', 'removeQuickReply', 'clearMessage', 'deleteMessage',
  'newsletterFollow', 'newsletterUnfollow', 'newsletterMute', 'newsletterUnmute', 'newsletterCreate',
  'newsletterUpdate', 'newsletterReactMessage', 'newsletterDelete', 'communityCreate', 'communityLeave',
];

export function makeReadOnly(sock) {
  for (const name of WRITE_METHODS) {
    if (typeof sock[name] !== 'function') continue;
    // presence is pinged by some internals; make it a silent no-op instead of an error
    sock[name] =
      name === 'sendPresenceUpdate' || name === 'presenceSubscribe'
        ? async () => {}
        : async () => {
            throw new Error(`whatsapp-24h is read-only: ${name} is disabled`);
          };
  }
  return sock;
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'video/quicktime': '.mov',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/amr': '.amr',
  'application/pdf': '.pdf',
};

function extFor(media, type) {
  const fromName = media.fileName && path.extname(media.fileName);
  if (fromName) return fromName.toLowerCase();
  const mime = (media.mimetype || '').split(';')[0].trim();
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  return { sticker: '.webp', voice: '.ogg', audio: '.ogg', image: '.jpg', video: '.mp4', gif: '.mp4', video_note: '.mp4' }[type] || '.bin';
}

export class WhatsApp extends EventEmitter {
  constructor({ store, sessionDir, maxMediaMB = 100, logger }) {
    super();
    this.store = store;
    this.sessionDir = sessionDir;
    this.maxMediaBytes = maxMediaMB * 1024 * 1024;
    this.log = logger;
    this.sock = null;
    this.state = 'starting'; // starting | qr | connecting | open | closed | logged_out | error
    this.qr = null;
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.lastError = null;
    this.retry = 0;
    this.mediaQueue = [];
    this.mediaActive = 0;
    this.stopped = false;
  }

  status() {
    return {
      state: this.state,
      qr: this.state === 'qr' ? this.qrDataUrl : null,
      pairingCode: this.pairingCode,
      me: this.store.me,
      error: this.lastError,
      mediaQueue: this.mediaQueue.length + this.mediaActive,
    };
  }

  async start() {
    this.stopped = false;
    await fsp.mkdir(this.sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {}
    const sock = makeWASocket({
      version,
      logger: this.log.child({ module: 'baileys' }, { level: 'warn' }),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.log) },
      browser: Browsers.macOS('Desktop'),
      // read-only: never show as "online" (that would silence notifications on the phone)
      markOnlineOnConnect: false,
      // only the recent history; we keep 24 h anyway
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => {
        const m = this.store.getMessage(this.store.canonical(key.remoteJid), key.id);
        return m?.text ? { conversation: m.text } : undefined;
      },
    });
    makeReadOnly(sock);
    this.sock = sock;
    if (!state.creds.registered) this.state = 'connecting';

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this.onConnection(sock, u));
    sock.ev.process((events) => {
      if (sock !== this.sock) return;
      try {
        this.onEvents(events);
      } catch (err) {
        this.log.error({ err: err?.stack || String(err) }, 'event handling failed');
      }
    });
  }

  async onConnection(sock, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return;
    if (qr) {
      this.qr = qr;
      this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      if (!this.pairingCode) this.state = 'qr';
      this.emit('change');
    }
    if (connection === 'connecting' && this.state !== 'qr') this.state = 'connecting';
    if (connection === 'open') {
      this.state = 'open';
      this.qr = this.qrDataUrl = this.pairingCode = null;
      this.lastError = null;
      this.retry = 0;
      const me = sock.user || {};
      const jid = jidNormalizedUser(me.id);
      if (me.lid) this.store.addLidMapping(jidNormalizedUser(me.lid), jid);
      this.store.setMe({ jid, name: me.name || me.notify || null });
      this.log.info({ jid }, 'connected');
      this.emit('change');
      // read-only query: subjects and participants of my groups
      sock
        .groupFetchAllParticipating()
        .then((groups) => Object.values(groups).forEach((g) => this.store.setGroupMetadata(g)))
        .catch((e) => this.log.warn({ err: e?.message }, 'group fetch failed'));
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      this.log.warn({ code, err: lastDisconnect?.error?.message }, 'connection closed');
      if (this.stopped) return;
      if (code === DisconnectReason.loggedOut) {
        // unlinked from the phone: start over with a fresh QR
        this.state = 'logged_out';
        this.lastError = 'Esta computadora se desvinculó de WhatsApp. Escanea el código otra vez.';
        await this.resetSession();
        this.emit('change');
        setTimeout(() => this.start().catch((e) => this.fail(e)), 1000);
        return;
      }
      if (code === 405 || code === 403) {
        this.state = 'error';
        this.lastError = 'WhatsApp rechazó la conexión por ahora. Espera unas horas y vuelve a intentar.';
      } else {
        this.state = this.store.me ? 'connecting' : 'starting';
      }
      this.emit('change');
      const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60000, 2000 * 2 ** this.retry++);
      setTimeout(() => this.start().catch((e) => this.fail(e)), code === 405 ? 30 * 60 * 1000 : delay);
    }
  }

  fail(err) {
    this.state = 'error';
    this.lastError = err?.message || String(err);
    this.log.error({ err: err?.stack || String(err) }, 'start failed');
    this.emit('change');
    setTimeout(() => this.start().catch((e) => this.fail(e)), 30000);
  }

  async requestPairingCode(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 8) throw new Error('Escribe tu número con código de país, por ejemplo 5215512345678.');
    if (!this.sock || this.state === 'open') throw new Error('Ya hay una sesión conectada.');
    const code = await this.sock.requestPairingCode(digits);
    this.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
    this.state = 'qr';
    this.emit('change');
    return this.pairingCode;
  }

  /** Unlink this computer (the user asked for it in the page). Saved files stay. */
  async unlink() {
    this.stopped = true;
    try {
      await this.sock?.logout();
    } catch {}
    try {
      this.sock?.end(undefined);
    } catch {}
    await this.resetSession();
    this.store.setMe(null);
    this.state = 'starting';
    this.emit('change');
    await this.start();
  }

  async resetSession() {
    await fsp.rm(this.sessionDir, { recursive: true, force: true });
  }

  // ---------- events ----------
  onEvents(ev) {
    const store = this.store;
    if (ev['lid-mapping.update']) {
      const m = ev['lid-mapping.update'];
      const list = Array.isArray(m) ? m : m?.lid ? [m] : Object.entries(m || {}).map(([lid, pn]) => ({ lid, pn }));
      for (const x of list) store.addLidMapping(x.lid, x.pn);
    }
    if (ev['messaging-history.set']) {
      const { chats = [], contacts = [], messages = [], lidPnMappings = [] } = ev['messaging-history.set'];
      for (const x of lidPnMappings) store.addLidMapping(x.lid, x.pn);
      for (const c of contacts) store.upsertContact(c);
      for (const c of chats) store.upsertChat(c);
      let kept = 0;
      for (const m of messages) if (this.handleMessage(m, { isHistory: true })) kept++;
      this.log.info({ chats: chats.length, messages: messages.length, kept }, 'history sync chunk');
    }
    if (ev['contacts.upsert']) ev['contacts.upsert'].forEach((c) => store.upsertContact(c));
    if (ev['contacts.update']) ev['contacts.update'].forEach((c) => store.upsertContact(c));
    if (ev['chats.upsert']) ev['chats.upsert'].forEach((c) => store.upsertChat(c));
    if (ev['chats.update']) ev['chats.update'].forEach((c) => store.updateChat(c));
    if (ev['groups.upsert']) ev['groups.upsert'].forEach((g) => store.setGroupMetadata(g));
    if (ev['groups.update']) ev['groups.update'].forEach((g) => store.setGroupMetadata(g));
    if (ev['group-participants.update']) {
      const { id } = ev['group-participants.update'];
      this.sock?.groupMetadata(id).then((g) => store.setGroupMetadata(g)).catch(() => {});
    }
    if (ev['messages.upsert']) {
      const { messages, type } = ev['messages.upsert'];
      for (const m of messages) this.handleMessage(m, { isHistory: false, live: type === 'notify' });
    }
    if (ev['messages.update']) {
      for (const { key, update } of ev['messages.update']) {
        const chatId = store.canonical(key.remoteJid, key.remoteJidAlt);
        if (typeof update.status === 'number') {
          if (key.fromMe) {
            store.updateMessage(chatId, key.id, (m) => {
              const s = ['error', 'pending', 'sent', 'delivered', 'read', 'played'][update.status];
              if (s && (m.status == null || update.status >= ['error', 'pending', 'sent', 'delivered', 'read', 'played'].indexOf(m.status))) m.status = s;
            });
          } else if (update.status >= 4) {
            store.markRead(chatId, key.id); // another device of mine (the phone) read it
          }
        }
        if (update.starred !== undefined) store.updateMessage(chatId, key.id, (m) => (m.starred = !!update.starred));
      }
    }
    if (ev['message-receipt.update']) {
      for (const { key, receipt } of ev['message-receipt.update']) {
        const chatId = store.canonical(key.remoteJid, key.remoteJidAlt);
        if (!key.fromMe) {
          // receipts on someone else's message can only come from my own devices
          if (receipt.readTimestamp || receipt.playedTimestamp) store.markRead(chatId, key.id);
          continue;
        }
        const user = store.canonical(receipt.userJid);
        store.updateMessage(chatId, key.id, (m) => {
          m.receipts = m.receipts || {};
          const r = (m.receipts[user] = m.receipts[user] || {});
          const iso = (t) => (toNum(t) ? new Date(toNum(t) * 1000).toISOString() : undefined);
          if (receipt.receiptTimestamp) r.deliveredAt = iso(receipt.receiptTimestamp);
          if (receipt.readTimestamp) r.readAt = iso(receipt.readTimestamp);
          if (receipt.playedTimestamp) r.playedAt = iso(receipt.playedTimestamp);
        });
      }
    }
    if (ev['messages.reaction']) {
      for (const { key, reaction } of ev['messages.reaction']) {
        const chatId = store.canonical(key.remoteJid, key.remoteJidAlt);
        const rk = reaction.key || {};
        const sender = rk.fromMe ? store.me?.jid : store.canonical(rk.participant || rk.remoteJid, rk.participantAlt || rk.remoteJidAlt);
        const at = toNum(reaction.senderTimestampMs) ? Math.floor(toNum(reaction.senderTimestampMs) / 1000) : Math.floor(Date.now() / 1000);
        store.addReaction({ chatId, targetId: key.id, emoji: reaction.text || '', sender, at });
      }
    }
    if (ev['messages.delete']) {
      const d = ev['messages.delete'];
      // "delete for me" done on the phone: mark it, the window cleanup removes it later
      for (const key of d.keys || []) {
        store.updateMessage(store.canonical(key.remoteJid), key.id, (m) => (m.deletedForMe = true));
      }
    }
    if (ev.call) {
      for (const c of ev.call) {
        if (!['offer', 'timeout', 'reject', 'accept', 'terminate'].includes(c.status)) continue;
        const chatId = store.canonical(c.chatId || c.from);
        const ts = Math.floor(new Date(c.date || Date.now()).getTime() / 1000);
        const id = `call-${c.id}`;
        const prev = store.getMessage(chatId, id);
        const labels = { offer: 'Llamada entrante', timeout: 'Llamada perdida', reject: 'Llamada rechazada', accept: 'Llamada contestada', terminate: 'Llamada terminada' };
        const outcome = c.status === 'offer' ? prev?.call?.outcome || 'ringing' : c.status;
        store.putMessage(
          {
            id, chatId, fromMe: false, sender: store.canonical(c.from), ts: prev?.ts || ts, time: prev?.time || new Date(ts * 1000).toISOString(),
            type: 'call',
            text: `${c.isVideo ? 'Videollamada' : 'Llamada'}${c.isGroup ? ' grupal' : ''}: ${labels[c.status].replace('Llamada ', '').toLowerCase()}`,
            call: { video: !!c.isVideo, group: !!c.isGroup, outcome },
          },
          { live: true },
        );
      }
    }
  }

  /** Returns true when the message was kept (it falls inside the window). */
  handleMessage(msg, { isHistory, live = false }) {
    const store = this.store;
    const out = classify(msg, { meJid: store.me?.jid, canonical: (j, a) => store.canonical(j, a), isHistory });
    if (out.kind === 'reaction') {
      store.addReaction(out);
      return true;
    }
    if (out.kind === 'edit') {
      return store.updateMessage(out.chatId, out.targetId, (m) => {
        m.edited = m.edited || { previous: [] };
        if (m.text && m.text !== out.text) m.edited.previous.push(m.text);
        m.edited.at = new Date(out.at * 1000).toISOString();
        m.text = out.text;
      });
    }
    if (out.kind === 'revoke') {
      return store.updateMessage(out.chatId, out.targetId, (m) => {
        m.deleted = { at: new Date(out.at * 1000).toISOString(), by: out.by };
      });
    }
    if (out.kind !== 'message') return false;
    const rec = store.putMessage(out.record, { live });
    if (!rec) return false;
    if (rec.media && !rec.media.file && rec.media.status === 'pending' && rec.type !== 'waiting') this.queueMedia(msg, rec);
    return true;
  }

  // ---------- media ----------
  queueMedia(msg, rec) {
    if (rec.media.size && rec.media.size > this.maxMediaBytes) {
      rec.media.status = 'too_large';
      this.store.markDirty(rec.chatId);
      return;
    }
    this.mediaQueue.push({ msg, rec });
    this.pumpMedia();
  }

  pumpMedia() {
    while (this.mediaActive < 3 && this.mediaQueue.length) {
      const job = this.mediaQueue.shift();
      this.mediaActive++;
      this.download(job)
        .catch(() => {})
        .finally(() => {
          this.mediaActive--;
          this.pumpMedia();
        });
    }
  }

  async download({ msg, rec }) {
    const store = this.store;
    // the record may have been pruned or replaced meanwhile
    const live = store.getMessage(rec.chatId, rec.id);
    if (!live || !live.media || live.media.file) return;
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: this.log, reuploadRequest: this.sock?.updateMediaMessage });
      const d = new Date(rec.ts * 1000);
      const p = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const ext = extFor(live.media, live.type);
      const base = live.media.fileName ? sanitize(path.basename(live.media.fileName, path.extname(live.media.fileName))).slice(0, 60) : live.type;
      const name = `${stamp}_${base}_${rec.id.slice(-6)}${ext}`;
      const current = store.getMessage(rec.chatId, rec.id);
      if (!current?.media) return;
      const dir = store.mediaDirFor(rec.chatId);
      await fsp.mkdir(dir, { recursive: true });
      current.media.file = `media/${name}`; // set first so the orphan cleanup keeps it
      current.media.status = 'downloaded';
      current.media.size = buf.length;
      const tmp = path.join(dir, `${name}.part`);
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, path.join(dir, name));
      store.markDirty(rec.chatId);
    } catch (err) {
      const current = store.getMessage(rec.chatId, rec.id);
      if (current?.media) {
        current.media.status = 'failed';
        current.media.error = err?.message?.slice(0, 200) || 'download failed';
        store.markDirty(rec.chatId);
      }
      this.log.warn({ id: rec.id, err: err?.message }, 'media download failed');
    }
  }

  async stop() {
    this.stopped = true;
    try {
      this.sock?.end(undefined);
    } catch {}
  }
}

