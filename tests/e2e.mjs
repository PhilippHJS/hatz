// Spielt im echten Browser mit drei Geräten: Raum öffnen, beitreten, Runde
// spielen, fangen, Rundenende, nächste Runde, Verbindungsstörungen.
// Braucht die devDependencies (npm install) und einen installierten Chrome.
//   node tests/e2e.mjs            Bilder landen in tests/shots/
//   CHROME=/pfad/zu/chrome SHOTS=/tmp/bilder node tests/e2e.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';
import mqtt from 'mqtt';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.env.SHOTS || path.join(root, 'tests', 'shots');
const WEB_PORT = 8124;
const RELAY_PORTS = [9124, 9125];
const RELAYS = RELAY_PORTS.map((port) => `ws://127.0.0.1:${port}`).join(',');
const BASE = `http://127.0.0.1:${WEB_PORT}/`;
fs.mkdirSync(shots, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const web = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(WEB_PORT, '127.0.0.1');

// Lokale Vermittler anstelle der öffentlichen. Lassen sich einzeln abschalten.
async function startBroker(port) {
  const broker = await Aedes.createBroker();
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, req) => broker.handle(createWebSocketStream(socket), req));
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    async stop() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => broker.close(resolve));
    },
  };
}
const brokers = [];
for (const port of RELAY_PORTS) brokers.push(await startBroker(port));

// Ein Fremder, der beim Vermittler alles mitliest.
const overheard = [];
const lurker = mqtt.connect(`ws://127.0.0.1:${RELAY_PORTS[1]}`);
lurker.on('connect', () => lurker.subscribe('#'));
lurker.on('message', (topic, payload) => overheard.push({ topic, text: payload.toString('latin1') }));

const problems = [];
const check = (ok, text) => {
  if (!ok) problems.push(text);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: [
    '--no-sandbox', '--no-proxy-server',
    // damit sich die Fenster auf demselben Rechner direkt finden
    '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns',
  ],
});

async function device(label, viewport = { width: 1366, height: 768 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'de-DE' });
  const page = await context.newPage();
  page.on('pageerror', (err) => problems.push(`${label}: Seitenfehler ${err.message}`));
  page.on('console', (msg) => {
    // Abgeschaltete Vermittler meldet der Browser selbst als Fehler, das gehört zum Test.
    if (msg.type() === 'error' && !/WebSocket|ERR_CONNECTION/.test(msg.text())) problems.push(`${label}: Konsole ${msg.text()}`);
  });
  page.on('dialog', (dialog) => dialog.accept());
  page.label = label;
  return page;
}

const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let devices = []; // die Fenster des laufenden Durchgangs, für die Fehlersuche
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout });
const state = (page) => page.evaluate(() => {
  const s = window.__hatz.session;
  if (!s) return null;
  const v = s.client.view(performance.now());
  return {
    code: s.code, role: s.role, status: s.client.status, slot: s.client.slot,
    phase: v.phase, round: v.round, ready: v.ready, seed: v.maze ? v.maze.seed : null,
    players: v.players.map((p) => ({ x: p.x, y: p.y, score: p.score, name: p.name, kind: p.kind, online: p.online })),
    net: s.status, rtt: s.client.rtt, screen: document.body.dataset.screen,
    lobby: s.client.lobby ? s.client.lobby.slots.map((slot) => `${slot.kind}:${slot.name}:${slot.online}`) : null,
  };
});
// Der gültige Stand beim Gastgeber
const truth = (page) => page.evaluate(() => {
  const sim = window.__hatz.session.host.sim;
  return { tick: sim.tick, phase: sim.phase, ringDir: sim.ringDir, players: sim.players.map((p) => ({ x: p.body.x, y: p.body.y, score: p.score })) };
});
const PLAY = 2;
const END = 3;

async function enter(page, url, name) {
  await page.goto(url);
  await page.fill('#f-name', name);
  await page.click('#b-main');
  await until(page, () => window.__hatz.session && window.__hatz.session.client.status === 'in');
}

