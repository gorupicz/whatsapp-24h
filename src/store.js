// In-memory store of the last N hours, mirrored to plain files in the user's folder:
//
//   <dataDir>/LEEME.txt
//   <dataDir>/index.json                      every chat with activity in the window
//   <dataDir>/chats/<Name (number)>/chat.json  chat metadata (group?, archived?, unread...)
//   <dataDir>/chats/<Name (number)>/messages.json
//   <dataDir>/chats/<Name (number)>/conversation.txt   human-readable transcript
//   <dataDir>/chats/<Name (number)>/media/...           attachments
//   <dataDir>/estados/...                                statuses (stories), same layout
//
// Chat metadata and contact names (no message content) also live in <stateDir> so a restart
// keeps names and archive flags for chats that have no messages in the window.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chatTypeOf, jidUser } from './parse.js';

const FLUSH_DELAY_MS = 1500;

export class Store {
  constructor({ dataDir, stateDir, retentionHours = 24, logger = console }) {
    this.dataDir = dataDir;
    this.stateDir = stateDir;
    this.retentionSecs = retentionHours * 3600;
    this.retentionHours = retentionHours;
    this.log = logger;
    this.chats = new Map(); // chatId -> meta
    this.messages = new Map(); // chatId -> Map(id -> record)
    this.contacts = new Map(); // jid -> { name, notify, verifiedName }
    this.lidToPn = new Map();
    this.me = null; // { jid, name }
    this.dirty = new Set();
    this.stateDirty = false;
    this.flushTimer = null;
    this.flushing = null;
  }

