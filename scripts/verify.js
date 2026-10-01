'use strict';

/**
 * Verifica un despliegue público del juego.
 *
 *   node scripts/verify.js https://hundir-la-flota-rggc.onrender.com
 *
 * 1. Despierta la instancia (los planes gratis se duermen).
 * 2. Comprueba /health, /config.js y que client.js lleve los arreglos.
 * 3. Ejecuta la suite completa (test/sim.js + test/dom.js) contra esa URL
 *    usando WebSocket seguro (wss://), es decir, desde fuera de tu red.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const BASE = String(process.argv[2] || '')
  .trim()
  .replace(/\/+$/, '');

if (!/^https?:\/\//.test(BASE)) {
  console.log('Uso: node scripts/verify.js https://TU-SERVIDOR.onrender.com');
  process.exit(1);
}

const WS = BASE.replace(/^http/, 'ws');
const ROOT = path.join(__dirname, '..');
const ok = (m) => console.log(`  ok  ${m}`);
const bad = (m) => console.log(`  FALLO: ${m}`);

async function get(p, timeout = 60000) {
  const res = await fetch(BASE + p, { signal: AbortSignal.timeout(timeout) });
  return { status: res.status, body: await res.text() };
}

async function wake() {
  console.log('\n[1] Despertando la instancia (puede tardar ~60 s)…');
  for (let i = 0; i < 6; i++) {
    try {
      const r = await get('/health', 70000);
      if (r.status === 200) {
        ok(`/health -> ${r.body}`);
        return true;
      }
    } catch {
      /* reintentar */
    }
    process.stdout.write('  …sigue durmiendo\n');
  }
  bad('no responde /health');
  return false;
}

async function checkCode() {
  console.log('\n[2] Código desplegado');
  try {
    const js = await get('/client.js');
    if (js.status !== 200) return bad(`/client.js -> HTTP ${js.status}`);
    if (js.body.includes(".split(' ')")) {
      bad('client.js es la VERSIÓN ROTA (contiene .split) — falta redesplegar');
      return false;
    }
    ok(`client.js corregido (${js.body.length} bytes, sin .split)`);

    if (js.body.includes('location.origin')) {
      ok('enlace de invitación con origen absoluto');
    } else {
      bad('falta el arreglo del enlace de invitación');
      return false;
    }

    const cfg = await get('/config.js');
    ok(`/config.js -> ${cfg.body.trim()}`);

    const page = await get('/');
    if (page.status === 200 && page.body.includes('Hundir la Flota')) {
      ok('la página principal carga');
    } else {
      bad(`la página principal -> HTTP ${page.status}`);
      return false;
    }
    return true;
  } catch (e) {
    bad(`error al descargar el código: ${e.message}`);
    return false;
  }
}

function runTest(file, env) {
  const r = spawnSync(process.execPath, [path.join('test', file)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/=== (\d+\/\d+) comprobaciones OK ===/);
  const failed = r.status !== 0;
  if (failed) {
    console.log(out.split('\n').filter((l) => l.includes('FALLO') || l.includes('ERROR')).join('\n'));
    bad(`${file}: ${m ? m[1] : 'falló'}`);
  } else {
    ok(`${file}: ${m ? m[1] : 'OK'}`);
  }
  return !failed;
}

async function main() {
  console.log(`=== Verificación de ${BASE} ===`);
  if (!(await wake())) process.exit(1);
  if (!(await checkCode())) process.exit(1);

  console.log('\n[3] Partida completa por wss:// (servidor)');
  const a = runTest('sim.js', { URL: WS, HTTP: BASE });

  console.log('\n[4] Partida completa en el cliente real (jsdom + wss://)');
  const b = runTest('dom.js', { BASE });

  const all = a && b;
  console.log(`\n=== ${all ? 'TODO CORRECTO' : 'HAY FALLOS'} — ${BASE} ===`);
  process.exit(all ? 0 : 1);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
