// Die Sicht eines Geräts auf das Spiel.
//
// Die eigene Figur wird sofort bei jedem Tastendruck vorausberechnet, ohne auf
// den Gastgeber zu warten. Kommt dessen gültiger Stand an, werden die noch
// unbestätigten Eingaben darauf erneut angewendet. Weicht das vom Gezeigten
// ab, gleitet die Figur unmerklich dorthin statt zu springen. Die Mitspieler
// werden mit einer kleinen Verzögerung zwischen zwei bekannten Ständen bewegt,
// damit sie auch bei unruhiger Verbindung flüssig laufen.

import { buildMaze } from './maze.js';
import { newBody, copyBody, stepBody, IDLE } from './physics.js';
import { preyOf, hunterOf, PHASE } from './sim.js';
import { DT, TICK_RATE, PROTOCOL, WISPS } from './config.js';

const STEP_MS = DT * 1000;
const LOST_MS = 5000;

export function createClient({ id, name, watch = false, link }) {
  const client = {
    id,
    name,
    status: 'joining', // joining | in | full | old | lost | closed
    slot: -1,
    lobby: null,
    maze: null,
    latest: null,
    rtt: null,
    effects: [], // Ereignisse fürs Zeichnen, werden dort abgeholt
  };

  const snaps = []; // nach Schrittnummer sortiert
  const pending = []; // eigene Eingaben, die der Gastgeber noch nicht bestätigt hat
  const me = newBody(0, 0);
  const mePrev = newBody(0, 0);
  const err = { x: 0, y: 0 };
  const seenEvents = new Set();
  const recent = []; // die letzten Eingaben, zum mehrfachen Mitschicken
  let seq = 0;
  let myTp = -1;
  let haveMe = false;
  let alpha = 1;
  let acc = 0;
  let lastFrame = null;
  let lastHello = -1e9;
  let lastPing = 0;
  let lastHeard = null;
  let stepsSinceSend = 0;
  let epoch = null; // Kennung des Gastgebers, wechselt, wenn er neu lädt
  let welcomeN = 0;

  // Uhrenabgleich: Schrittnummer des Gastgebers als Funktion der eigenen Zeit
  const samples = [];
  let interval = 1;
  let delay = 3;
  let lastSnapK = null;

  function hostTickAt(now) {
    let best = -Infinity;
    for (const s of samples) if (s.v > best) best = s.v;
    return best + now / STEP_MS;
  }

  function renderMe(out) {
    out.x = mePrev.x + (me.x - mePrev.x) * alpha + err.x;
    out.y = mePrev.y + (me.y - mePrev.y) * alpha + err.y;
    return out;
  }
  const before = { x: 0, y: 0 };
  const after = { x: 0, y: 0 };

  function loadBody(body, arr) {
    body.x = arr[0];
    body.y = arr[1];
    body.vx = arr[2];
    body.vy = arr[3];
    body.st = arr[4];
    body.ex = (arr[5] & 1) !== 0;
    body.sp = (arr[5] & 2) !== 0;
    body.hot = (arr[5] & 4) !== 0;
    body.rw = arr[6];
  }

  // Gültigen Stand übernehmen und die offenen Eingaben erneut anwenden
  function reconcile(snap) {
    const arr = snap.p[client.slot];
    const ack = snap.a[client.slot];
    while (pending.length && pending[0].seq <= ack) pending.shift();
    renderMe(before);
    loadBody(me, arr);
    copyBody(me, mePrev);
    if (snap.ph === PHASE.PLAY && client.maze) {
      for (let i = 0; i < pending.length; i += 1) {
        if (i === pending.length - 1) copyBody(me, mePrev);
        stepBody(client.maze, me, pending[i].code);
      }
    }
    renderMe(after);
    const jumped = arr[9] !== myTp || !haveMe;
    myTp = arr[9];
    haveMe = true;
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    if (jumped || dx * dx + dy * dy > 2.25) {
      err.x = 0;
      err.y = 0;
    } else {
      err.x += dx;
      err.y += dy;
    }
  }

  function onSnapshot(snap, now) {
    if (!Array.isArray(snap.p) || snap.p.length !== 3) return;
    // Nachzügler aus einer alten Runde oder von vor langer Zeit ignorieren
    if (client.latest && (snap.rn < client.latest.rn || snap.k < client.latest.k - 2 * TICK_RATE)) return;
    const wantSeed = snap.rn > 0 ? snap.sd : null;
    const haveSeed = client.maze ? client.maze.seed : null;
    if (wantSeed !== haveSeed || (client.latest && snap.rn !== client.latest.rn)) {
      if (wantSeed !== haveSeed) client.maze = wantSeed === null ? null : buildMaze(wantSeed);
      snaps.length = 0;
      seenEvents.clear();
    }

    // einsortieren, Doppelte verwerfen
    let at = snaps.length;
    while (at > 0 && snaps[at - 1].k > snap.k) at -= 1;
    if (at > 0 && snaps[at - 1].k === snap.k) return;
    snaps.splice(at, 0, snap);
    while (snaps.length > 2 && snaps[snaps.length - 1].k - snaps[0].k > 2 * TICK_RATE) snaps.shift();

    samples.push({ v: snap.k - now / STEP_MS, at: now });
    while (samples.length > 1 && now - samples[0].at > 2500) samples.shift();
    if (lastSnapK !== null && snap.k > lastSnapK) interval += (Math.min(snap.k - lastSnapK, 12) - interval) * 0.1;
    if (lastSnapK === null || snap.k > lastSnapK) lastSnapK = snap.k;

    for (const e of snap.e || []) {
      if (seenEvents.has(e[0])) continue;
      seenEvents.add(e[0]);
      // Beim Einstieg mitten in der Runde keine alten Ereignisse nachspielen
      if (client.latest) client.effects.push({ type: 'catch', id: e[0], tick: e[1], by: e[2], of: e[3], x: e[4], y: e[5] });
    }

    if (!client.latest || snap.k > client.latest.k) {
      client.latest = snap;
      if (client.slot >= 0) reconcile(snap);
    }
  }

  function forget() {
    client.status = 'joining';
    client.slot = -1;
    client.lobby = null;
    client.latest = null;
    client.maze = null;
    snaps.length = 0;
    samples.length = 0;
    pending.length = 0;
    seenEvents.clear();
    haveMe = false;
    lastSnapK = null;
    lastHello = -1e9;
    welcomeN = 0;
  }

  client.receive = (msg, now) => {
    if (!msg || typeof msg !== 'object') return;
    lastHeard = now;
    if (client.status === 'lost') client.status = client.slot >= 0 || watch ? 'in' : 'joining';
    if (msg.h !== undefined && msg.h !== epoch) {
      // Der Gastgeber hat neu geladen: alles Alte vergessen und neu anmelden
      if (epoch !== null) forget();
      epoch = msg.h;
    }
    if (msg.t === 's') {
      if (client.status === 'in') onSnapshot(msg, now);
    } else if (msg.t === 'lobby') {
      if (client.lobby && msg.n < client.lobby.n) return;
      client.lobby = msg;
      // Der Gastgeber kennt uns nicht (mehr): neu anmelden
      if (client.status === 'in' && !watch && msg.n >= welcomeN && !msg.slots.some((slot) => slot.id === id)) {
        client.status = 'joining';
        client.slot = -1;
        haveMe = false;
      }
    } else if (msg.t === 'welcome') {
      client.status = 'in';
      welcomeN = msg.n || 0;
      if (client.slot !== msg.slot) {
        client.slot = msg.slot;
        pending.length = 0;
        haveMe = false;
      }
    } else if (msg.t === 'full') {
      if (client.status !== 'in') client.status = 'full';
    } else if (msg.t === 'closed') {
      client.status = 'closed';
    } else if (msg.t === 'old') {
      client.status = 'old';
    } else if (msg.t === 'pong') {
      const rtt = now - msg.ts;
      if (rtt >= 0 && rtt < 5000) client.rtt = client.rtt === null ? rtt : client.rtt + (rtt - client.rtt) * 0.3;
    }
  };

  // Einmal pro Bild: Zeit vorrücken, Eingabe anwenden und verschicken.
  client.frame = (now, inputCode = IDLE) => {
    if (lastFrame === null) lastFrame = now;
    let elapsed = now - lastFrame;
    lastFrame = now;
    if (elapsed > 250) elapsed = STEP_MS; // Fenster war im Hintergrund
    acc += elapsed;

    if (lastHeard !== null && now - lastHeard > LOST_MS && (client.status === 'in' || client.status === 'joining')) client.status = 'lost';
    // Anklopfen, bis der Gastgeber antwortet. Ist der Raum voll, seltener nachfragen.
    const knock = client.status === 'full' ? 3000 : 1000;
    if ((client.status === 'joining' || client.status === 'lost' || client.status === 'full') && now - lastHello > knock) {
      lastHello = now;
      link.send({ t: 'hello', name: client.name, v: PROTOCOL, watch: watch || undefined }, false);
    }
    if (now - lastPing > 1000) {
      lastPing = now;
      link.send({ t: 'ping', ts: now }, false);
    }

    // Eingaben nur schicken, solange eine Runde läuft oder gleich beginnt
    const phase = client.latest ? client.latest.ph : PHASE.LOBBY;
    const playing = client.status === 'in' && client.slot >= 0 && haveMe
      && (phase === PHASE.PLAY || phase === PHASE.COUNTDOWN);
    while (acc >= STEP_MS) {
      acc -= STEP_MS;
      if (!playing) continue;
      seq += 1;
      pending.push({ seq, code: inputCode });
      if (pending.length > 240) pending.shift();
      copyBody(me, mePrev);
      if (client.latest && client.latest.ph === PHASE.PLAY && client.maze) stepBody(client.maze, me, inputCode);
      recent.push(inputCode);
      if (recent.length > 8) recent.shift();
      stepsSinceSend += 1;
      const direct = link.direct();
      if (stepsSinceSend >= (direct ? 1 : 2)) {
        stepsSinceSend = 0;
        const count = Math.min(recent.length, direct ? 4 : 8);
        link.send({ t: 'i', s: seq, c: recent.slice(recent.length - count) }, true);
      }
    }
    alpha = acc / STEP_MS;

    const fade = Math.exp(-elapsed / 70);
    err.x *= fade;
    err.y *= fade;

    // Verzögerung für die Mitspieler an die Verbindung anpassen
    if (samples.length) {
      let best = -Infinity;
      let worst = Infinity;
      for (const s of samples) {
        if (s.v > best) best = s.v;
        if (s.v < worst) worst = s.v;
      }
      const target = Math.min(Math.max(interval + (best - worst) + 0.5, 1.5), 30);
      delay += (target - delay) * (target > delay ? 0.2 : 0.02);
    }
  };

  const lerpOut = { x: 0, y: 0, vx: 0, vy: 0, tp: 0 };
  function remoteAt(slot, tick) {
    const n = snaps.length;
    if (!n) return null;
    let b = 0;
    while (b < n && snaps[b].k <= tick) b += 1;
    if (b === 0) {
      const p = snaps[0].p[slot];
      lerpOut.x = p[0]; lerpOut.y = p[1]; lerpOut.vx = p[2]; lerpOut.vy = p[3]; lerpOut.tp = p[9];
      return lerpOut;
    }
    const pa = snaps[b - 1].p[slot];
    lerpOut.tp = pa[9];
    if (b === n) {
      // neuester Stand ist schon älter: kurz in Laufrichtung weiterdenken
      const ahead = Math.min(tick - snaps[n - 1].k, 8) * DT;
      const moving = snaps[n - 1].ph === PHASE.PLAY ? 1 : 0;
      lerpOut.x = pa[0] + pa[2] * ahead * moving;
      lerpOut.y = pa[1] + pa[3] * ahead * moving;
      lerpOut.vx = pa[2]; lerpOut.vy = pa[3];
      return lerpOut;
    }
    const pb = snaps[b].p[slot];
    if (pa[9] !== pb[9]) {
      lerpOut.x = pa[0]; lerpOut.y = pa[1]; lerpOut.vx = 0; lerpOut.vy = 0;
      return lerpOut;
    }
    const f = (tick - snaps[b - 1].k) / (snaps[b].k - snaps[b - 1].k);
    lerpOut.x = pa[0] + (pb[0] - pa[0]) * f;
    lerpOut.y = pa[1] + (pb[1] - pa[1]) * f;
    lerpOut.vx = pb[2]; lerpOut.vy = pb[3];
    return lerpOut;
  }

  const view = {
    ready: false, phase: PHASE.LOBBY, round: 0, ticksLeft: 0, tick: 0, maze: null, ringDir: 1,
    slot: -1, prey: -1, hunter: -1,
    players: [0, 1, 2].map((slot) => ({
      slot, x: 0, y: 0, vx: 0, vy: 0, st: 1, ex: false, sp: false, hot: false,
      score: 0, shield: 0, tp: 0, name: WISPS[slot].name, kind: 'bot', online: true, mine: false,
    })),
  };

  // Alles, was gezeichnet wird, für den Zeitpunkt `now`.
  client.view = (now) => {
    const latest = client.latest;
    view.ready = Boolean(latest && client.maze && latest.rn > 0);
    view.slot = client.slot;
    if (!latest) return view;
    const hostTick = hostTickAt(now);
    view.phase = latest.ph;
    view.round = latest.rn;
    view.maze = client.maze;
    view.ringDir = latest.rd;
    view.tick = hostTick;
    view.ticksLeft = Math.max(0, latest.pe - hostTick);
    view.prey = client.slot >= 0 ? preyOf(latest.rd, client.slot) : -1;
    view.hunter = client.slot >= 0 ? hunterOf(latest.rd, client.slot) : -1;
    const renderTick = hostTick - delay;
    for (const out of view.players) {
      const arr = latest.p[out.slot];
      const info = client.lobby && client.lobby.slots[out.slot];
      out.mine = out.slot === client.slot;
      if (out.mine && haveMe) {
        renderMe(out);
        out.vx = me.vx; out.vy = me.vy; out.st = me.st; out.ex = me.ex; out.sp = me.sp;
      } else {
        const r = remoteAt(out.slot, renderTick);
        if (r) {
          out.x = r.x; out.y = r.y; out.vx = r.vx; out.vy = r.vy;
        }
        out.st = arr[4]; out.ex = (arr[5] & 1) !== 0; out.sp = (arr[5] & 2) !== 0;
      }
      out.hot = (arr[5] & 4) !== 0;
      out.score = arr[7];
      out.shield = arr[8];
      // Der Sprung an einen neuen Ort gilt erst, wenn er auch zu sehen ist.
      out.tp = out.mine ? arr[9] : lerpOut.tp;
      if (info) {
        out.name = info.name;
        out.kind = info.kind;
        out.online = info.online;
      }
    }
    return view;
  };

  client.delayMs = () => delay * STEP_MS;
  client.leave = () => link.send({ t: 'bye' }, false);
  client.debug = () => ({ pending: pending.length, err: Math.sqrt(err.x * err.x + err.y * err.y), delay, interval, seq, me: copyBody(me) });
  return client;
}