async function run(mode) {
  const direct = mode === 'direkt';
  const extra = direct ? '' : '&direkt=0';
  console.log(`\n--- ${direct ? 'mit Direktverbindung' : 'nur über Vermittler'} ---`);
  const host = await device(`Gastgeber/${mode}`, { width: 1440, height: 860 });
  const g1 = await device(`Gast1/${mode}`);
  const g2 = await device(`Gast2/${mode}`, { width: 1280, height: 720 });
  const all = [host, g1, g2];
  devices = all;

  await host.goto(`${BASE}?relay=${RELAYS}${extra}`);
  await sleep(1500);
  if (direct) await shot(host, '01-start');
  await host.fill('#f-name', 'Anna');
  await host.click('#b-main');
  await until(host, () => window.__hatz.session && window.__hatz.session.client.status === 'in');
  const code = (await state(host)).code;
  check(/^[A-Z]{5}$/.test(code), `Raumcode ${code}`);
  check((await host.inputValue('#f-link')).includes(`raum=${code}`), 'Einladungslink enthält den Code');
  await until(host, () => window.__hatz.session.status && window.__hatz.session.status.up === 2);

  const link = `${BASE}?relay=${RELAYS}${extra}&raum=${code}`;
  await g1.goto(link);
  check((await g1.textContent('#invited')).includes(code), 'Eingeladener sieht den Raumcode');
  await g1.fill('#f-name', 'Ben');
  await g1.click('#b-main');
  await until(g1, () => window.__hatz.session && window.__hatz.session.client.status === 'in');
  await enter(g2, link, 'Cem <b>');
  await until(host, () => window.__hatz.session.client.lobby.slots.every((slot) => slot.kind === 'human' && slot.online));
  const lobby = (await state(host)).lobby;
  check(lobby.join() === 'human:Anna:true,human:Ben:true,human:Cem <b>:true', `drei Menschen am Tisch (${lobby})`);

  if (direct) {
    await until(g1, () => window.__hatz.session.status && window.__hatz.session.status.direct, null, 15000).catch(() => {});
    await until(g2, () => window.__hatz.session.status && window.__hatz.session.status.direct, null, 15000).catch(() => {});
    const d1 = (await state(g1)).net.direct;
    const d2 = (await state(g2)).net.direct;
    check(d1 && d2, `Direktverbindung zu beiden Gästen (${d1}, ${d2})`);
    await sleep(600);
    await shot(host, '02-raum');
    await shot(g1, '03-raum-gast');
  } else {
    await sleep(1500);
    check(!(await state(g1)).net.direct, 'ohne Direktverbindung läuft es über die Vermittler');
    check((await g1.textContent('#room-note')).includes('Vermittler'), 'Hinweis nennt den Weg über Vermittler');
  }
  check((await host.innerHTML('#slots')).includes('Cem &lt;b&gt;'), 'Namen werden als Text gezeigt');

  // Gastgeber stellt die Ausdauer auf "viel", die Gäste sehen es, können aber nichts ändern.
  await host.evaluate(() => localStorage.removeItem('hatz-levels'));
  await host.click('#options label:has(input[name="opt-stamina"][value="2"])');
  await until(g1, () => {
    const radio = document.querySelector('#options input[name="opt-stamina"][value="2"]');
    return radio.checked && document.querySelector('#settings').disabled;
  });
  check(true, 'Gast sieht die Einstellung des Gastgebers, ausgegraut');
  await g1.click('#options label:has(input[name="opt-stamina"][value="0"])', { force: true }).catch(() => {});
  await sleep(300);
  const staminaAt = await host.evaluate(() => window.__hatz.session.host.levels.length - 3);
  check((await host.evaluate((i) => window.__hatz.session.host.levels[i], staminaAt)) === 2, 'Gast kann die Einstellung nicht ändern');

  await host.click('#b-start');
  await until(host, () => document.body.dataset.screen === 'game');
  for (const page of all) await until(page, () => document.body.dataset.screen === 'game');
  await sleep(1200);
  if (direct) await shot(g1, '04-countdown');
  for (const page of all) await until(page, (phase) => window.__hatz.view().phase === phase, PLAY);
  const seeds = await Promise.all(all.map(async (page) => (await state(page)).seed));
  check(seeds[0] !== null && seeds.every((seed) => seed === seeds[0]), 'alle haben dasselbe Labyrinth');
  const stamina = await Promise.all(all.map((page) => page.evaluate(() => window.__hatz.view().rules.sprintSeconds)));
  check(stamina.every((value) => value === 3.4), `alle spielen mit der eingestellten Ausdauer (${stamina})`);

  // Jeder läuft los. Die eigene Figur muss sich sofort bewegen und beim Gastgeber ankommen.
  const before = await truth(host);
  // Tasten in Richtungen, in denen vom Startfeld aus kein Hindernis steht
  const openKeys = (page) => page.evaluate(() => {
    const v = window.__hatz.view();
    const m = v.maze;
    const p = v.players[v.slot];
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const keys = [];
    if (!m.v[y * (m.W + 1) + x + 1]) keys.push('KeyD');
    else if (!m.v[y * (m.W + 1) + x]) keys.push('KeyA');
    if (!m.h[(y + 1) * m.W + x]) keys.push('KeyS');
    else if (!m.h[y * m.W + x]) keys.push('KeyW');
    return keys;
  });
  const keys = [];
  for (const page of all) keys.push(await openKeys(page));
  for (let i = 0; i < 3; i += 1) for (const key of keys[i]) await all[i].keyboard.down(key);
  await sleep(1500);
  for (let i = 0; i < 3; i += 1) for (const key of keys[i]) await all[i].keyboard.up(key);
  await sleep(direct ? 500 : 900);
  const after = await truth(host);
  for (let i = 0; i < 3; i += 1) {
    const st = await state(all[i]);
    const moved = Math.hypot(after.players[st.slot].x - before.players[st.slot].x, after.players[st.slot].y - before.players[st.slot].y);
    check(moved > 0.4, `${all[i].label}: Figur hat sich bewegt (${moved.toFixed(2)} Felder)`);
    const own = st.players[st.slot];
    const off = Math.hypot(own.x - after.players[st.slot].x, own.y - after.players[st.slot].y);
    check(off < 0.05, `${all[i].label}: eigene Figur stimmt mit dem Gastgeber überein (${off.toFixed(3)})`);
    let worst = 0;
    for (const p of st.players) worst = Math.max(worst, Math.hypot(p.x - after.players[st.players.indexOf(p)].x, p.y - after.players[st.players.indexOf(p)].y));
    check(worst < 0.3, `${all[i].label}: sieht alle am richtigen Ort (${worst.toFixed(2)})`);
  }
  if (direct) {
    const rtt = (await state(g1)).rtt;
    check(rtt !== null && rtt < 80, `Laufzeit zum Gastgeber ${rtt === null ? '?' : rtt.toFixed(0)} ms`);
  }

  // Ein Fang: Der Gastgeber stellt Jäger und Beute nebeneinander.
  const s1 = await state(g1);
  await host.evaluate((slot) => {
    const sim = window.__hatz.session.host.sim;
    const prey = sim.players[(slot + sim.ringDir + 3) % 3];
    const me = sim.players[slot];
    prey.shield = 0;
    prey.dead = 0;
    me.dead = 0;
    me.body.x = prey.body.x;
    me.body.y = prey.body.y;
    me.tp += 1;
  }, s1.slot);
  // Zählt ab dem Stand davor: Beim Loslaufen kann es schon zufällig einen Fang gegeben haben.
  const wanted = s1.players[s1.slot].score + 1;
  await until(g1, ([slot, score]) => window.__hatz.view().players[slot].score === score, [s1.slot, wanted]);
  await sleep(250);
  if (direct) await shot(g1, '05-fang');
  await sleep(400);
  const scores = await Promise.all(all.map(async (page) => (await state(page)).players.map((p) => p.score).join()));
  check(scores.every((text) => text === scores[0]) && scores[0].includes('-1'), `Punktestand überall gleich (${scores[0]})`);
  check((await g1.textContent('#ring .me .pts')) === String(wanted), 'Anzeige zeigt den Punkt');

  // Die Beute setzt drei Sekunden aus und sieht so lange das ganze Feld.
  const preySlot = (s1.slot + (await truth(host)).ringDir + 3) % 3;
  let preyPage = null;
  for (const page of all) if ((await state(page)).slot === preySlot) preyPage = page;
  const outState = await preyPage.evaluate((slot) => ({
    dead: window.__hatz.view().players[slot].dead,
    banner: document.querySelector('#down').hidden ? '' : document.querySelector('#down').textContent,
    wide: document.querySelector('#wide').style.opacity,
  }), preySlot);
  check(outState.dead > 0 && /gefangen/.test(outState.banner), `Gefangener setzt aus: "${outState.banner}"`);
  check(outState.wide === '1', 'in der Auszeit ist das ganze Feld zu sehen');
  check(await g1.evaluate(() => Boolean(document.querySelector('#ring .chip.out'))), 'der Jäger sieht, dass seine Beute aussetzt');
  if (direct) await shot(preyPage, '05b-auszeit');
  const diedAt = Date.now();
  await until(preyPage, (slot) => window.__hatz.view().players[slot].dead === 0, preySlot, 8000);
  const waited = (Date.now() - diedAt + 900) / 1000;
  check(waited > 2.2 && waited < 4.2, `Wiedereinstieg nach rund drei Sekunden (${waited.toFixed(1)} s seit dem Fang)`);
  await sleep(400);
  const backState = await preyPage.evaluate(() => ({ banner: document.querySelector('#down').hidden, wide: document.querySelector('#wide').style.opacity }));
  check(backState.banner && backState.wide === '0', 'danach wieder nur der eigene Sichtkreis');

  if (direct) {
    // Bild einer Begegnung: Gast 1 sieht Beute und Jäger
    await host.evaluate((slot) => {
      const sim = window.__hatz.session.host.sim;
      const me = sim.players[slot];
      const m = sim.maze;
      // ein Feld mit freier Sicht nach links und rechts suchen
      for (let y = 0; y < m.H; y += 1) {
        for (let x = 1; x < m.W - 1; x += 1) {
          const open = (cx) => !m.v[y * (m.W + 1) + cx];
          if (open(x) && open(x + 1) && open(x - 1) && open(x + 2)) {
            me.body.x = x + 0.5; me.body.y = y + 0.5;
            const prey = sim.players[(slot + sim.ringDir + 3) % 3];
            const hunter = sim.players[(slot - sim.ringDir + 3) % 3];
            prey.body.x = x + 2.4; prey.body.y = y + 0.5;
            hunter.body.x = x - 1.4; hunter.body.y = y + 0.5;
            for (const p of sim.players) { p.tp += 1; p.body.vx = 0; p.body.vy = 0; p.dead = 0; p.shield = 0; }
            return;
          }
        }
      }
    }, s1.slot);
    await sleep(500);
    await shot(g1, '06-begegnung');
  }

  if (!direct) {
    // Ein Vermittler fällt aus: Das Spiel läuft über den anderen weiter.
    await brokers[0].stop();
    await sleep(800);
    // in Richtungen laufen, in denen keine Hecke im Weg steht (und nicht während einer Auszeit)
    await until(g1, (slot) => window.__hatz.view().players[slot].dead === 0, s1.slot, 8000);
    const b = await truth(host);
    const away = await openKeys(g1);
    for (const key of away) await g1.keyboard.down(key);
    await sleep(1200);
    for (const key of away) await g1.keyboard.up(key);
    await sleep(700);
    const a = await truth(host);
    const moved = Math.hypot(a.players[s1.slot].x - b.players[s1.slot].x, a.players[s1.slot].y - b.players[s1.slot].y);
    check(moved > 0.3, `nach Ausfall eines Vermittlers kommt die Eingabe noch an (${moved.toFixed(2)} Felder)`);
    brokers[0] = await startBroker(RELAY_PORTS[0]);
  }

  if (direct) {
    // Items: Gast 2 bekommt eine Falle (geheim) und dann einen Blitz (für alle sichtbar)
    const s2slot = (await state(g2)).slot;
    const give = (item) => host.evaluate(([slot, index]) => {
      const sim = window.__hatz.session.host.sim;
      sim.players[slot].item = index;
    }, [s2slot, item]);
    const ids = await host.evaluate(async () => (await import('/js/config.js')).ITEM);
    await give(ids.trap);
    await until(g2, () => !document.querySelector('#slot .full') === false);
    check((await g2.textContent('#slot')).includes('Falle'), 'Gast sieht sein Item im Vorrat');
    check(!(await g1.textContent('#slot')).includes('Falle'), 'die anderen sehen es nicht');
    await g2.keyboard.press('KeyE');
    await until(host, (slot) => window.__hatz.session.host.sim.players[slot].item === -1, s2slot);
    await sleep(500);
    check((await g2.textContent('#feed')).includes('Falle gelegt'), 'Gast bekommt Rückmeldung zur Falle');
    check(!(await g1.textContent('#feed')).includes('Falle'), 'die Falle bleibt für die anderen geheim');
    await give(ids.bolt);
    await until(g2, () => Boolean(document.querySelector('#slot .full')));
    await g2.keyboard.press('KeyE');
    await until(g1, () => !document.querySelector('#banner').hidden, null, 5000);
    const banner = await g1.textContent('#banner');
    check(/Blitz/.test(banner), `alle sehen den Blitz: "${banner}"`);
    check((await g1.textContent('#feed')).includes('Blitz von'), 'Meldung nennt, wer geblitzt hat');
    const frozen = await g1.evaluate(() => window.__hatz.view().players[window.__hatz.view().slot].fz);
    check(frozen > 0, 'die anderen sind gelähmt');
    await sleep(120);
    await shot(g1, '05c-blitz');
    await sleep(1500);
  }

  // Gast lädt mitten in der Runde neu und sitzt wieder auf seinem Platz.
  const s2 = await state(g2);
  await g2.reload();
  await until(g2, () => window.__hatz.session && window.__hatz.session.client.status === 'in' && window.__hatz.view().ready, null, 20000);
  const s2b = await state(g2);
  check(s2b.slot === s2.slot && s2b.phase === PLAY, `nach dem Neuladen wieder auf Platz ${s2.slot}`);

  // Rundenende
  await host.evaluate(() => {
    const sim = window.__hatz.session.host.sim;
    sim.phaseEnd = sim.tick + 90;
  });
  for (const page of all) await until(page, (phase) => window.__hatz.view().phase === phase && document.body.dataset.screen === 'room', END);
  await sleep(500);
  const title = await g1.textContent('#room-title');
  check(/gewinn|Unentschieden/.test(title), `Ergebnis beim Gast: "${title}"`);
  if (direct) {
    await shot(g1, '07-ergebnis');
    await shot(host, '08-ergebnis-gastgeber');
  }
  check(await g1.isHidden('#b-start'), 'nur der Gastgeber kann starten');

  // nächste Runde mit neuem Labyrinth
  await host.click('#b-start');
  for (const page of all) await until(page, (old) => window.__hatz.view().round === 2 && window.__hatz.view().maze.seed !== old, seeds[0]);
  check(true, 'zweite Runde beginnt bei allen mit neuem Labyrinth');

  if (direct) {
    // Gastgeber lädt neu: Der Raum steht unter demselben Code wieder, die Gäste finden zurück.
    await host.reload();
    await until(host, () => window.__hatz.session && window.__hatz.session.role === 'host');
    await until(host, () => window.__hatz.session.client.lobby && window.__hatz.session.client.lobby.slots.filter((slot) => slot.kind === 'human' && slot.online).length === 3, null, 30000);
    check((await state(host)).code === code, 'Gastgeber lädt neu, Raum und Gäste sind wieder da');
    for (const page of [g1, g2]) await until(page, () => window.__hatz.session.client.status === 'in' && document.body.dataset.screen === 'room');
  }

  for (const page of all) await page.context().close();
}

