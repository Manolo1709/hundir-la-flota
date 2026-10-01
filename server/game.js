'use strict';

/**
 * Núcleo del juego: flota, tableros, colocación, disparos, turnos y victoria.
 * El servidor es la única autoridad: el cliente solo envía intenciones.
 */

const BOARD_SIZE = 10;

const FLEET = [
  { size: 4, count: 1, name: 'Acorazado' },
  { size: 3, count: 2, name: 'Crucero' },
  { size: 2, count: 3, name: 'Destructor' },
  { size: 1, count: 4, name: 'Lancha' },
];

const MODES = {
  '1v1': { id: '1v1', label: '1 vs 1', teams: 2, perTeam: 1 },
  '1v1v1': { id: '1v1v1', label: '1 vs 1 vs 1', teams: 3, perTeam: 1 },
  '1v1v1v1': { id: '1v1v1v1', label: '1 vs 1 vs 1 vs 1', teams: 4, perTeam: 1 },
  '2v2': { id: '2v2', label: '2 vs 2', teams: 2, perTeam: 2 },
};

const TOTAL_PLAYERS = Object.fromEntries(
  Object.entries(MODES).map(([id, m]) => [id, m.teams * m.perTeam])
);

class GameError extends Error {}

const cellKey = (x, y) => `${x},${y}`;

function expectedFleet() {
  const bySize = {};
  for (const f of FLEET) bySize[f.size] = (bySize[f.size] || 0) + f.count;
  return bySize;
}

function shipCells(x, y, size, horizontal) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    cells.push(horizontal ? { x: x + i, y } : { x, y: y + i });
  }
  return cells;
}

function emptyGrid() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

/** ¿Se puede colocar un barco sin tocarse (ni siquiera en diagonal) con otros? */
function canPlace(grid, x, y, size, horizontal) {
  const cells = shipCells(x, y, size, horizontal);
  for (const c of cells) {
    if (c.x < 0 || c.y < 0 || c.x >= BOARD_SIZE || c.y >= BOARD_SIZE) return false;
  }
  // La rejilla solo contiene los barcos ya colocados (el nuevo aún no se marca),
  // así que comprobamos la propia casilla y su vecindario completo.
  for (const c of cells) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = c.x + dx;
        const ny = c.y + dy;
        if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
        if (grid[ny][nx] !== null) return false;
      }
    }
  }
  return true;
}

/** Genera una flota aleatoria válida. */
function generateFleet() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const grid = emptyGrid();
    const ships = [];
    let ok = true;
    let id = 0;
    for (const f of FLEET) {
      for (let n = 0; n < f.count && ok; n++) {
        let placed = false;
        for (let tries = 0; tries < 500 && !placed; tries++) {
          const horizontal = Math.random() < 0.5;
          const maxX = horizontal ? BOARD_SIZE - f.size : BOARD_SIZE - 1;
          const maxY = horizontal ? BOARD_SIZE - 1 : BOARD_SIZE - f.size;
          const x = Math.floor(Math.random() * (maxX + 1));
          const y = Math.floor(Math.random() * (maxY + 1));
          if (!canPlace(grid, x, y, f.size, horizontal)) continue;
          const cells = shipCells(x, y, f.size, horizontal);
          for (const c of cells) grid[c.y][c.x] = id;
          ships.push({ id: id++, size: f.size, x, y, horizontal, cells });
          placed = true;
        }
        if (!placed) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (ok) return ships;
  }
  throw new Error('No se pudo generar una flota válida');
}

/**
 * Valida una flota enviada por un cliente.
 * Devuelve las naves normalizadas o lanza GameError.
 */
