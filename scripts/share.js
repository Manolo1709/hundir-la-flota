'use strict';

/**
 * npm run share
 * -------------
 * 1. Descarga cloudflared si no está (sin instalar, sin cuenta)
 * 2. Arranca el servidor si no está en marcha
 * 3. Abre un túnel público y escribe la URL en public/public-url.txt
 *    (el servidor la lee al vuelo, así que el botón "Invitar jugadores"
 *     genera ya el enlace público correcto)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const CF_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const CF_EXE = path.join(ROOT, 'cloudflared.exe');
const URL_FILE = path.join(ROOT, 'public', 'public-url.txt');
const children = [];

const log = (m) => console.log(`[share] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function download(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('Demasiadas redirecciones'));
          return resolve(download(res.headers.location, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Descarga fallida: HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function ensureCloudflared() {
  if (fs.existsSync(CF_EXE)) return;
  log(`Descargando cloudflared (~40 MB)…`);
  const buf = await download(CF_URL);
  fs.writeFileSync(CF_EXE, buf);
  log('cloudflared descargado ✓');
}

async function serverUp() {
  try {
    const res = await fetch(`http://localhost:${PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serverUp()) {
    log(`Servidor ya en marcha en :${PORT} ✓`);
    return;
  }
  log('Arrancando el servidor…');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  children.push(child);
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    if (await serverUp()) {
      log('Servidor listo ✓');
      return;
    }
  }
  throw new Error('El servidor no arrancó');
}

function startTunnel() {
  log('Abriendo el túnel público con cloudflared…');
  const child = spawn(CF_EXE, ['tunnel', '--url', `http://localhost:${PORT}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const onData = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[cloudflared] ${text}`);
      buf += text;
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !done) {
        done = true;
        resolve(m[0]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => (!done && reject(e), (done = true)));
    child.on('exit', (code) => {
      if (!done) {
        done = true;
        reject(new Error(`cloudflared terminó con código ${code}`));
      }
    });
    setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('cloudflared no dio una URL en 40 s'));
      }
    }, 40000);
  });
}

async function verify(url) {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (res.ok) return true;
    } catch {
      /* reintentar */
    }
    await sleep(1500);
  }
  return false;
}

function shutdown(code) {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignorar */
    }
  }
  process.exit(code || 0);
}

async function main() {
  log('Hundir la Flota — modo compartir por internet');
  await ensureCloudflared();
  await ensureServer();

  const tunnelUrl = await startTunnel();
  fs.writeFileSync(URL_FILE, tunnelUrl + '\n');
  log(`Túnel listo: ${tunnelUrl}`);

  const ok = await verify(tunnelUrl);
  if (!ok) {
    log('AVISO: el enlace todavía no responde desde fuera; inténtalo en unos segundos.');
  } else {
    log('Comprobado: el enlace responde desde internet ✓');
  }

  console.log('\n==========================================================');
  console.log('  ENLACE PARA INVITAR A TUS AMIGOS:');
  console.log(`  ${tunnelUrl}`);
  console.log('----------------------------------------------------------');
  console.log('  1. Abre TÚ también ese enlace en el navegador');
  console.log('  2. Crea la sala y pulsa "👥 Invitar jugadores"');
  console.log('  3. Comparte el enlace que se copia (o el código)');
  console.log('  Deja esta ventana abierta: si la cierras, se corta el túnel.');
  console.log('==========================================================\n');
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((err) => {
  console.error(`[share] ERROR: ${err.message}`);
  shutdown(1);
});
