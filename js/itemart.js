// Symbole der Items: dieselben Pfade auf der Leinwand und in der Anzeige.
// Jedes Item steht in einer runden Plakette in seiner Farbe, das Zeichen
// darauf ist dunkel, damit es auf jeder Farbe gut lesbar ist.

import { ITEMS } from './config.js';

const INK = '#101a30';
const shapes = ITEMS.map((item) => ({
  fill: (item.icon.fill || []).map((d) => new Path2D(d)),
  line: (item.icon.line || []).map((d) => new Path2D(d)),
}));

// Plakette mit Zeichen, Mitte (x, y), Durchmesser `size`
export function drawBadge(ctx, index, x, y, size, alpha = 1) {
  const item = ITEMS[index];
  if (!item) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = item.color;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, size * 0.07);
  ctx.strokeStyle = INK;
  ctx.stroke();
  drawGlyph(ctx, index, x, y, size * 0.66, INK);
  ctx.restore();
}

// Nur das Zeichen, ohne Plakette
export function drawGlyph(ctx, index, x, y, size, color) {
  const shape = shapes[index];
  if (!shape) return;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  for (const path of shape.fill) ctx.fill(path);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  for (const path of shape.line) ctx.stroke(path);
  ctx.restore();
}

// Dasselbe als SVG für die Anzeige
export function glyphSvg(index) {
  const item = ITEMS[index];
  if (!item) return '';
  const fill = (item.icon.fill || []).map((d) => `<path d="${d}"/>`).join('');
  const line = (item.icon.line || []).map((d) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/>`).join('');
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${fill}${line}</svg>`;
}
