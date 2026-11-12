// Bewegung einer Figur für genau einen Schritt. Der Gastgeber rechnet damit
// den gültigen Stand, jedes Gerät damit die eigene Figur voraus. Beide müssen
// auf dieselben Zahlen kommen, deshalb hier nur Grundrechenarten und Wurzeln.

import {
  DT, HIT_R, WALK_SPEED, SPRINT_SPEED, ACCEL, REGEN_SECONDS, REGEN_DELAY, RECOVER_AT, DEFAULT_RULES,
} from './config.js';

const DIAG = 0.7071067811865476;
const PROBE = 0.06;
const R2 = HIT_R * HIT_R;
const MIN_RUN = WALK_SPEED * DT * 0.3;

export function newBody(x, y) {
  return { x, y, vx: 0, vy: 0, st: 1, ex: false, rw: 0, sp: false, hot: false };
}

export function copyBody(from, to = {}) {
  to.x = from.x;
  to.y = from.y;
  to.vx = from.vx;
  to.vy = from.vy;
  to.st = from.st;
  to.ex = from.ex;
  to.rw = from.rw;
  to.sp = from.sp;
  to.hot = from.hot;
  return to;
}

// Eingabe als eine Zahl: Richtung links/rechts, hoch/runter und Sprint.
export const packInput = (mx, my, sprint) => (mx + 1) + 3 * (my + 1) + (sprint ? 9 : 0);
export const IDLE = packInput(0, 0, false);
export const inputX = (code) => (code % 3) - 1;
export const inputY = (code) => (Math.floor(code / 3) % 3) - 1;
export const inputSprint = (code) => code >= 9;

// Schiebt den Punkt o aus allen Hecken in der Nähe heraus. Ist `body` gesetzt,
// verliert es dabei das Tempo, das in die Hecke hinein zeigt.
function pushOut(m, o, body) {
  for (let pass = 0; pass < 4; pass += 1) {
    let moved = false;
    const cx = Math.floor(o.x);
    const cy = Math.floor(o.y);
    for (let ly = cy; ly <= cy + 1; ly += 1) {
      if (ly < 0 || ly > m.H) continue;
      for (let x = cx - 1; x <= cx + 1; x += 1) {
        if (x < 0 || x >= m.W || !m.h[ly * m.W + x]) continue;
        const qx = o.x < x ? x : o.x > x + 1 ? x + 1 : o.x;
        if (pushFrom(m, o, qx, ly, body)) moved = true;
      }
    }
    for (let lx = cx; lx <= cx + 1; lx += 1) {
      if (lx < 0 || lx > m.W) continue;
      for (let y = cy - 1; y <= cy + 1; y += 1) {
        if (y < 0 || y >= m.H || !m.v[y * (m.W + 1) + lx]) continue;
        const qy = o.y < y ? y : o.y > y + 1 ? y + 1 : o.y;
        if (pushFrom(m, o, lx, qy, body)) moved = true;
      }
    }
    if (!moved) break;
  }
}

function pushFrom(m, o, qx, qy, body) {
  const dx = o.x - qx;
  const dy = o.y - qy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= R2) return false;
  let nx;
  let ny;
  if (d2 < 1e-18) {
    // genau auf der Hecke: zur Mitte des Labyrinths hin ausweichen
    nx = qx < m.W / 2 ? 1 : -1;
    ny = 0;
    if (qy <= 0 || qy >= m.H) {
      nx = 0;
      ny = qy <= 0 ? 1 : -1;
    }
  } else {
    const d = Math.sqrt(d2);
    nx = dx / d;
    ny = dy / d;
  }
  o.x = qx + nx * HIT_R;
  o.y = qy + ny * HIT_R;
  if (body) {
    const into = body.vx * nx + body.vy * ny;
    if (into < 0) {
      body.vx -= nx * into;
      body.vy -= ny * into;
    }
  }
  return true;
}

const probe = { x: 0, y: 0 };

// Wie gut kommt man von (x, y) aus in Richtung (dx, dy) voran? 1 heißt frei,
// 0 heißt gar nicht. (dx, dy) hat die Länge 1.
function progress(m, x, y, dx, dy) {
  probe.x = x + dx * PROBE;
  probe.y = y + dy * PROBE;
  pushOut(m, probe, null);
  return ((probe.x - x) * dx + (probe.y - y) * dy) / PROBE;
}
const STUCK = 0.35;
const isBlocked = (m, x, y, dx, dy) => progress(m, x, y, dx, dy) < STUCK;