function validateFleet(rawShips) {
  if (!Array.isArray(rawShips)) throw new GameError('Flota no válida');

  const expected = expectedFleet();
  const grid = emptyGrid(); // guarda el índice de la nave ocupando esa celda
  const ships = [];
  const countBySize = {};

  rawShips.forEach((s, index) => {
    if (!s || typeof s !== 'object') throw new GameError('Barco no válido');
    const x = Number(s.x);
    const y = Number(s.y);
    const size = Number(s.size);
    const horizontal = Boolean(s.horizontal);
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(size)) {
      throw new GameError('Coordenadas de barco no válidas');
    }
    if (!expected[size]) throw new GameError(`Tamaño de barco no permitido: ${size}`);
    countBySize[size] = (countBySize[size] || 0) + 1;

    const cells = shipCells(x, y, size, horizontal);
    for (const c of cells) {
      if (c.x < 0 || c.y < 0 || c.x >= BOARD_SIZE || c.y >= BOARD_SIZE) {
        throw new GameError('Un barco está fuera del tablero');
      }
      if (grid[c.y][c.x] !== null) throw new GameError('Dos barcos se solapan');
      grid[c.y][c.x] = index;
    }
    ships.push({ id: index, size, x, y, horizontal, cells, sunk: false });
  });

  for (const [sizeStr, count] of Object.entries(expected)) {
    if ((countBySize[sizeStr] || 0) !== count) {
      throw new GameError('La flota no está completa: coloca todos los barcos');
    }
  }

  // Sin contacto ni siquiera en diagonal entre barcos distintos
  ships.forEach((ship, index) => {
    for (const c of ship.cells) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = c.x + dx;
          const ny = c.y + dy;
          if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
          const owner = grid[ny][nx];
          if (owner !== null && owner !== index) {
            throw new GameError('Los barcos no pueden tocarse, ni siquiera en diagonal');
          }
        }
      }
    }
  });

  return ships;
}

function coordName(x, y) {
  return `${String.fromCharCode(65 + x)}${y + 1}`;
}

class Game {
  /**
   * @param {Array<{id:string,name:string,team:number}>} roster
   * @param {string} modeId
   */
  constructor(roster, modeId) {
    this.mode = MODES[modeId] || MODES['1v1'];
    this.modeId = this.mode.id;
    this.boardSize = BOARD_SIZE;
    this.fleet = FLEET.map((f) => ({ ...f }));
    this.phase = 'placing'; // placing | battle | over
    this.players = new Map();
    this.teams = [];
    this.teamPointers = [];
    this.turn = null; // {team, playerIdx}
    this.turnNumber = 0;
    this.winners = null;
    this.log = [];
    this.history = [];

    roster.forEach((p) => {
      const team = p.team | 0;
      if (!this.teams[team]) this.teams[team] = [];
      this.teams[team].push(p.id);
    });
    this.teams = this.teams.map((t) => t || []);
    this.teamPointers = this.teams.map(() => -1);

    roster.forEach((p) => {
      this.players.set(p.id, {
        id: p.id,
        name: p.name,
        team: p.team | 0,
        connected: p.connected !== false,
        ready: false,
        eliminated: false,
        ships: [],
        placed: false,
        incoming: new Set(),
        disconnectTimer: null,
      });
    });

    this.addLog(`🎮 Partida ${this.mode.label} iniciada. Colocad la flota.`, 'info');
  }

  playerList() {
    return [...this.players.values()];
  }

  addLog(text, kind = 'info') {
    this.log.push({ text, kind });
    if (this.log.length > 120) this.log.shift();
  }

  player(id) {
    const p = this.players.get(id);
    if (!p) throw new GameError('Jugador no encontrado');
    return p;
  }

  shipIsSunk(p, ship) {
    return ship.cells.every((c) => p.incoming.has(cellKey(c.x, c.y)));
  }

  isPlayerAlive(p) {
    if (!p || p.eliminated) return false;
    if (this.phase === 'placing') return true;
    if (!p.ships.length) return false;
    return p.ships.some((s) => !this.shipIsSunk(p, s));
  }

  /** Coloca la flota manualmente y marca "listo". */
  placeFleet(id, rawShips) {
    if (this.phase !== 'placing') throw new GameError('La partida ya está en marcha');
    const p = this.player(id);
    p.ships = validateFleet(rawShips);
    p.placed = true;
    p.ready = true;
    this.addLog(`⚓ ${p.name} tiene la flota lista`, 'info');
    if (this.playerList().every((x) => x.ready)) this.startBattle();
    return p.ships;
  }

  unready(id) {
    if (this.phase !== 'placing') throw new GameError('La partida ya está en marcha');
    this.player(id).ready = false;
  }

