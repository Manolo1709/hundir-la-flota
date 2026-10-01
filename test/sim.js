'use strict';

/**
 * Test de integración: simula partidas reales por WebSocket.
 * Uso:  node test/sim.js   (el servidor debe estar en marcha en :3000)
 */

const WebSocket = require('ws');
const { generateFleet } = require('../server/game');

const URL = process.env.URL || 'ws://localhost:3000';
// URL HTTP equivalente para comprobar /config.js (ws://→http://, wss://→https://)
const HTTP_URL = process.env.HTTP || URL.replace(/^ws/, 'http').replace(/\/$/, '');
let failures = 0;
let checks = 0;

function check(cond, msg) {
  checks++;
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.log(`  FALLO: ${msg}`);
  }
}

class Client {
  constructor(name) {
    this.name = name;
    this.queue = [];
    this.pending = [];
  }

  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        const idx = this.pending.findIndex((p) => p.pred(m));
        if (idx >= 0) {
          const p = this.pending.splice(idx, 1)[0];
          p.res(m);
        } else {
          this.queue.push(m);
        }
      });
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /** Espera el ÚLTIMO mensaje en cola que cumpla pred (o el siguiente que llegue). */
  next(pred, ms = 6000) {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (pred(this.queue[i])) return Promise.resolve(this.queue.splice(i, 1)[0]);
    }
    return new Promise((res, rej) => {
      const entry = {
        pred,
        res: (m) => {
          clearTimeout(t);
          res(m);
        },
      };
      const t = setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== entry);
        rej(new Error(`timeout esperando mensaje para ${this.name}`));
      }, ms);
      this.pending.push(entry);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function makeClient(name) {
  const c = new Client(name);
  await c.connect();
  const w = await c.next((m) => m.type === 'welcome');
  c.id = w.playerId;
  return c;
}

async function makeRoom(mode, names) {
  const cs = [];
  for (const n of names) cs.push(await makeClient(n));
  cs[0].send({ type: 'create', mode, name: names[0] });
  const rm = await cs[0].next((m) => m.type === 'room');
  const code = rm.room.code;
  for (let i = 1; i < cs.length; i++) {
    cs[i].send({ type: 'join', code, name: names[i] });
    await cs[i].next((m) => m.type === 'room');
  }
  return { cs, code };
}

async function start(cs) {
  cs[0].send({ type: 'start' });
  const states = await Promise.all(
    cs.map((c) => c.next((m) => m.type === 'state' && m.state.phase === 'placing'))
  );
  return states[0].state;
}

async function readyAll(cs) {
  for (const c of cs) c.send({ type: 'ready', ships: generateFleet() });
  const states = await Promise.all(
    cs.map((c) => c.next((m) => m.type === 'state' && m.state.phase === 'battle'))
  );
  return states[0].state;
}

/** Descarta eventos de disparo/errores pendientes para no desincronizar el seguimiento. */
function drainMsgs(cs) {
  for (const c of cs) c.queue = c.queue.filter((m) => m.type !== 'shot' && m.type !== 'error');
}

