// Gastgeber und Mitspieler über eine nachgestellte, schlechte Verbindung:
// Nachrichten kommen verspätet, durcheinander, doppelt oder gar nicht an.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost, createLoopback } from '../js/host.js';
import { createClient } from '../js/client.js';
import { packInput, IDLE } from '../js/physics.js';
import { PHASE, hunterOf } from '../js/sim.js';
import { makeRng } from '../js/rng.js';
import { COUNTDOWN_TICKS, TICK_RATE, RESPAWN_TICKS } from '../js/config.js';

// Eine Welt mit eigener Uhr. `net` beschreibt die Leitung der Mitspieler.
function world({ net, guests = 2, seconds = 20, seed = 1 }) {
  const rng = makeRng(seed);
  let now = 1000;
  const queue = []; // { at, fn }
  const later = (ms, fn) => queue.push({ at: now + ms, fn });
  const host = createHost({ seconds });
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
  assert.equal(guest.effects.filter((e) => e.type === 'catch').length, 1);

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
  const before = { ...w.host.sim.players[guest.slot].body };
  w.run(7000);
  assert.equal(w.host.lobby().slots[guest.slot].online, false);
  const body = w.host.sim.players[guest.slot].body;
  assert.ok(Math.hypot(body.x - before.x, body.y - before.y) > 0.5 || w.host.sim.players[guest.slot].tp > 1, 'der Bot bewegt die Figur');
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
