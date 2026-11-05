// Turns a raw Baileys WAMessage into a plain, JSON-friendly record (or an "effect" on another
// message: reaction, edit, delete). Pure: no I/O, no socket. Tested in test/parse.test.js.
import { proto, normalizeMessageContent, getContentType } from '@whiskeysockets/baileys';

const STATUS_NAMES = ['error', 'pending', 'sent', 'delivered', 'read', 'played'];
export const statusName = (n) => STATUS_NAMES[n] ?? null;

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video_note',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

// Protocol messages that only carry plumbing (keys, history notifications...).
const PROTOCOL = proto.Message.ProtocolMessage.Type;

export const jidUser = (jid) => (jid || '').split('@')[0].split(':')[0];
export const isGroupJid = (jid) => (jid || '').endsWith('@g.us');
export const isStatusJid = (jid) => jid === 'status@broadcast';

export function chatTypeOf(jid) {
  if (isStatusJid(jid)) return 'status';
  if (isGroupJid(jid)) return 'group';
  if ((jid || '').endsWith('@newsletter')) return 'channel';
  if ((jid || '').endsWith('@broadcast')) return 'broadcast';
  return 'individual';
}

const toNum = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export { toNum };

/** Best-effort human text for any message content (also used for quoted messages). */
export function textOf(content) {
  const c = normalizeMessageContent(content);
  if (!c) return null;
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    c.documentMessage?.caption ||
    c.ptvMessage?.caption ||
    c.buttonsResponseMessage?.selectedDisplayText ||
    c.listResponseMessage?.title ||
    c.templateButtonReplyMessage?.selectedDisplayText ||
    c.interactiveResponseMessage?.body?.text ||
    c.buttonsMessage?.contentText ||
    c.templateMessage?.hydratedTemplate?.hydratedContentText ||
    c.listMessage?.description ||
    c.pollCreationMessage?.name ||
    c.pollCreationMessageV2?.name ||
    c.pollCreationMessageV3?.name ||
    c.eventMessage?.name ||
    c.contactMessage?.displayName ||
    c.locationMessage?.name ||
    c.groupInviteMessage?.groupName ||
    null
  );
}

function typeOf(content) {
  const c = normalizeMessageContent(content);
  if (!c) return { type: 'unknown', key: null };
  const key = getContentType(c);
  if (!key) return { type: 'unknown', key: null };
  if (key === 'conversation' || key === 'extendedTextMessage') return { type: 'text', key };
  if (key === 'audioMessage') return { type: c.audioMessage?.ptt ? 'voice' : 'audio', key };
  if (key === 'videoMessage') return { type: c.videoMessage?.gifPlayback ? 'gif' : 'video', key };
  if (MEDIA_TYPES[key]) return { type: MEDIA_TYPES[key], key };
  if (key === 'locationMessage') return { type: 'location', key };
  if (key === 'liveLocationMessage') return { type: 'live_location', key };
  if (key === 'contactMessage') return { type: 'contact', key };
  if (key === 'contactsArrayMessage') return { type: 'contacts', key };
  if (/^pollCreationMessage/.test(key)) return { type: 'poll', key };
  if (key === 'eventMessage') return { type: 'event', key };
  if (key === 'groupInviteMessage') return { type: 'group_invite', key };
  if (key === 'reactionMessage') return { type: 'reaction', key };
  if (key === 'productMessage') return { type: 'product', key };
  if (key === 'protocolMessage') return { type: 'protocol', key };
  return { type: 'other', key };
}

/**
 * @param {object} msg   raw WAMessage
 * @param {object} ctx   { meJid, canonical(jid, alt) -> jid, isHistory }
 * @returns {{kind: string, ...}}
 *   kind 'message' → { record }
 *   kind 'reaction' → { chatId, targetId, emoji, sender, at }
 *   kind 'edit' → { chatId, targetId, text, at }
 *   kind 'revoke' → { chatId, targetId, by, at }
 *   kind 'ignore'
 */