/** Juega una partida entera con disparos aleatorios. */
async function playFull(cs, state, label) {
  drainMsgs(cs);
  let turn = state.turn;
  let alive = Object.fromEntries(state.players.map((p) => [p.id, p.alive]));
  const teams = Object.fromEntries(state.players.map((p) => [p.id, p.team]));
  const targetShots = new Map(); // targetId -> Set de celdas ya disparadas por CUALQUIERA
  const cellsFor = (id) => {
    if (!targetShots.has(id)) targetShots.set(id, new Set());
    return targetShots.get(id);
  };
  const turnSeq = [];
  let shots = 0;
  let consecutiveErrors = 0;
  let duplicateChecked = false;

  while (true) {
    const shooter = cs.find((c) => c.id === turn.playerId);
    if (!shooter) throw new Error('No encuentro al jugador con turno');

    const targets = Object.keys(alive).filter(
      (id) => alive[id] && id !== shooter.id && teams[id] !== teams[shooter.id]
    );
    if (!targets.length) throw new Error('No hay objetivos vivos');
    const targetId = targets[Math.floor(Math.random() * targets.length)];
    const used = cellsFor(targetId);

    // Comprueba que no se puede repetir una casilla ya disparada
    if (!duplicateChecked && used.size > 0) {
      drainMsgs(cs);
      const [px, py] = [...used][0].split(',').map(Number);
      shooter.send({ type: 'fire', targetId, x: px, y: py });
      const err = await shooter.next((m) => m.type === 'error');
      check(/disparado/i.test(err.message), `${label}: rechaza casilla repetida ("${err.message}")`);
      duplicateChecked = true;
    }

    let x;
    let y;
    let guard = 0;
    do {
      x = Math.floor(Math.random() * 10);
      y = Math.floor(Math.random() * 10);
      guard++;
    } while (used.has(`${x},${y}`) && guard < 500);
    used.add(`${x},${y}`);

    drainMsgs(cs);
    shooter.send({ type: 'fire', targetId, x, y });
    // Solo cuenta la respuesta a MI disparo: otra copia diferida de un evento
    // anterior podría llegar durante este await.
    const res = await shooter.next(
      (m) => m.type === 'error' || (m.type === 'shot' && m.byId === shooter.id)
    );

    if (res.type === 'error') {
      // El turno no avanza: reintentamos con otra casilla
      used.delete(`${x},${y}`);
      consecutiveErrors++;
      if (consecutiveErrors > 8) {
        throw new Error(`${label}: errores repetidos del servidor: "${res.message}"`);
      }
      continue;
    }
    consecutiveErrors = 0;
    drainMsgs(cs);

    const ev = res;
    shots++;
    if (ev.byId !== shooter.id) check(false, `${label}: el disparo lo firma el jugador correcto`);
    if (ev.result === 'sunk' && (!ev.ship || !ev.ship.cells.length)) {
      check(false, `${label}: evento de hundimiento con barco completo`);
    }

    alive = ev.alive;
    if (ev.turn) {
      turnSeq.push(ev.turn.team);
      turn = ev.turn;
    }

    if (ev.phase === 'over') {
      check(Boolean(ev.winners), `${label}: la partida termina con ganadores`);
      check(ev.winners.every((w) => alive[w.id]), `${label}: los ganadores estaban vivos`);
      check(
        turnSeq.every((t, i) => i === 0 || t !== turnSeq[i - 1]),
        `${label}: los equipos alternan turno (${turnSeq.length} turnos)`
      );
      console.log(
        `  info: ${shots} disparos, ganador: ${ev.winners.map((w) => w.name).join(', ') || 'nadie'}`
      );
      return ev;
    }
    if (shots > 900) throw new Error(`${label}: la partida no termina`);
  }
}

function leaveAll(cs) {
  for (const c of cs) {
    c.send({ type: 'leave' });
    c.close();
  }
}

async function test1v1() {
  console.log('\n[1] 1 vs 1 — partida completa');
  const { cs, code } = await makeRoom('1v1', ['Ana', 'Luis']);
  check(code.length === 5, 'se crea sala con código');

  // Sala llena: un tercero no debe entrar
  const extra = await makeClient('Carl');
  extra.send({ type: 'join', code, name: 'Carl' });
  const errFull = await extra.next((m) => m.type === 'error');
  check(/llena/i.test(errFull.message), `sala llena rechazada ("${errFull.message}")`);
  extra.close();

  const state = await start(cs);
  check(state.players.length === 2, '2 jugadores en la partida');

  // Flota inválida
  cs[1].send({ type: 'ready', ships: generateFleet().slice(1) });
  const errFleet = await cs[1].next((m) => m.type === 'error');
  check(/flota|barcos/i.test(errFleet.message), `flota incompleta rechazada ("${errFleet.message}")`);

  const battle = await readyAll(cs);
  const first = cs.find((c) => c.id === battle.turn.playerId);
  const other = cs.find((c) => c.id !== battle.turn.playerId);

  // Disparo fuera de turno
  other.send({ type: 'fire', targetId: first.id, x: 0, y: 0 });
  const errTurn = await other.next((m) => m.type === 'error');
  check(/turno/i.test(errTurn.message), `disparo fuera de turno rechazado ("${errTurn.message}")`);

  // Disparo a uno mismo
  first.send({ type: 'fire', targetId: first.id, x: 3, y: 3 });
  const errSelf = await first.next((m) => m.type === 'error');
  check(/ti mismo/i.test(errSelf.message), `disparo a uno mismo rechazado ("${errSelf.message}")`);

  await playFull(cs, battle, '1v1');
  leaveAll(cs);
}