  // ---------- loading ----------
  async load() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.mkdir(this.stateDir, { recursive: true });
    const state = await readJson(path.join(this.stateDir, 'state.json'), {});
    for (const c of state.chats || []) this.chats.set(c.id, c);
    for (const [jid, c] of Object.entries(state.contacts || {})) this.contacts.set(jid, c);
    for (const [lid, pn] of Object.entries(state.lidToPn || {})) this.lidToPn.set(lid, pn);
    if (state.me) this.me = state.me;
    for (const [jid, c] of this.contacts) {
      // a bare phone number is not a name
      if (c.notify === `+${jidUser(jid)}`) delete c.notify;
      // contacts saved under @lid before their number was known
      const pn = jid.endsWith('@lid') && this.lidToPn.get(jid);
      if (pn) {
        this.contacts.set(pn, { ...c, ...this.contacts.get(pn) });
        this.contacts.delete(jid);
      }
    }
    for (const meta of this.chats.values()) {
      if (!meta.folder) continue;
      const msgs = await readJson(path.join(this.dataDir, meta.folder, 'messages.json'), []);
      const map = new Map();
      for (const m of msgs) map.set(m.id, m);
      if (map.size) this.messages.set(meta.id, map);
    }
    await this.prune();
  }

  // ---------- identity ----------
  setMe(me) {
    this.me = me;
    this.stateDirty = true;
    this.scheduleFlush();
  }

  addLidMapping(lid, pn) {
    if (!lid?.endsWith('@lid') || !pn?.endsWith('@s.whatsapp.net')) return;
    if (this.lidToPn.get(lid) === pn) return;
    this.lidToPn.set(lid, pn);
    this.stateDirty = true;
    const lc = this.contacts.get(lid);
    if (lc) {
      this.contacts.set(pn, { ...lc, ...this.contacts.get(pn) });
      this.contacts.delete(lid);
      this.namesChanged = true;
    }
    if (this.chats.has(lid) || this.messages.has(lid)) this.mergeChat(lid, pn);
  }

  /** Prefer the phone-number JID over the anonymous @lid one, so one person = one chat. */
  canonical(jid, alt) {
    if (!jid) return jid;
    let j = jid.replace(/:\d+@/, '@');
    if (j.endsWith('@lid')) {
      if (alt?.endsWith('@s.whatsapp.net')) {
        this.addLidMapping(j, alt.replace(/:\d+@/, '@'));
        return alt.replace(/:\d+@/, '@');
      }
      return this.lidToPn.get(j) || j;
    }
    return j;
  }

  upsertContact(c) {
    if (!c?.id) return;
    if (c.notify && /^\+?\d[\d\s-]*$/.test(c.notify)) c = { ...c, notify: undefined };
    if (c.lid && c.phoneNumber) this.addLidMapping(c.lid, c.phoneNumber);
    if (c.id.endsWith('@lid') && c.phoneNumber) this.addLidMapping(c.id, c.phoneNumber);
    const jid = this.canonical(c.id, c.phoneNumber);
    const prev = this.contacts.get(jid) || {};
    const next = { ...prev };
    for (const k of ['name', 'notify', 'verifiedName']) if (c[k]) next[k] = c[k];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      this.contacts.set(jid, next);
      this.stateDirty = true;
      this.namesChanged = true;
      this.scheduleFlush();
    }
  }

  nameOf(jid, fallback) {
    if (!jid) return fallback || null;
    if (this.me && jid === this.me.jid) return 'Yo';
    const c = this.contacts.get(jid);
    const chat = this.chats.get(jid);
    return c?.name || chat?.name || c?.notify || c?.verifiedName || fallback || (jid.endsWith('@s.whatsapp.net') ? `+${jidUser(jid)}` : jidUser(jid));
  }

  // ---------- chats ----------
  ensureChat(chatId) {
    let meta = this.chats.get(chatId);
    if (!meta) {
      meta = { id: chatId, type: chatTypeOf(chatId), unreadCount: 0, archived: false };
      this.chats.set(chatId, meta);
      this.stateDirty = true;
    }
    return meta;
  }

  /** Full chat object (history sync / chats.upsert): unreadCount is absolute. */
  upsertChat(chat) {
    if (!chat?.id) return;
    const id = this.canonical(chat.id, chat.pnJid);
    const meta = this.ensureChat(id);
    applyChatFields(meta, chat);
    if (typeof chat.unreadCount === 'number' && chat.unreadCount >= 0) {
      meta.unreadCount = chat.unreadCount;
      this.applyUnreadToMessages(id);
    }
    if (chat.markedAsUnread) meta.markedUnread = true;
    this.markDirty(id);
  }

  /** Partial update (chats.update): positive unreadCount is a delta, 0 = read, -1 = marked unread. */
  updateChat(update) {
    if (!update?.id) return;
    const id = this.canonical(update.id);
    const meta = this.ensureChat(id);
    applyChatFields(meta, update);
    const u = update.unreadCount;
    if (typeof u === 'number') {
      if (u > 0) meta.unreadCount = (meta.unreadCount || 0) + u;
      else if (u === 0) {
        meta.unreadCount = 0;
        meta.markedUnread = false;
        this.markAllRead(id);
      } else if (u < 0) meta.markedUnread = true;
    }
    this.markDirty(id);
  }

  setGroupMetadata(g) {
    if (!g?.id) return;
    const meta = this.ensureChat(g.id);
    meta.name = g.subject || meta.name;
    meta.group = {
      subject: g.subject ?? meta.group?.subject ?? null,
      description: g.desc ?? meta.group?.description ?? null,
      owner: g.owner ? this.canonical(g.owner, g.ownerPn) : meta.group?.owner ?? null,
      createdAt: g.creation ? new Date(g.creation * 1000).toISOString() : meta.group?.createdAt ?? null,
      onlyAdminsCanSend: g.announce ?? meta.group?.onlyAdminsCanSend ?? null,
      isCommunity: g.isCommunity ?? meta.group?.isCommunity ?? false,
      communityId: g.linkedParent ?? meta.group?.communityId ?? null,
      participants: g.participants
        ? g.participants.map((p) => {
            if (p.lid && p.phoneNumber) this.addLidMapping(p.lid, p.phoneNumber);
            return { jid: this.canonical(p.id, p.phoneNumber), admin: p.admin || null };
          })
        : meta.group?.participants ?? [],
    };
    this.markDirty(g.id);
  }

  mergeChat(fromId, toId) {
    const from = this.chats.get(fromId);
    const to = this.ensureChat(toId);
    if (from) {
      for (const [k, v] of Object.entries(from)) if (to[k] == null && k !== 'id' && k !== 'folder') to[k] = v;
      this.chats.delete(fromId);
    }
    const msgs = this.messages.get(fromId);
    if (msgs) {
      const target = this.messages.get(toId) || new Map();
      for (const [id, m] of msgs) target.set(id, { ...m, chatId: toId });
      this.messages.set(toId, target);
      this.messages.delete(fromId);
    }
    if (from?.folder) {
      if (!to.folder) to.folder = from.folder; // _flush renames it to the new name
      else {
        // both had folders: move the attachments over, drop the old folder
        const src = path.join(this.dataDir, from.folder, 'media');
        const dst = path.join(this.dataDir, to.folder, 'media');
        try {
          fs.mkdirSync(dst, { recursive: true });
          for (const f of fs.readdirSync(src)) fs.renameSync(path.join(src, f), path.join(dst, f));
        } catch {}
        fs.rmSync(path.join(this.dataDir, from.folder), { recursive: true, force: true });
      }
    }
    this.stateDirty = true;
    this.markDirty(toId);
  }

  // ---------- messages ----------
  isInWindow(ts) {
    return ts >= Math.floor(Date.now() / 1000) - this.retentionSecs;
  }

  getMessage(chatId, id) {
    return this.messages.get(chatId)?.get(id) || null;
  }

  findMessage(id) {
    for (const map of this.messages.values()) if (map.has(id)) return map.get(id);
    return null;
  }

  putMessage(record, { live = false } = {}) {
    if (!this.isInWindow(record.ts)) return null;
    const chat = this.ensureChat(record.chatId);
    let map = this.messages.get(record.chatId);
    if (!map) this.messages.set(record.chatId, (map = new Map()));
    const prev = map.get(record.id);
    const merged = prev ? mergeRecords(prev, record) : record;
    if (!merged.fromMe && merged.type !== 'system' && merged.readByMe === undefined) merged.readByMe = !live ? null : false;
    map.set(record.id, merged);
    if (!chat.lastMessageTs || merged.ts > chat.lastMessageTs) chat.lastMessageTs = merged.ts;
    if (live && merged.fromMe && !prev) this.markAllRead(record.chatId, merged.ts); // replying reads the chat
    if (!merged.fromMe && merged.pushName && merged.sender && !this.contacts.get(merged.sender)?.notify) {
      this.upsertContact({ id: merged.sender, notify: merged.pushName });
    }
    if (!live) this.applyUnreadToMessages(record.chatId);
    this.markDirty(record.chatId);
    return merged;
  }

  updateMessage(chatId, id, fn) {
    const m = this.getMessage(chatId, id) || this.findMessage(id);
    if (!m) return false;
    fn(m);
    this.markDirty(m.chatId);
    return true;
  }

  addReaction({ chatId, targetId, emoji, sender, senderName, at }) {
    const found = this.updateMessage(chatId, targetId, (m) => {
      m.reactions = (m.reactions || []).filter((r) => r.sender !== sender);
      if (emoji) m.reactions.push({ emoji, sender, at: at ? new Date(at * 1000).toISOString() : null });
    });
    if (!found && emoji && this.isInWindow(at)) {
      // Reaction to a message older than the window: keep it as its own entry.
      this.putMessage(
        { id: `reaction-${targetId}-${jidUser(sender)}`, chatId, fromMe: sender === this.me?.jid, sender, pushName: senderName, ts: at, time: new Date(at * 1000).toISOString(), type: 'reaction', text: emoji, reactionTo: { id: targetId } },
        { live: true },
      );
    }
    if (senderName && sender) this.upsertContact({ id: sender, notify: senderName });
  }

  markAllRead(chatId, beforeTs = Infinity) {
    const map = this.messages.get(chatId);
    if (!map) return;
    const now = new Date().toISOString();
    for (const m of map.values()) {
      if (!m.fromMe && m.readByMe !== true && m.ts <= beforeTs) {
        m.readByMe = true;
        m.readByMeAt = now;
      }
    }
    this.markDirty(chatId);
  }

  markRead(chatId, id) {
    this.updateMessage(chatId, id, (m) => {
      if (!m.fromMe && m.readByMe !== true) {
        m.readByMe = true;
        m.readByMeAt = new Date().toISOString();
      }
    });
  }

  /** For history-synced chats: the newest `unreadCount` incoming messages are unread, older ones read. */
  applyUnreadToMessages(chatId) {
    const meta = this.chats.get(chatId);
    const map = this.messages.get(chatId);
    if (!meta || !map) return;
    const incoming = [...map.values()].filter((m) => !m.fromMe && m.type !== 'system').sort((a, b) => b.ts - a.ts);
    const unread = meta.unreadCount || 0;
    incoming.forEach((m, i) => {
      if (m.readByMe === true && m.readByMeAt) return; // observed read, keep it
      m.readByMe = i >= unread;
    });
  }

  // ---------- retention ----------
  async prune() {
    const cutoff = Math.floor(Date.now() / 1000) - this.retentionSecs;
    for (const [chatId, map] of this.messages) {
      let removed = 0;
      for (const [id, m] of map) {
        if (m.ts < cutoff) {
          map.delete(id);
          removed++;
        }
      }
      if (!map.size) this.messages.delete(chatId);
      // rewrite every chat: refreshes files and sweeps attachments nobody references
      this.dirty.add(chatId);
    }
    await this.flush();
  }

  // ---------- persistence ----------
  markDirty(chatId) {
    this.dirty.add(chatId);
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((e) => this.log.error?.({ err: e?.message }, 'flush failed'));
    }, FLUSH_DELAY_MS);
  }

  /** Folder (relative to dataDir) for a chat. */
  folderFor(chatId) {
    const meta = this.chats.get(chatId);
    if (meta?.type === 'status') return 'estados';
    const name = sanitize(this.nameOf(chatId)) || 'chat';
    const id = jidUser(chatId);
    const label = chatId.endsWith('@s.whatsapp.net') ? `+${id}` : id;
    return path.join('chats', name.includes(id) ? name : `${name} (${label})`.slice(0, 120));
  }

  mediaDirFor(chatId) {
    return path.join(this.dataDir, this.folderFor(chatId), 'media');
  }

  async flush() {
    if (this.flushing) {
      await this.flushing;
      if (!this.dirty.size && !this.stateDirty) return;
    }
    this.flushing = this._flush().finally(() => (this.flushing = null));
    return this.flushing;
  }

  async _flush() {
    if (this.namesChanged && Date.now() - (this.lastFullRewrite || 0) > 20000) {
      this.namesChanged = false;
      this.lastFullRewrite = Date.now();
      for (const id of this.messages.keys()) this.dirty.add(id);
    } else if (this.namesChanged) this.scheduleFlush();
    const dirty = [...this.dirty];
    this.dirty.clear();
    for (const chatId of dirty) {
      const meta = this.chats.get(chatId);
      if (!meta) continue;
      const map = this.messages.get(chatId);
      if (!map || !map.size) {
        if (meta.folder) {
          await fsp.rm(path.join(this.dataDir, meta.folder), { recursive: true, force: true });
          delete meta.folder;
          this.stateDirty = true;
        }
        continue;
      }
      const folder = this.folderFor(chatId);
      const abs = path.join(this.dataDir, folder);
      if (meta.folder && meta.folder !== folder && fs.existsSync(path.join(this.dataDir, meta.folder))) {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.rm(abs, { recursive: true, force: true });
        await fsp.rename(path.join(this.dataDir, meta.folder), abs);
      }
      if (meta.folder !== folder) {
        meta.folder = folder;
        this.stateDirty = true;
      }
      await fsp.mkdir(abs, { recursive: true });
      const msgs = [...map.values()].sort((a, b) => a.ts - b.ts);
      for (const m of msgs) decorate(m, this);
      await writeJson(path.join(abs, 'messages.json'), msgs);
      await writeJson(path.join(abs, 'chat.json'), this.publicChat(chatId));
      await writeAtomic(path.join(abs, 'conversation.txt'), transcript(this, chatId, msgs));
      await this.cleanOrphanMedia(abs, msgs);
    }
    if (dirty.length) {
      await writeJson(path.join(this.dataDir, 'index.json'), {
        generatedAt: new Date().toISOString(),
        retentionHours: this.retentionHours,
        account: this.me ? { jid: this.me.jid, name: this.me.name || null } : null,
        chats: this.listChats(),
      });
      await writeAtomic(path.join(this.dataDir, 'LEEME.txt'), README_TXT(this.retentionHours));
    }
    if (this.stateDirty) {
      this.stateDirty = false;
      await writeJson(path.join(this.stateDir, 'state.json'), {
        me: this.me,
        chats: [...this.chats.values()],
        contacts: Object.fromEntries(this.contacts),
        lidToPn: Object.fromEntries(this.lidToPn),
      });
    }
  }

  async cleanOrphanMedia(chatAbs, msgs) {
    const dir = path.join(chatAbs, 'media');
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch {
      return;
    }
    const keep = new Set(msgs.map((m) => m.media?.file && path.basename(m.media.file)).filter(Boolean));
    for (const f of files) {
      if (f.endsWith('.part')) continue;
      if (!keep.has(f)) await fsp.rm(path.join(dir, f), { force: true });
    }
  }

  // ---------- read API ----------
  publicChat(chatId) {
    const meta = this.chats.get(chatId) || { id: chatId };
    const map = this.messages.get(chatId);
    const msgs = map ? [...map.values()] : [];
    const last = msgs.sort((a, b) => b.ts - a.ts)[0];
    return {
      id: chatId,
      name: this.nameOf(chatId),
      type: meta.type || chatTypeOf(chatId),
      isGroup: meta.type === 'group',
      phone: chatId.endsWith('@s.whatsapp.net') ? `+${jidUser(chatId)}` : null,
      archived: !!meta.archived,
      pinned: !!meta.pinned,
      muted: meta.muteEndTime ? meta.muteEndTime * 1000 > Date.now() || meta.muteEndTime < 0 : false,
      mutedUntil: meta.muteEndTime > 0 ? new Date(meta.muteEndTime * 1000).toISOString() : null,
      unreadCount: meta.unreadCount || 0,
      markedUnread: !!meta.markedUnread,
      disappearingSeconds: meta.ephemeralExpiration || null,
      readOnly: !!meta.readOnly,
      group: meta.group
        ? {
            ...meta.group,
            participants: (meta.group.participants || []).map((p) => {
              const jid = p.jid?.endsWith('@lid') ? this.lidToPn.get(p.jid) || p.jid : p.jid;
              return { ...p, jid, name: this.nameOf(jid) };
            }),
          }
        : undefined,
      folder: meta.folder || null,
      messageCount: msgs.length,
      unreadInWindow: msgs.filter((m) => !m.fromMe && m.readByMe === false).length,
      mediaCount: msgs.filter((m) => m.media?.file).length,
      lastMessageAt: last ? last.time : null,
      lastMessagePreview: last ? preview(this, last) : null,
    };
  }

  listChats() {
    return [...this.messages.keys()]
      .map((id) => this.publicChat(id))
      .sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
  }

  listMessages(chatId) {
    const map = this.messages.get(chatId);
    if (!map) return [];
    return [...map.values()].sort((a, b) => a.ts - b.ts).map((m) => decorate(m, this));
  }

  stats() {
    let messages = 0;
    let media = 0;
    let statuses = 0;
    let groups = 0;
    let unread = 0;
    let lastTs = 0;
    for (const [chatId, map] of this.messages) {
      const meta = this.chats.get(chatId);
      if (meta?.type === 'status') statuses += map.size;
      else messages += map.size;
      if (meta?.type === 'group') groups++;
      for (const m of map.values()) {
        if (m.media?.file) media++;
        if (!m.fromMe && m.readByMe === false) unread++;
        if (m.ts > lastTs) lastTs = m.ts;
      }
    }
    return {
      chats: [...this.messages.keys()].filter((id) => this.chats.get(id)?.type !== 'status').length,
      groups,
      messages,
      statuses,
      media,
      unread,
      lastMessageAt: lastTs ? new Date(lastTs * 1000).toISOString() : null,
    };
  }
}

