// Gastgeber und Mitspieler über eine nachgestellte, schlechte Verbindung:
// Nachrichten kommen verspätet, durcheinander, doppelt oder gar nicht an.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost, createLoopback } from '../js/host.js';
import { createClient } from '../js/client.js';
import { packInput, IDLE } from '../js/physics.js';
import { PHASE, EVENT, hunterOf } from '../js/sim.js';
import { makeRng } from '../js/rng.js';
import { COUNTDOWN_TICKS, TICK_RATE, RESPAWN_TICKS, SETTINGS, rulesFor, ITEM, itemTicks } from '../js/config.js';
import { useItem } from '../js/sim.js';

// Eine Welt mit eigener Uhr. `net` beschreibt die Leitung der Mitspieler.
// Die Grundtests laufen ohne Items, damit kein Bot mit einem Blitz dazwischenfunkt.
const NO_ITEMS = SETTINGS.map((setting) => (setting.key === 'items' ? 0 : setting.normal));

function world({ net, guests = 2, seconds = 20, seed = 1, levels = NO_ITEMS }) {
  const rng = makeRng(seed);
  let now = 1000;
  const queue = []; // { at, fn }
  const later = (ms, fn) => queue.push({ at: now + ms, fn });
  const host = createHost({ seconds, levels });
  const loop = createLoopback(host, () => now);

  // Leitung übers "Netz": Verlust, Laufzeit mit Schwankung, Doppelte
  const remote = new Map();
  const travel = (fn) => {
    if (rng() < net.loss) return;
    later(net.delay + rng() * net.jitter, fn);
    if (rng() < net.dup) later(net.delay + rng() * net.jitter, fn);
  };
  host.addLine({
    sendTo(id, msg) {
      const deliver = remote.get(id);
      if (!deliver) return false;
      const text = JSON.stringify(msg);
      travel(() => deliver(JSON.parse(text)));
      return true;
    },
    broadcast(msg, fast, tick) {
      if (fast && net.direct === false && tick % 3 !== 0) return;
      const text = JSON.stringify(msg);
      for (const deliver of remote.values()) travel(() => deliver(JSON.parse(text)));
    },
    isDirect: () => net.direct !== false,
  });

  const clients = [];
  let local = null;
  const localLink = loop.connect('host', (msg) => local.receive(msg, now));
  local = createClient({ id: 'host', name: 'Anna', link: localLink });
  clients.push({ client: local, frameAt: now });
  for (let i = 0; i < guests; i += 1) {
    const id = `gast${i}`;
    const link = {
      send: (msg) => {
        const text = JSON.stringify(msg);
        travel(() => host.handle(id, JSON.parse(text), now));
      },
      direct: () => net.direct !== false,
    };
    const client = createClient({ id, name: `Gast ${i + 1}`, link });
    remote.set(id, (msg) => client.receive(msg, now));
    clients.push({ client, frameAt: now + 3 + i * 5 });
  }
  const inputs = clients.map(() => IDLE);
  const w = {
    host, clients: clients.map((c) => c.client), inputs,
    now: () => now,
    // lässt die Welt `ms` Millisekunden laufen
    run(ms, each) {
      const end = now + ms;
      while (now < end) {
        now += 1;
        queue.sort((a, b) => a.at - b.at);
        while (queue.length && queue[0].at <= now) queue.shift().fn();
        host.advance(now);
        clients.forEach((c, i) => {
          // 60 Bilder pro Sekunde, jeder mit eigenem Takt
          if (now >= c.frameAt) {
            c.frameAt += 1000 / 60;
            c.client.frame(now, inputs[i]);
          }
        });
        if (each) each(now);
      }
    },
  };
  return w;
}

const GOOD = { delay: 15, jitter: 10, loss: 0, dup: 0 };
const ROUGH = { delay: 40, jitter: 40, loss: 0.05, dup: 0.05 };
const RELAY = { delay: 70, jitter: 60, loss: 0.03, dup: 0.2, direct: false };

