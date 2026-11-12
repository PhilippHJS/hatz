// Die Regeln der Ringjagd. Läuft nur beim Gastgeber und kennt weder Browser
// noch Netzwerk: Eingaben rein, neuer Spielstand raus.
//
// Jeder jagt genau einen Mitspieler und wird vom anderen gejagt. Wer seine
// Beute berührt, bekommt einen Punkt, die Beute verliert einen Punkt. Sie
// setzt kurz aus, sieht so lange das ganze Feld und steigt dann an einer
// entfernten Stelle wieder ein. Alle sind gleich schnell, nur wer seine Beute
// gerade im Sichtkreis hat, läuft etwas schneller. Sonst käme nie jemand heran.
//
// Mit Items liegen leuchtende Kisten im Labyrinth. Wer eine berührt und nichts
// auf Vorrat hat, bekommt ein Item und löst es mit E aus (siehe ITEMS in
// config.js).

import { buildMaze, cellAt, cellX, cellY, pathDist } from './maze.js';
import { makeRng } from './rng.js';
import { newBody, stepBody, inputUse } from './physics.js';
import {
  CATCH_DIST, SHIELD_TICKS, COUNTDOWN_TICKS, ROUND_SECONDS, TICK_RATE, DEFAULT_LEVELS, DEFAULT_RULES, cleanLevels, rulesFor,
  ITEMS, ITEM, itemTicks, BOX_RADIUS, BOX_RESPAWN_TICKS, TRAP_RADIUS, TRAP_LIFE_TICKS, boxCount,
} from './config.js';

export const PHASE = { LOBBY: 0, COUNTDOWN: 1, PLAY: 2, END: 3 };
// Arten von Ereignissen: gefangen, Item benutzt, in eine Falle getappt,
// Kiste aufgehoben, Item ging nicht (Hecke ohne Platz)
export const EVENT = { CATCH: 0, USE: 1, TRAP: 2, PICK: 3, FAIL: 4 };
const EVENT_TICKS = 3 * TICK_RATE; // so lange bleibt ein Ereignis in den Meldungen
const MAX_TRAPS = 2; // je Spieler, die älteste verschwindet

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
    flip: 0, // Kehrtwende: so lange läuft der Ring andersherum
    levels: DEFAULT_LEVELS.slice(), // Einstellungen der laufenden Runde
    rules: DEFAULT_RULES,
    // dead: Schritte bis zum Wiedereinstieg, 0 heißt im Spiel
    // item: Item auf Vorrat (-1: keins), star/cloak/sight/decoy: Restzeit der Wirkung
    // frozenBy: 1 Blitz, 2 Falle (solange body.fz läuft); fx/fy: Blickrichtung
    players: [0, 1, 2].map((slot) => ({
      slot, body: newBody(0, 0), score: 0, shield: 0, dead: 0, tp: 0,
      item: -1, star: 0, cloak: 0, sight: 0, decoy: 0, frozenBy: 0, fx: 0, fy: 1,
    })),
    boxes: [], // { id, x, y }
    boxWait: [], // Restzeit bis zur nächsten Kiste, je Kiste, die fehlt
    hedges: [], // gepflanzte Hecken { id, side: 0 waagrecht / 1 senkrecht, index, ticks, owner }
    traps: [], // { id, x, y, owner, life }
    nextId: 1,
    events: [],
    nextEvent: 1,
  };
}

export const preyOf = (ringDir, slot) => (slot + ringDir + 3) % 3;
export const hunterOf = (ringDir, slot) => (slot - ringDir + 3) % 3;
// Richtung des Rings gerade jetzt, die Kehrtwende eingerechnet
export const ringOf = (sim) => (sim.flip > 0 ? -sim.ringDir : sim.ringDir);

// Darf a den Mitspieler b fangen? Nur die Rollen, ohne Abstand und Schonfrist.
// Ein Stern jagt beide und kann selbst nicht gefangen werden.
// Geht für die Spieler der Simulation und für die Sicht eines Geräts.
export function canCatch(ring, a, b) {
  if (a.slot === b.slot || a.dead > 0 || b.dead > 0) return false;
  if (b.star > 0) return false;
  if (a.star > 0) return true;
  return preyOf(ring, a.slot) === b.slot;
}

