// Items: Kisten, Vorrat, Aufholhilfe und jede einzelne Wirkung. Start: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import { hWall, vWall, cellAt, pathDist } from '../js/maze.js';
import { packInput, IDLE } from '../js/physics.js';
import {
  createSim, startRound, stepSim, useItem, preyOf, hunterOf, ringOf, canCatch, sees, fakeSpot, rollColumn, PHASE, EVENT,
} from '../js/sim.js';
import { createBot } from '../js/bots.js';
import {
  SETTINGS, ITEMS, ITEM, itemTicks, COUNTDOWN_TICKS, TICK_RATE, BOX_RESPAWN_TICKS, HIT_R, CATCH_DIST, boxCount,
} from '../js/config.js';

const ITEMS_ON = SETTINGS.map((setting) => setting.normal);
const ITEMS_OFF = SETTINGS.map((setting) => (setting.key === 'items' ? 0 : setting.normal));
const idle = () => [[IDLE], [IDLE], [IDLE]];

// Runde mit Items, Countdown vorbei, Kisten weg (damit nichts zufällig aufgehoben wird)
function playing(seed = 1234, levels = ITEMS_ON) {
  const sim = createSim();
  startRound(sim, seed, 120, levels);
  for (let t = 0; t < COUNTDOWN_TICKS; t += 1) stepSim(sim, idle());
  assert.equal(sim.phase, PHASE.PLAY);
  sim.boxes = [];
  sim.boxWait = [];
  return sim;
}
// Figuren an Feldmitten stellen, weit genug auseinander
function put(sim, slot, x, y) {
  const p = sim.players[slot];
  p.body.x = x;
  p.body.y = y;
  p.body.vx = 0;
  p.body.vy = 0;
  p.shield = 0;
  p.dead = 0;
  return p;
}
function spread(sim) {
  const m = sim.maze;
  put(sim, 0, 0.5, 0.5);
  put(sim, 1, m.W - 0.5, 0.5);
  put(sim, 2, m.W / 2 + 0.5, m.H - 0.5);
}
const eventsOf = (sim, kind) => sim.events.filter((e) => e.kind === kind);

test('Kisten: liegen verteilt, geben ein Item, kommen nach einer Weile wieder', () => {
  const sim = createSim();
  startRound(sim, 77, 120, ITEMS_ON);
  const m = sim.maze;
  assert.equal(sim.boxes.length, boxCount(m.N));
  const cells = sim.boxes.map((box) => cellAt(m, box.x, box.y));
  assert.equal(new Set(cells).size, cells.length, 'nie zwei auf einem Feld');
  for (const cell of cells) {
    for (const p of sim.players) assert.ok(pathDist(m, cell, cellAt(m, p.body.x, p.body.y)) >= 3, 'nicht direkt neben einem Spieler');
  }
  for (let t = 0; t < COUNTDOWN_TICKS; t += 1) stepSim(sim, idle());

  // Spieler 0 auf die erste Kiste stellen
  const box = sim.boxes[0];
  const p = put(sim, 0, box.x, box.y);
  stepSim(sim, idle());
  assert.ok(p.item >= 0 && p.item < ITEMS.length, 'Item auf Vorrat');
  assert.equal(sim.boxes.length, boxCount(m.N) - 1);
  const pick = eventsOf(sim, EVENT.PICK);
  assert.equal(pick.length, 1);
  assert.equal(pick[0].by, 0);

  // Mit vollem Vorrat bleibt die nächste Kiste liegen
  const second = sim.boxes[0];
  const held = p.item;
  put(sim, 0, second.x, second.y);
  stepSim(sim, idle());
  assert.equal(p.item, held);
  assert.ok(sim.boxes.includes(second));

  // Neue Kiste nach der Wartezeit
  const count = sim.boxes.length;
  for (let t = 0; t < BOX_RESPAWN_TICKS; t += 1) stepSim(sim, idle());
  assert.equal(sim.boxes.length, count + 1);
});