// Eckenhilfe: Wer knapp neben einem Durchgang gegen die Hecke läuft, wird
// seitlich hineingeschoben. Liefert -1, 0 oder 1 für die Seite.
function sidestep(m, b, dx, dy) {
  const lx = dy !== 0 ? 1 : 0;
  const ly = dx !== 0 ? 1 : 0;
  const drift = b.vx * lx + b.vy * ly;
  const first = drift < 0 ? -1 : 1;
  for (let k = 1; k <= 5; k += 1) {
    const s = k * 0.08;
    for (let pick = 0; pick < 2; pick += 1) {
      const side = pick === 0 ? first : -first;
      const px = b.x + lx * s * side;
      const py = b.y + ly * s * side;
      probe.x = px;
      probe.y = py;
      pushOut(m, probe, null);
      const off = Math.abs(probe.x - px) + Math.abs(probe.y - py);
      if (off < 0.01 && !isBlocked(m, px, py, dx, dy)) return side;
    }
  }
  return 0;
}

// `rules` sind die Regeln der Runde (Tempo, Jagdfieber, Ausdauer).
export function stepBody(m, b, code, rules = DEFAULT_RULES) {
  let wx = inputX(code);
  let wy = inputY(code);
  if (wx !== 0 && wy !== 0) {
    // Schräg gegen eine Hecke: mit vollem Tempo an ihr entlang
    const px = progress(m, b.x, b.y, wx, 0);
    const py = progress(m, b.x, b.y, 0, wy);
    if (px < STUCK && py >= STUCK) wx = 0;
    else if (py < STUCK && px >= STUCK) wy = 0;
    else if (px >= STUCK && py >= STUCK && progress(m, b.x, b.y, wx * DIAG, wy * DIAG) < STUCK) {
      // Genau auf ein Heckenende zu: auf der näheren Seite herum, statt zu hängen
      if (px > py + 1e-9) wy = 0;
      else if (py > px + 1e-9) wx = 0;
      else if (Math.abs(b.vy) > Math.abs(b.vx)) wx = 0;
      else wy = 0;
    }
  } else if ((wx !== 0 || wy !== 0) && isBlocked(m, b.x, b.y, wx, wy)) {
    const side = sidestep(m, b, wx, wy);
    if (side !== 0) {
      if (wx !== 0) {
        wx = 0;
        wy = side;
      } else {
        wy = 0;
        wx = side;
      }
    }
  }

  const moving = wx !== 0 || wy !== 0;
  const sprinting = inputSprint(code) && moving && !b.ex && b.st > 0;
  const speed = (sprinting ? SPRINT_SPEED : WALK_SPEED) * rules.speed * (b.hot ? rules.huntBoost : 1) * (wx !== 0 && wy !== 0 ? DIAG : 1);
  b.vx += (wx * speed - b.vx) * ACCEL;
  b.vy += (wy * speed - b.vy) * ACCEL;
  if (!moving && b.vx * b.vx + b.vy * b.vy < 1e-4) {
    b.vx = 0;
    b.vy = 0;
  }
  const fromX = b.x;
  const fromY = b.y;
  b.x += b.vx * DT;
  b.y += b.vy * DT;
  pushOut(m, b, b);

  // Wer gegen eine Hecke drückt, kommt nicht voran und verbraucht auch nichts.
  const dx = b.x - fromX;
  const dy = b.y - fromY;
  const minRun = MIN_RUN * rules.speed;
  const running = sprinting && dx * dx + dy * dy > minRun * minRun;
  if (running) {
    b.st -= DT / rules.sprintSeconds;
    b.rw = REGEN_DELAY;
    if (b.st <= 0) {
      b.st = 0;
      b.ex = true;
    }
  } else {
    if (b.rw > 0) b.rw -= 1;
    else if (b.st < 1) b.st = Math.min(1, b.st + DT / REGEN_SECONDS);
    if (b.ex && b.st >= RECOVER_AT) b.ex = false;
  }
  b.sp = running;
  return b;
}
