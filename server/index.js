'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomManager, MODES } = require('./rooms');
const { GameError } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DISCONNECT_GRACE_ROOM_MS = 10 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ------------------------------------------------------------------ */
/* Servidor estático                                                   */
/* ------------------------------------------------------------------ */

const PUBLIC_URL_FILE = path.join(PUBLIC_DIR, 'public-url.txt');

/** URL pública usada en los enlaces de invitación (env > fichero del túnel). */
function publicUrl() {
  const fromEnv = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(PUBLIC_URL_FILE)) {
      return fs.readFileSync(PUBLIC_URL_FILE, 'utf8').trim().replace(/\/+$/, '');
    }
  } catch {
    /* ignorar */
  }
  return '';
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: manager.rooms.size }));
    return;
  }
  if (urlPath === '/config.js') {
    // Configuración para el cliente (URL pública usada en los enlaces de invitación)
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(`window.__PUBLIC_URL__ = ${JSON.stringify(publicUrl())};\n`);
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const manager = new RoomManager();

/* ------------------------------------------------------------------ */
/* Utilidades de sesión                                                */
/* ------------------------------------------------------------------ */

const send = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};
const errorMsg = (message) => ({ type: 'error', message });

function sanitizeName(raw) {
  let name = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 16);
  if (!name) name = `Jugador-${Math.floor(1000 + Math.random() * 9000)}`;
  return name;
}

function currentRoom(session) {
  const room = manager.get(session.roomCode);
  if (!room) throw new GameError('No estás en ninguna sala');
  if (!room.player(session.playerId)) {
    session.roomCode = null;
    throw new GameError('No estás en ninguna sala');
  }
  return room;
}

function currentGame(session) {
  const room = currentRoom(session);
  if (room.status !== 'playing' || !room.game) throw new GameError('La partida no ha empezado');
  return { room, game: room.game };
}

function addPlayer(room, session) {
  manager.join(room, {
    id: session.playerId,
    name: session.name,
    ws: session.ws,
    connected: true,
    team: 0,
  });
  session.roomCode = room.code;
}

function leaveRoom(session, explicit) {
  const code = session.roomCode;
  if (!code) return;
  const room = manager.get(code);
  session.roomCode = null;
  if (!room) return;
  const p = room.player(session.playerId);
  if (!p || (p.ws && p.ws !== session.ws)) return;

  if (explicit || room.status !== 'playing') {
    manager.leave(room, session.playerId);
    if (!manager.rooms.has(room.code)) return;
    room.broadcastState();
  }
}

function onDisconnect(session) {
  const code = session.roomCode;
  if (!code) return;
  const room = manager.get(code);
  session.roomCode = null;
  if (!room) return;
  const p = room.player(session.playerId);
  if (!p || (p.ws && p.ws !== session.ws)) return; // ya reconectado desde otro socket

  if (room.status !== 'playing' || !room.game) {
    // En el lobby se da un margen de 30 s para recargar la página y volver.
    p.connected = false;
    room.broadcastState();
    p.disconnectTimer = setTimeout(() => {
      p.disconnectTimer = null;
      if (p.connected) return;
      const r = manager.get(room.code);
      if (!r) return;
      manager.leave(r, p.id);
      if (manager.rooms.has(r.code)) r.broadcastState();
    }, 30000);
    return;
  }

  p.connected = false;
  const g = room.game;
  const gp = g.players.get(p.id);
  if (gp) {
    gp.connected = false;
    g.markDisconnected(p.id, () => room.broadcastState());
  }
  room.broadcastState();
}

/* ------------------------------------------------------------------ */
/* Enrutado de mensajes                                                */
/* ------------------------------------------------------------------ */