export function classify(msg, ctx) {
  const key = msg?.key;
  if (!key?.remoteJid || !key.id) return { kind: 'ignore' };
  const chatId = ctx.canonical(key.remoteJid, key.remoteJidAlt);
  const ts = toNum(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
  const fromMe = !!key.fromMe;
  const rawSender = fromMe
    ? ctx.meJid
    : isGroupJid(key.remoteJid) || isStatusJid(key.remoteJid)
      ? key.participant
      : key.remoteJid;
  const senderAlt = fromMe ? null : key.participant ? key.participantAlt : key.remoteJidAlt;
  const sender = rawSender ? ctx.canonical(rawSender, senderAlt) : null;
  const content = normalizeMessageContent(msg.message);
  const { type, key: contentKey } = typeOf(msg.message);

  // System / stub messages (group created, participant added, call missed, etc.)
  if (!content && msg.messageStubType) {
    const stubName = proto.WebMessageInfo.StubType[msg.messageStubType] || String(msg.messageStubType);
    if (stubName === 'CIPHERTEXT') {
      return {
        kind: 'message',
        record: base({ type: 'waiting', text: 'Esperando este mensaje (WhatsApp lo reenviará).' }),
      };
    }
    return {
      kind: 'message',
      record: base({
        type: 'system',
        system: { event: stubName, params: msg.messageStubParameters || [] },
        text: describeStub(stubName, msg.messageStubParameters || []),
      }),
    };
  }
  if (!content) return { kind: 'ignore' };

  if (type === 'reaction') {
    const r = content.reactionMessage;
    if (!r?.key?.id) return { kind: 'ignore' };
    return {
      kind: 'reaction',
      chatId,
      targetId: r.key.id,
      emoji: r.text || '',
      sender,
      senderName: fromMe ? null : msg.pushName || null,
      at: toNum(r.senderTimestampMs) ? Math.floor(toNum(r.senderTimestampMs) / 1000) : ts,
    };
  }

  if (type === 'protocol') {
    const p = content.protocolMessage;
    if (p?.type === PROTOCOL.REVOKE && p.key?.id) {
      return { kind: 'revoke', chatId, targetId: p.key.id, by: sender, at: ts };
    }
    if (p?.type === PROTOCOL.MESSAGE_EDIT && p.key?.id) {
      return { kind: 'edit', chatId, targetId: p.key.id, text: textOf(p.editedMessage), at: ts };
    }
    if (p?.type === PROTOCOL.EPHEMERAL_SETTING) {
      const secs = toNum(p.ephemeralExpiration) || 0;
      return {
        kind: 'message',
        record: base({
          type: 'system',
          system: { event: 'EPHEMERAL_SETTING', params: [String(secs)] },
          text: secs ? `Mensajes temporales activados (${Math.round(secs / 86400)} días)` : 'Mensajes temporales desactivados',
        }),
      };
    }
    return { kind: 'ignore' };
  }

  // Plumbing-only payloads (sender keys, context info alone) carry nothing visible.
  if (type === 'unknown') return { kind: 'ignore' };
  if (type === 'other' && ['senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'encReactionMessage', 'keepInChatMessage', 'encEventResponseMessage', 'albumMessage'].includes(contentKey)) {
    return { kind: 'ignore' };
  }

  const inner = content[contentKey] || {};
  const record = base({ type, text: textOf(msg.message) });
  if (type === 'other') record.otherType = contentKey;

  const info = inner.contextInfo || content.extendedTextMessage?.contextInfo;
  if (info) {
    if (info.stanzaId) {
      record.replyTo = {
        id: info.stanzaId,
        sender: info.participant ? ctx.canonical(info.participant) : null,
        text: info.quotedMessage ? textOf(info.quotedMessage) : null,
        type: info.quotedMessage ? typeOf(info.quotedMessage).type : null,
      };
    }
    if (info.mentionedJid?.length) record.mentions = info.mentionedJid.map((j) => ctx.canonical(j));
    if (info.isForwarded) record.forwarded = { score: info.forwardingScore || 1 };
    if (info.expiration) record.disappearingSeconds = info.expiration;
  }

  if (msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessageV2Extension || inner.viewOnce) {
    record.viewOnce = true;
  }

  if (MEDIA_TYPES[contentKey]) {
    record.media = {
      mimetype: inner.mimetype || null,
      fileName: inner.fileName || null,
      size: toNum(inner.fileLength),
      seconds: inner.seconds ?? null,
      width: inner.width ?? null,
      height: inner.height ?? null,
      animated: contentKey === 'stickerMessage' ? !!inner.isAnimated : undefined,
      file: null,
      status: 'pending',
    };
  }
  if (contentKey === 'locationMessage' || contentKey === 'liveLocationMessage') {
    record.location = {
      latitude: inner.degreesLatitude,
      longitude: inner.degreesLongitude,
      name: inner.name || null,
      address: inner.address || null,
      url: inner.degreesLatitude != null ? `https://maps.google.com/?q=${inner.degreesLatitude},${inner.degreesLongitude}` : null,
    };
  }
  if (contentKey === 'contactMessage') record.contacts = [{ name: inner.displayName, vcard: inner.vcard }];
  if (contentKey === 'contactsArrayMessage') {
    record.contacts = (inner.contacts || []).map((c) => ({ name: c.displayName, vcard: c.vcard }));
    record.text = record.text || `${record.contacts.length} contactos`;
  }
  if (type === 'poll') {
    record.poll = {
      question: inner.name,
      options: (inner.options || []).map((o) => o.optionName),
      multipleAnswers: (inner.selectableOptionsCount || 0) !== 1,
    };
  }
  if (type === 'event') {
    record.event = {
      name: inner.name,
      description: inner.description || null,
      startTime: toNum(inner.startTime) ? new Date(toNum(inner.startTime) * 1000).toISOString() : null,
      location: inner.location?.name || null,
    };
  }
  if (type === 'product') {
    const p = inner.product || {};
    record.product = { title: p.title || null, description: p.description || null, price: toNum(p.priceAmount1000) != null ? toNum(p.priceAmount1000) / 1000 : null, currency: p.currencyCode || null, url: p.url || null };
    record.text = [p.title, p.description, inner.body].filter(Boolean).join(' — ') || null;
  }
  if (type === 'group_invite') record.groupInvite = { groupName: inner.groupName, groupJid: inner.groupJid };

  // History sync carries reactions and group receipts inline.
  const inlineReactions = (msg.reactions || [])
    .filter((r) => r?.text)
    .map((r) => ({
      emoji: r.text,
      sender: r.key?.fromMe ? ctx.meJid : r.key?.participant ? ctx.canonical(r.key.participant) : r.key?.remoteJid ? ctx.canonical(r.key.remoteJid) : null,
      at: toNum(r.senderTimestampMs) ? Math.floor(toNum(r.senderTimestampMs) / 1000) : null,
    }));
  if (inlineReactions.length) record.reactions = inlineReactions;
  if (fromMe && msg.userReceipt?.length) {
    record.receipts = {};
    for (const r of msg.userReceipt) {
      if (!r.userJid) continue;
      record.receipts[ctx.canonical(r.userJid)] = {
        deliveredAt: isoOf(toNum(r.receiptTimestamp)),
        readAt: isoOf(toNum(r.readTimestamp)),
        playedAt: isoOf(toNum(r.playedTimestamp)),
      };
    }
  }
  return { kind: 'message', record };

  function base(extra) {
    const rec = {
      id: key.id,
      chatId,
      fromMe,
      sender,
      pushName: fromMe ? null : msg.pushName || null,
      ts,
      time: new Date(ts * 1000).toISOString(),
      ...extra,
    };
    if (ctx.isHistory) rec.fromHistorySync = true;
    if (msg.broadcast) rec.broadcast = true;
    if (fromMe) rec.status = statusName(msg.status) || 'sent';
    if (msg.starred) rec.starred = true;
    return rec;
  }
}

const isoOf = (secs) => (secs ? new Date(secs * 1000).toISOString() : null);

function describeStub(name, params) {
  const p = params.join(', ');
  const map = {
    GROUP_CREATE: `Grupo creado: ${p}`,
    GROUP_CHANGE_SUBJECT: `Nuevo nombre del grupo: ${p}`,
    GROUP_CHANGE_DESCRIPTION: 'Cambió la descripción del grupo',
    GROUP_CHANGE_ICON: 'Cambió la foto del grupo',
    GROUP_PARTICIPANT_ADD: `Agregado al grupo: ${p}`,
    GROUP_PARTICIPANT_REMOVE: `Eliminado del grupo: ${p}`,
    GROUP_PARTICIPANT_LEAVE: `Salió del grupo: ${p}`,
    GROUP_PARTICIPANT_PROMOTE: `Ahora es admin: ${p}`,
    GROUP_PARTICIPANT_DEMOTE: `Ya no es admin: ${p}`,
    GROUP_PARTICIPANT_INVITE: `Se unió con enlace: ${p}`,
    CALL_MISSED_VOICE: 'Llamada de voz perdida',
    CALL_MISSED_VIDEO: 'Videollamada perdida',
    CALL_MISSED_GROUP_VOICE: 'Llamada grupal perdida',
    CALL_MISSED_GROUP_VIDEO: 'Videollamada grupal perdida',
    REVOKE: 'Mensaje eliminado',
    E2E_ENCRYPTED: 'Mensajes cifrados de extremo a extremo',
  };
  return map[name] || `Evento: ${name}${p ? ` (${p})` : ''}`;
}
