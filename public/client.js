'use strict';

/* ============================================================
   Hundir la Flota online — cliente
   ============================================================ */

/* ---------------- Constantes y utilidades ---------------- */

const $ = (s) => document.querySelector(s);
const BOARD_SIZE = 10;

const FLEET = [
  { size: 4, count: 1, name: 'Acorazado' },
  { size: 3, count: 2, name: 'Crucero' },
  { size: 2, count: 3, name: 'Destructor' },
  { size: 1, count: 4, name: 'Lancha' },
];

const MODES = {
  '1v1': { label: '1 vs 1', total: 2, teams: 2 },
  '1v1v1': { label: '1 vs 1 vs 1', total: 3, teams: 3 },
  '1v1v1v1': { label: '1 vs 1 vs 1 vs 1', total: 4, teams: 4 },
  '2v2': { label: '2 vs 2', total: 4, teams: 2 },
};

const TEAM_LABELS = ['Equipo A', 'Equipo B'];
const TEAM_CLASS = ['team-a', 'team-b'];

const cellKey = (x, y) => `${x},${y}`;
const coordName = (x, y) => `${String.fromCharCode(65 + x)}${y + 1}`;
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

function shipCellsOf(x, y, size, horizontal) {
  const cells = [];
  for (let i = 0; i < size; i++) cells.push(horizontal ? { x: x + i, y } : { x, y: y + i });
  return cells;
}

function expectedFleet() {
  const m = {};
  for (const f of FLEET) m[f.size] = (m[f.size] || 0) + f.count;
  return m;
}

function toGrid(ships) {
  const grid = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  ships.forEach((s, i) => {
    for (const c of s.cells) {
      if (c.x >= 0 && c.y >= 0 && c.x < BOARD_SIZE && c.y < BOARD_SIZE) grid[c.y][c.x] = i;
    }
  });
  return grid;
}

/** ¿Es válida la posición (x,y) para un barco dado el resto de la flota? */
function canPlaceLocal(ships, x, y, size, horizontal) {
  const cells = shipCellsOf(x, y, size, horizontal);
  if (cells.some((c) => c.x < 0 || c.y < 0 || c.x >= BOARD_SIZE || c.y >= BOARD_SIZE)) return false;
  const grid = toGrid(ships);
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

/** Valida la flota completa. Devuelve null si es válida o un mensaje de error. */
function validateLocal(ships) {
  if (!Array.isArray(ships)) return 'Flota no válida';
  const expected = expectedFleet();
  const count = {};
  for (const s of ships) {
    count[s.size] = (count[s.size] || 0) + 1;
    if (!expected[s.size]) return `Tamaño de barco no permitido: ${s.size}`;
    if (s.cells.some((c) => c.x < 0 || c.y < 0 || c.x >= BOARD_SIZE || c.y >= BOARD_SIZE)) {
      return 'Un barco está fuera del tablero';
    }
  }
  for (const [size, n] of Object.entries(expected)) {
    if ((count[size] || 0) !== n) return 'La flota no está completa: coloca todos los barcos';
  }
  const grid = toGrid(ships);
  for (let i = 0; i < ships.length; i++) {
    for (const c of ships[i].cells) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = c.x + dx;
          const ny = c.y + dy;
          if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
          const owner = grid[ny][nx];
          if (owner !== null && owner !== i) {
            return 'Los barcos no pueden tocarse, ni siquiera en diagonal';
          }
        }
      }
    }
  }
  return null;
}

