# WhatsApp 24h

**Copia local y de solo lectura de tus últimas 24 horas de WhatsApp.**

Corre en tu computadora, se conecta a tu WhatsApp como un “dispositivo vinculado” (igual que WhatsApp Web) y guarda en la carpeta que tú elijas todo lo que pasó en las últimas 24 horas. Lo que tiene más de 24 horas se borra solo.

- **Nunca envía mensajes.** No marca como leído, no aparece “en línea”, no cambia nada de tus chats. Solo lee.
- **Todo se queda en tu computadora.** La página solo abre en `http://localhost:2424` y no se puede ver desde otra computadora.
- **Qué guarda:** mensajes de chats 1 a 1 y de grupos, fotos, videos, audios, notas de voz, documentos, stickers, estados (historias), respuestas (a qué mensaje responde), reacciones, mensajes editados y eliminados, ubicaciones, contactos, encuestas, llamadas, si leíste cada mensaje, y si el chat está archivado, fijado o silenciado.

## Instalación fácil (con Claude Code o Codex)

Si no sabes de programación, abre **Claude Code** o **ChatGPT Codex** y pega este mensaje tal cual:

```text
Quiero instalar en mi computadora el programa "WhatsApp 24h": https://github.com/gorupicz/whatsapp-24h

No sé de programación. Hazlo tú todo, paso a paso, y háblame en español sencillo, sin términos técnicos. Cuando necesites algo de mí (mi contraseña de la computadora, elegir una carpeta, escanear un código), pídemelo con instrucciones muy claras y espera mi respuesta.

1. Revisa si tengo Node.js versión 20 o más nueva. Si no lo tengo, instala la versión LTS:
   - Mac: con Homebrew si ya lo tengo; si no, descarga el instalador .pkg oficial de https://nodejs.org y ejecútalo (me va a pedir mi contraseña; avísame antes).
   - Windows: winget install OpenJS.NodeJS.LTS
   - Linux: con el gestor de paquetes del sistema.
2. Descarga el programa en mi carpeta personal, en una carpeta llamada "whatsapp-24h" (con git clone; si no tengo git, descarga y descomprime https://github.com/gorupicz/whatsapp-24h/archive/refs/heads/main.zip). Si ya existía, actualízala sin borrar las carpetas "session", "state" ni el archivo "config.json".
3. Dentro de esa carpeta corre: npm install
4. Pregúntame en qué carpeta quiero guardar mis conversaciones. Sugiéreme "Conversaciones de WhatsApp" dentro de mi carpeta personal. En Mac no uses Documentos, Escritorio ni Descargas (macOS bloquea ahí a los programas en segundo plano). Luego corre: npm run setup -- --folder "<la carpeta que elegí>"
5. Corre: npm test   (deben pasar todas las pruebas)
6. Corre: npm run autostart:on   (lo deja funcionando en segundo plano y arranca solo cada vez que prendo la computadora)
7. Abre en mi navegador http://localhost:2424 y guíame para vincular mi WhatsApp: en el teléfono, Dispositivos vinculados → Vincular un dispositivo → escanear el código de la pantalla. Si no puedo escanear, que use la opción "Vincula con tu número de teléfono" de esa misma página.
8. Cuando la página diga "Conectado", dime en una o dos frases: dónde quedó guardada mi carpeta, que la página es http://localhost:2424 y que lo de más de 24 horas se borra solo.

Reglas: no modifiques el código del programa. Nunca envíes mensajes de WhatsApp ni intentes leer mis conversaciones tú mismo. Si algo falla, explícame qué pasó en palabras simples y prueba otra vez antes de rendirte.
```

## Instalación manual