function wander(w, rng, t) {
  if (t % 230 === 0) {
    for (let i = 0; i < w.inputs.length; i += 1) w.inputs[i] = packInput(rng.int(3) - 1, rng.int(3) - 1, rng() < 0.3);
  }
}

for (const [label, net] of [['gute Verbindung', GOOD], ['schlechte Verbindung', ROUGH], ['über Vermittler', RELAY]]) {
  test(`Beitritt und ganze Runde: ${label}`, (t) => {
    const w = world({ net, seconds: 12, seed: 7 });
    w.run(2500);
    const slots = w.clients.map((c) => c.slot);
    assert.deepEqual([...slots].sort(), [0, 1, 2], `Plätze ${slots}`);
    for (const c of w.clients) assert.equal(c.status, 'in');
    assert.deepEqual(w.host.lobby().slots.map((s) => s.kind), ['human', 'human', 'human']);
    assert.equal(w.clients[1].lobby.slots.filter((s) => s.online).length, 3);

    w.host.start();
    w.run((COUNTDOWN_TICKS / TICK_RATE) * 1000 + 400);
    for (const c of w.clients) assert.equal(c.latest.ph, PHASE.PLAY, 'Runde läuft bei allen');

    const rng = makeRng(99);
    let worstErr = 0;
    let worstRemote = 0;
    let measured = 0;
    w.run(8000, (t) => {
      wander(w, rng, t);
      if (t % 50 !== 0) return;
      for (const c of w.clients) {
        worstErr = Math.max(worstErr, c.debug().err);
        // Wo ich die anderen sehe, verglichen mit ihrem wahren Ort
        const view = c.view(t);
        for (const p of view.players) {
          if (p.mine) continue;
          const truth = w.host.sim.players[p.slot].body;
          worstRemote = Math.max(worstRemote, Math.hypot(p.x - truth.x, p.y - truth.y));
          measured += 1;
        }
      }
    });
    assert.ok(measured > 100);
    t.diagnostic(`eigene Figur korrigiert um höchstens ${worstErr.toFixed(3)}, Mitspieler höchstens ${worstRemote.toFixed(2)} Felder daneben, Verzögerung ${w.clients[1].delayMs().toFixed(0)} ms`);
    // Mitspieler erscheinen leicht verzögert, aber nie weit weg vom wahren Ort
    const lag = (net.delay + net.jitter) / 1000 + 0.2;
    assert.ok(worstRemote < 7.6 * lag + 0.3, `${label}: Mitspieler bis zu ${worstRemote.toFixed(2)} Felder daneben`);
    assert.ok(worstErr < (net.loss ? 0.6 : 0.1), `${label}: Korrektur der eigenen Figur bis ${worstErr.toFixed(3)} Felder`);

    // Alle lassen los: Die vorausberechnete Figur muss exakt beim gültigen Stand landen.
    w.inputs.fill(IDLE);
    w.run(1500);
    for (const c of w.clients) {
      const mine = c.debug().me;
      const truth = w.host.sim.players[c.slot].body;
      assert.ok(Math.hypot(mine.x - truth.x, mine.y - truth.y) < 1e-9, `${label}: Platz ${c.slot} steht ${Math.hypot(mine.x - truth.x, mine.y - truth.y)} daneben`);
      assert.equal(c.debug().pending < 30, true);
    }

    w.run(4000);
    for (const c of w.clients) {
      assert.equal(c.latest.ph, PHASE.END);
      assert.deepEqual(c.view(w.now()).players.map((p) => p.score), w.host.sim.players.map((p) => p.score));
    }
  });
}

test('Vorhersage: ohne Verlust weicht die eigene Figur nie sichtbar ab', (t) => {
  const w = world({ net: { delay: 60, jitter: 0, loss: 0, dup: 0 }, seconds: 30, seed: 3, guests: 1 });
  w.run(1500);
  w.host.start();
  w.run((COUNTDOWN_TICKS / TICK_RATE) * 1000 + 500);
  const rng = makeRng(5);
  let worst = 0;
  w.run(10000, (t) => {
    wander(w, rng, t);
    for (const c of w.clients) worst = Math.max(worst, c.debug().err);
  });
  // Abweichungen entstehen nur, wenn das Jagdfieber umschaltet oder jemand gefangen wird
  t.diagnostic(`größte Abweichung ${worst.toFixed(4)} Felder`);
  assert.ok(worst < 0.12, `Abweichung bis ${worst.toFixed(4)} Felder`);
});