/** Flota aleatoria válida (misma lógica que el servidor). */
function generateFleetLocal() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const ships = [];
    const grid = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
    let ok = true;
    for (const f of FLEET) {
      for (let n = 0; n < f.count && ok; n++) {
        let placed = false;
        for (let tries = 0; tries < 500 && !placed; tries++) {
          const horizontal = Math.random() < 0.5;
          const maxX = horizontal ? BOARD_SIZE - f.size : BOARD_SIZE - 1;
          const maxY = horizontal ? BOARD_SIZE - 1 : BOARD_SIZE - f.size;
          const x = Math.floor(Math.random() * (maxX + 1));
          const y = Math.floor(Math.random() * (maxY + 1));
          const cells = shipCellsOf(x, y, f.size, horizontal);
          if (cells.some((c) => c.x < 0 || c.y < 0 || c.x >= BOARD_SIZE || c.y >= BOARD_SIZE)) continue;
          const probe = ships.map((s) => ({ cells: s.cells }));
          if (!canPlaceLocal(probe, x, y, f.size, horizontal)) continue;
          for (const c of cells) grid[c.y][c.x] = 1;
          ships.push({ x, y, size: f.size, horizontal, cells });
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
  return [];
}

/* ---------------- Estado del cliente ---------------- */

let ws = null;
let meId = null;
let room = null; // snapshot del lobby
let state = null; // estado de la partida
let myShips = [];
let boards = new Map(); // id -> {shots: Map, revealed: Set}
let placement = { ships: [], size: 4, horizontal: true };
let pendingFire = false;
let reconnecting = false;
let selectedMode = '1v1';
let roomList = [];
let lastRoomsFetch = 0;
let autoJoinCode = null; // sala que entra automáticamente por enlace de invitación
let toastTimer = null;
let fireGuard = null;

/* ---------------- Conexión ---------------- */

function sendMsg(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  else toast('Sin conexión con el servidor');
}

function setConn(text, kind) {
  const el = $('#connStatus');
  el.textContent = text;
  el.className = `conn conn-${kind}`;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}`);
  ws = socket;

  socket.addEventListener('open', () => {
    setConn('conectado', 'ok');
    if (!room && !state) renderAll();
  });

  socket.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    try {
      handle(msg);
    } catch (err) {
      console.error('Error de cliente:', err);
    }
  });

  socket.addEventListener('close', () => {
    if (ws !== socket) return;
    ws = null;
    pendingFire = false;
    setConn('desconectado', 'off');
    setTimeout(() => {
      if (!ws) connect();
    }, 2000);
  });

  socket.addEventListener('error', () => {});
}

/* ---------------- Mensajes del servidor ---------------- */

function handle(msg) {
  switch (msg.type) {
    case 'welcome': {
      const savedRoom = sessionStorage.getItem('hlflota-room');
      const savedId = sessionStorage.getItem('hlflota-id');
      if (savedRoom && savedId && savedId !== msg.playerId && !reconnecting) {
        reconnecting = true;
        meId = savedId;
        setConn('reconectando…', 'wait');
        sendMsg({ type: 'reconnect', code: savedRoom, playerId: savedId });
      } else {
        if (!reconnecting) {
          meId = msg.playerId;
          sessionStorage.setItem('hlflota-id', meId);
        }
        reconnecting = false;
        if (autoJoinCode) joinRoom(autoJoinCode);
        renderAll();
      }
      break;
    }

    case 'room': {
      room = msg.room;
      state = null;
      reconnecting = false;
      sessionStorage.setItem('hlflota-room', room.code);
      if (room.mode) selectedMode = room.mode;
      renderAll();
      break;
    }

    case 'state': {
      const prev = state ? state.phase : null;
      state = msg.state;
      if (msg.roomCode) sessionStorage.setItem('hlflota-room', msg.roomCode);
      reconnecting = false;
      if (state.phase === 'placing' && prev !== 'placing') resetGameView();
      else state.players.forEach((p) => getBoard(p.id));
      renderAll();
      break;
    }

    case 'ships': {
      myShips = msg.ships || [];
      placement.ships = myShips;
      if (state && state.phase === 'placing') renderAll();
      break;
    }

    case 'shot': {
      pendingFire = false;
      if (fireGuard) clearTimeout(fireGuard);
      applyShot(msg);
      renderAll();
      break;
    }

    case 'history': {
      (msg.shots || []).forEach((s) => applyShot(s));
      renderAll();
      break;
    }

    case 'rooms': {
      roomList = msg.rooms || [];
      if (!room && !state) renderHome();
      break;
    }

    case 'error': {
      pendingFire = false;
      if (reconnecting) {
        reconnecting = false;
        const lostCode = sessionStorage.getItem('hlflota-room');
        sessionStorage.removeItem('hlflota-room');
        room = null;
        state = null;
        if (lostCode) $('#inputCode').value = lostCode;
        toast(`${msg.message}${lostCode ? ` (código ${lostCode})` : ''}`);
        renderAll();
        // El enlace de invitación manda: si no se pudo recuperar, volvemos a entrar.
        if (autoJoinCode) joinRoom(autoJoinCode);
      } else {
        toast(msg.message);
      }
      break;
    }

    case 'leftRoom': {
      room = null;
      state = null;
      sessionStorage.removeItem('hlflota-room');
      renderAll();
      break;
    }

    default:
      break;
  }
}

function getBoard(id) {
  let b = boards.get(id);
  if (!b) {
    b = { shots: new Map(), revealed: new Set() };
    boards.set(id, b);
  }
  return b;
}

function applyShot(ev) {
  const b = getBoard(ev.targetId);
  b.shots.set(cellKey(ev.x, ev.y), ev.result);
  if (ev.result === 'sunk' && ev.ship && ev.ship.cells) {
    for (const c of ev.ship.cells) b.revealed.add(cellKey(c.x, c.y));
  }
  if (!state) return;
  if (ev.phase) state.phase = ev.phase;
  if (ev.turn !== undefined) state.turn = ev.turn;
  if (ev.winners) state.winners = ev.winners;
  if (ev.log) state.log = ev.log;
  if (ev.alive) {
    for (const p of state.players) {
      if (ev.alive[p.id] !== undefined) p.alive = ev.alive[p.id];
    }
  }
  if (ev.shipsLeft) {
    for (const p of state.players) {
      if (ev.shipsLeft[p.id] !== undefined) p.shipsLeft = ev.shipsLeft[p.id];
    }
  }
  if (ev.eliminated) {
    const p = state.players.find((x) => x.id === ev.eliminated.id);
    if (p) {
      p.eliminated = true;
      p.alive = false;
    }
  }
}

function resetGameView() {
  myShips = [];
  boards.clear();
  placement = { ships: [], size: 4, horizontal: true };
  pendingFire = false;
  if (fireGuard) clearTimeout(fireGuard);
  if (state) state.players.forEach((p) => getBoard(p.id));
  $('#overlay').classList.add('hidden');
}

/* ---------------- Utilidades de presentación ---------------- */

function toast(message, kind) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind || ''}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3800);
}

function showScreen(sel) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
  const el = $(sel);
  if (el) el.classList.remove('hidden');
}

function currentMode() {
  return (state && state.mode) || (room && room.mode) || selectedMode;
}

function isTeamMode() {
  return currentMode() === '2v2';
}

function teamLabel(team) {
  return isTeamMode() ? TEAM_LABELS[team] || `Equipo ${team + 1}` : '';
}

function me() {
  if (state) return state.players.find((p) => p.id === meId) || null;
  if (room) return room.players.find((p) => p.id === meId) || null;
  return null;
}

function myTurn() {
  return Boolean(
    state && state.phase === 'battle' && state.turn && state.turn.playerId === meId
  );
}

function renderAll() {
  const code = (room && room.code) || (state && state.roomCode) || '';
  $('#roomBadge').classList.toggle('hidden', !code);
  if (code) $('#roomCodeText').textContent = code;

  if (state) {
    if (state.phase === 'placing') {
      showScreen('#screen-placing');
      renderPlacing();
    } else {
      showScreen('#screen-battle');
      renderBattle();
    }
    renderOverlay();
  } else if (room) {
    showScreen('#screen-lobby');
    renderLobby();
  } else {
    showScreen('#screen-home');
    renderHome();
  }
}

/* ---------------- Pantalla: inicio ---------------- */

function renderHome() {
  sendRooms();
  document.querySelectorAll('#modeGrid .mode-card').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.mode === selectedMode);
  });

  const wrap = $('#roomListWrap');
  if (roomList.length) {
    wrap.classList.remove('hidden');
    $('#roomList').innerHTML = roomList
      .map(
        (r) => `
      <li>
        <span class="code">${esc(r.code)}</span>
        <span>${esc(r.modeLabel)}</span>
        <span class="muted">${r.players}/${r.maxPlayers}</span>
        <button class="btn small" data-join="${esc(r.code)}">Unirse</button>
      </li>`
      )
      .join('');
  } else {
    wrap.classList.add('hidden');
  }
}

function sendRooms() {
  if (!ws || ws.readyState !== 1) return;
  if (Date.now() - lastRoomsFetch < 3000) return;
  lastRoomsFetch = Date.now();
  sendMsg({ type: 'listRooms' });
}

/** Enlace público de la sala: `https://servidor/?sala=ABC12` */
function inviteLink() {
  const base =
    String(window.__PUBLIC_URL__ || '')
      .trim()
      .replace(/\/+$/, '') || location.origin; // sin PUBLIC_URL: la propia URL actual
  return `${base}/?sala=${room ? room.code : ''}`;
}

function joinRoom(code) {
  autoJoinCode = null;
  sendMsg({ type: 'join', code, name: $('#inputName').value });
  toast(`Entrando en la sala ${code}…`, 'ok');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- Pantalla: sala / lobby ---------------- */

function renderLobby() {
  const r = room;
  if (!r) return;
  $('#lobbyCode').textContent = r.code;

  const isHost = r.hostId === meId;
  document.querySelectorAll('#lobbyModes .mode-card').forEach((btn) => {
    const active = btn.dataset.mode === r.mode;
    btn.classList.toggle('selected', active);
    btn.disabled = !isHost;
    btn.title = isHost ? 'Cambiar modo' : 'Solo el anfitrión puede cambiar el modo';
    btn.onclick = () => {
      if (!isHost || active) return;
      selectedMode = btn.dataset.mode;
      sendMsg({ type: 'setMode', mode: btn.dataset.mode });
    };
  });

  // Jugadores
  const teamMode = r.mode === '2v2';
  const rowCtx = { hostId: r.hostId, mode: r.mode, canSwap: teamMode };
  if (teamMode) {
    let html = '<div class="team-box">';
    for (let t = 0; t < r.teams; t++) {
      const list = r.players.filter((p) => p.team === t);
      html += `<div>
        <div class="team-title">${esc(TEAM_LABELS[t] || 'Equipo ' + (t + 1))} · ${list.length}/${r.perTeam}</div>
        <ul class="player-list">${list.map((p) => playerRow(p, rowCtx)).join('') || '<li class="muted">Libre</li>'}</ul>
      </div>`;
    }
    html += '</div>';
    $('#teamsBox').innerHTML = html;
    $('#lobbyPlayers').innerHTML = '';
    $('#lobbyPlayers').classList.add('hidden');
  } else {
    $('#teamsBox').innerHTML = '';
    $('#lobbyPlayers').classList.remove('hidden');
    $('#lobbyPlayers').innerHTML = r.players.map((p) => playerRow(p, rowCtx)).join('');
  }

  // Botón de empezar
  const total = MODES[r.mode] ? MODES[r.mode].total : r.maxPlayers;
  const btn = $('#btnStart');
  btn.classList.toggle('hidden', !isHost);

  let hint = '';
  if (r.players.length < total) {
    hint = `Faltan ${total - r.players.length} jugador(es) para ${MODES[r.mode].label} (${r.players.length}/${total}).`;
  } else if (teamMode) {
    const counts = [0, 0];
    r.players.forEach((p) => (counts[p.team] = (counts[p.team] || 0) + 1));
    if (counts[0] !== 2 || counts[1] !== 2) {
      hint = 'Los equipos deben tener 2 jugadores cada uno.';
    }
  }
  if (!isHost && !hint) hint = 'Esperando a que el anfitrión empiece la partida.';
  $('#lobbyHint').textContent = hint;
  btn.disabled = Boolean(hint) && isHost;
}

function playerRow(p, ctx = {}) {
  const isMe = p.id === meId;
  const cls = [isMe ? 'me' : ''];
  const tags = [];

  if (ctx.hostId === p.id) tags.push('<span class="tag host">👑 anfitrión</span>');
  if (ctx.showReady) {
    tags.push(
      p.ready
        ? '<span class="tag ready">✅ listo</span>'
        : '<span class="tag wait">colocando</span>'
    );
  }
  if (ctx.showShips) tags.push(`<span class="ships">⚓ ${p.shipsLeft ?? 0}</span>`);
  if (p.eliminated) tags.push('<span class="tag dead">sin flota</span>');
  if (p.connected === false) tags.push('<span class="tag dead">desconectado</span>');

  if (isTeamMode()) tags.unshift(`<span class="tag">${esc(teamLabel(p.team))}</span>`);

  const swap =
    ctx.canSwap && p.id === meId
      ? `<button class="swap-btn" data-swap="${p.team === 0 ? 1 : 0}">⇄ cambiar</button>`
      : '';

  if (p.connected === false) cls.push('off');
  if (p.eliminated) cls.push('dead');
  if (isTeamMode() && p.team != null) cls.push(TEAM_CLASS[p.team] || '');

  return `<li class="${cls.join(' ')}">
    <span class="name">${esc(p.name)}${isMe ? ' <span class="muted">(tú)</span>' : ''}</span>
    ${swap}
    ${tags.join('')}
  </li>`;
}

/* ---------------- Pantalla: colocación ---------------- */

function meReady() {
  const m = me();
  return Boolean(m && m.ready);
}

function placedCount(size) {
  return placement.ships.filter((s) => s.size === size).length;
}

function nextAvailableSize() {
  for (const f of FLEET) {
    if (placedCount(f.size) < f.count) return f.size;
  }
  return null;
}

function renderPlacing() {
  const m = me();
  const ready = meReady();

  renderPlaceBoard();
  renderTray();

  renderPlayerList($('#placingPlayers'), { showReady: true, mode: currentMode() });

  $('#btnReady').classList.toggle('hidden', ready);
  $('#btnUnready').classList.toggle('hidden', !ready);
  $('#btnRotate').disabled = ready;
  $('#btnAuto').disabled = ready;
  $('#btnRotate').classList.toggle('selected', !placement.horizontal);

  if (m && m.eliminated) {
    $('#placingHint').textContent = 'Estás fuera de la partida';
    $('#placingWait').textContent = '';
  } else if (ready) {
    $('#placingHint').textContent = '✅ Flota enviada';
    const waiting = (state ? state.players : [])
      .filter((p) => !p.ready && !p.eliminated)
      .map((p) => (p.id === meId ? 'tú' : p.name));
    $('#placingWait').textContent = waiting.length
      ? `Esperando a: ${waiting.join(', ')}`
      : '¡Todo listo! Empezando…';
  } else {
    $('#placingHint').textContent = 'Coloca tus barcos en el tablero';
    $('#placingWait').textContent = '';
  }
}

function renderPlayerList(el, opts = {}) {
  if (!state) return;
  el.innerHTML = state.players.map((p) => playerRow(p, opts)).join('');
}

function renderTray() {
  const ready = meReady();
  const html = FLEET.map((f) => {
    const left = f.count - placedCount(f.size);
    const selected = placement.size === f.size && left > 0 && !ready;
    const cls = ['tray-item'];
    if (selected) cls.push('selected');
    if (left <= 0) cls.push('used');
    const ship = '<i></i>'.repeat(f.size);
    return `<button class="${cls.join(' ')}" data-size="${f.size}" ${left <= 0 || ready ? 'disabled' : ''}>
      <span class="tray-ship">${ship}</span>
      <span>${f.name}</span>
      <span class="tray-count">×${left}</span>
    </button>`;
  }).join('');
  $('#tray').innerHTML = html;
  $('#tray').querySelectorAll('.tray-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      placement.size = Number(btn.dataset.size);
      renderPlacing();
    });
  });
}