  startBattle() {
    const aliveTeams = this.teams
      .map((ids, i) => ({ i, ids }))
      .filter((t) => t.ids.some((id) => this.isPlayerAlive(this.players.get(id))));
    if (aliveTeams.length < 2) return;
    this.phase = 'battle';
    const first = aliveTeams[Math.floor(Math.random() * aliveTeams.length)];
    this.teamPointers = this.teams.map(() => -1);
    this.turn = { team: first.i, playerIdx: this.firstAliveIndex(first.i) };
    this.teamPointers[first.i] = this.turn.playerIdx;
    this.turnNumber = 1;
    const p = this.currentPlayer();
    this.addLog(`🎲 Empieza la partida. Turno de ${p ? p.name : '?'}`, 'turn');
  }

  firstAliveIndex(teamIdx) {
    const ids = this.teams[teamIdx];
    for (let i = 0; i < ids.length; i++) {
      const p = this.players.get(ids[i]);
      if (p && this.isPlayerAlive(p) && p.connected) return i;
    }
    return 0;
  }

  currentPlayer() {
    if (!this.turn) return null;
    const ids = this.teams[this.turn.team] || [];
    const id = ids[this.turn.playerIdx];
    return id ? this.players.get(id) : null;
  }

  /** Siguiente equipo con jugadores en pie y, dentro de él, el siguiente jugador vivo. */
  advanceTurn() {
    const n = this.teams.length;
    for (let step = 1; step <= n; step++) {
      const team = (this.turn.team + step) % n;
      if (!this.teams[team] || !this.teams[team].length) continue;
      const hasAlive = this.teams[team].some((id) => {
        const p = this.players.get(id);
        return p && this.isPlayerAlive(p) && p.connected;
      });
      if (!hasAlive) continue;

      const ids = this.teams[team];
      let idx = this.teamPointers[team];
      for (let k = 1; k <= ids.length; k++) {
        const cand = (this.teamPointers[team] + k) % ids.length;
        const p = this.players.get(ids[cand]);
        if (p && this.isPlayerAlive(p) && p.connected) {
          idx = cand;
          break;
        }
      }
      this.teamPointers[team] = idx;
      this.turn = { team, playerIdx: idx };
      this.turnNumber++;
      return;
    }
    this.turn = null;
  }

  aliveTeamIndexes() {
    const set = new Set();
    for (const p of this.players.values()) {
      if (this.isPlayerAlive(p) && p.connected) set.add(p.team);
    }
    return [...set];
  }

  shipsLeft(id) {
    const p = this.players.get(id);
    if (!p) return 0;
    return p.ships.filter((s) => !this.shipIsSunk(p, s)).length;
  }

  /**
   * Dispara a una celda del tablero de otro jugador.
   * Devuelve un evento para difundir a todos los clientes.
   */
  fire(shooterId, targetId, x, y) {
    if (this.phase !== 'battle') throw new GameError('La partida no está en marcha');
    const shooter = this.player(shooterId);
    const current = this.currentPlayer();
    if (!current || current.id !== shooterId) throw new GameError('No es tu turno');
    if (!targetId) throw new GameError('Elige a quién disparar');
    const target = this.player(targetId);
    if (target.id === shooter.id) throw new GameError('No puedes dispararte a ti mismo');
    if (target.team === shooter.team) throw new GameError('No puedes disparar a tu compañero');
    if (!this.isPlayerAlive(target)) throw new GameError('Ese jugador ya no tiene barcos');
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new GameError('Casilla no válida');
    if (x < 0 || y < 0 || x >= this.boardSize || y >= this.boardSize) {
      throw new GameError('Casilla fuera del tablero');
    }

    const key = cellKey(x, y);
    if (target.incoming.has(key)) throw new GameError('Ya se ha disparado ahí');
    target.incoming.add(key);

    const ship = target.ships.find((s) => s.cells.some((c) => c.x === x && c.y === y));
    let result = 'miss';
    let sunkShip = null;
    if (ship) {
      result = 'hit';
      if (this.shipIsSunk(target, ship)) {
        result = 'sunk';
        sunkShip = { size: ship.size, cells: ship.cells };
        this.addLog(
          `💥 ${shooter.name} hunde un barco de ${target.name} (${coordName(x, y)})`,
          'sunk'
        );
      } else {
        this.addLog(`🔥 ${shooter.name} da en ${target.name} en ${coordName(x, y)}`, 'hit');
      }
    } else {
      this.addLog(`💦 ${shooter.name} falla contra ${target.name} en ${coordName(x, y)}`, 'miss');
    }

    const event = {
      type: 'shot',
      byId: shooter.id,
      byName: shooter.name,
      targetId: target.id,
      targetName: target.name,
      x,
      y,
      coord: coordName(x, y),
      result,
      ship: sunkShip,
      at: Date.now(),
    };

    if (!this.isPlayerAlive(target)) {
      target.eliminated = true;
      event.eliminated = { id: target.id, name: target.name };
      this.addLog(`☠️ ${target.name} se ha quedado sin barcos`, 'dead');
    }

    const winners = this.checkWin();
    if (winners) {
      this.phase = 'over';
      this.winners = winners;
      this.turn = null;
      event.winners = winners.map((w) => ({ id: w.id, name: w.name }));
      this.addLog(
        winners.length
          ? `🏆 Victoria de ${winners.map((w) => w.name).join(' y ')}`
          : '🏆 Nadie se ha salvado',
        'over'
      );
    } else {
      this.advanceTurn();
      const next = this.currentPlayer();
      if (next) this.addLog(`👉 Turno de ${next.name}`, 'turn');
    }

    event.alive = this.aliveMap();
    event.shipsLeft = this.shipsLeftMap();
    event.turn = this.turnInfo();
    event.phase = this.phase;
    event.log = this.log.slice(-50);
    this.history.push(event);
    return event;
  }

