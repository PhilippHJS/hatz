// Einfache Mitspieler für freie Plätze. Ein Bot läuft seiner Beute auf dem
// kürzesten Weg hinterher und flieht, sobald ein Jäger in seinem Sichtkreis
// auftaucht und ihm auf dem Laufweg nahe kommt. Ist die Beute dabei zum
// Greifen nah, packt er lieber zu, sonst liefen alle drei endlos im Kreis.
// Hat er nichts auf Vorrat, holt er sich eine Kiste in der Nähe, und seine
// Items setzt er ein, wenn sie gerade helfen. Er drückt dieselben Tasten wie
// ein Mensch und weiß nur, was ein Mensch auch wüsste: Unsichtbare verfolgt
// er nicht, und einer falschen Fährte läuft er hinterher.

import { cellAt, cellX, cellY, pathDist, canSee } from './maze.js';
import { packInput, IDLE } from './physics.js';
import { ringOf, canCatch, sees, fakeSpot } from './sim.js';
import { makeRng } from './rng.js';
import { TICK_RATE, ITEM } from './config.js';

// Ist der Weg zwischen zwei benachbarten Feldern gerade frei? (gepflanzte Hecken zählen)
function openBetween(m, a, b) {
  const ax = a % m.W;
  const ay = Math.floor(a / m.W);
  const bx = b % m.W;
  const by = Math.floor(b / m.W);
  if (ay === by) return !m.v[ay * (m.W + 1) + Math.max(ax, bx)];
  return !m.h[Math.max(ay, by) * m.W + ax];
}

