// Labyrinth, Bewegung, Regeln und Bots. Start: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMaze, hWall, vWall, castRay, canSee, cellAt, pathDist } from '../js/maze.js';
import { newBody, stepBody, packInput, IDLE } from '../js/physics.js';
import { createSim, startRound, stepSim, preyOf, hunterOf, PHASE, ranking } from '../js/sim.js';
import { createBot } from '../js/bots.js';
import { makeRng } from '../js/rng.js';
import {
  HIT_R, WALK_SPEED, SPRINT_SPEED, DT, TICK_RATE, COUNTDOWN_TICKS, SHIELD_TICKS, CATCH_DIST,
  SPRINT_SECONDS, MAZE_W, MAZE_H,
} from '../js/config.js';

// Kleinster Abstand der Figur zu irgendeiner Hecke
function clearance(m, x, y) {
  let best = Infinity;
  for (const s of m.segments) {
    const qx = Math.min(Math.max(x, s.x1), s.x2);
    const qy = Math.min(Math.max(y, s.y1), s.y2);
    best = Math.min(best, Math.hypot(x - qx, y - qy));
  }
  return best;
}

// Handgebautes Labyrinth aus Text: '#' ist eine Hecke, alles andere frei.
// Jede zweite Zeile/Spalte steht für eine Kante.
function mazeFromText(rows) {
  const H = (rows.length - 1) / 2;
  const W = (rows[0].length - 1) / 2;
  const m = { W, H, N: W * H, h: new Uint8Array((H + 1) * W), v: new Uint8Array(H * (W + 1)) };
  for (let y = 0; y <= H; y += 1) for (let x = 0; x < W; x += 1) m.h[y * W + x] = rows[y * 2][x * 2 + 1] === '#' ? 1 : 0;
  for (let y = 0; y < H; y += 1) for (let x = 0; x <= W; x += 1) m.v[y * (W + 1) + x] = rows[y * 2 + 1][x * 2] === '#' ? 1 : 0;
  m.segments = [];
  for (let y = 0; y <= H; y += 1) for (let x = 0; x < W; x += 1) if (hWall(m, x, y)) m.segments.push({ x1: x, y1: y, x2: x + 1, y2: y });
  for (let y = 0; y < H; y += 1) for (let x = 0; x <= W; x += 1) if (vWall(m, x, y)) m.segments.push({ x1: x, y1: y, x2: x, y2: y + 1 });
  return m;
}

test('Labyrinth: gleicher Startwert, gleiches Labyrinth', () => {
  const a = buildMaze(12345);
  const b = buildMaze(12345);
  const c = buildMaze(12346);
  assert.deepEqual(a.h, b.h);
  assert.deepEqual(a.v, b.v);
  assert.notDeepEqual([...a.h, ...a.v], [...c.h, ...c.v]);
});

test('Labyrinth: zusammenhängend, spiegelgleich, ohne Sackgassen', () => {
  let junctions = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    const m = buildMaze(seed * 7919);
    assert.equal(m.W, MAZE_W);
    assert.equal(m.H, MAZE_H);
    for (let x = 0; x < m.W; x += 1) assert.ok(hWall(m, x, 0) && hWall(m, x, m.H), 'Rand oben/unten');
    for (let y = 0; y < m.H; y += 1) assert.ok(vWall(m, 0, y) && vWall(m, m.W, y), 'Rand links/rechts');
    for (let i = 0; i < m.N * m.N; i += 1) assert.ok(m.dist[i] < 255, `Startwert ${seed}: nicht zusammenhängend`);
    for (let c = 0; c < m.N; c += 1) {
      assert.ok(m.nbr[c].length >= 2, `Startwert ${seed}: Sackgasse in Feld ${c}`);
      if (m.nbr[c].length >= 3) junctions += 1;
    }
    for (let y = 0; y <= m.H; y += 1) for (let x = 0; x < m.W; x += 1) assert.equal(hWall(m, x, y), hWall(m, m.W - 1 - x, y));
    for (let y = 0; y < m.H; y += 1) for (let x = 0; x <= m.W; x += 1) assert.equal(vWall(m, x, y), vWall(m, m.W - x, y));
  }
  const share = junctions / (300 * MAZE_W * MAZE_H);
  assert.ok(share > 0.2 && share < 0.6, `Anteil Kreuzungen ${share.toFixed(2)}`);
});

test('Sicht: Strahlen enden an Hecken', () => {
  const m = mazeFromText([
    '#######',
    '#     #',
    '# ### #',
    '#     #',
    '#######',
  ]);
  assert.ok(Math.abs(castRay(m, 0.5, 0.5, 1, 0, 99) - 2.5) < 1e-9);
  assert.ok(Math.abs(castRay(m, 1.5, 0.5, 0, 1, 99) - 0.5) < 1e-9);
  assert.ok(Math.abs(castRay(m, 0.5, 0.5, 0, 1, 99) - 1.5) < 1e-9);
  assert.equal(castRay(m, 0.5, 0.5, 1, 0, 1.25), 1.25);
  assert.equal(canSee(m, 1.5, 0.5, 1.5, 1.5, 9), false);
  assert.equal(canSee(m, 0.5, 0.5, 0.5, 1.5, 9), true);
  assert.equal(canSee(m, 0.5, 0.5, 2.5, 0.5, 1), false, 'zu weit weg');
});

