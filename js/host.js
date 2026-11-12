// Der Gastgeber: führt den gültigen Spielstand, vergibt die drei Plätze und
// schickt allen laufend den Stand. Kennt weder Browser noch Netzwerk, die
// Nachrichten gehen über "Leitungen", die von außen eingehängt werden.
//
// Jede Nachricht darf verloren gehen, doppelt oder verspätet ankommen:
// Spielstände tragen ihre Schrittnummer, Eingaben eine laufende Nummer.

import { createSim, startRound, backToLobby, stepSim, ringOf, PHASE } from './sim.js';
import { createBot } from './bots.js';
import { IDLE, MAX_INPUT } from './physics.js';
import { randomSeed } from './rng.js';
import { DT, TICK_RATE, PROTOCOL, ROUND_SECONDS, WISPS, SETTINGS, cleanLevels } from './config.js';

const OFFLINE_MS = 5000; // ohne Lebenszeichen gilt ein Mitspieler als weg
const FREE_MS = 20000; // dann wird sein Platz in der Lobby wieder frei
const QUEUE_MAX = 40;

export function createHost({ seconds = ROUND_SECONDS, levels, autoRestart = false, onChange = () => {} } = {}) {
  const sim = createSim();
  const lines = [];
  const slots = [0, 1, 2].map((index) => ({
    index, kind: 'bot', id: null, name: WISPS[index].name, online: true, heard: 0,
    queue: [], recvSeq: 0, ackSeq: 0, bot: null,
  }));
  // levels: die Einstellungen für die nächste Runde, je eine Stufe
  const host = { sim, slots, seconds, levels: cleanLevels(levels) };
  const epoch = Math.floor(Math.random() * 2147483647) + 1; // erkennt, wenn der Gastgeber neu geladen hat
  let version = 1;
  let clock = null; // Zeit des letzten Schritts in ms
  let endedAt = 0;
  let lobbyDue = 0;

  const slotOf = (id) => slots.find((slot) => slot.id === id) || null;
  const changed = () => {
    version += 1;
    lobbyDue = 0;
    onChange();
  };

  function sendTo(id, msg) {
    for (const line of lines) if (line.sendTo(id, msg)) return;
  }
  function broadcast(msg, fast) {
    for (const line of lines) line.broadcast(msg, fast, sim.tick);
  }
  const isDirect = (id) => lines.some((line) => line.isDirect && line.isDirect(id));

  function free(slot) {
    slot.kind = 'bot';
    slot.id = null;
    slot.name = WISPS[slot.index].name;
    slot.online = true;
    slot.queue.length = 0;
  }

  function lobbyMessage() {
    return {
      t: 'lobby',
      h: epoch,
      n: version,
      phase: sim.phase,
      round: sim.round,
      seconds: host.seconds,
      levels: host.levels,
      slots: slots.map((slot) => ({ name: slot.name, kind: slot.kind, id: slot.id, online: slot.online })),
    };
  }

  function snapshot() {
    return {
      t: 's',
      h: epoch,
      k: sim.tick,
      ph: sim.phase,
      pe: sim.phaseEnd,
      rn: sim.round,
      sd: sim.seed,
      rd: ringOf(sim), // Richtung des Rings, Kehrtwende eingerechnet
      fl: sim.flip,
      o: sim.levels,
      // Je Figur: Ort, Tempo, Ausdauer, Punkte, Auszeit und Items. Das Item auf
      // Vorrat steht für alle drin, gezeigt wird aber nur das eigene.
      p: sim.players.map((player) => {
        const b = player.body;
        return [
          b.x, b.y, b.vx, b.vy, b.st, (b.ex ? 1 : 0) | (b.sp ? 2 : 0) | (b.hot ? 4 : 0), b.rw,
          player.score, player.shield, player.tp, player.dead,
          player.item, player.star, player.cloak, player.sight, player.decoy, b.ph, b.fz, player.frozenBy,
        ];
      }),
      bx: sim.boxes.map((box) => [box.id, box.x, box.y]),
      hd: sim.hedges.map((hedge) => [hedge.id, hedge.side, hedge.index, hedge.ticks, hedge.owner]),
      tr: sim.traps.map((trap) => [trap.id, trap.x, trap.y, trap.owner]),
      a: slots.map((slot) => slot.ackSeq),
      e: sim.events.map((event) => [event.id, event.tick, event.kind, event.by, event.of, event.x, event.y, event.item]),
    };
  }

  host.addLine = (line) => lines.push(line);

  host.start = () => {
    if (sim.phase === PHASE.COUNTDOWN || sim.phase === PHASE.PLAY) return;
    startRound(sim, randomSeed(), host.seconds, host.levels);
    for (const slot of slots) {
      slot.bot = createBot(slot.index, sim.seed);
      slot.queue.length = 0;
      slot.ackSeq = slot.recvSeq;
    }
    changed();
  };

  host.toLobby = () => {
    backToLobby(sim);
    changed();
  };

  host.setSeconds = (value) => {
    host.seconds = value;
    changed();
  };

  // Stellt eine Einstellung auf eine Stufe. Gilt ab der nächsten Runde.
  host.setLevel = (key, level) => {
    const index = SETTINGS.findIndex((setting) => setting.key === key);
    if (index < 0) return;
    const next = host.levels.slice();
    next[index] = level;
    host.levels = cleanLevels(next);
    changed();
  };

  // Nachricht eines Mitspielers
  host.handle = (id, msg, now) => {
    if (!msg || typeof msg !== 'object') return;
    let slot = slotOf(id);
    if (slot) slot.heard = now;

    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL) {
        sendTo(id, { t: 'old' });
        return;
      }
      if (msg.watch) {
        // Zuschauer ohne Platz (das Vorschaubild auf der Startseite)
        sendTo(id, { t: 'welcome', h: epoch, slot: -1, n: version });
        return;
      }
      const name = String(msg.name || '').trim().slice(0, 14) || 'Namenlos';
      if (!slot) {
        slot = slots.find((candidate) => candidate.kind === 'bot');
        if (!slot) {
          sendTo(id, { t: 'full' });
          return;
        }
        slot.kind = 'human';
        slot.id = id;
      }
      slot.name = name;
      slot.online = true;
      slot.heard = now;
      slot.queue.length = 0;
      slot.recvSeq = 0;
      slot.ackSeq = 0;
      changed();
      sendTo(id, { t: 'welcome', h: epoch, slot: slot.index, n: version });
      return;
    }
    if (msg.t === 'ping') {
      sendTo(id, { t: 'pong', ts: msg.ts });
      return;
    }
    if (!slot) return;

    if (msg.t === 'i' && Array.isArray(msg.c) && Number.isInteger(msg.s)) {
      if (!slot.online) {
        slot.online = true;
        changed();
      }
      const first = msg.s - msg.c.length + 1;
      for (let i = 0; i < msg.c.length; i += 1) {
        const seq = first + i;
        const code = msg.c[i];
        if (seq <= slot.recvSeq || !Number.isInteger(code) || code < 0 || code > MAX_INPUT) continue;
        slot.queue.push({ seq, code });
        slot.recvSeq = seq;
      }
      while (slot.queue.length > QUEUE_MAX) slot.ackSeq = slot.queue.shift().seq;
    } else if (msg.t === 'bye') {
      free(slot);
      changed();
    }
  };

  function inputsFor(slot) {
    const human = slot.kind === 'human' && slot.online;
    if (sim.phase !== PHASE.PLAY) {
      if (slot.queue.length) {
        slot.ackSeq = slot.queue[slot.queue.length - 1].seq;
        slot.queue.length = 0;
      }
      return [];
    }
    if (!human) return [slot.bot ? slot.bot.think(sim) : IDLE];
    // Meist genau eine Eingabe pro Schritt. Staut es sich, zwei auf einmal.
    const q = slot.queue;
    const take = q.length === 0 ? 0 : q.length > (isDirect(slot.id) ? 3 : 7) ? 2 : 1;
    const codes = [];
    for (let i = 0; i < take; i += 1) {
      const item = q.shift();
      codes.push(item.code);
      slot.ackSeq = item.seq;
    }
    return codes;
  }

  function step(now) {
    stepSim(sim, slots.map(inputsFor));
    if (sim.phase === PHASE.END && !endedAt) {
      endedAt = now;
      changed();
    }
    if (sim.phase !== PHASE.END) endedAt = 0;
    // Solange nichts läuft, reicht ein gelegentlicher Stand.
    const live = sim.phase === PHASE.PLAY || sim.phase === PHASE.COUNTDOWN;
    if (live || sim.tick % 12 === 0) broadcast(snapshot(), true);
  }

  function upkeep(now) {
    for (const slot of slots) {
      if (slot.kind !== 'human') continue;
      const silent = now - slot.heard;
      if (slot.online && silent > OFFLINE_MS) {
        slot.online = false;
        slot.queue.length = 0;
        changed();
      }
      const idle = sim.phase === PHASE.LOBBY || sim.phase === PHASE.END;
      if (!slot.online && idle && silent > FREE_MS) {
        free(slot);
        changed();
      }
    }
    if (autoRestart && endedAt && now - endedAt > 4000) host.start();
    if (now >= lobbyDue) {
      lobbyDue = now + 1000;
      broadcast(lobbyMessage(), false);
    }
  }

  // Bringt den Spielstand auf die Zeit `now` (ms).
  host.advance = (now) => {
    if (clock === null) clock = now;
    if (now - clock > 300) clock = now - 300; // nach einer langen Pause nicht alles nachholen
    let steps = 0;
    while (now - clock >= DT * 1000 && steps < 12) {
      clock += DT * 1000;
      step(now);
      steps += 1;
    }
    upkeep(now);
  };

  // Raum schließen: allen Bescheid geben
  host.close = () => broadcast({ t: 'closed', h: epoch }, false);

  host.lobby = lobbyMessage;
  host.ticksPerSecond = TICK_RATE;
  return host;
}

// Leitung ohne Netz: verbindet den Gastgeber mit dem Spiel im selben Fenster.
// Nachrichten gehen als Text hin und her, genau wie über das Netz.
export function createLoopback(host, now) {
  const ends = new Map(); // id -> Empfänger auf der Gegenseite
  host.addLine({
    sendTo(id, msg) {
      const deliver = ends.get(id);
      if (!deliver) return false;
      deliver(JSON.parse(JSON.stringify(msg)));
      return true;
    },
    broadcast(msg) {
      if (!ends.size) return;
      const text = JSON.stringify(msg);
      for (const deliver of ends.values()) deliver(JSON.parse(text));
    },
    isDirect: (id) => ends.has(id),
  });
  return {
    connect(id, deliver) {
      ends.set(id, deliver);
      return {
        send: (msg) => host.handle(id, JSON.parse(JSON.stringify(msg)), now()),
        close: () => ends.delete(id),
        direct: () => true,
        local: true,
      };
    },
  };
}
