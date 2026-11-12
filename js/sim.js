// Die Regeln der Ringjagd. Läuft nur beim Gastgeber und kennt weder Browser
// noch Netzwerk: Eingaben rein, neuer Spielstand raus.
//
// Jeder jagt genau einen Mitspieler und wird vom anderen gejagt. Wer seine
// Beute berührt, bekommt einen Punkt, die Beute verliert einen
// Punkt. Sie setzt drei Sekunden aus, sieht so lange das ganze Feld und steigt
// dann an einer entfernten Stelle wieder ein. Alle sind gleich schnell, nur
// wer seine Beute gerade im Sichtkreis hat, läuft etwas schneller. Sonst käme
// nie jemand heran.

import { buildMaze, cellAt, cellX, cellY, pathDist } from './maze.js';
import { makeRng } from './rng.js';
import { newBody, stepBody } from './physics.js';
import {
  CATCH_DIST, SHIELD_TICKS, RESPAWN_TICKS, COUNTDOWN_TICKS, ROUND_SECONDS, TICK_RATE, VISION_RADIUS,
} from './config.js';

export const PHASE = { LOBBY: 0, COUNTDOWN: 1, PLAY: 2, END: 3 };
const EVENT_TICKS = 3 * TICK_RATE; // so lange bleibt ein Ereignis in den Meldungen

export function createSim() {
  return {
    tick: 0,
    phase: PHASE.LOBBY,
    phaseEnd: 0,
    playTicks: ROUND_SECONDS * TICK_RATE,
    round: 0,
    seed: 0,
    maze: null,
    rng: null,
    ringDir: 1,
    // dead: Schritte bis zum Wiedereinstieg, 0 heißt im Spiel
    players: [0, 1, 2].map((slot) => ({ slot, body: newBody(0, 0), score: 0, shield: 0, dead: 0, tp: 0 })),
    events: [],
    nextEvent: 1,
  };
}

export const preyOf = (ringDir, slot) => (slot + ringDir + 3) % 3;
export const hunterOf = (ringDir, slot) => (slot - ringDir + 3) % 3;

// Sieht a den Mitspieler b? Beide müssen im Spiel sein und b im Sichtkreis von a.
export function sees(a, b) {
  if (a.dead > 0 || b.dead > 0) return false;
  const dx = a.body.x - b.body.x;
  const dy = a.body.y - b.body.y;
  return dx * dx + dy * dy <= VISION_RADIUS * VISION_RADIUS;
}

function place(sim, player, cell) {
  const tp = player.tp + 1;
  player.body = newBody(cellX(sim.maze, cell) + 0.5, cellY(sim.maze, cell) + 0.5);
  player.tp = tp;
}

export function startRound(sim, seed, seconds = ROUND_SECONDS) {
  sim.seed = seed >>> 0;
  sim.maze = buildMaze(sim.seed);
  sim.rng = makeRng(sim.seed ^ 0x9e3779b9);
  sim.round += 1;
  sim.ringDir = sim.rng() < 0.5 ? 1 : -1;
  sim.playTicks = Math.round(seconds * TICK_RATE);
  sim.events = [];

  // Startfelder: drei Felder, die auf dem Laufweg möglichst weit auseinanderliegen
  const m = sim.maze;
  let best = null;
  let bestScore = -1;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const a = sim.rng.int(m.N);
    const b = sim.rng.int(m.N);
    const c = sim.rng.int(m.N);
    const score = Math.min(pathDist(m, a, b), pathDist(m, b, c), pathDist(m, a, c));
    if (score > bestScore) {
      bestScore = score;
      best = [a, b, c];
    }
  }
  sim.players.forEach((player, slot) => {
    place(sim, player, best[slot]);
    player.score = 0;
    player.shield = 0;
    player.dead = 0;
  });
  sim.phase = PHASE.COUNTDOWN;
  sim.phaseEnd = sim.tick + COUNTDOWN_TICKS;
}

export function backToLobby(sim) {
  sim.phase = PHASE.LOBBY;
  sim.phaseEnd = 0;
}

// Wiedereinstieg möglichst weit weg von den beiden anderen
function respawn(sim, slot) {
  const m = sim.maze;
  const others = sim.players.filter((p) => p.slot !== slot).map((p) => cellAt(m, p.body.x, p.body.y));
  const ranked = [];
  for (let c = 0; c < m.N; c += 1) {
    ranked.push([Math.min(pathDist(m, c, others[0]), pathDist(m, c, others[1])), c]);
  }
  ranked.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const [, cell] = ranked[sim.rng.int(Math.min(6, ranked.length))];
  place(sim, sim.players[slot], cell);
  sim.players[slot].shield = SHIELD_TICKS;
}

// Ein Schritt. `inputs[slot]` ist die Liste der Eingaben, die für diese Figur
// in diesem Schritt gelten (meist genau eine).
export function stepSim(sim, inputs) {
  sim.tick += 1;
  if (sim.phase === PHASE.COUNTDOWN && sim.tick >= sim.phaseEnd) {
    sim.phase = PHASE.PLAY;
    sim.phaseEnd = sim.tick + sim.playTicks;
  }
  if (sim.phase !== PHASE.PLAY) return;

  // Auszeit läuft ab: wieder einsteigen
  for (const player of sim.players) {
    if (player.dead > 0) {
      player.dead -= 1;
      if (player.dead === 0) respawn(sim, player.slot);
    }
  }

  // Jagdfieber: Wer seine Beute sieht, ist in diesem Schritt schneller.
  for (const hunter of sim.players) {
    const prey = sim.players[preyOf(sim.ringDir, hunter.slot)];
    hunter.body.hot = prey.shield === 0 && sees(hunter, prey);
  }
  for (const player of sim.players) {
    if (player.dead > 0) continue;
    const list = inputs[player.slot];
    if (list) for (const code of list) stepBody(sim.maze, player.body, code);
  }

  const caught = [];
  for (const hunter of sim.players) {
    const prey = sim.players[preyOf(sim.ringDir, hunter.slot)];
    if (hunter.dead > 0 || prey.dead > 0 || prey.shield > 0) continue;
    const dx = hunter.body.x - prey.body.x;
    const dy = hunter.body.y - prey.body.y;
    if (dx * dx + dy * dy < CATCH_DIST * CATCH_DIST) caught.push([hunter, prey]);
  }
  for (const [hunter, prey] of caught) {
    hunter.score += 1;
    prey.score -= 1;
    sim.events.push({ id: sim.nextEvent, tick: sim.tick, by: hunter.slot, of: prey.slot, x: prey.body.x, y: prey.body.y });
    sim.nextEvent += 1;
  }
  for (const [, prey] of caught) {
    prey.dead = RESPAWN_TICKS;
    prey.body.vx = 0;
    prey.body.vy = 0;
    prey.body.sp = false;
    prey.body.hot = false;
  }

  for (const player of sim.players) if (player.shield > 0) player.shield -= 1;
  while (sim.events.length && sim.tick - sim.events[0].tick > EVENT_TICKS) sim.events.shift();

  if (sim.tick >= sim.phaseEnd) sim.phase = PHASE.END;
}

// Rangfolge am Rundenende: Punkte absteigend
export function ranking(scores) {
  return scores.map((score, slot) => ({ slot, score })).sort((a, b) => b.score - a.score || a.slot - b.slot);
}