test('Bewegung: niemand kommt durch eine Hecke', () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const m = buildMaze(seed * 104729);
    const rng = makeRng(seed);
    const b = newBody(0.5 + rng.int(m.W), 0.5 + rng.int(m.H));
    let code = IDLE;
    let travelled = 0;
    for (let t = 0; t < 12000; t += 1) {
      if (t % 14 === 0) code = packInput(rng.int(3) - 1, rng.int(3) - 1, rng() < 0.4);
      const px = b.x;
      const py = b.y;
      stepBody(m, b, code);
      travelled += Math.hypot(b.x - px, b.y - py);
      assert.ok(clearance(m, b.x, b.y) >= HIT_R - 1e-6, `Startwert ${seed}, Schritt ${t}: in der Hecke`);
      assert.ok(Math.hypot(b.vx, b.vy) <= SPRINT_SPEED + 1e-9, 'zu schnell');
      assert.ok(Math.hypot(b.x - px, b.y - py) <= SPRINT_SPEED * DT * 1.05, 'Sprung');
      assert.ok(b.st >= 0 && b.st <= 1);
    }
    assert.ok(travelled > 150, `Startwert ${seed}: kaum bewegt (${travelled.toFixed(0)} Felder)`);
  }
});

test('Bewegung: schräg an der Hecke entlang ohne Tempoverlust', () => {
  const m = mazeFromText([
    '#############',
    '#           #',
    '#############',
  ]);
  const b = newBody(0.5, 0.5);
  for (let t = 0; t < 60; t += 1) stepBody(m, b, packInput(1, -1, false));
  assert.ok(Math.abs(b.vx - WALK_SPEED) < 0.01, `Tempo ${b.vx.toFixed(2)}`);
  assert.ok(b.x > 0.5 + WALK_SPEED * 0.9);
});

test('Bewegung: Eckenhilfe führt in den Durchgang', () => {
  //  Gang unten, Abzweig nach oben über dem mittleren Feld
  const rows = [
    '#######',
    '# # # #',
    '### ###',
    '#     #',
    '#######',
  ];
  const m = mazeFromText(rows);
  // zu früh und zu spät abgebogen, jeweils nur "hoch" gedrückt
  for (const startX of [1.1, 1.25, 1.75, 1.9]) {
    const b = newBody(startX, 1.5);
    for (let t = 0; t < 45; t += 1) stepBody(m, b, packInput(0, -1, false));
    assert.ok(b.y < 0.9, `von x=${startX}: hängt bei y=${b.y.toFixed(2)}`);
  }
  // weit weg vom Durchgang bleibt man einfach stehen
  const far = newBody(0.5, 1.5);
  for (let t = 0; t < 45; t += 1) stepBody(m, far, packInput(0, -1, false));
  assert.ok(far.y > 1.3 && Math.abs(far.x - 0.5) < 0.05);
  // im Lauf abbiegen: rechts halten, kurz vor dem Abzweig zusätzlich hoch
  const run = newBody(0.5, 1.5);
  for (let t = 0; t < 6; t += 1) stepBody(m, run, packInput(1, 0, false));
  for (let t = 0; t < 50; t += 1) stepBody(m, run, packInput(1, -1, false));
  assert.ok(run.y < 0.9, `im Lauf: y=${run.y.toFixed(2)}`);
});

test('Bewegung: niemand bleibt an einem Heckenende hängen', () => {
  // Vom Feld oben links geht es nach rechts und nach unten, dazwischen steht eine Ecke.
  const m = mazeFromText([
    '#######',
    '#     #',
    '# ### #',
    '# # # #',
    '#######',
  ]);
  // genau schräg auf die Ecke zu, aus der Feldmitte und leicht versetzt
  for (const [sx, sy] of [[0.5, 0.5], [0.52, 0.5], [0.5, 0.53], [0.45, 0.6]]) {
    const b = newBody(sx, sy);
    for (let t = 0; t < 40; t += 1) stepBody(m, b, packInput(1, 1, false));
    const gone = Math.hypot(b.x - sx, b.y - sy);
    assert.ok(gone > 0.8, `von (${sx}, ${sy}): nur ${gone.toFixed(2)} Felder weit gekommen`);
  }
  // geradeaus auf das Ende einer Hecke zu, die in Laufrichtung weitergeht
  const end = mazeFromText([
    '#########',
    '#       #',
    '#   ### #',
    '#       #',
    '#########',
  ]);
  const b = newBody(0.5, 1.0);
  for (let t = 0; t < 70; t += 1) stepBody(end, b, packInput(1, 0, false));
  assert.ok(b.x > 2.5, `geradeaus: hängt bei x=${b.x.toFixed(2)}`);
});