export function createBot(slot, seed) {
  const rng = makeRng((seed ^ (0x51ed27 * (slot + 1))) >>> 0);
  const bot = { slot, target: -1, roam: -1, wait: 0, alarm: 0, startle: 0, fleeing: false, goal: -1, hold: 0, cooldown: 0 };

  bot.think = (sim) => {
    const m = sim.maze;
    const meP = sim.players[slot];
    if (meP.dead > 0) {
      bot.target = -1;
      bot.alarm = 0;
      return IDLE;
    }
    const me = meP.body;
    const ring = ringOf(sim);
    const myCell = cellAt(m, me.x, me.y);
    const others = sim.players.filter((p) => p.slot !== slot);

    // Beute: wen er fangen darf, außer Unsichtbaren. Bei falscher Fährte die falsche Stelle.
    let preyP = null;
    let preySpot = null;
    let preyCell = -1;
    let dPrey = 99;
    for (const p of others) {
      if (!canCatch(ring, meP, p) || p.cloak > 0) continue;
      const spot = p.decoy > 0 ? fakeSpot(m, p.body.x, p.body.y) : p.body;
      const cell = cellAt(m, Math.min(Math.max(spot.x, 0), m.W - 0.01), Math.min(Math.max(spot.y, 0), m.H - 0.01));
      const d = pathDist(m, myCell, cell);
      if (d < dPrey) {
        preyP = p;
        preySpot = spot;
        preyCell = cell;
        dPrey = d;
      }
    }
    // Jäger: wer ihn fangen darf (bei einem Stern können es zwei sein), der nächste zählt
    let hunterP = null;
    let hunterCell = -1;
    let dHunter = 99;
    for (const p of others) {
      if (!canCatch(ring, p, meP)) continue;
      const cell = cellAt(m, p.body.x, p.body.y);
      const d = pathDist(m, myCell, cell);
      if (d < dHunter) {
        hunterP = p;
        hunterCell = cell;
        dHunter = d;
      }
    }
    const hunting = preyP !== null;

    // Nichts auf Vorrat: eine nahe Kiste ist ein lohnendes Ziel
    let boxCell = -1;
    let dBox = 99;
    if (meP.item < 0) {
      for (const box of sim.boxes) {
        const cell = cellAt(m, box.x, box.y);
        const d = pathDist(m, myCell, cell);
        if (d < dBox) {
          dBox = d;
          boxCell = cell;
        }
      }
    }
    let goal;
    if (boxCell >= 0 && dBox <= 8 && (!hunting || dBox < dPrey)) goal = boxCell;
    else if (hunting) goal = preyCell;
    else {
      // ohne Beute irgendwohin streifen
      if (bot.roam < 0 || bot.roam === myCell) bot.roam = rng.int(m.N);
      goal = bot.roam;
    }
    if (hunting) bot.roam = -1;

    // Einen Jäger bemerkt der Bot erst in seinem Sichtkreis, und dann mit Schrecksekunde.
    const spotted = others.some((p) => canCatch(ring, p, meP) && sees(meP, p, sim.rules.vision));
    if (spotted && bot.alarm === 0) bot.startle = 14 + rng.int(12);
    if (spotted) bot.alarm = Math.round(1.6 * TICK_RATE);
    else if (bot.alarm > 0) bot.alarm -= 1;
    if (bot.startle > 0) bot.startle -= 1;
    const scared = hunterP !== null && bot.alarm > 0 && bot.startle === 0 && dHunter <= 4;
    // Wagemut: Beute näher als der Jäger und Puste voll, dann zupacken statt fliehen
    const bold = hunting && preyP.shield === 0 && dPrey <= 2 && dPrey <= dHunter && !me.ex && (me.st > 0.85 || me.sp);
    const threatened = scared && !bold;

    const arrived = bot.target < 0
      || (Math.abs(cellX(m, bot.target) + 0.5 - me.x) < 0.2 && Math.abs(cellY(m, bot.target) + 0.5 - me.y) < 0.2);
    bot.wait -= 1;
    if (arrived || bot.wait <= 0 || threatened !== bot.fleeing || goal !== bot.goal) {
      bot.fleeing = threatened;
      bot.goal = goal;
      bot.wait = 10 + rng.int(8);
      let best = myCell;
      let bestScore = -Infinity;
      for (const n of m.nbr[myCell]) {
        if (!openBetween(m, myCell, n)) continue;
        let score;
        if (threatened) score = pathDist(m, n, hunterCell) * 10 - pathDist(m, n, goal);
        else score = -pathDist(m, n, goal) * 10 + (hunterP ? Math.min(pathDist(m, n, hunterCell), 6) : 0);
        score += rng() * 2;
        if (score > bestScore) {
          bestScore = score;
          best = n;
        }
      }
      // Auf der Flucht lieber stehen bleiben als dem Jäger entgegenlaufen
      if (threatened && pathDist(m, best, hunterCell) < dHunter && dHunter > 1) best = myCell;
      bot.target = best;
    }

    let tx = cellX(m, bot.target) + 0.5;
    let ty = cellY(m, bot.target) + 0.5;
    if (me.ph > 0) {
      // Mit der Rakete geradewegs: weg vom Jäger oder hin zum Ziel
      if (threatened) {
        tx = me.x + (me.x - hunterP.body.x);
        ty = me.y + (me.y - hunterP.body.y);
      } else if (goal === preyCell && preySpot) {
        tx = preySpot.x;
        ty = preySpot.y;
      } else {
        tx = cellX(m, goal) + 0.5;
        ty = cellY(m, goal) + 0.5;
      }
    } else if (hunting && goal === preyCell && !threatened && dPrey <= 1 && canSee(m, me.x, me.y, preySpot.x, preySpot.y, 2.5)) {
      // Beute in Reichweite und keine Hecke dazwischen: direkt draufhalten
      tx = preySpot.x;
      ty = preySpot.y;
    }
    const dx = tx - me.x;
    const dy = ty - me.y;
    const mx = Math.abs(dx) > 0.1 ? Math.sign(dx) : 0;
    const my = Math.abs(dy) > 0.1 ? Math.sign(dy) : 0;

    // Sprint: auf der Flucht erst, wenn es eng wird oder der Jäger selbst
    // sprintet. Bei der Jagd nur ausgeruht, dann aber durchziehen.
    let sprint = false;
    if (threatened) sprint = !me.ex && (dHunter <= 3 || (hunterP.body.sp && dHunter <= 5));
    else if (hunting && goal === preyCell && dPrey <= 5 && preyP.shield === 0) sprint = !me.ex && (me.st > 0.85 || me.sp);

    // Items: einsetzen, wenn es gerade hilft, spätestens nach 20 Sekunden
    let use = false;
    if (meP.item < 0) bot.hold = 0;
    else bot.hold += 1;
    if (bot.cooldown > 0) bot.cooldown -= 1;
    else if (meP.item >= 0 && bot.hold > 20) {
      const close = hunting && preyP.shield === 0;
      switch (meP.item) {
        case ITEM.sight:
          use = true;
          break;
        case ITEM.cloak:
          use = threatened || (close && dPrey <= 5);
          break;
        case ITEM.rocket:
          use = (threatened && dHunter <= 3)
            || (close && dPrey >= 4 && Math.hypot(preySpot.x - me.x, preySpot.y - me.y) < 2.5);
          break;
        case ITEM.star:
          use = (close && dPrey <= 6) || (hunterP !== null && dHunter <= 4);
          break;
        case ITEM.bolt:
          use = (close && dPrey <= 2) || (threatened && dHunter <= 2);
          break;
        case ITEM.flip:
          use = threatened && dHunter <= 3 && hunterP.shield === 0;
          break;
        case ITEM.hedge:
          use = threatened && dHunter <= 4;
          break;
        case ITEM.trap:
          use = threatened || bot.hold > 8 * TICK_RATE;
          break;
        case ITEM.decoy:
          use = hunterP !== null && dHunter <= 10 && !spotted;
          break;
        default:
          break;
      }
      if (bot.hold > 20 * TICK_RATE) use = true;
      if (use) bot.cooldown = 30;
    }

    return packInput(mx, my, sprint, use);
  };
  return bot;
}