async function test1v1v1() {
  console.log('\n[2] 1 vs 1 vs 1 — libre para todos');
  const { cs, code } = await makeRoom('1v1v1', ['Ana', 'Luis', 'Eva']);

  // No debe empezar con dos
  const { cs: duo } = await makeRoom('1v1v1', ['Beto', 'Rita']);
  duo[0].send({ type: 'start' });
  const errShort = await duo[0].next((m) => m.type === 'error');
  check(/exactamente 3/i.test(errShort.message), `no empieza sin 3 jugadores ("${errShort.message}")`);
  leaveAll(duo);

  const state = await start(cs);
  check(state.players.length === 3, '3 jugadores en la partida');
  const battle = await readyAll(cs);

  // Todo el mundo es objetivo legítimo en FFA
  const shooter = cs.find((c) => c.id === battle.turn.playerId);
  const victim = cs.find((c) => c.id !== shooter.id);
  shooter.send({ type: 'fire', targetId: victim.id, x: 0, y: 0 });
  const ev = await shooter.next((m) => m.type === 'shot');
  check(ev.byId === shooter.id && ev.targetId === victim.id, 'se puede disparar a cualquier rival');
  battle.turn = ev.turn;

  await playFull(cs, battle, '1v1v1');
  leaveAll(cs);
}

async function test1v1v1v1() {
  console.log('\n[3] 1 vs 1 vs 1 vs 1 — 4 jugadores');
  const { cs } = await makeRoom('1v1v1v1', ['Ana', 'Luis', 'Eva', 'Hugo']);
  const state = await start(cs);
  check(state.players.length === 4, '4 jugadores en la partida');
  const battle = await readyAll(cs);
  await playFull(cs, battle, '1v1v1v1');
  leaveAll(cs);
}

async function test2v2() {
  console.log('\n[4] 2 vs 2 — equipos');
  const { cs, code } = await makeRoom('2v2', ['Ana', 'Luis', 'Eva', 'Hugo']);

  // Equilibrio de equipos
  const roomSnap = (await cs[0].next((m) => m.type === 'room' && m.room.code === code)).room;
  const counts = [0, 0];
  roomSnap.players.forEach((p) => (counts[p.team] = (counts[p.team] || 0) + 1));
  check(counts[0] === 2 && counts[1] === 2, `equipos equilibrados por defecto (${counts.join(' vs ')})`);

  // Cambiar de equipo propio
  const idA = cs[0].id;
  const p0 = roomSnap.players.find((p) => p.id === idA);
  const otherTeam = p0.team === 0 ? 1 : 0;
  const partner = roomSnap.players.find((p) => p.team === otherTeam && p.id !== idA);
  if (partner) {
    const mover = cs.find((c) => c.id === partner.id);
    // No se puede colar en un equipo que ya está completo
    mover.send({ type: 'setTeam', team: p0.team });
    const errTeam = await mover.next((m) => m.type === 'error');
    check(
      /completo/i.test(errTeam.message),
      `bloquea unirse a un equipo lleno ("${errTeam.message}")`
    );
    // Sí se puede volver a tu equipo
    mover.send({ type: 'setTeam', team: otherTeam });
    await mover.next((m) => m.type === 'room');
  }

  const state = await start(cs);
  check(state.players.length === 4, '4 jugadores en la partida');

  const battle = await readyAll(cs);
  const shooter = cs.find((c) => c.id === battle.turn.playerId);
  const me = battle.players.find((p) => p.id === shooter.id);
  const mate = battle.players.find((p) => p.team === me.team && p.id !== me.id);
  const enemy = battle.players.find((p) => p.team !== me.team);

  // No se puede disparar al compañero
  shooter.send({ type: 'fire', targetId: mate.id, x: 0, y: 0 });
  const errMate = await shooter.next((m) => m.type === 'error');
  check(/compañero/i.test(errMate.message), `bloquea disparo al compañero ("${errMate.message}")`);

  // Sí se puede al equipo contrario
  shooter.send({ type: 'fire', targetId: enemy.id, x: 0, y: 0 });
  const ev = await shooter.next((m) => m.type === 'shot');
  check(ev.targetId === enemy.id, 'se puede disparar al equipo contrario');
  battle.turn = ev.turn;

  await playFull(cs, battle, '2v2');
  leaveAll(cs);
}