function route(session, msg) {
  switch (msg.type) {
    case 'hello': {
      session.name = sanitizeName(msg.name);
      break;
    }

    case 'listRooms': {
      send(session.ws, { type: 'rooms', rooms: manager.listOpen() });
      break;
    }

    case 'create': {
      if (!MODES[msg.mode]) throw new GameError('Modo de juego no válido');
      leaveRoom(session, true);
      session.name = sanitizeName(msg.name);
      const room = manager.create(msg.mode);
      addPlayer(room, session);
      room.broadcastState();
      break;
    }

    case 'join': {
      const room = manager.get(msg.code);
      if (!room) throw new GameError('Sala no encontrada. Revisa el código.');
      const existing = room.player(session.playerId);
      if (existing) {
        session.roomCode = room.code;
        room.send(session.playerId, room.snapshot());
        if (room.game) room.send(session.playerId, room.stateMsg());
        break;
      }
      leaveRoom(session, true);
      session.name = sanitizeName(msg.name);
      manager.join(room, {
        id: session.playerId,
        name: session.name,
        ws: session.ws,
        connected: true,
        team: 0,
      });
      session.roomCode = room.code;
      room.broadcastState();
      break;
    }

    case 'reconnect': {
      const room = manager.get(msg.code);
      if (!room) throw new GameError('Esa sala ya no existe');
      const p = room.player(msg.playerId);
      if (!p) throw new GameError('No se pudo recuperar la sesión. Vuelve a entrar.');
      if (p.connected && p.ws && p.ws.readyState === 1 && p.ws !== session.ws) {
        throw new GameError('Esa sesión ya está conectada');
      }
      session.playerId = msg.playerId;
      session.name = p.name;
      session.roomCode = room.code;
      p.ws = session.ws;
      p.connected = true;
      if (p.disconnectTimer) {
        clearTimeout(p.disconnectTimer);
        p.disconnectTimer = null;
      }
      send(session.ws, { type: 'welcome', playerId: p.id });

      if (room.game) {
        const g = room.game;
        g.markReconnected(p.id);
        room.broadcastState();
        const me = g.players.get(p.id);
        if (me && me.placed && me.ships.length) {
          send(session.ws, { type: 'ships', ships: me.ships });
        }
        if (g.history.length) {
          send(session.ws, { type: 'history', shots: g.history });
        }
      } else {
        room.broadcastState();
      }
      break;
    }

    case 'leave': {
      leaveRoom(session, true);
      send(session.ws, { type: 'leftRoom' });
      break;
    }

    case 'setMode': {
      const room = currentRoom(session);
      if (room.status !== 'lobby') throw new GameError('La partida ya ha empezado');
      if (room.hostId !== session.playerId) throw new GameError('Solo el anfitrión cambia el modo');
      const mode = MODES[msg.mode];
      if (!mode) throw new GameError('Modo de juego no válido');
      const total = mode.teams * mode.perTeam;
      if (room.players.length > total) {
        throw new GameError(`Esa sala tiene más jugadores que plazas para ${mode.label}`);
      }
      room.modeId = msg.mode;
      room.players.forEach((p, i) => {
        p.team = room.defaultTeamFor(i);
      });
      room.broadcastState();
      break;
    }

    case 'setTeam': {
      const room = currentRoom(session);
      manager.setTeam(room, session.playerId, msg.team);
      room.broadcastState();
      break;
    }

    case 'start': {
      const room = currentRoom(session);
      if (room.hostId !== session.playerId) throw new GameError('Solo el anfitrión puede empezar');
      manager.start(room);
      room.broadcastState();
      break;
    }

    case 'ready': {
      const { room, game } = currentGame(session);
      const ships = game.placeFleet(session.playerId, msg.ships);
      room.send(session.playerId, { type: 'ships', ships });
      room.broadcastState();
      break;
    }

    case 'unready': {
      const { room, game } = currentGame(session);
      game.unready(session.playerId);
      room.broadcastState();
      break;
    }

    case 'fire': {
      const { room, game } = currentGame(session);
      const event = game.fire(session.playerId, msg.targetId, msg.x, msg.y);
      room.broadcast(event);
      break;
    }

    case 'playAgain': {
      const room = currentRoom(session);
      manager.playAgain(room);
      room.broadcastState();
      break;
    }

    case 'toLobby': {
      const room = currentRoom(session);
      if (room.status !== 'playing' || !room.game) throw new GameError('No hay partida activa');
      if (room.game.phase !== 'over') throw new GameError('La partida aún no ha terminado');
      manager.backToLobby(room);
      room.broadcastState();
      break;
    }

    case 'ping': {
      send(session.ws, { type: 'pong' });
      break;
    }

    default:
      throw new GameError('Mensaje desconocido');
  }
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  const session = {
    ws,
    playerId: crypto.randomUUID(),
    name: null,
    roomCode: null,
  };
  send(ws, { type: 'welcome', playerId: session.playerId });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, errorMsg('Mensaje no válido'));
      return;
    }
    if (!msg || typeof msg.type !== 'string') {
      send(ws, errorMsg('Mensaje no válido'));
      return;
    }
    try {
      route(session, msg);
    } catch (err) {
      const message =
        err instanceof GameError ? err.message : 'Error inesperado en el servidor';
      if (!(err instanceof GameError)) console.error('[error]', err);
      send(ws, errorMsg(message));
    }
  });

  ws.on('close', () => {
    try {
      onDisconnect(session);
    } catch (err) {
      console.error('[disconnect]', err);
    }
  });
  ws.on('error', () => {});
});

/* ------------------------------------------------------------------ */
/* Limpieza de salas huérfanas                                         */
/* ------------------------------------------------------------------ */

let allDisconnectedSince = new Map();

setInterval(() => {
  for (const [code, room] of manager.rooms) {
    const anyConnected = room.players.some((p) => p.connected);
    if (!anyConnected) {
      const since = allDisconnectedSince.get(code) || Date.now();
      allDisconnectedSince.set(code, since);
      if (Date.now() - since > DISCONNECT_GRACE_ROOM_MS) {
        manager.close(room);
        allDisconnectedSince.delete(code);
      }
    } else {
      allDisconnectedSince.delete(code);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log('----------------------------------------------------------');
  console.log('  HUNDIR LA FLOTA ONLINE');
  console.log(`  Servidor:   http://localhost:${PORT}`);
  console.log(`  Invitacion: ${publicUrl() || '(ejecuta "npm run share" para un enlace publico)'}`);
  console.log(`  Modos:      ${Object.values(MODES).map((m) => m.label).join(', ')}`);
  console.log('----------------------------------------------------------');
});
