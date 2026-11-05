// Runs the server in the background and at every login (macOS, Windows, Linux).
//   npm run autostart:on    start now + on every login
//   npm run autostart:off   stop it and remove the login item
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { APP_DIR, loadConfig } from '../src/config.js';

const mode = process.argv[2];
if (mode !== 'on' && mode !== 'off') {
  console.log('Uso: npm run autostart:on | npm run autostart:off');
  process.exit(1);
}
const node = process.execPath;
const server = path.join(APP_DIR, 'src', 'server.js');
const logDir = path.join(APP_DIR, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const { port } = loadConfig();
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { stdio: 'pipe' }).toString();
  } catch (e) {
    return e.stdout?.toString() || '';
  }
};

if (process.platform === 'darwin') {
  const label = 'com.whatsapp24h.server';
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  run('launchctl', ['bootout', domain, plist]);
  if (mode === 'on') {
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${x(node)}</string><string>${x(server)}</string></array>
  <key>WorkingDirectory</key><string>${x(APP_DIR)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${x(path.join(logDir, 'launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${x(path.join(logDir, 'launchd.log'))}</string>
</dict></plist>
`,
    );
    run('launchctl', ['bootstrap', domain, plist]);
  } else if (fs.existsSync(plist)) fs.rmSync(plist);
} else if (process.platform === 'win32') {
  const startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbs = path.join(startup, 'whatsapp-24h.vbs');
  // stop a running copy (the one listening on our port)
  const out = run('netstat', ['-ano']);
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(`:${port} `) && /LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      run('taskkill', ['/PID', pid, '/F']);
    }
  }
  if (mode === 'on') {
    fs.mkdirSync(startup, { recursive: true });
    fs.writeFileSync(
      vbs,
      `Set sh = CreateObject("WScript.Shell")\r\nsh.CurrentDirectory = "${APP_DIR}"\r\nsh.Run """${node}"" ""${server}""", 0, False\r\n`,
    );
    spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore' }).unref();
  } else if (fs.existsSync(vbs)) fs.rmSync(vbs);
} else {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unit = path.join(unitDir, 'whatsapp-24h.service');
  run('systemctl', ['--user', 'disable', '--now', 'whatsapp-24h.service']);
  if (mode === 'on') {
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      unit,
      `[Unit]\nDescription=WhatsApp 24h (read-only)\nAfter=network-online.target\n\n[Service]\nWorkingDirectory=${APP_DIR}\nExecStart="${node}" "${server}"\nRestart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`,
    );
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'whatsapp-24h.service']);
  } else if (fs.existsSync(unit)) fs.rmSync(unit);
}

if (mode === 'on') {
  // wait until the page answers
  let ok = false;
  for (let t = 0; t < 30 && !ok; t++) {
    await new Promise((r) => setTimeout(r, 1000));
    ok = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.status < 500).catch(() => false);
  }
  console.log(ok ? `✓ Funcionando. Abre http://localhost:${port} en tu navegador. Arrancará solo cada vez que prendas la computadora.` : `⚠ No respondió todavía. Revisa ${path.join(logDir, 'server.log')}`);
} else {
  console.log('✓ Detenido. Ya no arrancará al prender la computadora.');
}
