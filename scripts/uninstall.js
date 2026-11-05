// Uninstall from the command line (same as the "Desinstalar" button on the page):
//   npm run uninstall
// Unlinks this computer from WhatsApp, stops the program, removes it from login and deletes
// the saved conversations. Afterwards the "whatsapp-24h" program folder can be dragged to the trash.
import { loadConfig, APP_DIR } from '../src/config.js';
import { removeLoginItem, unloadLoginItem, deleteConversations, deleteProgramState } from '../src/uninstall.js';

const cfg = loadConfig();
let viaServer = null;
try {
  const r = await fetch(`http://127.0.0.1:${cfg.port}/api/uninstall`, { method: 'POST', headers: { 'X-WA24': '1', Host: `localhost:${cfg.port}` } });
  viaServer = await r.json();
} catch {}

if (viaServer?.ok) {
  console.log('✓ Esta computadora se desvinculó de tu WhatsApp.');
} else {
  // Not running: clean up what is on disk. The phone may still list this computer.
  removeLoginItem();
  unloadLoginItem();
  deleteConversations(cfg.dataDir);
  deleteProgramState();
  console.log('ℹ El programa no estaba corriendo. Por si acaso, revisa en tu teléfono: WhatsApp → Dispositivos vinculados, y cierra la sesión de esta computadora si aparece.');
}
console.log('✓ Ya no arranca al prender la computadora.');
console.log(`✓ Se borraron las conversaciones guardadas (${cfg.dataDir}).`);
console.log(`Último paso opcional: arrastra a la papelera la carpeta del programa: ${APP_DIR}`);
