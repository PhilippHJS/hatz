// Einfache Mitspieler für freie Plätze. Ein Bot läuft seiner Beute auf dem
// kürzesten Weg hinterher und flieht, sobald sein Jäger in seinem Sichtkreis
// auftaucht und ihm auf dem Laufweg nahe kommt. Ist die Beute dabei zum
// Greifen nah, packt er lieber zu, sonst liefen alle drei endlos im Kreis.
// Setzt die Beute gerade aus, streift er umher. Er drückt dieselben Tasten
// wie ein Mensch.

import { cellAt, cellX, cellY, pathDist, canSee } from './maze.js';
import { packInput, IDLE } from './physics.js';
import { preyOf, hunterOf, sees } from './sim.js';
import { makeRng } from './rng.js';
import { TICK_RATE } from './config.js';

export function createBot(slot, seed) {
  const rng = makeRng((seed ^ (0x51ed27 * (slot + 1))) >>> 0);
  const bot = { slot, target: -1, roam: -1, wait: 0, alarm: 0, startle: 0, fleeing: false };

  bot.think = (sim) => {
    const m = sim.maze;
    const meP = sim.players[slot];
    if (meP.dead > 0) {
      bot.target = -1;
      bot.alarm = 0;
      return IDLE;
    }
    const me = meP.body;
    const preyP = sim.players[preyOf(sim.ringDir, slot)];
    const hunterP = sim.players[hunterOf(sim.ringDir, slot)];
    const prey = preyP.body;
    const hunter = hunterP.body;
    const myCell = cellAt(m, me.x, me.y);
    const hunting = preyP.dead === 0;
    // Ohne Beute irgendwohin streifen, bis sie wieder da ist
    if (hunting) bot.roam = -1;
    else if (bot.roam < 0 || bot.roam === myCell) bot.roam = rng.int(m.N);
    const preyCell = hunting ? cellAt(m, prey.x, prey.y) : bot.roam;
    const hunterCell = cellAt(m, hunter.x, hunter.y);
    const dPrey = pathDist(m, myCell, preyCell);
    const dHunter = hunterP.dead === 0 ? pathDist(m, myCell, hunterCell) : 99;

    // Den Jäger bemerkt der Bot erst in seinem Sichtkreis, und dann mit Schrecksekunde.
    const spotted = sees(meP, hunterP, sim.rules.vision);
    if (spotted && bot.alarm === 0) bot.startle = 14 + rng.int(12);
    if (spotted) bot.alarm = Math.round(1.6 * TICK_RATE);
    else if (bot.alarm > 0) bot.alarm -= 1;
    if (bot.startle > 0) bot.startle -= 1;
    const scared = bot.alarm > 0 && bot.startle === 0 && dHunter <= 4;
    // Wagemut: Beute näher als der Jäger und Puste voll, dann zupacken statt fliehen
    const bold = hunting && preyP.shield === 0 && dPrey <= 2 && dPrey <= dHunter && !me.ex && (me.st > 0.85 || me.sp);
    const threatened = scared && !bold;

    const arrived = bot.target < 0
      || (Math.abs(cellX(m, bot.target) + 0.5 - me.x) < 0.2 && Math.abs(cellY(m, bot.target) + 0.5 - me.y) < 0.2);
    bot.wait -= 1;
    if (arrived || bot.wait <= 0 || threatened !== bot.fleeing) {
      bot.fleeing = threatened;
      bot.wait = 10 + rng.int(8);
      let best = myCell;
      let bestScore = -Infinity;
      for (const n of m.nbr[myCell]) {
        let score;
        if (threatened) score = pathDist(m, n, hunterCell) * 10 - pathDist(m, n, preyCell);
        else score = -pathDist(m, n, preyCell) * 10 + (hunterP.dead === 0 ? Math.min(pathDist(m, n, hunterCell), 6) : 0);
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
    // Beute in Reichweite und keine Hecke dazwischen: direkt draufhalten
    if (hunting && !threatened && dPrey <= 1 && canSee(m, me.x, me.y, prey.x, prey.y, 2.5)) {
      tx = prey.x;
      ty = prey.y;
    }
    const dx = tx - me.x;
    const dy = ty - me.y;
    const mx = Math.abs(dx) > 0.1 ? Math.sign(dx) : 0;
    const my = Math.abs(dy) > 0.1 ? Math.sign(dy) : 0;

    // Sprint: auf der Flucht erst, wenn es eng wird oder der Jäger selbst
    // sprintet. Bei der Jagd nur ausgeruht, dann aber durchziehen.
    let sprint = false;
    if (threatened) sprint = !me.ex && (dHunter <= 3 || (hunter.sp && dHunter <= 5));
    else if (hunting && dPrey <= 5 && preyP.shield === 0) sprint = !me.ex && (me.st > 0.85 || me.sp);

    return packInput(mx, my, sprint);
  };
  return bot;
}