test('Bewegung: Sprint kostet Ausdauer und erholt sich', () => {
  const m = mazeFromText(['#' + '##'.repeat(40), '#' + '  '.repeat(39) + ' #', '#' + '##'.repeat(40)]);
  const b = newBody(0.5, 0.5);
  let sprintTicks = 0;
  for (let t = 0; t < 400 && !b.ex; t += 1) {
    stepBody(m, b, packInput(1, 0, true));
    sprintTicks += 1;
  }
  assert.ok(Math.abs(sprintTicks / TICK_RATE - SPRINT_SECONDS) < 0.05, `Sprintdauer ${sprintTicks}`);
  stepBody(m, b, packInput(1, 0, true));
  assert.equal(b.sp, false, 'leer gesprintet heißt gehen');
  for (let t = 0; t < 20 * TICK_RATE; t += 1) stepBody(m, b, IDLE);
  assert.equal(b.st, 1);
  assert.equal(b.ex, false);
});

test('Regeln: Fangen gibt einen Punkt, kostet einen und setzt die Beute weit weg', () => {
  const sim = createSim();
  startRound(sim, 4242, 60);
  assert.equal(sim.phase, PHASE.COUNTDOWN);
  const idle = [[IDLE], [IDLE], [IDLE]];
  const before = sim.players.map((p) => ({ x: p.body.x, y: p.body.y }));
  for (let t = 0; t < COUNTDOWN_TICKS; t += 1) stepSim(sim, [[packInput(1, 0, true)], [IDLE], [IDLE]]);
  assert.equal(sim.phase, PHASE.PLAY);
  assert.ok(Math.abs(sim.players[0].body.x - before[0].x) < 0.2, 'im Countdown bewegt sich niemand');

  const hunter = sim.players[0];
  const prey = sim.players[preyOf(sim.ringDir, 0)];
  const third = sim.players[hunterOf(sim.ringDir, 0)];
  assert.notEqual(prey.slot, third.slot);
  assert.equal(preyOf(sim.ringDir, third.slot), 0, 'der Dritte jagt mich');
  assert.equal(preyOf(sim.ringDir, prey.slot), third.slot, 'meine Beute jagt den Dritten');

  // Der Dritte läuft seinem eigenen Jäger in die Arme: Punkt für den Jäger.
  third.body.x = prey.body.x;
  third.body.y = prey.body.y;
  stepSim(sim, idle);
  assert.equal(prey.score, 1);
  assert.equal(third.score, -1);
  assert.equal(hunter.score, 0);

  const tp = prey.tp;
  hunter.body.x = prey.body.x + CATCH_DIST * 0.9;
  hunter.body.y = prey.body.y;
  stepSim(sim, idle);
  assert.equal(hunter.score, 1);
  assert.equal(prey.score, 0);
  assert.equal(third.score, -1);
  assert.equal(prey.tp, tp + 1);
  assert.equal(prey.shield, SHIELD_TICKS - 1);
  const m = sim.maze;
  const far = pathDist(m, cellAt(m, prey.body.x, prey.body.y), cellAt(m, hunter.body.x, hunter.body.y));
  assert.ok(far >= 8, `Wiedereinstieg nur ${far} Felder entfernt`);
  assert.equal(sim.events.length, 2);

  // Schonfrist: sofort wieder berühren zählt nicht
  hunter.body.x = prey.body.x;
  hunter.body.y = prey.body.y;
  stepSim(sim, idle);
  assert.equal(hunter.score, 1);
});

test('Regeln: Runde endet pünktlich, Rangfolge stimmt', () => {
  const sim = createSim();
  startRound(sim, 99, 2);
  const idle = [[IDLE], [IDLE], [IDLE]];
  let ticks = 0;
  while (sim.phase !== PHASE.END && ticks < 10000) {
    stepSim(sim, idle);
    ticks += 1;
  }
  assert.equal(ticks, COUNTDOWN_TICKS + 2 * TICK_RATE);
  assert.deepEqual(ranking([1, -2, 1]).map((r) => r.slot), [0, 2, 1]);
});

test('Bots: jagen, fliehen und fangen sich gegenseitig', () => {
  let catches = 0;
  for (let seed = 1; seed <= 6; seed += 1) {
    const sim = createSim();
    startRound(sim, seed * 31337, 120);
    const bots = [0, 1, 2].map((slot) => createBot(slot, seed));
    const moved = [0, 0, 0];
    while (sim.phase !== PHASE.END) {
      const inputs = sim.phase === PHASE.PLAY ? bots.map((bot) => [bot.think(sim)]) : [[IDLE], [IDLE], [IDLE]];
      const before = sim.players.map((p) => [p.body.x, p.body.y, p.tp]);
      stepSim(sim, inputs);
      sim.players.forEach((p, i) => {
        if (p.tp === before[i][2]) moved[i] += Math.hypot(p.body.x - before[i][0], p.body.y - before[i][1]);
      });
    }
    const total = sim.players.reduce((sum, p) => sum + p.score, 0);
    assert.equal(total, 0, 'Punkte gleichen sich aus');
    catches += sim.nextEvent - 1;
    for (const dist of moved) assert.ok(dist > 120, `Startwert ${seed}: Bot kaum bewegt (${dist.toFixed(0)})`);
  }
  assert.ok(catches >= 6, `nur ${catches} Fänge in 6 Runden`);
});