// Sieht a den Mitspieler b? Beide im Spiel, b nicht unsichtbar und im Sichtkreis.
export function sees(a, b, radius) {
  if (a.dead > 0 || b.dead > 0 || b.cloak > 0) return false;
  const dx = a.body.x - b.body.x;
  const dy = a.body.y - b.body.y;
  return dx * dx + dy * dy <= radius * radius;
}

// Wohin zeigt der Pfeil des Jägers, wenn die Beute eine falsche Fährte legt?
// Auf die gespiegelte Stelle: Das Labyrinth ist spiegelgleich, die Fährte
// läuft also durch echte Gänge und bewegt sich glaubwürdig mit.
export function fakeSpot(m, x, y) {
  const candidates = [[m.W - x, y], [m.W - x, m.H - y], [(x + m.W / 2) % m.W, m.H - y]];
  for (const [fx, fy] of candidates) if (Math.hypot(fx - x, fy - y) >= 5) return { x: fx, y: fy };
  const [fx, fy] = candidates[candidates.length - 1];
  return { x: fx, y: fy };
}

function place(sim, player, cell) {
  const tp = player.tp + 1;
  player.body = newBody(cellX(sim.maze, cell) + 0.5, cellY(sim.maze, cell) + 0.5);
  player.tp = tp;
}

function addEvent(sim, kind, by, of, x, y, item = -1) {
  sim.events.push({ id: sim.nextEvent, tick: sim.tick, kind, by, of, x, y, item });
  sim.nextEvent += 1;
}

export function startRound(sim, seed, seconds = ROUND_SECONDS, levels = DEFAULT_LEVELS) {
  sim.seed = seed >>> 0;
  sim.levels = cleanLevels(levels);
  sim.rules = rulesFor(sim.levels);
  sim.maze = buildMaze(sim.seed, sim.rules.mazeW, sim.rules.mazeH);
  sim.rng = makeRng(sim.seed ^ 0x9e3779b9);
  sim.round += 1;
  sim.ringDir = sim.rng() < 0.5 ? 1 : -1;
  sim.flip = 0;
  sim.playTicks = Math.round(seconds * TICK_RATE);
  sim.events = [];
  sim.boxes = [];
  sim.boxWait = [];
  sim.hedges = [];
  sim.traps = [];

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
    player.item = -1;
    player.star = 0;
    player.cloak = 0;
    player.sight = 0;
    player.decoy = 0;
    player.frozenBy = 0;
  });
  if (sim.rules.items) for (let i = 0; i < boxCount(m.N); i += 1) spawnBox(sim);
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

// Neue Kiste auf einem Feld, das nicht zu nah an den Spielern und an anderen
// Kisten liegt. Findet sich keins, wird es mit dem Abstand weniger genau genommen.
function spawnBox(sim) {
  const m = sim.maze;
  const near = sim.players.filter((p) => p.dead === 0).map((p) => cellAt(m, p.body.x, p.body.y));
  const boxes = sim.boxes.map((box) => cellAt(m, box.x, box.y));
  for (const [fromPlayers, fromBoxes] of [[4, 5], [3, 3], [1, 1], [0, 1]]) {
    const cells = [];
    for (let c = 0; c < m.N; c += 1) {
      if (near.some((p) => pathDist(m, c, p) < fromPlayers)) continue;
      if (boxes.some((b) => pathDist(m, c, b) < fromBoxes)) continue;
      cells.push(c);
    }
    if (cells.length) {
      const cell = cells[sim.rng.int(cells.length)];
      sim.boxes.push({ id: sim.nextId, x: cellX(m, cell) + 0.5, y: cellY(m, cell) + 0.5 });
      sim.nextId += 1;
      return;
    }
  }
}

// Inhalt einer Kiste. Wer vorne liegt, bekommt eher schwache Items, wer
// hinten liegt, eher starke.
export function rollColumn(sim, player) {
  const higher = sim.players.filter((p) => p.score > player.score).length;
  const lower = sim.players.filter((p) => p.score < player.score).length;
  return higher === 0 && lower > 0 ? 0 : lower === 0 && higher > 0 ? 2 : 1;
}
function rollItem(sim, player) {
  const column = rollColumn(sim, player);
  const total = ITEMS.reduce((sum, item) => sum + item.weight[column], 0);
  let pick = sim.rng() * total;
  for (let i = 0; i < ITEMS.length; i += 1) {
    pick -= ITEMS[i].weight[column];
    if (pick < 0) return i;
  }
  return ITEMS.length - 1;
}

