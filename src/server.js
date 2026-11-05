// Local web page + JSON API on http://localhost:2424 (only reachable from this computer).
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pino from 'pino';
import { loadConfig, APP_DIR } from './config.js';
import { Store } from './store.js';
import { WhatsApp } from './whatsapp.js';
import { removeLoginItem, unloadLoginItem, deleteConversations, deleteProgramState } from './uninstall.js';

const cfg = loadConfig();
fs.mkdirSync(cfg.logDir, { recursive: true });
const log = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pino.multistream([
    { stream: process.stdout },
    { stream: pino.destination({ dest: path.join(cfg.logDir, 'server.log'), mkdir: true, sync: false }) },
  ]),
);

process.on('unhandledRejection', (err) => log.error({ err: err?.stack || String(err) }, 'unhandled rejection'));
process.on('uncaughtException', (err) => log.error({ err: err?.stack || String(err) }, 'uncaught exception'));

const PUBLIC_DIR = path.join(APP_DIR, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.amr': 'audio/amr', '.pdf': 'application/pdf',
};

let store;
let wa;
let pruneTimer;

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Block other websites from talking to this server (DNS rebinding / cross-site requests).
function allowedHost(req) {
  const host = (req.headers.host || '').toLowerCase();
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name.endsWith('.localhost');
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10000) break;
  }
  try {
    return JSON.parse(data || '{}');
  } catch {
    return {};
  }
}

async function serveFile(req, res, file) {
  let stat;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return send(res, 404, { error: 'not found' });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

function openFolder(dir) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
}

async function handle(req, res) {
  if (!allowedHost(req)) return send(res, 403, { error: 'forbidden host' });
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p.startsWith('/api/') && !wa) return send(res, 503, { state: 'starting' });

  if (req.method === 'POST') {
    // only our own page may call actions (custom header forces a CORS preflight we never allow)
    if (req.headers['x-wa24'] !== '1') return send(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    try {
      if (p === '/api/pairing-code') return send(res, 200, { code: await wa.requestPairingCode(body.phone) });
      if (p === '/api/unlink') {
        await wa.unlink();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/uninstall') {
        log.info('uninstall requested');
        clearInterval(pruneTimer);
        await store.flushing;
        store.close();
        await wa.shutdownAndUnlink();
        removeLoginItem();
        const removed = deleteConversations(cfg.dataDir);
        deleteProgramState();
        send(res, 200, { ok: true, dataDir: cfg.dataDir, folderRemoved: removed, appDir: APP_DIR });
        setTimeout(() => {
          unloadLoginItem();
          process.exit(0); // exit 0: a login item never restarts it
        }, 500);
        return;
      }
      if (p === '/api/open-folder') {
        openFolder(cfg.dataDir);
        return send(res, 200, { ok: true });
      }
    } catch (err) {
      return send(res, 400, { error: err?.message || String(err) });
    }
    return send(res, 404, { error: 'not found' });
  }

  if (p === '/api/status') {
    return send(res, 200, { ...wa.status(), dataDir: cfg.dataDir, retentionHours: cfg.retentionHours, stats: store.stats() });
  }
  if (p === '/api/chats') return send(res, 200, { chats: store.listChats() });
  if (p === '/api/messages') {
    const chatId = url.searchParams.get('chat');
    return send(res, 200, { chat: store.publicChat(chatId), messages: store.listMessages(chatId) });
  }
  if (p.startsWith('/files/')) {
    // /files/<chat folder>/media/<name>
    const rel = decodeURIComponent(p.slice('/files/'.length));
    const abs = path.resolve(cfg.dataDir, rel);
    if (!abs.startsWith(cfg.dataDir + path.sep)) return send(res, 403, { error: 'forbidden' });
    return serveFile(req, res, abs);
  }
  if (p === '/' || p === '/index.html') return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
  const asset = path.resolve(PUBLIC_DIR, '.' + p);
  if (asset.startsWith(PUBLIC_DIR + path.sep)) return serveFile(req, res, asset);
  return send(res, 404, { error: 'not found' });
}

function listen(host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) =>
      handle(req, res).catch((err) => {
        log.error({ err: err?.stack }, 'request failed');
        if (!res.headersSent) send(res, 500, { error: 'internal error' });
      }),
    );
    server.once('error', reject);
    server.listen(cfg.port, host, () => resolve(server));
  });
}

async function main() {
  // Port first: a second copy must not open a second WhatsApp session.
  try {
    await listen('127.0.0.1');
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      log.info(`Ya está corriendo en http://localhost:${cfg.port}`);
      process.exit(0);
    }
    throw err;
  }
  await listen('::1').catch(() => {}); // IPv6 loopback, when available

  store = new Store({ dataDir: cfg.dataDir, stateDir: cfg.stateDir, retentionHours: cfg.retentionHours, logger: log });
  await store.load();
  wa = new WhatsApp({ store, sessionDir: cfg.sessionDir, maxMediaMB: cfg.maxMediaMB, logger: log });
  await wa.start();

  pruneTimer = setInterval(() => store.prune().catch((e) => log.error({ err: e?.message }, 'prune failed')), 5 * 60 * 1000);

  log.info(`WhatsApp 24h listo: abre http://localhost:${cfg.port}  ·  carpeta: ${cfg.dataDir}`);

  const shutdown = async () => {
    await wa.stop();
    await store.flush().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.fatal({ err: err?.stack || String(err) }, 'failed to start');
  setTimeout(() => process.exit(1), 200);
});
