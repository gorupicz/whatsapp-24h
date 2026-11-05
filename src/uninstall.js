// Removes everything WhatsApp 24h created outside its own program folder:
// the login item, the saved conversations, the WhatsApp session and the logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_DIR, CONFIG_FILE } from './config.js';

const run = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch {}
};

/** Stop starting at login. Does not kill the running copy. */
export function removeLoginItem() {
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.whatsapp24h.server.plist');
    fs.rmSync(plist, { force: true });
  } else if (process.platform === 'win32') {
    const vbs = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'whatsapp-24h.vbs');
    fs.rmSync(vbs, { force: true });
  } else {
    run('systemctl', ['--user', 'disable', 'whatsapp-24h.service']);
    fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', 'whatsapp-24h.service'), { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
  }
}

/** macOS: forget the background job now (if it is this process, it gets stopped). */
export function unloadLoginItem() {
  if (process.platform === 'darwin') run('launchctl', ['remove', 'com.whatsapp24h.server']);
}

/**
 * Deletes only what this program wrote in the conversations folder (never other files the
 * user may have put there), then the folder itself if it ends up empty.
 */
export function deleteConversations(dataDir) {
  const home = os.homedir();
  if (!dataDir || dataDir === home || dataDir === path.parse(dataDir).root || home.startsWith(dataDir + path.sep)) return false;
  for (const name of ['chats', 'estados', 'index.json', 'LEEME.txt']) {
    fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  }
  try {
    for (const f of fs.readdirSync(dataDir)) if (f === '.DS_Store' || f.endsWith('.tmp')) fs.rmSync(path.join(dataDir, f), { force: true });
    fs.rmdirSync(dataDir);
  } catch {}
  return !fs.existsSync(dataDir);
}

/** Session (the link to WhatsApp), names cache, logs and settings inside the program folder. */
export function deleteProgramState() {
  for (const name of ['session', 'state', 'logs']) fs.rmSync(path.join(APP_DIR, name), { recursive: true, force: true });
  fs.rmSync(CONFIG_FILE, { force: true });
}
