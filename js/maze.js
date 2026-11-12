// Das Labyrinth: ein Raster aus Feldern mit dünnen Hecken auf den Kanten.
//
//   h[y * W + x]        Hecke an der Oberkante von Feld (x, y), y von 0 bis H
//   v[y * (W + 1) + x]  Hecke an der linken Kante von Feld (x, y), x von 0 bis W
//
// Aus einem Startwert entsteht immer dasselbe Labyrinth. Es ist spiegelgleich,
// hat keine Sackgassen und viele Rundwege, damit niemand in der Falle sitzt.

import { makeRng } from './rng.js';
import { MAZE_W, MAZE_H } from './config.js';

const SIDES = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export function buildMaze(seed, W = MAZE_W, H = MAZE_H) {
  const rng = makeRng(seed);
  const h = new Uint8Array((H + 1) * W).fill(1);
  const v = new Uint8Array(H * (W + 1)).fill(1);
  const half = W / 2;

  // Kante zwischen Feld (x, y) und seinem Nachbarn auf Seite d
  const edge = (x, y, d) => {
    if (d === 0) return [h, y * W + x];
    if (d === 2) return [h, (y + 1) * W + x];
    if (d === 3) return [v, y * (W + 1) + x];
    return [v, y * (W + 1) + x + 1];
  };
  const isOpen = (x, y, d) => {
    const [arr, i] = edge(x, y, d);
    return !arr[i];
  };
  const setOpen = (x, y, d) => {
    const [arr, i] = edge(x, y, d);
    arr[i] = 0;
  };
  // Zahl der Hecken, die an einem Gitterpunkt zusammentreffen. Rechts der Naht
  // steht noch nichts, dort zählt das Spiegelbild.
  const postDegree = (px, py) => {
    let n = 0;
    if (px > 0 && h[py * W + px - 1]) n += 1;
    if (px < W && h[py * W + (px < half ? px : W - 1 - px)]) n += 1;
    if (py > 0 && v[(py - 1) * (W + 1) + px]) n += 1;
    if (py < H && v[py * (W + 1) + px]) n += 1;
    return n;
  };
  // Lässt das Entfernen der Hecke an beiden Enden noch etwas stehen?
  // Sonst entstünden kahle Plätze ohne Deckung.
  const keepsPosts = (x, y, d) => {
    const ends = d === 0 ? [[x, y], [x + 1, y]]
      : d === 2 ? [[x, y + 1], [x + 1, y + 1]]
        : d === 3 ? [[x, y], [x, y + 1]]
          : [[x + 1, y], [x + 1, y + 1]];
    return ends.every(([px, py]) => postDegree(px, py) >= 2);
  };
  // Innerhalb der linken Hälfte, die Naht zur rechten zählt mit
  const removable = (x, y, d) => {
    if (d === 0) return y > 0;
    if (d === 2) return y < H - 1;
    if (d === 3) return x > 0;
    return true;
  };
  const openCount = (x, y) => SIDES.reduce((n, _, d) => n + (isOpen(x, y, d) ? 1 : 0), 0);

  // 1. Linke Hälfte als zusammenhängendes Labyrinth aufbauen.
  const seen = new Uint8Array(half * H);
  const active = [[rng.int(half), rng.int(H)]];
  seen[active[0][1] * half + active[0][0]] = 1;
  while (active.length) {
    const at = rng() < 0.6 ? active.length - 1 : rng.int(active.length);
    const [x, y] = active[at];
    const options = [];
    for (let d = 0; d < 4; d += 1) {
      const nx = x + SIDES[d][0];
      const ny = y + SIDES[d][1];
      if (nx >= 0 && nx < half && ny >= 0 && ny < H && !seen[ny * half + nx]) options.push(d);
    }
    if (!options.length) {
      active.splice(at, 1);
      continue;
    }
    const d = rng.pick(options);
    setOpen(x, y, d);
    const nx = x + SIDES[d][0];
    const ny = y + SIDES[d][1];
    seen[ny * half + nx] = 1;
    active.push([nx, ny]);
  }

  // 2. Sackgassen öffnen.
  const cells = [];
  for (let y = 0; y < H; y += 1) for (let x = 0; x < half; x += 1) cells.push([x, y]);
  for (const [x, y] of rng.shuffle(cells.slice())) {
    while (openCount(x, y) < 2) {
      const closed = [0, 1, 2, 3].filter((d) => !isOpen(x, y, d) && removable(x, y, d));
      const gentle = closed.filter((d) => keepsPosts(x, y, d));
      setOpen(x, y, rng.pick(gentle.length ? gentle : closed));
    }
  }

  // 3. Ein paar zusätzliche Durchgänge für mehr Kreuzungen.
  for (const [x, y] of cells) {
    for (const d of [1, 2]) {
      if (!isOpen(x, y, d) && removable(x, y, d) && rng() < 0.12 && keepsPosts(x, y, d)) setOpen(x, y, d);
    }
  }

  // 4. Die Naht zur rechten Hälfte braucht genug Übergänge.
  const seamRows = () => {
    const rows = [];
    for (let y = 0; y < H; y += 1) if (!v[y * (W + 1) + half]) rows.push(y);
    return rows;
  };
  const order = rng.shuffle([...Array(H).keys()]);
  const wanted = Math.max(3, Math.round(H / 3));
  for (const y of order) {
    const rows = seamRows();
    if (rows.length >= wanted) break;
    if (rows.some((row) => Math.abs(row - y) < 2)) continue;
    v[y * (W + 1) + half] = 0;
  }
  if (seamRows().length === 0) v[order[0] * (W + 1) + half] = 0;

  // 5. Nach rechts spiegeln.
  for (let y = 0; y <= H; y += 1) {
    for (let x = 0; x < half; x += 1) h[y * W + (W - 1 - x)] = h[y * W + x];
  }
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < half; x += 1) v[y * (W + 1) + (W - x)] = v[y * (W + 1) + x];
  }

  const maze = { seed, W, H, N: W * H, h, v };
  maze.segments = mergeSegments(maze);
  maze.nbr = neighbours(maze);
  maze.dist = allDistances(maze);
  return maze;
}