try {
  await run('direkt');
  await run('vermittler');

  // Enges Fenster: Startseite bleibt bedienbar
  const phone = await device('Handy', { width: 390, height: 780 });
  await phone.goto(`${BASE}?relay=${RELAYS}`);
  await sleep(1200);
  await shot(phone, '09-schmal');
  check(await phone.isVisible('#b-main'), 'Startseite passt auf ein schmales Fenster');
  await phone.context().close();

  await sleep(300);
  check(overheard.length > 50, `Mitleser hat ${overheard.length} Nachrichten gesehen`);
  // Nur Muster ab vier Zeichen: Drei Buchstaben wie "Ben" tauchen in tausenden
  // Zufallsbytes der verschlüsselten Daten gelegentlich zufällig auf.
  const leaked = overheard.find((entry) => /Anna|Cem <|"name"|"t":"|lobby|welcome|hello/.test(entry.text) || /Anna|Ben|Cem/.test(entry.topic));
  check(!leaked, `Mitleser findet weder Namen noch Klartext${leaked ? ` (${leaked.topic})` : ''}`);
} catch (err) {
  problems.push(`Abbruch: ${err.stack || err}`);
  // Was sehen die Fenster in diesem Moment?
  for (const page of devices) {
    try {
      console.log(`     ${page.label}: ${JSON.stringify(await state(page))}`);
      if (page === devices[0]) console.log(`     Spielstand: ${JSON.stringify(await truth(page))}`);
    } catch (inner) {
      console.log(`     ${page.label}: nicht mehr erreichbar (${inner.message.split('\n')[0]})`);
    }
  }
  console.log(`FAIL Abbruch: ${err.message}`);
}

await browser.close();
lurker.end(true);
for (const broker of brokers) await broker.stop();
web.close();
console.log(problems.length ? `\n${problems.length} Problem(e):\n${problems.join('\n')}` : '\nAlles in Ordnung.');
process.exit(problems.length ? 1 : 0);