test('Kisten: ohne Items gibt es keine', () => {
  const sim = playing(5, ITEMS_OFF);
  startRound(sim, 6, 60, ITEMS_OFF);
  assert.equal(sim.boxes.length, 0);
  for (let t = 0; t < COUNTDOWN_TICKS + 20 * TICK_RATE; t += 1) stepSim(sim, idle());
  assert.equal(sim.boxes.length, 0);
});

test('Aufholhilfe: Wer hinten liegt, bekommt eher starke Items', () => {
  const sim = playing(9);
  const p = sim.players[0];
  const tally = (scores) => {
    sim.players.forEach((q, i) => {
      q.score = scores[i];
    });
    const counts = ITEMS.map(() => 0);
    for (let i = 0; i < 3000; i += 1) {
      p.item = -1;
      sim.boxes = [{ id: 1, x: p.body.x, y: p.body.y }];
      sim.boxWait = [];
      stepSim(sim, idle());
      counts[p.item] += 1;
    }
    return counts;
  };
  spread(sim);
  assert.equal(rollColumn(sim, p), 1, 'Gleichstand: Mitte');
  const leader = tally([5, 0, 0]);
  assert.equal(rollColumn(sim, p), 0);
  const last = tally([-5, 0, 0]);
  assert.equal(rollColumn(sim, p), 2);
  for (const counts of [leader, last]) assert.equal(counts.reduce((a, b) => a + b, 0), 3000);
  assert.ok(last[ITEM.star] > 4 * leader[ITEM.star], `Stern: ${leader[ITEM.star]} vorne, ${last[ITEM.star]} hinten`);
  assert.ok(leader[ITEM.sight] > 2 * last[ITEM.sight], `Mondschein: ${leader[ITEM.sight]} vorne, ${last[ITEM.sight]} hinten`);
  for (let i = 0; i < ITEMS.length; i += 1) assert.ok(leader[i] + last[i] > 0, `${ITEMS[i].id} kommt vor`);
});

test('Vorrat: E löst genau einmal aus, ohne Item passiert nichts', () => {
  const sim = playing(11);
  spread(sim);
  const p = sim.players[0];
  p.item = ITEM.sight;
  const press = idle();
  press[0] = [packInput(0, 0, false, true)];
  stepSim(sim, press);
  assert.equal(p.item, -1);
  assert.equal(p.sight, itemTicks(ITEM.sight) - 0);
  const used = eventsOf(sim, EVENT.USE);
  assert.equal(used.length, 1);
  assert.equal(used[0].item, ITEM.sight);
  // nochmal drücken: nichts auf Vorrat
  stepSim(sim, press);
  assert.equal(eventsOf(sim, EVENT.USE).length, 1);
  // Wirkung läuft ab
  for (let t = 0; t < itemTicks(ITEM.sight); t += 1) stepSim(sim, idle());
  assert.equal(p.sight, 0);
});

test('Tarnkappe: unsichtbar, kein Jagdfieber für den Jäger, aber fangbar', () => {
  const sim = playing(12);
  spread(sim);
  const ring = ringOf(sim);
  const prey = sim.players[0];
  const hunter = sim.players[hunterOf(ring, 0)];
  put(sim, hunter.slot, prey.body.x + 1.5, prey.body.y);
  stepSim(sim, idle());
  assert.equal(hunter.body.hot, true, 'vorher sieht der Jäger die Beute');
  prey.item = ITEM.cloak;
  useItem(sim, prey);
  assert.equal(sees(hunter, prey, sim.rules.vision), false);
  stepSim(sim, idle());
  assert.equal(hunter.body.hot, false, 'kein Jagdfieber auf Unsichtbare');
  put(sim, hunter.slot, prey.body.x + CATCH_DIST * 0.5, prey.body.y);
  stepSim(sim, idle());
  assert.equal(prey.dead > 0, true, 'Unsichtbare können gefangen werden');
  assert.equal(prey.cloak, 0, 'wer gefangen wird, verliert die Tarnkappe');
});