function renderPlaceBoard() {
  const host = $('#myBoardPlace');
  host.innerHTML = '';
  const ready = meReady();
  host.classList.toggle('locked', ready);

  const grid = buildGrid();
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      const cell = grid.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
      const ship = placement.ships.find((s) => s.cells.some((c) => c.x === x && c.y === y));
      if (ship) cell.classList.add('ship');
    }
  }

  if (!ready) {
    grid.addEventListener('mouseover', (e) => onPlaceHover(e, grid));
    grid.addEventListener('mouseleave', () => clearPreview(grid));
    grid.addEventListener('click', (e) => onPlaceClick(e, grid));
  }
  host.appendChild(grid);
}

function clearPreview(grid) {
  grid.querySelectorAll('.preview, .preview-bad').forEach((c) => {
    c.classList.remove('preview', 'preview-bad');
  });
}

function onPlaceHover(e, grid) {
  const cell = e.target.closest('.cell[data-x]');
  clearPreview(grid);
  if (!cell) return;
  const x = Number(cell.dataset.x);
  const y = Number(cell.dataset.y);
  const occupied = placement.ships.find((s) => s.cells.some((c) => c.x === x && c.y === y));
  if (occupied) return;
  const cells = shipCellsOf(x, y, placement.size, placement.horizontal);
  const ok = canPlaceLocal(placement.ships, x, y, placement.size, placement.horizontal);
  for (const c of cells) {
    const el = grid.querySelector(`.cell[data-x="${c.x}"][data-y="${c.y}"]`);
    if (el) el.classList.add(ok ? 'preview' : 'preview-bad');
  }
}