// ---------- helpers ----------
const CHAT_FIELDS = ['name', 'archived', 'pinned', 'muteEndTime', 'ephemeralExpiration', 'readOnly'];
function applyChatFields(meta, src) {
  for (const k of CHAT_FIELDS) {
    if (src[k] === undefined || src[k] === null) continue;
    let v = src[k];
    if (typeof v === 'object' && typeof v.toNumber === 'function') v = v.toNumber();
    if (k === 'pinned') v = !!v;
    if (k === 'name' && !v) continue;
    meta[k] = v;
  }
}

function mergeRecords(prev, next) {
  const out = { ...prev, ...next };
  // keep what we learned about the old copy
  for (const k of ['reactions', 'readByMe', 'readByMeAt', 'edited', 'deleted', 'receipts']) {
    if (prev[k] !== undefined && (next[k] === undefined || (k === 'readByMe' && next[k] === null))) out[k] = prev[k];
  }
  if (prev.media?.file && next.media && !next.media.file) out.media = prev.media;
  if (prev.type !== 'waiting' && next.type === 'waiting') return prev;
  return out;
}

function decorate(m, store) {
  const fix = (j) => (j && j.endsWith('@lid') ? store.lidToPn.get(j) || j : j);
  m.sender = fix(m.sender);
  if (m.sender) m.senderName = store.nameOf(m.sender, m.pushName);
  if (m.replyTo?.sender) {
    m.replyTo.sender = fix(m.replyTo.sender);
    m.replyTo.senderName = store.nameOf(m.replyTo.sender);
  }
  if (m.mentions) m.mentions = m.mentions.map(fix);
  if (m.replyTo?.id && !m.replyTo.text) {
    const q = store.getMessage(m.chatId, m.replyTo.id);
    if (q) m.replyTo.text = q.text || (q.media ? `[${q.type}]` : null);
  }
  for (const r of m.reactions || []) {
    r.sender = fix(r.sender);
    r.senderName = store.nameOf(r.sender);
  }
  return m;
}

