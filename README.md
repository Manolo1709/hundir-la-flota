# ⚓ Hundir la Flota — online multijugador

Juego de **Hundir la Flota** para navegador, con servidor propio y salas por código.
Soporta **1 vs 1**, **1 vs 1 vs 1**, **1 vs 1 vs 1 vs 1** y **2 vs 2**.

- Sin frameworks ni build: HTML + CSS + JavaScript puro en el cliente.
- Node.js + WebSockets (`ws`) en el servidor, con la **lógica de juego autoritativa**
  (el cliente solo envía intenciones: nunca se puede hacer trampa editando el navegador).

---

## 🚀 Puesta en marcha

```bash
npm install
npm start
```

Abre <http://localhost:3000>

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `HOST` | `0.0.0.0` | Interfaz de escucha (visible en la red local) |
| `PUBLIC_URL` | _(vacía)_ | URL pública base de los enlaces de invitación. Si no está, se lee `public/public-url.txt` (lo escribe `npm run share`) y, si tampoco, manda la URL con la que abre el jugador |

### Tests

```bash
npm test
```

1. `test/ids.js` — coherencia HTML/CSS/JS (que todos los IDs que usa el JS existan).
2. `test/sim.js` — simula por WebSocket partidas completas de los 4 modos,
   errores de reglas, reconexión y el enlace `?sala=`.
3. `test/dom.js` — **el cliente real** (`public/client.js`) corriendo en jsdom:
   4 ventanas juegan dos partidas enteras clicando de verdad (crear, unirse por
   enlace, colocar, disparar, revancha y volver al lobby) y falla si el cliente
   lanza algún error. Necesita `npm install` (usa jsdom) y el servidor en marcha.

---

## 🕹️ Cómo se juega

1. **Crea una sala** (elige el modo) o **únete** con el código de  letras que aparece en pantalla.
2. Comparte el código: los demás entran con él. En modo **2v2** cada jugador
   elige equipo con el botón *"⇄ cambiar"*.
3. Cuando estén todos, el anfitrión pulsa **▶ Empezar**.
4. **Colocad la flota** (10 barcos en 10×10):
   1×4 (Acorazado), 2×3 (Crucero), 3×2 (Destructor), 4×1 (Lancha).
   Pulsa un barco de la lista, gíralo con **R**, y haz clic en el tablero.
   También hay botón **🎲 Automático**. Los barcos **no pueden tocarse, ni en diagonal**.
5. Pulsa **✅ Listo**. Cuando estén todos, empieza la batalla.
6. Por turnos disparas a una casilla de un rival: **💦 agua**, **🔥 tocado** o **💥 hundido**.
   Al hundir un barco se revelan todas sus casillas. Gana el último equipo (o jugador)
   con barcos a flote.

### Detalles de reglas

- **1v1 / 1v1v1 / 1v1v1v1**: todos contra todos; puedes disparar a cualquier rival vivo.
- **2v2**: solo puedes disparar al equipo contrario; dentro de cada equipo los
  compañeros **alternan** turno.
- Un jugador **eliminado** (sin barcos) deja de disparar y no puede ser objetivo.
- Si alguien se desconecta en mitad de la partida tiene **15 s de margen** para volver;
  si no, queda eliminado. En la sala (lobby) el margen es de 30 s (refrescar la página no te echa).

---

## 🏗️ Estructura

```
hundir-la-flota/
├── package.json
├── server/
│   ├── index.js     HTTP (estáticos) + WebSocket + enrutado de mensajes
│   ├── rooms.js     Salas, lobby, equipos, inicio y reinicio de partidas
│   └── game.js      Reglas: flota, colocación, disparos, turnos, victoria
├── public/
│   ├── index.html   Pantallas (inicio, sala, colocación, batalla)
│   ├── style.css    Estética tipo océano + tableros
│   └── client.js    Render de tableros, colocación y estado del juego
└── test/
    └── sim.js       Test de integración: partidas completas de los 4 modos
```

### Protocolo (JSON por WebSocket)

Cliente → servidor: `create`, `join`, `reconnect`, `leave`, `setMode`, `setTeam`,
`start`, `ready`, `unready`, `fire`, `playAgain`, `toLobby`, `listRooms`.

Servidor → cliente: `welcome`, `room`, `state`, `ships`, `shot`, `history`,
`rooms`, `error`, `leftRoom`.

El estado de cada tablero se reconstruye en cliente a partir de los eventos `shot`
(cada uno incluye turno, barcos restantes, jugadores vivos y registro).

---

## 🌐 Jugar online con amigos

### Botón «👥 Invitar jugadores» (dentro de la sala)

Al crear la sala aparece **👥 Invitar jugadores**, que genera y copia un enlace con el
código incrustado:

```
https://TU-DOMINIO/?sala=AB1CD
```

Quien abre ese enlace **entra directamente a la sala**, sin escribir nada. Si no tiene
nombre guardado, el servidor le asigna `Jugador-1234` (puede cambiarlo saliendo).

La base del enlace sale, por este orden, de:

1. La variable de entorno `PUBLIC_URL`.
2. El fichero `public/public-url.txt` (lo escribe `npm run share`).
3. La dirección con la que **tú** abres el juego.

👉 **Consejo**: abre el juego por la URL pública **antes** de crear la sala y el enlace de
invitación saldrá correcto.

### Un solo comando: `npm run share`

```powershell
npm run share   # servidor + túnel público + enlace listo para copiar
```

`scripts/share.js` descarga cloudflared si falta (sin instalar, sin cuenta), arranca el
servidor si no está en marcha, abre el túnel y escribe la URL en `public/public-url.txt`.
Deja esa ventana abierta: si la cierras, se corta el túnel (la URL cambia en cada arranque).

> ⚠️ **Redes corporativas**: muchos filtros bloquean los túneles. Cloudflare, por ejemplo,
> necesita resolver `argotunnel.com` y una DNS con secuestro interno lo impide. Si el
> túnel no arranca en tu red, usa alguna de las opciones de abajo.

### Otras opciones

- **Misma red (casa/oficina)**: el servidor escucha en `0.0.0.0`, basta con que los demás
  abran `http://TU_IP_LOCAL:3000` (habilita el puerto 3000 en el firewall).
- **Tailscale Funnel** (si ya lo usas): `tailscale funnel --bg localhost:3000` → URL
  pública `https://TU-MAQUINA.ts.net`. Puede requerir habilitar Funnel en el ACL del tailnet.
- **Despliegue permanente**: sube la carpeta a un VPS / [Render](https://render.com) /
  [Railway](https://railway.app) (Node 18+) y define `PUBLIC_URL=https://tudominio`.

---

## ✅ Ideas para mejorar

- Reincorporación de espectadores y vista de observador.
- Barcos con forma (submarino, portaaviones) y potenciadores (radar, doble disparo).
- Chat en la sala, sonidos y animaciones de explosión.
- Posición de tiro en diagonal desde el último impacto ("regla del radar").
- Ranking/estadísticas por sala.
