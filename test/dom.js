'use strict';

/**
 * Prueba de DOM: ejecuta el cliente REAL (public/client.js) dentro de jsdom
 * y juega una partida completa con 4 "pestañas":
 *   - Ana crea la sala (1 vs 1 vs 1 vs 1)
 *   - Beto y Clara se unen con el código
 *   - Dana entra automáticamente por el enlace de invitación (?sala=CODIGO)
 *   - Se coloca la flota con los botones reales y se dispara hasta el final
 *
 * Cualquier error de renderizado o de lógica del cliente (tipo el de
 * battleCellClass) se captura y hace fallar la prueba.
 *
 * Uso:  node test/dom.js   (el servidor debe estar en marcha en :3000)
 */

const fs = require('fs');
const path = require('path');

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch {
  console.log('jsdom no está instalado: prueba de DOM omitida (npm i -D jsdom)');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'client.js'), 'utf8');
const WS = require('ws');
const BASE = process.env.BASE || 'http://localhost:3000';

const players = []; // ámbito global para poder diagnosticar desde el catch

let checks = 0;
let failures = 0;
const errors = [];

function check(cond, msg) {
  checks++;
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.log(`  FALLO: ${msg}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Abre una "pestaña" con el cliente real cargado. */
function player(name, url) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    const msg = e.message || String(e);
    if (msg.startsWith('Not implemented')) return; // ruidos conocidos de jsdom
    errors.push(`[${name}] ${e.stack || msg}`);
  });
  vc.on('error', (...args) => {
    errors.push(
      `[${name}] ${args.map((a) => (a && a.stack) || String(a)).join(' ')}`
    );
  });

  const dom = new JSDOM(HTML, {
    url: url || BASE,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;
  // WebSocket instrumentado: cuenta conexiones, cierres y errores
  class MockWS extends WS {
    constructor(u) {
      super(u);
      w.__socks = (w.__socks || 0) + 1;
      this.addEventListener('close', (e) => {
        w.__closes = (w.__closes || []).concat(`${e.code}/${e.reason || 'sin motivo'}`);
      });
      this.addEventListener('error', (e) => {
        w.__errs = (w.__errs || []).concat(String((e && e.message) || e));
      });
    }
  }
  w.WebSocket = MockWS; // el cliente hace new WebSocket(...)
  try {
    // Se inyecta como <script> real: así los "let" globales (room, state, ws…)
    // quedan en el ámbito global y los siguientes eval() pueden leerlos.
    // Además se captura el listener de DOMContentLoaded para no duplicar init():
    // jsdom lo dispararía también tras nuestra llamada manual.
    const tag = w.document.createElement('script');
    tag.textContent =
      '(function(){ window.__origDAL = document.addEventListener;' +
      ' document.addEventListener = function(t, f, o) {' +
      '   if (t === "DOMContentLoaded") { window.__init = f; return; }' +
      '   return window.__origDAL.call(document, t, f, o); }; })();\n' +
      CLIENT +
      '\n; document.addEventListener = window.__origDAL; window.__init = window.__init || init;';
    w.document.body.appendChild(tag);
    // Registro de mensajes recibidos (para diagnóstico)
    w.eval(
      'window.__msgs = []; window.__sends = []; window.__origHandle = handle;' +
        'handle = function (m) { window.__msgs.push(m.type); return window.__origHandle(m); };' +
        'window.__origSend = sendMsg;' +
        'sendMsg = function (o) { window.__sends.push(o.type); return window.__origSend(o); };'
    );
  } catch (e) {
    errors.push(`[${name}] error al cargar client.js: ${e.stack}`);
  }
  const input = w.document.getElementById('inputName');
  if (input) input.value = name;
  if (w.__init) w.__init();

  const obj = {
    name,
    w,
    d: w.document,
    g: (expr) => w.eval(expr),
  };
  players.push(obj);
  return obj;
}

function report(label) {
  console.log(`  --- diagnóstico: ${label} ---`);
  for (const p of players) {
    let info;
    try {
      info =
        `room=${p.g('room && room.code')} fase=${p.g('state && state.phase')}` +
        ` ws=${p.g('ws && ws.readyState')} auto=${p.g('String(autoJoinCode)')}` +
        ` salaHTML="${p.d.getElementById('lobbyCode').textContent}"` +
        ` msgs=[${p.g('window.__msgs.slice(-8).join(",")')}]` +
        ` sends=[${p.g('window.__sends.join(",")')}]` +
        ` socks=${p.g('String(window.__socks)')} cierres=[${p.g('String((window.__closes||[]).join(" | "))')}]` +
        ` errs=[${p.g('String((window.__errs||[]).join(" | "))')}]` +
        ` toast="${p.d.getElementById('toast').textContent}"`;
    } catch (e) {
      info = `error: ${e.message}`;
    }
    console.log(`  dbg ${p.name}: ${info}`);
  }
  [...new Set(errors)].slice(0, 8).forEach((e) => console.log(`  cliente: ${e.split('\n')[0]}`));
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try {
      v = fn();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout esperando: ${label}`);
    await sleep(15);
  }
}