  checkWin() {
    const teams = this.aliveTeamIndexes();
    if (teams.length > 1) return null;
    if (teams.length === 0) return [];
    return this.teams[teams[0]]
      .map((id) => this.players.get(id))
      .filter((p) => p && this.isPlayerAlive(p) && p.connected);
  }

  /** Un jugador se desconecta: se le da un margen para volver. */
  markDisconnected(id, onChange) {
    const p = this.players.get(id);
    if (!p || p.eliminated || p.disconnectTimer) return;
    p.connected = false;
    p.disconnectTimer = setTimeout(() => {
      p.disconnectTimer = null;
      if (p.connected || p.eliminated) return;
      p.eliminated = true;
      p.ready = true;
      this.addLog(`🚪 ${p.name} se ha desconectado y queda eliminado`, 'dead');

      const winners = this.checkWin();
      if (winners) {
        this.phase = 'over';
        this.winners = winners;
        this.turn = null;
        this.addLog(
          winners.length
            ? `🏆 Victoria de ${winners.map((w) => w.name).join(' y ')}`
            : '🏆 Nadie se ha salvado',
          'over'
        );
      } else if (this.phase === 'battle' && this.currentPlayer() && this.currentPlayer().id === id) {
        this.advanceTurn();
      } else if (this.phase === 'placing' && this.playerList().every((x) => x.ready)) {
        this.startBattle();
      }
      if (onChange) onChange();
    }, 15000);
  }

  markReconnected(id) {
    const p = this.players.get(id);
    if (!p) return false;
    if (p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
    p.connected = true;
    return true;
  }

  destroy() {
    for (const p of this.players.values()) {
      if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
    }
  }

  aliveMap() {
    const out = {};
    for (const p of this.players.values()) out[p.id] = this.isPlayerAlive(p);
    return out;
  }

  shipsLeftMap() {
    const out = {};
    for (const p of this.players.values()) out[p.id] = this.shipsLeft(p.id);
    return out;
  }

  turnInfo() {
    const p = this.currentPlayer();
    if (!p) return null;
    return { playerId: p.id, name: p.name, team: p.team, number: this.turnNumber };
  }

  /** Estado agregado que se difunde a todos. */
  stateView() {
    return {
      phase: this.phase,
      mode: this.modeId,
      modeLabel: this.mode.label,
      boardSize: this.boardSize,
      fleet: this.fleet,
      players: this.playerList().map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        connected: p.connected,
        ready: p.ready,
        alive: this.isPlayerAlive(p),
        eliminated: p.eliminated,
        shipsLeft: this.shipsLeft(p.id),
        ships: p.ships.length,
      })),
      turn: this.turnInfo(),
      winners: this.winners ? this.winners.map((w) => ({ id: w.id, name: w.name })) : null,
      log: this.log.slice(-50),
    };
  }
}

function randomCode(len = 5) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

module.exports = {
  BOARD_SIZE,
  FLEET,
  MODES,
  TOTAL_PLAYERS,
  Game,
  GameError,
  generateFleet,
  validateFleet,
  coordName,
  randomCode,
  cellKey,
};