test('Rakete: durch Hecken, nie aus dem Garten, landet in einem freien Feld', () => {
  const sim = playing(13);
  const m = sim.maze;
  spread(sim);
  // ein Feld mit Hecke rechts suchen
  let spot = null;
  for (let y = 0; y < m.H && !spot; y += 1) {
    for (let x = 1; x < m.W - 3 && !spot; x += 1) if (vWall(m, x + 1, y) && vWall(m, x + 2, y)) spot = [x, y];
  }
  assert.ok(spot);
  const p = put(sim, 0, spot[0] + 0.5, spot[1] + 0.5);
  const right = idle();
  right[0] = [packInput(1, 0, false)];
  for (let t = 0; t < 30; t += 1) stepSim(sim, right);
  assert.ok(p.body.x < spot[0] + 1, 'ohne Rakete hält die Hecke');
  p.item = ITEM.rocket;
  const fire = idle();
  fire[0] = [packInput(1, 0, false, true)];
  stepSim(sim, fire);
  assert.equal(p.body.ph, itemTicks(ITEM.rocket) - 1);
  let crossed = false;
  while (p.body.ph > 0) {
    stepSim(sim, right);
    if (p.body.x > spot[0] + 1.5) crossed = true;
    assert.ok(p.body.x >= HIT_R - 1e-9 && p.body.x <= m.W - HIT_R + 1e-9);
  }
  assert.ok(crossed, 'durch die Hecke');
  // nach der Landung steckt die Figur in keiner Hecke
  const cx = Math.floor(p.body.x);
  const cy = Math.floor(p.body.y);
  const gap = Math.min(p.body.x - cx, cx + 1 - p.body.x, p.body.y - cy, cy + 1 - p.body.y);
  const walls = [hWall(m, cx, cy) && p.body.y - cy, hWall(m, cx, cy + 1) && cy + 1 - p.body.y, vWall(m, cx, cy) && p.body.x - cx, vWall(m, cx + 1, cy) && cx + 1 - p.body.x];
  for (const d of walls) if (d !== false && d !== 0) assert.ok(d >= HIT_R - 1e-6, `steckt in der Hecke (${d.toFixed(3)}, Lücke ${gap.toFixed(2)})`);

  // gegen den Rand: bleibt drin
  put(sim, 0, m.W - 0.5, 0.5);
  p.item = ITEM.rocket;
  stepSim(sim, fire);
  while (p.body.ph > 0) stepSim(sim, right);
  assert.ok(p.body.x <= m.W - HIT_R + 1e-9);
});

test('Stern: jagt beide, ist selbst nicht zu fangen', () => {
  const sim = playing(14);
  spread(sim);
  const ring = ringOf(sim);
  const star = sim.players[0];
  const myHunter = sim.players[hunterOf(ring, 0)];
  const myPrey = sim.players[preyOf(ring, 0)];
  star.item = ITEM.star;
  useItem(sim, star);
  assert.equal(canCatch(ring, star, myHunter), true, 'fängt auch den eigenen Jäger');
  assert.equal(canCatch(ring, star, myPrey), true);
  assert.equal(canCatch(ring, myHunter, star), false, 'niemand fängt den Stern');
  // Der eigene Jäger läuft in den Stern: Punkt für den Stern
  put(sim, myHunter.slot, star.body.x + CATCH_DIST * 0.5, star.body.y);
  stepSim(sim, idle());
  assert.equal(star.score, 1);
  assert.equal(myHunter.score, -1);
  assert.equal(star.dead, 0);
  // Jagdfieber auf beide
  put(sim, myPrey.slot, star.body.x + 2, star.body.y);
  stepSim(sim, idle());
  assert.equal(star.body.hot, true);
  // läuft ab
  for (let t = 0; t < itemTicks(ITEM.star); t += 1) stepSim(sim, idle());
  assert.equal(star.star, 0);
  assert.equal(canCatch(ringOf(sim), star, myHunter), false);
});