async function testReconnect() {
  console.log('\n[5] Reconexión en mitad de la partida');
  const { cs, code } = await makeRoom('1v1', ['Ana', 'Luis']);
  await start(cs);
  const battle = await readyAll(cs);

  // Dos disparos para tener historial
  let turn = battle.turn;
  for (let i = 0; i < 2; i++) {
    drainMsgs(cs);
    const shooter = cs.find((c) => c.id === turn.playerId);
    const other = cs.find((c) => c.id !== turn.playerId);
    shooter.send({ type: 'fire', targetId: other.id, x: i, y: 0 });
    const res = await shooter.next((m) => m.type === 'shot' && m.byId === shooter.id);
    turn = res.turn;
  }

  // Luis "recarga la página"
  const luis = cs[1];
  const luisId = luis.id;
  luis.close();
  await new Promise((r) => setTimeout(r, 400));

  const back = await makeClient('Luis');
  back.send({ type: 'reconnect', code, playerId: luisId });
  const w = await back.next((m) => m.type === 'welcome' && m.playerId === luisId);
  check(w.playerId === luisId, 'recupera su identidad en la sala');

  const st = await back.next((m) => m.type === 'state');
  check(st.state.phase === 'battle', 'vuelve a la partida en marcha');

  const hist = await back.next((m) => m.type === 'history');
  check(hist.shots.length === 2, `recupera el historial (${hist.shots.length} disparos)`);

  const shipsMsg = await back.next((m) => m.type === 'ships');
  check(Array.isArray(shipsMsg.ships) && shipsMsg.ships.length === 10, 'recupera su flota');

  back.id = luisId;
  const ana = cs[0];
  const ev = await playFull([ana, back], st.state, 'reconexión');
  check(ev.phase === 'over', 'la partida continúa hasta el final tras reconectar');
  leaveAll([ana, back]);
}

async function testInviteConfig() {
  console.log('\n[6] Enlace de invitación (?sala=) y config.js');
  const res = await fetch(`${HTTP_URL}/config.js`);
  const txt = await res.text();
  check(res.ok, 'responde GET /config.js');
  check(
    /window\.__PUBLIC_URL__\s*=\s*"[^"]*"\s*;/.test(txt.trim()),
    `config.js define window.__PUBLIC_URL__ ("${txt.trim().slice(0, 60)}")`
  );

  // Un invitado que llega con ?sala=CODIGO se une nada más conectar, sin listar salas
  const anfitrion = await makeClient('Anfitrion');
  anfitrion.send({ type: 'create', name: 'Anfitrion', mode: '1v1' });
  const rm = await anfitrion.next((m) => m.type === 'room');
  const code = rm.room.code;
  check(code.length >= 4, `la sala tiene código para el enlace (${code})`);

  const invitado = await makeClient('Invitado');
  invitado.send({ type: 'join', code, name: 'Invitado' });
  const joined = await invitado.next((m) => m.type === 'room');
  check(joined.room.code === code, 'el invitado entra directamente con el código del enlace');
  anfitrion.ws.close();
  invitado.ws.close();
}

async function main() {
  console.log('=== Hundir la Flota — tests de integración ===');
  const only = process.env.ONLY;
  if (!only || only === '6') await testInviteConfig();
  if (!only || only === '1') await test1v1();
  if (!only || only === '2') await test1v1v1();
  if (!only || only === '3') await test1v1v1v1();
  if (!only || only === '4') await test2v2();
  if (!only || only === '5') await testReconnect();

  console.log(`\n=== ${checks - failures}/${checks} comprobaciones OK ===`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