test('Auszeit: Gefangene stehen still und steigen bei allen gleich wieder ein', () => {
  const w = world({ net: ROUGH, seconds: 60, seed: 21 });
  w.run(2500);
  w.host.start();
  w.run((COUNTDOWN_TICKS / TICK_RATE) * 1000 + 400);
  const sim = w.host.sim;
  const guest = w.clients[1];
  const other = w.clients[2];
  const me = sim.players[guest.slot];
  const hunter = sim.players[hunterOf(sim.ringDir, guest.slot)];
  const off = (client) => {
    const mine = client.debug().me;
    const truth = sim.players[client.slot].body;
    return Math.hypot(mine.x - truth.x, mine.y - truth.y);
  };

  // Der Gast rennt gerade, als sein Jäger ihn erwischt, und hält die Tasten weiter gedrückt.
  w.inputs[1] = packInput(1, 1, true);
  w.run(500);
  hunter.body.x = me.body.x;
  hunter.body.y = me.body.y;
  w.run(700);
  assert.ok(me.dead > 0 && me.dead < RESPAWN_TICKS);
  assert.ok(guest.view(w.now()).players[guest.slot].dead > 0, 'der Gast weiß, dass er aussetzt');
  assert.ok(off(guest) < 1e-9, `eigene Figur steht am Ort des Fangs (${off(guest)})`);
  assert.ok(other.view(w.now()).players[guest.slot].dead > 0, 'die anderen sehen ihn nicht mehr');
  assert.equal(guest.effects.filter((e) => e.kind === EVENT.CATCH).length, 1);

  // drei Sekunden später ist er wieder da, bei allen am selben Ort
  w.run((RESPAWN_TICKS / TICK_RATE) * 1000);
  assert.equal(me.dead, 0);
  w.run(600);
  assert.ok(Math.hypot(me.body.vx, me.body.vy) > 1 || me.body.x !== 0, 'nach dem Einstieg läuft er mit den gehaltenen Tasten weiter');
  w.inputs.fill(IDLE);
  w.run(1500);
  for (const c of w.clients) {
    assert.ok(off(c) < 1e-9, `Platz ${c.slot} steht ${off(c)} daneben`);
    const seen = c.view(w.now()).players[guest.slot];
    assert.equal(seen.dead, 0);
    assert.ok(Math.hypot(seen.x - me.body.x, seen.y - me.body.y) < 1e-6);
  }
});

test('Wer weg ist, wird vom Bot vertreten und bekommt seinen Platz zurück', () => {
  const w = world({ net: GOOD, seconds: 30, seed: 11, guests: 1 });
  w.run(1500);
  assert.deepEqual(w.host.lobby().slots.map((s) => s.kind), ['human', 'human', 'bot']);
  w.host.start();
  w.run((COUNTDOWN_TICKS / TICK_RATE) * 1000 + 300);
  // Gast verstummt: sein Fenster ist zu
  const guest = w.clients[1];
  const frame = guest.frame;
  guest.frame = () => {};
  // gelaufener Weg, nicht nur der Abstand zum Start: Ein fliehender Bot kann zurückkommen
  let walked = 0;
  let last = { ...w.host.sim.players[guest.slot].body };
  const tp = w.host.sim.players[guest.slot].tp;
  w.run(7000, (t) => {
    if (t % 50 !== 0) return;
    const now = w.host.sim.players[guest.slot].body;
    walked += Math.hypot(now.x - last.x, now.y - last.y);
    last = { ...now };
  });
  assert.equal(w.host.lobby().slots[guest.slot].online, false);
  // Wer still dasteht, wird manchmal gefangen und setzt gerade aus, das zählt auch
  const seat = w.host.sim.players[guest.slot];
  assert.ok(walked > 1 || seat.tp > tp || seat.dead > 0 || seat.score < 0, `der Bot bewegt die Figur (${walked.toFixed(2)} Felder)`);
  // und kommt wieder
  guest.frame = frame;
  w.run(2500);
  assert.equal(w.host.lobby().slots[guest.slot].online, true);
  assert.equal(guest.status, 'in');
  assert.equal(w.host.lobby().slots[guest.slot].id, 'gast0');
});