function onPlaceClick(e, grid) {
  if (meReady()) return;
  const cell = e.target.closest('.cell[data-x]');
  if (!cell) return;
  const x = Number(cell.dataset.x);
  const y = Number(cell.dataset.y);

  const existing = placement.ships.findIndex((s) => s.cells.some((c) => c.x === x && c.y === y));
  if (existing >= 0) {
    placement.ships.splice(existing, 1);
    renderPlacing();
    return;
  }

  if (!canPlaceLocal(placement.ships, x, y, placement.size, placement.horizontal)) {
    toast('Ahí no cabe: los barcos no pueden tocarse');
    return;
  }
  placement.ships.push({
    x,
    y,
    size: placement.size,
    horizontal: placement.horizontal,
    cells: shipCellsOf(x, y, placement.size, placement.horizontal),
  });
  const next = nextAvailableSize();
  if (next && placedCount(placement.size) >= (expectedFleet()[placement.size] || 0)) {
    placement.size = next;
  }
  renderPlacing();
}

/* ---------------- Pantalla: batalla ---------------- */

function canTarget(p) {
  if (!state || state.phase !== 'battle') return false;
  const m = me();
  if (!m || !m.alive) return false;
  if (!state.turn || state.turn.playerId !== meId) return false;
  if (p.id === meId || p.team === m.team || !p.alive) return false;
  return true;
}