test('Blitz: alle anderen stehen eine Sekunde still', () => {
  const sim = playing(15);
  spread(sim);
  const p = sim.players[0];
  p.item = ITEM.bolt;
  const moveAll = [[packInput(0, 1, false, true)], [packInput(0, 1, false)], [packInput(0, 1, false)]];
  const start = sim.players.map((q) => q.body.y);
  stepSim(sim, moveAll);
  assert.equal(sim.players[1].frozenBy, 1);
  const go = [[packInput(0, 1, false)], [packInput(0, 1, false)], [packInput(0, 1, false)]];
  for (let t = 1; t < itemTicks(ITEM.bolt); t += 1) stepSim(sim, go);
  assert.ok(p.body.y > start[0] + 0.5, 'der Werfer läuft');
  assert.equal(sim.players[1].body.y, start[1], 'die anderen stehen');
  assert.equal(sim.players[2].body.y, start[2]);
  for (let t = 0; t < 30; t += 1) stepSim(sim, go);
  assert.ok(sim.players[1].body.y > start[1] + 0.3, 'danach geht es weiter');
  assert.equal(sim.players[1].frozenBy, 0);
});

test('Kehrtwende: Der Ring läuft ein paar Sekunden andersherum', () => {
  const sim = playing(16);
  spread(sim);
  const before = ringOf(sim);
  const p = sim.players[0];
  const hunter = sim.players[hunterOf(before, 0)];
  p.item = ITEM.flip;
  useItem(sim, p);
  assert.equal(ringOf(sim), -before);
  assert.equal(canCatch(ringOf(sim), p, hunter), true, 'der Jäger wird zur Beute');
  // Jäger berührt mich: jetzt fange ich ihn
  put(sim, hunter.slot, p.body.x + CATCH_DIST * 0.5, p.body.y);
  stepSim(sim, idle());
  assert.equal(p.score, 1);
  assert.equal(hunter.score, -1);
  for (let t = 0; t < itemTicks(ITEM.flip); t += 1) stepSim(sim, idle());
  assert.equal(ringOf(sim), before);
});

test('Hecke: wächst hinter der Figur zu, hält alle auf und verschwindet wieder', () => {
  const sim = playing(17);
  const m = sim.maze;
  spread(sim);
  // ein Feld, aus dem es nach links weitergeht
  let spot = null;
  for (let y = 0; y < m.H && !spot; y += 1) for (let x = 2; x < m.W - 1 && !spot; x += 1) if (!vWall(m, x, y)) spot = [x, y];
  const p = put(sim, 0, spot[0] + 0.5, spot[1] + 0.5);
  p.fx = 1; // läuft nach rechts, hinter ihm ist links
  p.fy = 0;
  p.item = ITEM.hedge;
  useItem(sim, p);
  assert.equal(vWall(m, spot[0], spot[1]), 1, 'links zugewachsen');
  assert.equal(sim.hedges.length, 1);
  // ein anderer kommt von links nicht durch
  const q = put(sim, 1, spot[0] - 0.5, spot[1] + 0.5);
  const right = idle();
  right[1] = [packInput(1, 0, false)];
  for (let t = 0; t < 60; t += 1) stepSim(sim, right);
  assert.ok(q.body.x < spot[0] - HIT_R + 1e-6, 'aufgehalten');
  for (let t = 0; t < itemTicks(ITEM.hedge); t += 1) stepSim(sim, right);
  assert.equal(vWall(m, spot[0], spot[1]), 0, 'wieder offen');
  assert.ok(q.body.x > spot[0], 'und durch');

  // Kein Platz: Liegen alle offenen Seiten vor der Figur, bleibt das Item auf Vorrat.
  // Ein Eckfeld, offen nur nach rechts und unten, die Figur läuft schräg nach rechts unten.
  let corner = null;
  for (let y = 1; y < m.H - 1 && !corner; y += 1) {
    for (let x = 1; x < m.W - 1 && !corner; x += 1) {
      if (hWall(m, x, y) && vWall(m, x, y) && !vWall(m, x + 1, y) && !hWall(m, x, y + 1)) corner = [x, y];
    }
  }
  assert.ok(corner);
  put(sim, 0, corner[0] + 0.5, corner[1] + 0.5);
  p.fx = Math.SQRT1_2;
  p.fy = Math.SQRT1_2;
  p.item = ITEM.hedge;
  useItem(sim, p);
  assert.equal(p.item, ITEM.hedge);
  assert.equal(eventsOf(sim, EVENT.FAIL).length, 1);
});