// Die Kante des eigenen Feldes, die am ehesten hinter der Figur liegt (gegen
// die Laufrichtung). Nur offene Kanten im Inneren kommen in Frage.
function edgeBehind(sim, player) {
  const m = sim.maze;
  const cx = Math.floor(player.body.x);
  const cy = Math.floor(player.body.y);
  const sides = [
    { dx: 0, dy: -1, side: 0, index: cy * m.W + cx, inside: cy > 0 },
    { dx: 1, dy: 0, side: 1, index: cy * (m.W + 1) + cx + 1, inside: cx < m.W - 1 },
    { dx: 0, dy: 1, side: 0, index: (cy + 1) * m.W + cx, inside: cy < m.H - 1 },
    { dx: -1, dy: 0, side: 1, index: cy * (m.W + 1) + cx, inside: cx > 0 },
  ];
  let best = null;
  let bestDot = 0.3;
  for (const edge of sides) {
    const wall = edge.side === 0 ? m.h[edge.index] : m.v[edge.index];
    if (!edge.inside || wall) continue;
    const dot = edge.dx * player.fx + edge.dy * player.fy;
    if (dot < bestDot - 1e-9) {
      bestDot = dot;
      best = edge;
    }
  }
  return best;
}

function setEdge(m, side, index, value) {
  if (side === 0) m.h[index] = value;
  else m.v[index] = value;
}