function battleCellClass(x, y, p, mine) {
  const k = cellKey(x, y);
  const b = getBoard(p.id);
  const shot = b.shots.get(k);
  const cls = [];

  if (mine) {
    const ship = myShips.find((s) => s.cells.some((c) => c.x === x && c.y === y));
    if (ship) {
      cls.push('ship');
      if (shot) {
        const sunk = ship.cells.every((c) => b.shots.has(cellKey(c.x, c.y)));
        cls.push(sunk ? 'sunk' : 'hit');
      }
    } else if (shot) {
      cls.push(shot === 'miss' ? 'miss' : 'hit');
    }
  } else if (b.revealed.has(k)) {
    cls.push('sunk');
  } else if (shot === 'hit') {
    cls.push('hit');
  } else if (shot === 'miss') {
    cls.push('miss');
  }
  return cls;
}

function renderBattle() {
  if (!state) return;
  renderBanner();

  const m = me();
  const host = $('#boards');
  host.innerHTML = '';

  if (m) host.appendChild(boardPanel(m, true));
  for (const p of state.players) {
    if (m && p.id === m.id) continue;
    host.appendChild(boardPanel(p, false));
  }

  renderPlayerList($('#battlePlayers'), { showShips: true, mode: currentMode() });
  renderLog();
}