/** Coloca la flota de todos con los botones reales y espera la batalla. */
async function placeAll(players) {
  for (const p of players) {
    await waitFor(() => p.g('state && state.phase') === 'placing', 5000, `placing de ${p.name}`);
    p.d.getElementById('btnAuto').click();
    p.d.getElementById('btnReady').click();
  }
  await waitFor(() => players[0].g('state && state.phase') === 'battle', 8000, 'fase battle');
}

/** Juega la partida entera haciendo clic en las casillas objetivo. */
async function playToEnd(players, label) {
  let shots = 0;
  for (let i = 0; i < 1500; i++) {
    if (players[0].g('state && state.phase') === 'over') break;

    const shooter = players.find((p) => {
      try {
        return p.g('state && state.turn && state.turn.playerId') === p.g('meId');
      } catch {
        return false;
      }
    });
    if (!shooter) {
      await sleep(20);
      continue;
    }
    const cell = shooter.d.querySelector('.cell.targetable');
    if (!cell) {
      await sleep(20);
      continue;
    }
    const before = shooter.g('state.turn.number');
    cell.click();
    shots++;
    await waitFor(
      () =>
        shooter.g('state && state.phase') === 'over' ||
        shooter.g('state.turn ? state.turn.number : 0') !== before,
      4000,
      'avance de turno'
    ).catch(() => {});
  }

  const finalPhase = players[0].g('state && state.phase');
  check(finalPhase === 'over', `${label} termina en "over" (${shots} disparos con clic)`);
  return shots;
}

async function main() {
  console.log('=== Prueba de DOM: cliente real en jsdom ===');

  /* --- 1. Crear sala --- */
  const A = player('Ana');
  await waitFor(() => A.g('ws && ws.readyState') === 1, 5000, 'conexión de Ana');
  A.d.querySelector('#modeGrid .mode-card[data-mode="1v1v1v1"]').click();
  A.d.getElementById('btnCreate').click();
  await waitFor(() => A.g('room !== null'), 5000, 'sala creada');
  const code = A.d.getElementById('lobbyCode').textContent.trim();
  check(/^[A-Z0-9]{4,8}$/.test(code), `sala creada con código ${code}`);

  /* --- 2. Botón de invitación --- */
  A.d.getElementById('btnInvite').click();
  await sleep(80);
  const link = A.d.getElementById('inviteLink').value;
  check(link === `${BASE}/?sala=${code}`, `enlace de invitación: ${link}`);

  /* --- 3. Se unen por código --- */
  const joiners = [player('Beto'), player('Clara')];
  for (const p of joiners) {
    await waitFor(() => p.g('ws && ws.readyState') === 1, 5000, `conexión de ${p.name}`);
    p.d.getElementById('inputCode').value = code;
    p.d.getElementById('btnJoin').click();
    await waitFor(() => p.g('room !== null'), 5000, `${p.name} en la sala`);
  }
  check(true, 'Beto y Clara entraron con el código');

  /* --- 4. Cuarta jugadora por enlace de invitación --- */
  const D = player('Dana', `${BASE}/?sala=${code}`);
  await waitFor(() => D.g('room !== null'), 6000, 'Dana entra por ?sala=');
  check(D.g('room && room.code') === code, 'Dana entró sola por el enlace (?sala=)');

  const players = [A, ...joiners, D];

  /* --- 5. Lanzar la partida --- */
  await waitFor(
    () => !A.d.getElementById('btnStart').disabled,
    6000,
    'botón "Empezar" habilitado (sala completa)'
  );
  A.d.getElementById('btnStart').click();
  await waitFor(() => A.g('state && state.phase') === 'placing', 5000, 'fase placing');
  check(true, 'partida lanzada: fase de colocación');

  /* --- 6. Jugar la partida entera haciendo clic en las casillas --- */
  await placeAll(players);
  const shots1 = await playToEnd(players, 'partida 1');

  for (const p of players) {
    const vis = !p.d.getElementById('overlay').classList.contains('hidden');
    check(vis, `pantalla de victoria visible para ${p.name}`);
  }
  check(shots1 > 20, `se disparó desde el navegador (${shots1} clics)`);

  /* --- 7. Revancha: segunda partida completa --- */
  A.d.getElementById('btnRematch').click();
  await waitFor(() => A.g('state && state.phase') === 'placing', 6000, 'revancha');
  check(true, 'botón "Revancha": nueva partida (vuelve a la colocación)');

  await placeAll(players);
  await playToEnd(players, 'partida 2 (revancha)');

  /* --- 8. Vuelta al lobby (solo permitida cuando la partida ha terminado) --- */
  A.d.getElementById('btnToLobby').click();
  await waitFor(
    () => !A.d.getElementById('screen-lobby').classList.contains('hidden'),
    6000,
    'vuelta al lobby'
  );
  check(true, 'botón "Volver a la sala": se vuelve al lobby');

  /* --- 7. Errores capturados en el cliente --- */
  const unique = [...new Set(errors)];
  unique.slice(0, 6).forEach((e) => console.log(`  FALLO cliente: ${e.split('\n')[0]}`));
  check(unique.length === 0, `cero errores en el cliente (${unique.length})`);

  console.log(`\n=== ${checks - failures}/${checks} comprobaciones OK ===`);
  for (const p of players) p.w.close();
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  report(err.message);
  process.exit(1);
});