test('Falle: hält den Nächsten fest, nicht den, der sie gelegt hat', () => {
  const sim = playing(18);
  spread(sim);
  const owner = sim.players[0];
  owner.item = ITEM.trap;
  useItem(sim, owner);
  assert.equal(sim.traps.length, 1);
  const trap = sim.traps[0];
  stepSim(sim, idle());
  assert.equal(owner.body.fz, 0, 'die eigene Falle schnappt nicht zu');
  put(sim, 0, trap.x + 3, trap.y);
  const victim = put(sim, 1, trap.x, trap.y);
  stepSim(sim, idle());
  assert.equal(victim.frozenBy, 2);
  assert.ok(victim.body.fz > 0);
  assert.equal(sim.traps.length, 0, 'eine Falle schnappt nur einmal');
  const sprung = eventsOf(sim, EVENT.TRAP);
  assert.equal(sprung.length, 1);
  assert.equal(sprung[0].by, 0);
  assert.equal(sprung[0].of, 1);
  const go = idle();
  go[1] = [packInput(1, 0, false)];
  const x = victim.body.x;
  for (let t = 1; t < itemTicks(ITEM.trap); t += 1) stepSim(sim, go);
  assert.equal(victim.body.x, x, 'zwei Sekunden fest');
});

test('Falsche Fährte: zeigt auf eine Stelle weit weg, Bots fallen darauf herein', () => {
  const sim = playing(19);
  const m = sim.maze;
  for (let y = 0.5; y < m.H; y += 1) {
    for (let x = 0.5; x < m.W; x += 1) {
      const fake = fakeSpot(m, x, y);
      assert.ok(fake.x > 0 && fake.x < m.W && fake.y > 0 && fake.y < m.H);
      assert.ok(Math.hypot(fake.x - x, fake.y - y) >= 4, `bei (${x}, ${y}) zu nah`);
    }
  }
  // Ein Bot jagt eine Beute mit falscher Fährte: Er läuft zur falschen Stelle
  spread(sim);
  const ring = ringOf(sim);
  const prey = sim.players[preyOf(ring, 0)];
  put(sim, prey.slot, 2.5, m.H / 2 + 0.5);
  put(sim, 0, 3.5, m.H / 2 + 0.5);
  prey.item = ITEM.decoy;
  useItem(sim, prey);
  const fake = fakeSpot(m, prey.body.x, prey.body.y);
  const bot = createBot(0, 3);
  const start = Math.hypot(fake.x - 3.5, fake.y - (m.H / 2 + 0.5));
  for (let t = 0; t < 120; t += 1) {
    const inputs = idle();
    inputs[0] = [bot.think(sim)];
    stepSim(sim, inputs);
  }
  const hunter = sim.players[0].body;
  assert.ok(Math.hypot(fake.x - hunter.x, fake.y - hunter.y) < start - 2, 'der Bot läuft der Fährte nach');
});

test('Bots: ganze Runden mit Items, alles wird mal benutzt, Punkte gleichen sich aus', () => {
  const used = ITEMS.map(() => 0);
  for (let seed = 1; seed <= 6; seed += 1) {
    const sim = createSim();
    startRound(sim, seed * 4099, 120, ITEMS_ON);
    const bots = [0, 1, 2].map((slot) => createBot(slot, seed));
    let seen = 0;
    while (sim.phase !== PHASE.END) {
      stepSim(sim, sim.phase === PHASE.PLAY ? bots.map((bot) => [bot.think(sim)]) : idle());
      for (const e of sim.events) {
        if (e.id <= seen) continue;
        seen = e.id;
        if (e.kind === EVENT.USE) used[e.item] += 1;
      }
    }
    assert.equal(sim.players.reduce((sum, p) => sum + p.score, 0), 0);
    // keine Hecke ist übrig geblieben, die nicht im Spielstand steht
    for (const hedge of sim.hedges) assert.ok(hedge.ticks > 0);
  }
  for (let i = 0; i < ITEMS.length; i += 1) assert.ok(used[i] > 0, `${ITEMS[i].id} nie benutzt`);
});