function boardPanel(p, mine) {
  const panel = document.createElement('div');
  const cls = ['board-panel'];
  if (mine) cls.push('mine');
  const m = me();
  if (!mine && m && p.team === m.team && p.id !== meId) cls.push('teammate');
  if (!p.alive || p.eliminated) cls.push('dead');
  panel.className = cls.join(' ');

  const targeting = !mine && canTarget(p);
  const tags = [];
  if (mine) tags.push('<span class="tag">tú</span>');
  if (isTeamMode()) tags.push(`<span class="tag">${esc(teamLabel(p.team))}</span>`);
  if (!mine && m && p.team === m.team && p.id !== meId) {
    tags.push('<span class="tag ready">compañero</span>');
  }
  if (!p.alive || p.eliminated) tags.push('<span class="tag dead">sin flota</span>');
  else if (p.connected === false) tags.push('<span class="tag dead">desconectado</span>');

  const turnFlag =
    state.turn && state.turn.playerId === p.id
      ? '<span class="turn-flag">🎯 su turno</span>'
      : '';

  panel.innerHTML = `
    <div class="board-head">
      <h3>${mine ? 'Tu tablero' : esc(p.name)} ${tags.join(' ')}</h3>
      <span class="meta">⚓ ${p.shipsLeft ?? 0} barcos ${turnFlag}</span>
    </div>`;

  const hostEl = document.createElement('div');
  hostEl.className = 'board-host';
  const grid = buildGrid();
  const b = getBoard(p.id);

  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      const cell = grid.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
      const classes = battleCellClass(x, y, p, mine);
      classes.forEach((c) => cell.classList.add(c));
      cell.title = `${coordName(x, y)}`;
      if (targeting && !b.shots.has(cellKey(x, y)) && !pendingFire) {
        cell.classList.add('targetable');
      }
    }
  }

  if (targeting) {
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell[data-x]');
      if (!cell || pendingFire) return;
      if (!cell.classList.contains('targetable')) return;
      fire(p.id, Number(cell.dataset.x), Number(cell.dataset.y));
    });
  } else {
    grid.classList.add('locked');
  }

  hostEl.appendChild(grid);
  panel.appendChild(hostEl);
  return panel;
}