export const hWall = (m, x, y) => m.h[y * m.W + x];
export const vWall = (m, x, y) => m.v[y * (m.W + 1) + x];
export const cellAt = (m, x, y) => Math.floor(y) * m.W + Math.floor(x);
export const cellX = (m, c) => c % m.W;
export const cellY = (m, c) => Math.floor(c / m.W);
export const pathDist = (m, a, b) => m.dist[a * m.N + b];

// Fasst aneinanderstoßende Heckenstücke zu langen Linien zusammen (fürs Zeichnen).
function mergeSegments(m) {
  const out = [];
  for (let y = 0; y <= m.H; y += 1) {
    let start = -1;
    for (let x = 0; x <= m.W; x += 1) {
      const on = x < m.W && hWall(m, x, y);
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        out.push({ x1: start, y1: y, x2: x, y2: y });
        start = -1;
      }
    }
  }
  for (let x = 0; x <= m.W; x += 1) {
    let start = -1;
    for (let y = 0; y <= m.H; y += 1) {
      const on = y < m.H && vWall(m, x, y);
      if (on && start < 0) start = y;
      if (!on && start >= 0) {
        out.push({ x1: x, y1: start, x2: x, y2: y });
        start = -1;
      }
    }
  }
  return out;
}

function neighbours(m) {
  const nbr = [];
  for (let y = 0; y < m.H; y += 1) {
    for (let x = 0; x < m.W; x += 1) {
      const list = [];
      if (!hWall(m, x, y)) list.push((y - 1) * m.W + x);
      if (!vWall(m, x + 1, y)) list.push(y * m.W + x + 1);
      if (!hWall(m, x, y + 1)) list.push((y + 1) * m.W + x);
      if (!vWall(m, x, y)) list.push(y * m.W + x - 1);
      nbr.push(list);
    }
  }
  return nbr;
}

// Weglänge in Feldern zwischen allen Feldpaaren
function allDistances(m) {
  const dist = new Uint8Array(m.N * m.N).fill(255);
  const queue = new Int32Array(m.N);
  for (let from = 0; from < m.N; from += 1) {
    const row = from * m.N;
    let head = 0;
    let tail = 0;
    queue[tail++] = from;
    dist[row + from] = 0;
    while (head < tail) {
      const c = queue[head++];
      const d = dist[row + c] + 1;
      for (const n of m.nbr[c]) {
        if (dist[row + n] === 255) {
          dist[row + n] = d;
          queue[tail++] = n;
        }
      }
    }
  }
  return dist;
}

// Strahl von (px, py) in Richtung (dx, dy). Liefert die Strecke bis zur ersten
// Hecke, höchstens maxT.
export function castRay(m, px, py, dx, dy, maxT) {
  let cx = Math.floor(px);
  let cy = Math.floor(py);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const deltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const deltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let nextX = dx !== 0 ? (dx > 0 ? cx + 1 - px : px - cx) * deltaX : Infinity;
  let nextY = dy !== 0 ? (dy > 0 ? cy + 1 - py : py - cy) * deltaY : Infinity;
  for (let guard = 0; guard < 200; guard += 1) {
    if (cx < 0 || cy < 0 || cx >= m.W || cy >= m.H) return Math.min(nextX, nextY, maxT);
    if (nextX < nextY) {
      if (nextX >= maxT) return maxT;
      if (vWall(m, stepX > 0 ? cx + 1 : cx, cy)) return nextX;
      cx += stepX;
      nextX += deltaX;
    } else {
      if (nextY >= maxT) return maxT;
      if (hWall(m, cx, stepY > 0 ? cy + 1 : cy)) return nextY;
      cy += stepY;
      nextY += deltaY;
    }
  }
  return maxT;
}

// Steht zwischen a und b keine Hecke (und sind sie höchstens `radius` auseinander)?
export function canSee(m, ax, ay, bx, by, radius) {
  const dx = bx - ax;
  const dy = by - ay;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > radius) return false;
  if (d < 1e-6) return true;
  return castRay(m, ax, ay, dx / d, dy / d, d) >= d - 1e-9;
}
