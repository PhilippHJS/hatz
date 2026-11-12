// Labyrinth, Bewegung, Regeln und Bots. Start: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMaze, hWall, vWall, castRay, canSee, cellAt, pathDist } from '../js/maze.js';
import { newBody, stepBody, packInput, IDLE } from '../js/physics.js';
import { createSim, startRound, stepSim, preyOf, hunterOf, sees, PHASE, ranking } from '../js/sim.js';
import { createBot } from '../js/bots.js';
import { makeRng } from '../js/rng.js';
import {
  HIT_R, WALK_SPEED, SPRINT_SPEED, DT, TICK_RATE, COUNTDOWN_TICKS, SHIELD_TICKS, CATCH_DIST,
  SPRINT_SECONDS, MAZE_W, MAZE_H, RESPAWN_TICKS, VISION_RADIUS, HUNT_BOOST,
  SETTINGS, DEFAULT_LEVELS, DEFAULT_RULES, cleanLevels, rulesFor,
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

test('Hecken: Strahlen enden an ihnen', () => {
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

test('Regeln: Fangen gibt einen Punkt, kostet einen, dann drei Sekunden Auszeit', () => {
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
  const tp = third.tp;
  stepSim(sim, idle);
  const caughtAt = sim.tick;
  assert.equal(prey.score, 1);
  assert.equal(third.score, -1);
  assert.equal(hunter.score, 0);
  assert.equal(third.dead, RESPAWN_TICKS, 'der Gefangene setzt aus');
  assert.equal(third.tp, tp, 'und bleibt erst einmal, wo er ist');
  assert.equal(sim.events.length, 1);

  // Wer aussetzt, wird nicht noch einmal gefangen ...
  stepSim(sim, idle);
  assert.equal(prey.score, 1);
  // ... fängt selbst niemanden, auch wenn seine Beute direkt auf ihm steht ...
  prey.body.x = before[third.slot].x; // die Beute geht derweil woandershin
  prey.body.y = before[third.slot].y;
  hunter.body.x = third.body.x;
  hunter.body.y = third.body.y;
  stepSim(sim, idle);
  assert.equal(third.score, -1);
  assert.equal(hunter.score, 0);
  assert.equal(hunter.dead, 0);
  // ... und bewegt sich nicht.
  const spot = { x: third.body.x, y: third.body.y };
  const push = [[IDLE], [IDLE], [IDLE]];
  push[third.slot] = [packInput(1, 1, true)];
  for (let t = 0; t < 30; t += 1) stepSim(sim, push);
  assert.deepEqual({ x: third.body.x, y: third.body.y }, spot);

  // Nach genau drei Sekunden steigt er weit weg wieder ein, mit Schonfrist.
  while (third.dead > 0) stepSim(sim, idle);
  assert.equal(sim.tick - caughtAt, RESPAWN_TICKS);
  assert.equal(third.tp, tp + 1);
  assert.equal(third.shield, SHIELD_TICKS - 1);
  assert.equal(third.body.st, 1);
  const m = sim.maze;
  const here = cellAt(m, third.body.x, third.body.y);
  for (const other of [hunter, prey]) {
    const far = pathDist(m, here, cellAt(m, other.body.x, other.body.y));
    assert.ok(far >= 8, `Wiedereinstieg nur ${far} Felder von Platz ${other.slot} entfernt`);
  }

  // Schonfrist: sofort wieder berühren zählt nicht
  prey.body.x = third.body.x;
  prey.body.y = third.body.y;
  stepSim(sim, idle);
  assert.equal(prey.score, 1);
  assert.equal(third.dead, 0);
});

test('Regeln: Sichtkreis und Jagdfieber', () => {
  const sim = createSim();
  startRound(sim, 77, 60);
  const idle = [[IDLE], [IDLE], [IDLE]];
  for (let t = 0; t < COUNTDOWN_TICKS; t += 1) stepSim(sim, idle);
  const hunter = sim.players[0];
  const prey = sim.players[preyOf(sim.ringDir, 0)];
  const third = sim.players[hunterOf(sim.ringDir, 0)];
  // den Dritten aus dem Weg räumen
  third.body.x = hunter.body.x < MAZE_W / 2 ? MAZE_W - 0.5 : 0.5;
  third.body.y = hunter.body.y;
  // Beute knapp innerhalb des Kreises, egal ob Hecken dazwischen stehen
  const side = hunter.body.x < MAZE_W / 2 ? 1 : -1;
  prey.body.x = hunter.body.x + side * (VISION_RADIUS - 0.1);
  prey.body.y = hunter.body.y;
  assert.equal(sees(hunter, prey, VISION_RADIUS), true);
  assert.equal(sees(prey, hunter, VISION_RADIUS), true, 'Sicht gilt in beide Richtungen');
  stepSim(sim, idle);
  assert.equal(hunter.body.hot, true, 'Beute im Sichtkreis: Jagdfieber');
  assert.equal(prey.body.hot, false, 'der Gejagte wird davon nicht schneller');
  // knapp außerhalb
  prey.body.x = hunter.body.x + side * (VISION_RADIUS + 0.1);
  assert.equal(sees(hunter, prey, VISION_RADIUS), false);
  stepSim(sim, idle);
  assert.equal(hunter.body.hot, false);
  // geschützte oder aussetzende Beute zählt nicht
  prey.body.x = hunter.body.x + side * 2;
  prey.shield = 50;
  stepSim(sim, idle);
  assert.equal(hunter.body.hot, false);
  prey.shield = 0;
  prey.dead = 20;
  assert.equal(sees(hunter, prey, VISION_RADIUS), false, 'wer aussetzt, ist nicht zu sehen');
  stepSim(sim, idle);
  assert.equal(hunter.body.hot, false);
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

// Stufen in der Reihenfolge von SETTINGS: Tempo, Sichtkreis, Labyrinth, Ausdauer, Auszeit, Jagdfieber
const levelsOf = (changes) => SETTINGS.map((setting) => (setting.key in changes ? changes[setting.key] : 1));

test('Einstellungen: Stufen werden zu Regeln', () => {
  assert.deepEqual(SETTINGS.map((setting) => setting.key), ['speed', 'vision', 'maze', 'stamina', 'respawn', 'fever']);
  for (const setting of SETTINGS) {
    assert.equal(setting.options.length, 3, setting.key);
    assert.equal(setting.values.length, 3, setting.key);
  }
  // Die mittlere Stufe ist das bisherige Spiel.
  assert.deepEqual(DEFAULT_RULES, {
    speed: 1, vision: VISION_RADIUS, mazeW: MAZE_W, mazeH: MAZE_H,
    sprintSeconds: SPRINT_SECONDS, respawnTicks: RESPAWN_TICKS, huntBoost: HUNT_BOOST,
  });
  const low = rulesFor(SETTINGS.map(() => 0));
  const high = rulesFor(SETTINGS.map(() => 2));
  for (const key of Object.keys(DEFAULT_RULES)) {
    assert.ok(low[key] < DEFAULT_RULES[key] && DEFAULT_RULES[key] < high[key], `${key}: ${low[key]} < ${DEFAULT_RULES[key]} < ${high[key]}`);
  }
  assert.equal(low.huntBoost, 1, 'Jagdfieber aus heißt kein Vorteil');
  // Unsinn von außen wird zur mittleren Stufe.
  assert.deepEqual(cleanLevels(undefined), DEFAULT_LEVELS);
  assert.deepEqual(cleanLevels([2, -1, 7, 'x', 1.5, 0, 2, 2]), [2, 1, 1, 1, 1, 0]);
  assert.deepEqual(rulesFor('quatsch'), DEFAULT_RULES);
});

test('Einstellungen: jede Labyrinthgröße ist zusammenhängend, spiegelgleich, ohne Sackgassen', () => {
  for (const [W, H] of SETTINGS.find((setting) => setting.key === 'maze').values) {
    assert.equal(W % 2, 0);
    for (let seed = 1; seed <= 60; seed += 1) {
      const m = buildMaze(seed * 7919, W, H);
      assert.equal(m.W, W);
      assert.equal(m.H, H);
      for (let i = 0; i < m.N * m.N; i += 1) assert.ok(m.dist[i] < 255, `${W}x${H}, Startwert ${seed}: nicht zusammenhängend`);
      for (let c = 0; c < m.N; c += 1) assert.ok(m.nbr[c].length >= 2, `${W}x${H}, Startwert ${seed}: Sackgasse`);
      for (let y = 0; y < m.H; y += 1) for (let x = 0; x <= m.W; x += 1) assert.equal(vWall(m, x, y), vWall(m, m.W - x, y));
    }
  }
});

test('Einstellungen: Tempo wirkt auf Gehen und Sprinten, Hecken halten auch beim schnellsten', () => {
  const lane = mazeFromText(['#' + '##'.repeat(40), '#' + '  '.repeat(39) + ' #', '#' + '##'.repeat(40)]);
  const run = (rules, sprint) => {
    const b = newBody(0.5, 0.5);
    for (let t = 0; t < 60; t += 1) stepBody(lane, b, packInput(1, 0, sprint), rules);
    return b.vx;
  };
  for (const level of [0, 1, 2]) {
    const rules = rulesFor(levelsOf({ speed: level }));
    assert.ok(Math.abs(run(rules, false) - WALK_SPEED * rules.speed) < 0.01, `Gehen auf Stufe ${level}`);
    assert.ok(Math.abs(run(rules, true) - SPRINT_SPEED * rules.speed) < 0.01, `Sprinten auf Stufe ${level}`);
  }
  // Ausdauer reicht je nach Stufe unterschiedlich lange
  for (const level of [0, 1, 2]) {
    const rules = rulesFor(levelsOf({ stamina: level }));
    const b = newBody(0.5, 0.5);
    let ticks = 0;
    while (!b.ex && ticks < 600) {
      stepBody(lane, b, packInput(1, 0, true), rules);
      if (b.x > 30) b.x = 1;
      ticks += 1;
    }
    assert.ok(Math.abs(ticks / TICK_RATE - rules.sprintSeconds) < 0.05, `Ausdauer Stufe ${level}: ${ticks} Schritte`);
  }
  // schnellste Runde: Tempo schnell, Jagdfieber stark, Beute dauernd im Blick
  const fast = rulesFor(levelsOf({ speed: 2, fever: 2, stamina: 2 }));
  const top = SPRINT_SPEED * fast.speed * fast.huntBoost;
  for (let seed = 1; seed <= 6; seed += 1) {
    const m = buildMaze(seed * 104729, 24, 14);
    const rng = makeRng(seed);
    const b = newBody(0.5 + rng.int(m.W), 0.5 + rng.int(m.H));
    let code = IDLE;
    let fastest = 0;
    for (let t = 0; t < 12000; t += 1) {
      if (t % 11 === 0) code = packInput(rng.int(3) - 1, rng.int(3) - 1, rng() < 0.7);
      b.hot = true;
      stepBody(m, b, code, fast);
      fastest = Math.max(fastest, Math.hypot(b.vx, b.vy));
      assert.ok(clearance(m, b.x, b.y) >= HIT_R - 1e-6, `Startwert ${seed}, Schritt ${t}: in der Hecke`);
    }
    assert.ok(fastest > top * 0.97 && fastest <= top + 1e-9, `Spitzentempo ${fastest.toFixed(2)} von ${top.toFixed(2)}`);
  }
});

test('Einstellungen: gelten für die Runde, mit der sie gestartet wurde', () => {
  const sim = createSim();
  const levels = levelsOf({ vision: 0, maze: 0, respawn: 0, fever: 2 });
  startRound(sim, 2024, 60, levels);
  assert.equal(sim.maze.W, 16);
  assert.equal(sim.maze.H, 10);
  assert.deepEqual(sim.levels, levels);
  const idle = [[IDLE], [IDLE], [IDLE]];
  for (let t = 0; t < COUNTDOWN_TICKS; t += 1) stepSim(sim, idle);
  const hunter = sim.players[0];
  const prey = sim.players[preyOf(sim.ringDir, 0)];
  const third = sim.players[hunterOf(sim.ringDir, 0)];
  third.body.x = hunter.body.x < 8 ? 15.5 : 0.5;
  third.body.y = hunter.body.y;
  const side = hunter.body.x < 8 ? 1 : -1;
  // 3 Felder entfernt: im normalen Kreis sichtbar, im kleinen nicht
  prey.body.x = hunter.body.x + side * 3;
  prey.body.y = hunter.body.y;
  stepSim(sim, idle);
  assert.equal(hunter.body.hot, false, 'kleiner Sichtkreis reicht keine 3 Felder');
  prey.body.x = hunter.body.x + side * 2.4;
  stepSim(sim, idle);
  assert.equal(hunter.body.hot, true);
  // Fang: Auszeit dauert eine Sekunde
  prey.body.x = hunter.body.x;
  stepSim(sim, idle);
  assert.equal(prey.dead, TICK_RATE);
  let ticks = 0;
  while (prey.dead > 0) {
    stepSim(sim, idle);
    ticks += 1;
  }
  assert.equal(ticks, TICK_RATE);

  // Die nächste Runde kann andere Einstellungen haben.
  startRound(sim, 2025, 60);
  assert.equal(sim.maze.W, MAZE_W);
  assert.deepEqual(sim.rules, DEFAULT_RULES);
});

test('Einstellungen: Bots kommen mit jeder Stufe zurecht', () => {
  for (const setting of SETTINGS) {
    for (const level of [0, 2]) {
      const sim = createSim();
      startRound(sim, 555 + level, 60, levelsOf({ [setting.key]: level }));
      const bots = [0, 1, 2].map((slot) => createBot(slot, 9));
      const moved = [0, 0, 0];
      while (sim.phase !== PHASE.END) {
        const inputs = sim.phase === PHASE.PLAY ? bots.map((bot) => [bot.think(sim)]) : [[IDLE], [IDLE], [IDLE]];
        const before = sim.players.map((p) => [p.body.x, p.body.y, p.tp]);
        stepSim(sim, inputs);
        sim.players.forEach((p, i) => {
          if (p.tp === before[i][2]) moved[i] += Math.hypot(p.body.x - before[i][0], p.body.y - before[i][1]);
        });
      }
      assert.equal(sim.players.reduce((sum, p) => sum + p.score, 0), 0);
      for (const dist of moved) assert.ok(dist > 60, `${setting.label} Stufe ${level}: Bot kaum bewegt (${dist.toFixed(0)} Felder)`);
    }
  }
});