function fire(targetId, x, y) {
  if (pendingFire) return;
  pendingFire = true;
  sendMsg({ type: 'fire', targetId, x, y });
  if (fireGuard) clearTimeout(fireGuard);
  fireGuard = setTimeout(() => {
    pendingFire = false;
    renderAll();
  }, 3000);
}

function renderBanner() {
  const el = $('#battleBanner');
  const m = me();
  el.className = 'banner';

  if (state.phase === 'over') {
    el.classList.add('wait');
    el.textContent = '🏁 Partida terminada';
    return;
  }
  if (m && !m.alive) {
    el.classList.add('dead');
    el.textContent = '☠️ Tus barcos han sido hundidos. La partida continúa sin ti.';
    return;
  }
  if (myTurn()) {
    el.classList.add('mine');
    el.textContent = `🎯 ¡Tu turno! (turno ${state.turn.number}) — elige una casilla en el tablero de un rival`;
    return;
  }
  el.classList.add('wait');
  el.textContent = state.turn
    ? `⏳ Turno de ${state.turn.name} (turno ${state.turn.number})`
    : '⏳ Esperando…';
}

function renderLog() {
  const el = $('#log');
  if (!state || !state.log) return;
  el.innerHTML = state.log
    .map((e) => `<div class="log-line ${e.kind}">${esc(e.text)}</div>`)
    .join('');
  el.scrollTop = el.scrollHeight;
}

/* ---------------- Pantalla: final ---------------- */

function renderOverlay() {
  const ov = $('#overlay');
  if (!state || state.phase !== 'over' || !state.winners) {
    ov.classList.add('hidden');
    return;
  }
  ov.classList.remove('hidden');

  const winners = state.winners;
  const won = winners.some((w) => w.id === meId);
  if (!winners.length) {
    $('#overTitle').textContent = '☠️ Nadie se ha salvado';
    $('#overText').textContent = 'Todos los barcos han quedado bajo el mar.';
  } else if (won) {
    $('#overTitle').textContent = '🏆 ¡Victoria!';
    $('#overText').textContent =
      winners.length > 1
        ? `Habéis ganado: ${winners.map((w) => w.name).join(' y ')}`
        : '¡Has ganado la partida!';
  } else {
    $('#overTitle').textContent = '💀 Derrota';
    $('#overText').textContent = `Han ganado: ${winners.map((w) => w.name).join(' y ')}`;
  }

  const ranking = [...state.players].sort((a, b) => (b.shipsLeft || 0) - (a.shipsLeft || 0));
  $('#overBoard').innerHTML = `<ul class="player-list" style="width:100%">
    ${ranking.map((p) => playerRow(p, { showShips: true, mode: currentMode() })).join('')}
  </ul>`;
}

/* ---------------- Construcción de tableros ---------------- */

function buildGrid(size = BOARD_SIZE) {
  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.style.gridTemplateColumns = `repeat(${size + 1}, auto)`;

  const corner = document.createElement('div');
  corner.className = 'cell coord corner';
  grid.appendChild(corner);

  for (let x = 0; x < size; x++) {
    const c = document.createElement('div');
    c.className = 'cell coord';
    c.textContent = String.fromCharCode(65 + x);
    grid.appendChild(c);
  }
  for (let y = 0; y < size; y++) {
    const label = document.createElement('div');
    label.className = 'cell coord';
    label.textContent = String.fromCodePoint(49 + y);
    grid.appendChild(label);
    for (let x = 0; x < size; x++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.x = x;
      cell.dataset.y = y;
      grid.appendChild(cell);
    }
  }
  return grid;
}

/* ---------------- Eventos de la interfaz ---------------- */

function saveName() {
  const name = $('#inputName').value.trim();
  if (name) localStorage.setItem('hlflota-name', name);
  return name;
}

