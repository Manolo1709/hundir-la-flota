'use strict';

/** Comprueba que todos los IDs usados en client.js existen en index.html. */
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

const idsUsed = new Set(
  [...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1])
);
const idsHtml = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

const missing = [...idsUsed].filter((i) => !idsHtml.has(i));
const unused = [...idsHtml].filter((i) => !idsUsed.has(i) && !js.includes(`#${i}`));

console.log(`IDs usados en JS: ${idsUsed.size} · IDs en HTML: ${idsHtml.size}`);
if (missing.length) {
  console.log(`FALTAN EN HTML: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('Todos los IDs del JS existen en el HTML ✓');
console.log(`IDs HTML referenciados solo por CSS/logos: ${unused.join(', ') || 'ninguno'}`);

// Clases de CSS que el JS añade a los tableros
const cssClasses = ['ship', 'hit', 'sunk', 'miss', 'preview', 'preview-bad', 'targetable', 'locked', 'me', 'dead', 'teammate', 'mine'];
const jsText = js;
const cssMissing = cssClasses.filter((c) => !css.includes(`.${c}`));
if (cssMissing.length) {
  console.log(`CLASES SIN ESTILO: ${cssMissing.join(', ')}`);
  process.exit(1);
}
console.log('Todas las clases de tablero tienen estilo ✓');
