'use strict';

const { MODES, TOTAL_PLAYERS, Game, GameError, randomCode } = require('./game');

const MAX_ROOMS = 200;

class Room {
  constructor(code, modeId) {
    this.code = code;
    this.modeId = modeId;
    this.hostId = null;
    this.players = []; // {id, name, ws, connected, team}
    this.status = 'lobby'; // lobby | playing
    this.game = null;
    this.createdAt = Date.now();
  }

  get mode() {
    return MODES[this.modeId];
  }

  get maxPlayers() {
    return TOTAL_PLAYERS[this.modeId];
  }

  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  send(id, msg) {
    const p = this.player(id);
    if (p && p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(msg));
    }
  }

  broadcast(msg, exceptId = null) {
    const data = JSON.stringify(msg);
    for (const p of this.players) {
      if (p.id === exceptId) continue;
      if (p.ws && p.ws.readyState === 1) p.ws.send(data);
    }
  }

  /** Reparte los equipos por orden de llegada (alterna en 2v2). */
  defaultTeamFor(index) {
    const m = this.mode;
    return index % m.teams;
  }

  teamCounts() {
    const counts = Array.from({ length: this.mode.teams }, () => 0);
    for (const p of this.players) counts[p.team] = (counts[p.team] || 0) + 1;
    return counts;
  }

  snapshot() {
    return {
      type: 'room',
      room: {
        code: this.code,
        mode: this.modeId,
        modeLabel: this.mode.label,
        status: this.status,
        hostId: this.hostId,
        maxPlayers: this.maxPlayers,
        teams: this.mode.teams,
        perTeam: this.mode.perTeam,
        players: this.players.map((p) => ({
          id: p.id,
          name: p.name,
          team: p.team,
          connected: p.connected,
          host: p.id === this.hostId,
          ready: this.game ? Boolean(this.game.players.get(p.id)?.ready) : false,
          alive: this.game ? this.game.isPlayerAlive(this.game.players.get(p.id)) : true,
        })),
      },
    };
  }

  /** Estado completo de la partida (fase actual). */
  stateMsg() {
    if (!this.game) return this.snapshot();
    return { type: 'state', state: this.game.stateView(), roomCode: this.code };
  }

  broadcastState() {
    this.broadcast(this.stateMsg());
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  get(code) {
    if (!code) return null;
    return this.rooms.get(String(code).toUpperCase().trim()) || null;
  }

  create(modeId) {
    if (!MODES[modeId]) throw new GameError('Modo de juego no válido');
    if (this.rooms.size >= MAX_ROOMS) throw new GameError('Hay demasiadas salas ahora mismo');
    let code = randomCode();
    while (this.rooms.has(code)) code = randomCode();
    const room = new Room(code, modeId);
    this.rooms.set(code, room);
    return room;
  }

  listOpen() {
    return [...this.rooms.values()]
      .filter((r) => r.status === 'lobby' && r.players.length < r.maxPlayers)
      .map((r) => ({
        code: r.code,
        mode: r.modeId,
        modeLabel: r.mode.label,
        players: r.players.length,
        maxPlayers: r.maxPlayers,
      }));
  }

  join(room, player) {
    if (room.status !== 'lobby') throw new GameError('La partida ya ha empezado');
    if (room.players.length >= room.maxPlayers) throw new GameError('La sala está llena');
    if (room.player(player.id)) throw new GameError('Ya estás en esta sala');
    player.team = room.defaultTeamFor(room.players.length);
    room.players.push(player);
    if (!room.hostId) room.hostId = player.id;
    return room;
  }

  leave(room, playerId) {
    const idx = room.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return;
    room.players.splice(idx, 1);
    if (room.hostId === playerId) {
      room.hostId = room.players.length ? room.players[0].id : null;
    }
    if (!room.players.length) {
      this.close(room);
      return;
    }
    // Si la partida ya empezó, el que se va queda fuera del juego
    if (room.game && room.game.players.has(playerId)) {
      const g = room.game;
      if (g.phase !== 'over') {
        const p = g.players.get(playerId);
        if (p) {
          p.eliminated = true;
          p.ready = true;
          if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
          p.disconnectTimer = null;
          const winners = g.checkWin();
          if (winners) {
            g.phase = 'over';
            g.winners = winners;
            g.turn = null;
          }
        }
      }
    }
  }

  /** Cambia de equipo al propio jugador (solo en 2v2 y en el lobby). */
  setTeam(room, playerId, team) {
    if (room.status !== 'lobby') throw new GameError('La partida ya ha empezado');
    if (!Number.isInteger(team) || team < 0 || team >= room.mode.teams) {
      throw new GameError('Equipo no válido');
    }
    const p = room.player(playerId);
    if (!p) throw new GameError('No estás en esta sala');
    const count = room.players.filter((x) => x.team === team && x.id !== playerId).length;
    if (count >= room.mode.perTeam) throw new GameError('Ese equipo ya está completo');
    p.team = team;
  }

  canStart(room) {
    const m = room.mode;
    if (room.players.length !== m.teams * m.perTeam) {
      return `Se necesitan exactamente ${m.teams * m.perTeam} jugadores para ${m.label} (hay ${room.players.length})`;
    }
    if (m.perTeam > 1) {
      const counts = room.teamCounts();
      for (let i = 0; i < m.teams; i++) {
        if (counts[i] !== m.perTeam) {
          return `Los equipos están desiguales: cada equipo debe tener ${m.perTeam} jugadores`;
        }
      }
    }
    return null;
  }

  start(room) {
    const problem = this.canStart(room);
    if (problem) throw new GameError(problem);
    if (room.status === 'playing') throw new GameError('La partida ya está en marcha');

    const roster = room.players.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      connected: p.connected,
    }));
    room.game = new Game(roster, room.modeId);
    room.status = 'playing';
    return room.game;
  }

  playAgain(room) {
    if (room.status !== 'playing' || !room.game) throw new GameError('No hay partida activa');
    if (room.game.phase !== 'over') throw new GameError('La partida aún no ha terminado');
    if (room.players.length < 2) throw new GameError('No hay suficientes jugadores');
    room.game.destroy();
    const roster = room.players.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      connected: p.connected,
    }));
    room.game = new Game(roster, room.modeId);
    return room.game;
  }

  backToLobby(room) {
    if (room.game) room.game.destroy();
    room.game = null;
    room.status = 'lobby';
    room.players.forEach((p, i) => {
      p.team = room.defaultTeamFor(i);
    });
  }

  close(room) {
    if (room.game) room.game.destroy();
    this.rooms.delete(room.code);
  }
}

module.exports = { RoomManager, Room, MODES, TOTAL_PLAYERS };