function initEvents() {
  document.querySelectorAll('#modeGrid .mode-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedMode = btn.dataset.mode;
      renderHome();
    });
  });

  $('#btnCreate').addEventListener('click', () => {
    saveName();
    sendMsg({ type: 'create', mode: selectedMode, name: $('#inputName').value });
  });

  $('#btnJoin').addEventListener('click', () => {
    const code = $('#inputCode').value.trim().toUpperCase();
    if (code.length < 4) return toast('Escribe un código de sala válido');
    saveName();
    sendMsg({ type: 'join', code, name: $('#inputName').value });
  });

  $('#inputCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btnJoin').click();
  });

  $('#roomList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-join]');
    if (!btn) return;
    $('#inputCode').value = btn.dataset.join;
    $('#btnJoin').click();
  });

  $('#btnCopy').addEventListener('click', async () => {
    if (!room) return;
    const ok = await copyText(room.code);
    toast(ok ? `Código ${room.code} copiado ✓` : `El código de la sala es ${room.code}`, 'ok');
  });

  $('#btnInvite').addEventListener('click', async () => {
    if (!room) return;
    const link = inviteLink();
    $('#inviteLink').value = link;
    $('#inviteBox').classList.remove('hidden');
    const ok = await copyText(link);
    toast(ok ? 'Enlace de invitación copiado ✓' : 'Copia el enlace de la casilla', 'ok');
  });

  $('#btnCopyInvite').addEventListener('click', async () => {
    const link = $('#inviteLink').value || inviteLink();
    const ok = await copyText(link);
    toast(ok ? 'Enlace copiado ✓' : 'No se pudo copiar: selecciónalo a mano', ok ? 'ok' : undefined);
  });

  $('#btnLeave').addEventListener('click', () => sendMsg({ type: 'leave' }));

  $('#btnStart').addEventListener('click', () => sendMsg({ type: 'start' }));

  document.addEventListener('click', (e) => {
    const swap = e.target.closest('[data-swap]');
    if (swap && room) {
      sendMsg({ type: 'setTeam', team: Number(swap.dataset.swap) });
    }
  });

  $('#btnRotate').addEventListener('click', () => {
    placement.horizontal = !placement.horizontal;
    renderPlacing();
  });

  $('#btnAuto').addEventListener('click', () => {
    const fleet = generateFleetLocal();
    if (!fleet.length) return toast('No se pudo generar una flota');
    placement.ships = fleet;
    const next = nextAvailableSize();
    if (next) placement.size = next;
    renderPlacing();
  });

  $('#btnReady').addEventListener('click', () => {
    const err = validateLocal(placement.ships);
    if (err) return toast(err);
    sendMsg({
      type: 'ready',
      ships: placement.ships.map((s) => ({
        x: s.x,
        y: s.y,
        size: s.size,
        horizontal: s.horizontal,
      })),
    });
  });

  $('#btnUnready').addEventListener('click', () => sendMsg({ type: 'unready' }));

  $('#btnRematch').addEventListener('click', () => sendMsg({ type: 'playAgain' }));
  $('#btnToLobby').addEventListener('click', () => sendMsg({ type: 'toLobby' }));
  $('#btnExit').addEventListener('click', () => sendMsg({ type: 'leave' }));

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'r') return;
    if (!state || state.phase !== 'placing' || meReady()) return;
    placement.horizontal = !placement.horizontal;
    renderPlacing();
  });
}

/* ---------------- Arranque ---------------- */

function init() {
  const savedName = localStorage.getItem('hlflota-name');
  if (savedName) $('#inputName').value = savedName;

  const savedRoom = sessionStorage.getItem('hlflota-room');
  if (savedRoom) $('#inputCode').value = savedRoom;

  // ¿Has llegado por un enlace de invitación? (?sala=ABC12)
  try {
    const params = new URLSearchParams(location.search);
    const sala = String(params.get('sala') || params.get('room') || '')
      .toUpperCase()
      .trim();
    if (/^[A-Z0-9]{4,8}$/.test(sala)) {
      autoJoinCode = sala;
      $('#inputCode').value = sala;
      if (!$('#inputName').value) $('#inputName').value = '';
    }
  } catch {
    /* sin URL */
  }

  initEvents();
  renderAll();
  connect();
}

document.addEventListener('DOMContentLoaded', init);

/* Permite testear la lógica pura desde Node sin DOM. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { canPlaceLocal, generateFleetLocal, validateLocal, shipCellsOf, expectedFleet };
}