test('Vierter Mitspieler: Raum ist voll', () => {
  const w = world({ net: GOOD, guests: 3 });
  w.run(2500);
  const states = w.clients.map((c) => c.status).sort();
  assert.deepEqual(states, ['full', 'in', 'in', 'in']);
});

test('Einstellungen: kommen bei allen an, die Vorhersage rechnet mit denselben Regeln', () => {
  // schnell, großer Sichtkreis, kleines Labyrinth, wenig Ausdauer, kurze Auszeit, starkes Jagdfieber
  const levels = SETTINGS.map((setting) => ({ items: 0, speed: 2, vision: 2, maze: 0, stamina: 0, respawn: 0, fever: 2 }[setting.key]));
  const w = world({ net: { delay: 50, jitter: 20, loss: 0, dup: 0 }, seconds: 8, seed: 31, levels });
  w.run(2500);
  for (const c of w.clients) assert.deepEqual(c.lobby.levels, levels, 'im Raum sehen alle die Einstellungen');
  w.host.start();
  w.run((COUNTDOWN_TICKS / TICK_RATE) * 1000 + 400);
  for (const c of w.clients) {
    const view = c.view(w.now());
    assert.equal(view.maze.W, 16);
    assert.equal(view.maze.H, 10);
    assert.deepEqual(view.rules, rulesFor(levels));
  }
  const rng = makeRng(8);
  let worst = 0;
  w.run(5000, (t) => {
    if (t % 230 === 0) for (let i = 0; i < w.inputs.length; i += 1) w.inputs[i] = packInput(rng.int(3) - 1, rng.int(3) - 1, rng() < 0.6);
    for (const c of w.clients) worst = Math.max(worst, c.debug().err);
  });
  // Abweichungen entstehen wie sonst nur, wenn das Jagdfieber umschaltet oder jemand
  // gefangen wird. Bei schnellem Tempo und starkem Fieber sind sie etwas größer:
  // 50 bis 70 ms Laufzeit mal 2,5 Felder pro Sekunde Unterschied.
  assert.ok(worst < 0.35, `Abweichung bis ${worst.toFixed(3)} Felder`);
  w.inputs.fill(IDLE);
  w.run(1200);
  for (const c of w.clients) {
    const mine = c.debug().me;
    const truth = w.host.sim.players[c.slot].body;
    assert.ok(Math.hypot(mine.x - truth.x, mine.y - truth.y) < 1e-9, `Platz ${c.slot} steht daneben`);
  }

  // Der Gastgeber stellt um: gilt erst für die nächste Runde, dann aber bei allen.
  w.run(3000);
  assert.equal(w.host.sim.phase, PHASE.END);
  w.host.setLevel('maze', 2);
  w.host.setLevel('speed', 0);
  w.host.setLevel('gibtesnicht', 2);
  w.host.setLevel('vision', 9);
  w.run(1500);
  for (const c of w.clients) {
    assert.equal(c.view(w.now()).maze.W, 16, 'die alte Runde bleibt, wie sie war');
    assert.deepEqual(c.lobby.levels, w.host.levels);
  }
  assert.equal(w.host.levels[SETTINGS.findIndex((setting) => setting.key === 'vision')], 1, 'ungültige Stufe wird zur mittleren');
  w.host.start();
  w.run((COUNTDOWN_TICKS / TICK_RATE) * 1000 + 600);
  w.inputs.fill(packInput(1, 1, false));
  w.run(1500);
  w.inputs.fill(IDLE);
  w.run(1200);
  for (const c of w.clients) {
    const view = c.view(w.now());
    assert.equal(view.maze.W, 24);
    assert.equal(view.rules.speed, 0.8);
    const mine = c.debug().me;
    const truth = w.host.sim.players[c.slot].body;
    assert.ok(Math.hypot(mine.x - truth.x, mine.y - truth.y) < 1e-9, `zweite Runde: Platz ${c.slot} steht daneben`);
  }
});