// Item auf Vorrat auslösen
export function useItem(sim, player) {
  if (player.item < 0 || player.dead > 0) return;
  const item = player.item;
  const ticks = itemTicks(item);
  const b = player.body;
  switch (item) {
    case ITEM.sight:
      player.sight = ticks;
      break;
    case ITEM.cloak:
      player.cloak = ticks;
      break;
    case ITEM.rocket:
      b.ph = ticks;
      break;
    case ITEM.star:
      player.star = ticks;
      break;
    case ITEM.bolt:
      for (const other of sim.players) {
        if (other === player || other.dead > 0) continue;
        other.body.fz = Math.max(other.body.fz, ticks);
        other.body.vx = 0;
        other.body.vy = 0;
        other.frozenBy = 1;
      }
      break;
    case ITEM.flip:
      sim.flip = ticks;
      break;
    case ITEM.hedge: {
      const edge = edgeBehind(sim, player);
      if (!edge) {
        // Kein Platz für eine Hecke: Das Item bleibt auf Vorrat.
        addEvent(sim, EVENT.FAIL, player.slot, -1, b.x, b.y, item);
        return;
      }
      setEdge(sim.maze, edge.side, edge.index, 1);
      sim.hedges.push({ id: sim.nextId, side: edge.side, index: edge.index, ticks, owner: player.slot });
      sim.nextId += 1;
      break;
    }
    case ITEM.trap: {
      const mine = sim.traps.filter((trap) => trap.owner === player.slot);
      if (mine.length >= MAX_TRAPS) sim.traps.splice(sim.traps.indexOf(mine[0]), 1);
      sim.traps.push({ id: sim.nextId, x: b.x, y: b.y, owner: player.slot, life: TRAP_LIFE_TICKS });
      sim.nextId += 1;
      break;
    }
    case ITEM.decoy:
      player.decoy = ticks;
      break;
    default:
      return;
  }
  player.item = -1;
  addEvent(sim, EVENT.USE, player.slot, -1, b.x, b.y, item);
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
  const m = sim.maze;

  // Auszeit läuft ab: wieder einsteigen
  for (const player of sim.players) {
    if (player.dead > 0) {
      player.dead -= 1;
      if (player.dead === 0) respawn(sim, player.slot);
    }
  }

  // Wirkungen laufen ab
  if (sim.flip > 0) sim.flip -= 1;
  for (const player of sim.players) {
    if (player.star > 0) player.star -= 1;
    if (player.cloak > 0) player.cloak -= 1;
    if (player.sight > 0) player.sight -= 1;
    if (player.decoy > 0) player.decoy -= 1;
    if (player.body.fz === 0) player.frozenBy = 0;
  }
  for (let i = sim.hedges.length - 1; i >= 0; i -= 1) {
    const hedge = sim.hedges[i];
    hedge.ticks -= 1;
    if (hedge.ticks <= 0) {
      setEdge(m, hedge.side, hedge.index, 0);
      sim.hedges.splice(i, 1);
    }
  }
  for (let i = sim.traps.length - 1; i >= 0; i -= 1) {
    sim.traps[i].life -= 1;
    if (sim.traps[i].life <= 0) sim.traps.splice(i, 1);
  }
  for (let i = sim.boxWait.length - 1; i >= 0; i -= 1) {
    sim.boxWait[i] -= 1;
    if (sim.boxWait[i] <= 0) {
      sim.boxWait.splice(i, 1);
      spawnBox(sim);
    }
  }

  // Jagdfieber: Wer eine Beute im Sichtkreis hat, ist in diesem Schritt schneller.
  const ring = ringOf(sim);
  for (const hunter of sim.players) {
    hunter.body.hot = sim.players.some((prey) => canCatch(ring, hunter, prey) && prey.shield === 0 && sees(hunter, prey, sim.rules.vision));
  }

  // Items auslösen und bewegen
  for (const player of sim.players) {
    if (player.dead > 0) continue;
    const list = inputs[player.slot];
    if (list) {
      for (const code of list) {
        if (inputUse(code)) useItem(sim, player);
        stepBody(m, player.body, code, sim.rules);
      }
    }
    const b = player.body;
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (speed > 0.5) {
      player.fx = b.vx / speed;
      player.fy = b.vy / speed;
    }
  }

  // Kisten aufheben
  for (const player of sim.players) {
    if (player.dead > 0 || player.item >= 0) continue;
    const b = player.body;
    const at = sim.boxes.findIndex((box) => (box.x - b.x) ** 2 + (box.y - b.y) ** 2 < BOX_RADIUS * BOX_RADIUS);
    if (at < 0) continue;
    const [box] = sim.boxes.splice(at, 1);
    player.item = rollItem(sim, player);
    sim.boxWait.push(BOX_RESPAWN_TICKS);
    addEvent(sim, EVENT.PICK, player.slot, -1, box.x, box.y, player.item);
  }

  // Fallen schnappen zu
  for (let i = sim.traps.length - 1; i >= 0; i -= 1) {
    const trap = sim.traps[i];
    const victim = sim.players.find((p) => p.slot !== trap.owner && p.dead === 0
      && (p.body.x - trap.x) ** 2 + (p.body.y - trap.y) ** 2 < TRAP_RADIUS * TRAP_RADIUS);
    if (!victim) continue;
    sim.traps.splice(i, 1);
    victim.body.fz = Math.max(victim.body.fz, itemTicks(ITEM.trap));
    victim.body.vx = 0;
    victim.body.vy = 0;
    victim.body.ph = 0;
    victim.frozenBy = 2;
    addEvent(sim, EVENT.TRAP, trap.owner, victim.slot, trap.x, trap.y, ITEM.trap);
  }

  // Fangen
  const caught = [];
  const taken = new Set();
  for (const hunter of sim.players) {
    for (const prey of sim.players) {
      if (taken.has(prey.slot) || prey.shield > 0 || !canCatch(ring, hunter, prey)) continue;
      const dx = hunter.body.x - prey.body.x;
      const dy = hunter.body.y - prey.body.y;
      if (dx * dx + dy * dy < CATCH_DIST * CATCH_DIST) {
        caught.push([hunter, prey]);
        taken.add(prey.slot);
      }
    }
  }
  for (const [hunter, prey] of caught) {
    hunter.score += 1;
    prey.score -= 1;
    addEvent(sim, EVENT.CATCH, hunter.slot, prey.slot, prey.body.x, prey.body.y);
  }
  for (const [, prey] of caught) {
    prey.dead = sim.rules.respawnTicks;
    prey.body.vx = 0;
    prey.body.vy = 0;
    prey.body.sp = false;
    prey.body.hot = false;
    prey.body.ph = 0;
    prey.body.fz = 0;
    prey.frozenBy = 0;
    prey.cloak = 0;
    prey.decoy = 0;
  }

  for (const player of sim.players) if (player.shield > 0) player.shield -= 1;
  while (sim.events.length && sim.tick - sim.events[0].tick > EVENT_TICKS) sim.events.shift();

  if (sim.tick >= sim.phaseEnd) sim.phase = PHASE.END;
}

// Rangfolge am Rundenende: Punkte absteigend
export function ranking(scores) {
  return scores.map((score, slot) => ({ slot, score })).sort((a, b) => b.score - a.score || a.slot - b.slot);
}
