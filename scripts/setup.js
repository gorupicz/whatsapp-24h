// Chooses the folder where conversations are saved and writes config.json.
//   npm run setup                         (asks, suggests a default)
//   npm run setup -- --folder "/path/to/folder"
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { DEFAULT_DATA_DIR, expandHome, loadConfig, saveConfig, protectedFolderWarning } from '../src/config.js';

const args = process.argv.slice(2);
const i = args.indexOf('--folder');
let folder = i >= 0 ? args[i + 1] : null;

if (!folder) {
  const current = loadConfig().dataDir;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`¿En qué carpeta guardo las conversaciones?\n[Enter = ${current || DEFAULT_DATA_DIR}]: `);
  rl.close();
  folder = answer.trim() || current || DEFAULT_DATA_DIR;
}

const dir = path.resolve(expandHome(folder.replace(/^["']|["']$/g, '')));
fs.mkdirSync(dir, { recursive: true });
fs.accessSync(dir, fs.constants.W_OK);
saveConfig({ dataDir: dir });
console.log(`✓ Las conversaciones se guardarán en: ${dir}`);
const warn = protectedFolderWarning(dir);
if (warn) console.log(`⚠ ${warn}`);