Necesitas [Node.js](https://nodejs.org) 20 o más nuevo.

```bash
git clone https://github.com/gorupicz/whatsapp-24h.git ~/whatsapp-24h
cd ~/whatsapp-24h
npm install
npm run setup                 # elige la carpeta donde se guardan las conversaciones
npm run autostart:on          # corre en segundo plano y arranca con la computadora
```

Abre **http://localhost:2424** (o `http://whatsapp.localhost:2424` en Chrome, Edge o Firefox) y escanea el código con tu teléfono.

| Comando | Qué hace |
|---|---|
| `npm start` | Lo corre en esta ventana (para probar; se detiene al cerrarla) |
| `npm run autostart:on` | Lo corre en segundo plano y al prender la computadora |
| `npm run autostart:off` | Lo detiene y quita el arranque automático |
| `npm run setup` | Cambia la carpeta donde se guarda todo |
| `npm run uninstall` | Desinstala: desvincula, borra lo guardado y quita el arranque automático |
| `npm test` | Pruebas |

Para **actualizar**: `git pull && npm install && npm run autostart:on`.

## Desinstalar

En **http://localhost:2424** presiona **Desinstalar**. En un solo paso:
- desvincula la computadora de tu WhatsApp,
- borra las conversaciones guardadas (solo lo que creó el programa; si pusiste otros archivos en esa carpeta, no se tocan),
- detiene el programa y ya no arranca al prender la computadora.

Después puedes arrastrar la carpeta `whatsapp-24h` a la papelera. Con Claude Code o Codex basta con pedir: *“Desinstala WhatsApp 24h: corre `npm run uninstall` dentro de la carpeta whatsapp-24h y luego borra esa carpeta.”*

> El botón **Desvincular** solo desconecta tu WhatsApp; el programa sigue abierto esperando que vuelvas a escanear. Para quitarlo del todo usa **Desinstalar**.

## Usarlo con Claude Cowork

[COWORK.md](COWORK.md) trae las instrucciones para un proyecto “WhatsApp” en Cowork con tres formas de leer tus mensajes: A) WhatsApp Web, B) WhatsApp Desktop (Mac) y C) la carpeta de conversaciones.

## Qué hay en la carpeta

```
Conversaciones de WhatsApp/
  LEEME.txt
  index.json                       lista de chats con actividad en las últimas 24 h
  chats/
    Mamá (+5215512345678)/
      conversation.txt             la conversación en texto, fácil de leer
      messages.json                cada mensaje con todos sus detalles
      chat.json                    grupo o 1 a 1, participantes, archivado, silenciado, fijado, sin leer
      media/                       fotos, videos, audios, documentos, stickers
    Familia (120363…)/
      …
  estados/                         estados (historias)
```

Cada mensaje en `messages.json` incluye, cuando aplica: `type` (text, image, video, voice, audio, document, sticker, location, contact, poll, event, call, system…), `text`, `sender` y `senderName`, `time`, `fromMe`, `replyTo` (mensaje al que responde), `reactions`, `edited`, `deleted`, `forwarded`, `viewOnce`, `media.file` (ruta del adjunto), `readByMe` (si lo leíste), y para tus mensajes `status` (enviado, entregado, leído) y `receipts` (quién lo leyó en grupos).

`readByMe` sale de lo que WhatsApp avisa a los dispositivos vinculados: cuando lees un chat en tu teléfono, se marca como leído aquí también. Para mensajes que llegaron antes de vincular, se calcula con el contador de “sin leer” de cada chat.

## Configuración

`config.json` (lo crea `npm run setup`):

| Campo | Por defecto | |
|---|---|---|
| `dataDir` | `~/Conversaciones de WhatsApp` | carpeta de las conversaciones |
| `port` | `2424` | puerto de la página local |
| `retentionHours` | `24` | horas que se guarda todo |
| `maxMediaMB` | `100` | adjuntos más grandes no se descargan |

## Privacidad y límites

- La sesión de WhatsApp se guarda en `whatsapp-24h/session/`. Quien tenga esa carpeta puede leer tus mensajes nuevos: no la compartas.
- Las fotos “ver una vez” no se pueden guardar: WhatsApp no las manda a dispositivos vinculados.
- Los votos de encuestas no se guardan (solo la pregunta y las opciones).
- Las personas que no tienes guardadas y que no tienen nombre público en WhatsApp aparecen con su número, igual que en WhatsApp Web.
- Al vincular, WhatsApp manda los mensajes recientes en uno o dos minutos; de ahí en adelante todo llega en vivo.
- Es un programa no oficial: usa el mismo protocolo que WhatsApp Web mediante [Baileys](https://github.com/WhiskeySockets/Baileys). No está afiliado a WhatsApp ni a Meta. Como solo lee, el riesgo es bajo, pero úsalo bajo tu propia responsabilidad.

---

## English (short)

Read-only local WhatsApp archive. Links as a companion device (like WhatsApp Web), never sends anything, and keeps a rolling 24-hour copy of every chat (1:1, groups, statuses) in a folder you choose: text, attachments, replies, reactions, edits, deletions, read state, archived/pinned/muted flags. UI at `http://localhost:2424`, bound to loopback only. `npm install && npm run setup && npm run autostart:on`. MIT license. Not affiliated with WhatsApp or Meta.
