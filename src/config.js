import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.join(APP_DIR, 'config.json');
export const DEFAULT_DATA_DIR = path.join(os.homedir(), 'Conversaciones de WhatsApp');

export const DEFAULTS = {
  dataDir: DEFAULT_DATA_DIR,
  port: 2424,
  retentionHours: 24,
  maxMediaMB: 100,
};

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  const cfg = { ...DEFAULTS, ...file };
  if (process.env.WA24_DATA_DIR) cfg.dataDir = process.env.WA24_DATA_DIR;
  if (process.env.WA24_PORT) cfg.port = Number(process.env.WA24_PORT);
  if (process.env.WA24_RETENTION_HOURS) cfg.retentionHours = Number(process.env.WA24_RETENTION_HOURS);
  cfg.dataDir = path.resolve(expandHome(cfg.dataDir));
  cfg.sessionDir = path.join(APP_DIR, 'session');
  cfg.stateDir = path.join(APP_DIR, 'state');
  cfg.logDir = path.join(APP_DIR, 'logs');
  return cfg;
}

export function saveConfig(patch) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  const next = { ...file, ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** macOS asks for permission before background apps touch these folders; avoid them. */
export function protectedFolderWarning(dir) {
  if (process.platform !== 'darwin') return null;
  const home = os.homedir();
  for (const sub of ['Documents', 'Desktop', 'Downloads', 'Library/Mobile Documents']) {
    const p = path.join(home, sub);
    if (dir === p || dir.startsWith(p + path.sep)) {
      return `La carpeta está dentro de "${sub}". En Mac, los programas que corren en segundo plano necesitan permiso especial para escribir ahí. Mejor usa una carpeta directamente en tu carpeta personal, por ejemplo: ${DEFAULT_DATA_DIR}`;
    }
  }
  return null;
}