const TYPE_LABEL = {
  image: 'imagen', video: 'video', video_note: 'video circular', gif: 'GIF', audio: 'audio', voice: 'nota de voz',
  document: 'documento', sticker: 'sticker', location: 'ubicación', live_location: 'ubicación en tiempo real',
  contact: 'contacto', contacts: 'contactos', product: 'producto', call: 'llamada', poll: 'encuesta', event: 'evento', group_invite: 'invitación a grupo',
  reaction: 'reacción', system: 'aviso', waiting: 'esperando mensaje', other: 'otro',
};

function preview(store, m) {
  const who = m.fromMe ? 'Yo' : store.nameOf(m.sender, m.pushName);
  const body = m.deleted ? '(eliminado)' : m.text || (m.type !== 'text' ? `[${TYPE_LABEL[m.type] || m.type}]` : '');
  return `${who}: ${body}`.slice(0, 140);
}

function fmtLocal(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function transcript(store, chatId, msgs) {
  const c = store.publicChat(chatId);
  const kind = { group: 'grupo', individual: 'conversación 1 a 1', status: 'estados', channel: 'canal', broadcast: 'difusión' }[c.type] || c.type;
  const lines = [
    `${c.name} — ${kind}${c.phone ? ` — ${c.phone}` : ''}`,
    `Archivado: ${c.archived ? 'sí' : 'no'} · Fijado: ${c.pinned ? 'sí' : 'no'} · Silenciado: ${c.muted ? 'sí' : 'no'} · Sin leer: ${c.unreadCount}`,
    `Solo se guardan las últimas ${store.retentionHours} horas. Actualizado: ${fmtLocal(new Date().toISOString())}`,
    '',
  ];
  for (const m of msgs) {
    const who = m.fromMe ? 'Yo' : store.nameOf(m.sender, m.pushName);
    let line = `[${fmtLocal(m.time)}] ${who}`;
    if (m.replyTo) line += ` (respondiendo a ${m.replyTo.senderName || 'un mensaje'}${m.replyTo.text ? `: "${m.replyTo.text.slice(0, 60)}"` : ''})`;
    if (m.reactionTo) line += ' (reaccionó a un mensaje anterior)';
    line += ':';
    if (m.forwarded) line += ' [reenviado]';
    if (m.type !== 'text') line += ` [${TYPE_LABEL[m.type] || m.type}${m.media?.file ? `: ${m.media.file}` : ''}]`;
    if (m.location) line += ` ${m.location.url || ''}`;
    if (m.poll) line += ` ${m.poll.question} → ${m.poll.options.join(' / ')}`;
    if (m.text && !m.poll) line += ` ${m.text}`;
    if (m.edited) line += ' (editado)';
    if (m.deleted) line += ' (eliminado para todos)';
    if (!m.fromMe && m.readByMe === false) line += ' (sin leer)';
    if (m.fromMe && m.status) line += ` (${{ sent: 'enviado', delivered: 'entregado', read: 'leído', played: 'reproducido', pending: 'pendiente', error: 'error' }[m.status] || m.status})`;
    lines.push(line);
    if (m.reactions?.length) lines.push(`    Reacciones: ${m.reactions.map((r) => `${r.emoji} ${store.nameOf(r.sender)}`).join(', ')}`);
  }
  return lines.join('\n') + '\n';
}

export function sanitize(name) {
  return String(name || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

const writeJson = (file, obj) => writeAtomic(file, JSON.stringify(obj, null, 2));

const README_TXT = (h) => `WhatsApp 24h — copia local de solo lectura
==========================================

Esta carpeta guarda automáticamente tus conversaciones de WhatsApp de las últimas ${h} horas.
Lo que tiene más de ${h} horas se borra solo (mensajes y adjuntos).
El programa NUNCA envía mensajes: solo lee.

  index.json              Lista de chats con actividad (grupo o 1 a 1, archivado, sin leer, último mensaje)
  chats/<nombre>/         Una carpeta por conversación
      conversation.txt    La conversación en texto, fácil de leer
      messages.json       Todos los detalles: respuestas, reacciones, editados, eliminados, leídos, etc.
      chat.json           Datos del chat: si es grupo, participantes, archivado, silenciado, fijado
      media/              Fotos, videos, audios, notas de voz, documentos y stickers
  estados/                Los estados (historias) de tus contactos y los tuyos

Para verlo en el navegador abre: http://localhost:2424
`;