test('Items: Rakete zündet beim Gast sofort, gepflanzte Hecken stehen auch in seiner Kopie', () => {
  const ITEMS_ON = SETTINGS.map((setting) => setting.normal);
  const w = world({ net: { delay: 45, jitter: 15, loss: 0.02, dup: 0.02 }, seconds: 30, seed: 41, levels: ITEMS_ON });
  w.run(2500);
  w.host.start();
  w.run((COUNTDOWN_TICKS / TICK_RATE) * 1000 + 300);
  const sim = w.host.sim;
  sim.boxes = [];
  sim.boxWait = [];
  const guest = w.clients[1];
  const seat = sim.players[guest.slot];
  seat.item = ITEM.rocket;
  w.run(400);
  assert.equal(guest.view(w.now()).players[guest.slot].item, ITEM.rocket, 'der Gast sieht sein Item');
  assert.equal(w.clients[2].view(w.now()).players[guest.slot].item, -1, 'die anderen sehen es nicht');

  // E drücken (ein Bild lang), dann weiter nach rechts unten
  w.inputs[1] = packInput(1, 1, false, true);
  w.run(40); // sicher mindestens ein Rechenschritt
  w.inputs[1] = packInput(1, 1, false);
  assert.ok(guest.debug().me.ph > 0, 'die Rakete zündet sofort, ohne auf den Gastgeber zu warten');
  assert.equal(seat.body.ph, 0, 'beim Gastgeber ist sie noch nicht angekommen');
  let worst = 0;
  w.run(itemTicks(ITEM.rocket) / TICK_RATE * 1000 + 600, () => {
    worst = Math.max(worst, guest.debug().err);
  });
  assert.equal(seat.item, -1);
  assert.ok(worst < 0.3, `Korrektur während des Flugs bis ${worst.toFixed(3)} Felder`);
  w.inputs.fill(IDLE);
  w.run(1200);
  const mine = guest.debug().me;
  assert.ok(Math.hypot(mine.x - seat.body.x, mine.y - seat.body.y) < 1e-9, 'nach dem Flug exakt beim Gastgeber');

  // Hecke des Gastgebers: steht auch in der Kopie des Gasts und verschwindet dort wieder
  // Blickrichtung weg von einer offenen Seite, damit hinter ihm Platz ist
  const planter = sim.players[w.clients[0].slot];
  const m = sim.maze;
  const cx = Math.floor(planter.body.x);
  const cy = Math.floor(planter.body.y);
  const open = [
    [0, -1, cy > 0 && !m.h[cy * m.W + cx]],
    [1, 0, cx < m.W - 1 && !m.v[cy * (m.W + 1) + cx + 1]],
    [0, 1, cy < m.H - 1 && !m.h[(cy + 1) * m.W + cx]],
    [-1, 0, cx > 0 && !m.v[cy * (m.W + 1) + cx]],
  ].find(([, , free]) => free);
  planter.item = ITEM.hedge;
  planter.fx = -open[0];
  planter.fy = -open[1];
  useItem(sim, planter);
  assert.equal(sim.hedges.length, 1);
  const [hedge] = sim.hedges;
  const bit = (m) => (hedge.side === 0 ? m.h[hedge.index] : m.v[hedge.index]);
  w.run(400);
  assert.equal(bit(guest.view(w.now()).maze), 1, 'Hecke beim Gast');
  w.run(itemTicks(ITEM.hedge) / TICK_RATE * 1000 + 400);
  assert.equal(sim.hedges.length, 0);
  assert.equal(bit(guest.view(w.now()).maze), 0, 'und wieder weg');
});
