// Oberfläche: Startseite, Raum, Anzeige im Spiel. Verdrahtet Gastgeber,
// eigenes Spiel, Netz, Tastatur und Leinwand.

import { createHost, createLoopback } from './host.js';
import { createClient } from './client.js';
import { createRenderer } from './render.js';
import { createKeyboard } from './input.js';
import { createHostNet, createGuestNet, makeRoomCode, cleanCode, makeId, supported, DEFAULT_RELAYS } from './net.js';
import { PHASE, ranking } from './sim.js';
import { WISPS, TICK_RATE, ROUND_SECONDS } from './config.js';

const $ = (selector) => document.querySelector(selector);
const now = () => performance.now();
const params = new URLSearchParams(location.search);
// Für Tests: eigene Vermittler (?relay=ws://…,ws://…) und ohne Direktverbindung (?direkt=0)
const relays = params.get('relay') ? params.get('relay').split(',').filter(Boolean) : DEFAULT_RELAYS;
const useRtc = params.get('direkt') !== '0';

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function load(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function save(store, key, value) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Speicher gesperrt: dann eben ohne
  }
}

const myId = load(sessionStorage, 'hatz-id') || makeId();
save(sessionStorage, 'hatz-id', myId);

const canvas = $('#stage');
const renderer = createRenderer(canvas);
const keyboard = createKeyboard(window);

let session = null; // { role, code, host, client, net, status, since }
let invite = cleanCode(params.get('raum'));
let playSince = 0;

// ---------- Vorschau auf der Startseite: drei Bots jagen sich ----------

function createDemo() {
  const host = createHost({ seconds: 75, autoRestart: true });
  const loop = createLoopback(host, now);
  let client = null;
  const link = loop.connect('vorschau', (msg) => client.receive(msg, now()));
  client = createClient({ id: 'vorschau', name: '', watch: true, link });
  host.start();
  return { host, client };
}
const demo = createDemo();
let demoWanted = true;

// ---------- Raum betreten und verlassen ----------

function setUrl(code) {
  const next = new URLSearchParams(location.search);
  if (code) next.set('raum', code);
  else next.delete('raum');
  const query = next.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
  document.title = code ? `Hatz, Raum ${code}` : 'Hatz';
}

function openRoom(code) {
  const name = load(localStorage, 'hatz-name') || 'Gastgeber';
  const seconds = Number(load(localStorage, 'hatz-seconds')) || ROUND_SECONDS;
  const host = createHost({ seconds });
  const loop = createLoopback(host, now);
  let client = null;
  const link = loop.connect(myId, (msg) => client.receive(msg, now()));
  client = createClient({ id: myId, name, link });
  const mine = { role: 'host', code, host, client, net: null, status: null, since: now() };
  if (supported()) {
    mine.net = createHostNet({
      room: code,
      urls: relays,
      host,
      localId: myId,
      now,
      useRtc,
      onStatus: (status) => {
        mine.status = status;
      },
      onConflict: () => {
        // Jemand anderes führt unter diesem Code schon einen Raum: neuen Code nehmen.
        if (session !== mine || host.slots.some((slot) => slot.kind === 'human' && slot.id !== myId)) return;
        closeSession();
        openRoom(makeRoomCode());
      },
    });
  }
  session = mine;
  save(sessionStorage, 'hatz-room', JSON.stringify({ code, role: 'host' }));
  setUrl(code);
}

function joinRoom(code) {
  const name = load(localStorage, 'hatz-name') || 'Gast';
  let client = null;
  const mine = { role: 'guest', code, host: null, client: null, net: null, status: null, since: now() };
  mine.net = createGuestNet({
    room: code,
    urls: relays,
    id: myId,
    now,
    useRtc,
    onMessage: (msg) => client.receive(msg, now()),
    onStatus: (status) => {
      mine.status = status;
    },
  });
  client = createClient({ id: myId, name, link: mine.net.link });
  mine.client = client;
  session = mine;
  save(sessionStorage, 'hatz-room', JSON.stringify({ code, role: 'guest' }));
  setUrl(code);
}

function closeSession() {
  if (!session) return;
  if (session.host) session.host.close();
  else session.client.leave();
  const net = session.net;
  // dem Abschied noch kurz Zeit geben, bevor die Leitung zugeht
  if (net) setTimeout(() => net.stop(), 300);
  session = null;
  keyboard.setEnabled(false);
}

function leaveRoom() {
  if (!session) return;
  if (session.role === 'host') {
    const guests = session.host.slots.filter((slot) => slot.kind === 'human' && slot.id !== myId && slot.online).length;
    if (guests > 0 && !window.confirm('Wenn du gehst, endet der Raum für alle. Wirklich verlassen?')) return;
  }
  closeSession();
  save(sessionStorage, 'hatz-room', null);
  invite = '';
  setUrl('');
  demoWanted = true;
  showStartMode();
}

// ---------- Startseite ----------

function showStartMode() {
  const invited = Boolean(invite);
  $('#invited').hidden = !invited;
  $('#invited').textContent = invited ? `Du bist in den Raum ${invite} eingeladen.` : '';
  $('#b-main').textContent = invited ? 'Beitreten' : 'Raum erstellen';
  $('#join').hidden = invited;
  $('#b-own').hidden = !invited;
  const touchOnly = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
  $('#start-note').textContent = touchOnly ? 'Gespielt wird mit der Tastatur. Am Handy geht es noch nicht.' : '';
  $('#start-note').classList.remove('bad');
}

function takeName() {
  const name = $('#f-name').value.trim().slice(0, 14);
  if (!name) {
    $('#start-note').textContent = 'Gib zuerst einen Namen ein.';
    $('#start-note').classList.add('bad');
    $('#f-name').focus();
    return false;
  }
  save(localStorage, 'hatz-name', name);
  return true;
}

function tryJoin(code) {
  if (!supported()) {
    $('#start-note').textContent = 'Dieser Browser kann keine Verbindung aufbauen. Nimm einen aktuellen Browser und öffne die Seite über https.';
    $('#start-note').classList.add('bad');
    return;
  }
  joinRoom(code);
}

$('#f-name').value = load(localStorage, 'hatz-name') || '';
$('#enter').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!takeName()) return;
  if (invite) tryJoin(invite);
  else openRoom(makeRoomCode());
});
$('#join').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = cleanCode($('#f-code').value);
  if (!code) {
    $('#start-note').textContent = 'Der Raumcode besteht aus fünf Buchstaben.';
    $('#start-note').classList.add('bad');
    $('#f-code').focus();
    return;
  }
  if (takeName()) tryJoin(code);
});
$('#b-own').addEventListener('click', () => {
  invite = '';
  setUrl('');
  showStartMode();
});

// ---------- Raum ----------

$('#b-start').addEventListener('click', () => {
  if (session && session.host) session.host.start();
});
$('#b-leave').addEventListener('click', leaveRoom);
$('#b-quit').addEventListener('click', leaveRoom);
$('#length').addEventListener('change', (event) => {
  if (!session || !session.host || event.target.name !== 'seconds') return;
  const seconds = Number(event.target.value);
  session.host.setSeconds(seconds);
  save(localStorage, 'hatz-seconds', String(seconds));
});
$('#b-copy').addEventListener('click', async () => {
  const input = $('#f-link');
  let ok = false;
  try {
    await navigator.clipboard.writeText(input.value);
    ok = true;
  } catch {
    input.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
  }
  $('#b-copy').textContent = ok ? 'Link kopiert' : 'Bitte von Hand kopieren';
  setTimeout(() => {
    $('#b-copy').textContent = 'Link kopieren';
  }, 1800);
});

function wispSvg(slot) {
  const wisp = WISPS[slot];
  const amp = wisp.lobes === 4 ? 0.12 : wisp.lobes === 3 ? 0.14 : 0;
  const phase = wisp.lobes === 3 ? Math.PI * 1.5 : 0;
  const points = [];
  for (let k = 0; k < 48; k += 1) {
    const th = (k / 48) * Math.PI * 2;
    const r = 11.5 * (1 + amp * Math.cos(wisp.lobes * th + phase));
    points.push(`${(16 + Math.cos(th) * r).toFixed(1)},${(16 + Math.sin(th) * r).toFixed(1)}`);
  }
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><polygon points="${points.join(' ')}" fill="${wisp.color}" stroke="${wisp.deep}" stroke-width="1.5" stroke-linejoin="round"/>`
    + '<ellipse cx="12.4" cy="15" rx="1.5" ry="2.4" fill="#101a30"/><ellipse cx="19.6" cy="15" rx="1.5" ry="2.4" fill="#101a30"/></svg>';
}
const HUNTS = '<svg class="hunts" viewBox="0 0 24 16" aria-hidden="true"><path d="M2 8h17M13 2.5 19.5 8 13 13.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// DOM nur anfassen, wenn sich wirklich etwas geändert hat
const shown = {};
function put(key, value, apply) {
  if (shown[key] === value) return;
  shown[key] = value;
  apply(value);
}

function netNote() {
  const st = session.status;
  const age = now() - session.since;
  const rtt = session.client.rtt === null ? '' : ` (${Math.round(session.client.rtt)} ms)`;
  if (session.role === 'host') {
    if (!supported() || (st && st.failed)) return ['Dieser Browser kann keine Verbindung aufbauen. Alleine gegen Bots geht es trotzdem.', true];
    if (!st || st.up === 0) {
      if (st && st.everUp) return ['Verbindung zu den Vermittlern unterbrochen. Neuer Versuch läuft.', true];
      if (age > 8000) return ['Noch keine Verbindung zu den Vermittlern. Mitspieler können gerade nicht beitreten.', true];
      return ['Raum wird geöffnet …', false];
    }
    return [`Raum ist offen, ${st.up} von ${st.total} Vermittlern erreichbar.`, false];
  }
  const status = session.client.status;
  if (status === 'closed') return ['Der Gastgeber hat den Raum geschlossen.', true];
  if (status === 'full') return ['Der Raum ist schon voll. Sobald ein Platz frei wird, bist du drin.', true];
  if (status === 'old') return ['Diese Seite ist veraltet. Lade sie neu.', true];
  if (!st || st.up === 0) {
    if (age > 8000) return ['Keine Verbindung zu den Vermittlern. Prüfe dein Internet.', true];
    return ['Verbinde …', false];
  }
  if (!st.hostSeen) {
    if (age > 7000) return ['Unter diesem Code ist gerade kein Raum offen. Es wird weiter gesucht.', true];
    return ['Suche den Raum …', false];
  }
  if (status === 'lost') return ['Verbindung zum Gastgeber verloren. Neuer Versuch läuft.', true];
  if (status === 'joining') return ['Trete bei …', false];
  if (st.direct) return [`Direkt verbunden${rtt}.`, false];
  return [`Über Vermittler verbunden${rtt}. Eine direkte Leitung wird versucht.`, false];
}

function updateRoom(view) {
  const client = session.client;
  const lobby = client.lobby;
  const isHost = session.role === 'host';
  const ended = view.ready && view.phase === PHASE.END && client.status === 'in';
  const scores = view.players.map((p) => p.score);
  const names = lobby ? lobby.slots.map((slot) => slot.name) : WISPS.map((w) => w.name);

  let title = `Raum <span class="code">${session.code}</span>`;
  let lead = isHost ? 'Schick den Link an deine Mitspieler. Freie Plätze übernehmen Bots.' : 'Der Gastgeber startet die Runde.';
  if (ended) {
    const order = ranking(scores);
    const tie = order[0].score === order[1].score;
    title = tie ? 'Unentschieden' : order[0].slot === client.slot ? 'Du gewinnst' : `${esc(names[order[0].slot])} gewinnt`;
    lead = `Runde ${view.round} ist vorbei.${isHost ? '' : ' Der Gastgeber startet die nächste.'}`;
  }
  put('title', title, (v) => {
    $('#room-title').innerHTML = v;
  });
  put('lead', lead, (v) => {
    $('#room-lead').textContent = v;
  });

  const order = ended ? ranking(scores).map((entry) => entry.slot) : [0, 1, 2];
  const rows = order.map((slot) => {
    const info = lobby ? lobby.slots[slot] : { name: WISPS[slot].name, kind: 'bot', id: null, online: true };
    const tag = info.id === myId ? 'du' : info.kind === 'bot' ? 'Bot' : '';
    let state = '';
    if (ended) state = `<span class="pts">${scores[slot]}</span>`;
    else if (info.kind === 'human' && !info.online) state = '<span class="state">getrennt</span>';
    else if (info.kind === 'human' && isHost && info.id !== myId) state = `<span class="state">${session.net && session.net.isDirect(info.id) ? 'direkt verbunden' : 'über Vermittler'}</span>`;
    else if (info.kind === 'human') state = '<span class="state">bereit</span>';
    else state = '<span class="state">frei</span>';
    return `<li>${wispSvg(slot)}<span class="who">${esc(info.name)}${tag ? `<small>${tag}</small>` : ''}</span>${state}</li>`;
  }).join('');
  put('slots', rows, (v) => {
    $('#slots').innerHTML = v;
  });

  const linkParams = new URLSearchParams(location.search);
  linkParams.set('raum', session.code);
  put('link', `${location.origin}${location.pathname}?${linkParams}`, (v) => {
    $('#f-link').value = v;
  });
  const seconds = lobby ? lobby.seconds : ROUND_SECONDS;
  put('seconds', `${seconds}|${isHost}`, () => {
    for (const radio of document.querySelectorAll('#length input')) radio.checked = Number(radio.value) === seconds;
    $('#length').disabled = !isHost;
  });
  put('start', `${isHost}|${ended}`, () => {
    $('#b-start').hidden = !isHost;
    $('#b-start').textContent = ended ? 'Nächste Runde starten' : 'Runde starten';
  });
  const [note, bad] = netNote();
  put('note', `${note}|${bad}`, () => {
    $('#room-note').textContent = note;
    $('#room-note').classList.toggle('bad', bad);
  });
}

function updateHud(view, t) {
  const client = session.client;
  const names = view.players.map((p) => p.name);
  const chip = (slot, role, me) => `<div class="chip${me ? ' me' : ''}">${wispSvg(slot)}<span class="who">${esc(names[slot])}</span><span class="role">${role}</span><span class="pts">${view.players[slot].score}</span></div>`;
  const ring = chip(view.hunter, 'jagt dich', false) + HUNTS + chip(view.slot, 'du', true) + HUNTS + chip(view.prey, 'deine Beute', false);
  put('ring', ring, (v) => {
    $('#ring').innerHTML = v;
  });

  const counting = view.phase === PHASE.COUNTDOWN;
  const secs = counting ? (client.lobby ? client.lobby.seconds : ROUND_SECONDS) : Math.ceil(view.ticksLeft / TICK_RATE);
  put('timer', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}|${!counting && secs <= 10}`, (v) => {
    const [text, soon] = v.split('|');
    $('#timer').textContent = text;
    $('#timer').classList.toggle('soon', soon === 'true');
  });

  let conn = '';
  let bad = false;
  if (client.status === 'lost') {
    conn = 'Verbindung zum Gastgeber verloren';
    bad = true;
  } else if (session.role === 'guest' && session.status) {
    const rtt = client.rtt === null ? '' : `, ${Math.round(client.rtt / 5) * 5} ms`;
    conn = session.status.direct ? `direkt verbunden${rtt}` : `über Vermittler${rtt}`;
  }
  put('conn', `${conn}|${bad}`, () => {
    $('#conn').textContent = conn;
    $('#conn').classList.toggle('bad', bad);
  });

  if (view.phase === PHASE.PLAY && !playSince) playSince = t;
  if (view.phase !== PHASE.PLAY) playSince = 0;
  put('hint', keyboard.hasMoved() && playSince && t - playSince > 6000, (gone) => {
    $('#hint').classList.toggle('gone', gone);
  });

  if (counting) {
    const left = Math.ceil(view.ticksLeft / TICK_RATE);
    put('count-num', left <= 3 ? String(Math.max(left, 1)) : '', (v) => {
      $('#count-num').textContent = v;
    });
    const colored = (slot) => `<b style="color:${WISPS[slot].color}">${esc(names[slot])}</b>`;
    put('count-text', `Du jagst ${colored(view.prey)}. ${colored(view.hunter)} jagt dich.`, (v) => {
      $('#count-text').innerHTML = v;
    });
  }
}

// ---------- Takt ----------

// Der Spielstand des Gastgebers läuft über einen Taktgeber außerhalb der
// Seite weiter, auch wenn das Fenster gerade nicht vorne ist.
function startTicker(fn) {
  try {
    const source = 'setInterval(() => postMessage(0), 8);';
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    worker.onmessage = fn;
  } catch {
    setInterval(fn, 8);
  }
}
startTicker(() => {
  const t = now();
  if (session && session.host) session.host.advance(t);
  if (demoWanted) demo.host.advance(t);
});

const panelWidth = () => (window.innerWidth >= 980 ? Math.min(25 * 18, window.innerWidth) * 0.92 : 0);

function frame() {
  const t = now();
  let view = null;
  let screen = 'start';
  if (session) {
    session.client.frame(t, keyboard.code());
    view = session.client.view(t);
    const status = session.client.status;
    const live = view.ready && (status === 'in' || status === 'lost') && session.client.slot >= 0
      && (view.phase === PHASE.COUNTDOWN || view.phase === PHASE.PLAY);
    screen = live ? 'game' : 'room';
  }
  const ownView = Boolean(view && view.ready && session.client.slot >= 0);
  demoWanted = !ownView;

  put('screen', screen, (v) => {
    document.body.dataset.screen = v;
    $('#start').hidden = v !== 'start';
    $('#room').hidden = v !== 'room';
    $('#hud').hidden = v !== 'game';
    keyboard.setEnabled(v === 'game');
    if (v === 'game' && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  });
  put('count', screen === 'game' && view.phase === PHASE.COUNTDOWN, (v) => {
    $('#count').hidden = !v;
  });

  if (screen === 'game') {
    renderer.setInsets({ top: 70, right: 14, bottom: 42, left: 14 });
    updateHud(view, t);
  } else {
    renderer.setInsets({ top: 16, right: 16, bottom: 16, left: panelWidth() });
    if (screen === 'room') updateRoom(view);
  }

  if (ownView) {
    for (const e of session.client.effects.splice(0)) renderer.effect(e, view, t, false);
    renderer.draw(view, t, { spectate: false, tags: true });
  } else {
    demo.client.frame(t);
    const demoView = demo.client.view(t);
    for (const e of demo.client.effects.splice(0)) renderer.effect(e, demoView, t, true);
    renderer.draw(demoView, t, { spectate: true, tags: false });
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => renderer.resize());
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => renderer.resize());

// Nach dem Neuladen wieder in denselben Raum
const saved = (() => {
  try {
    return JSON.parse(load(sessionStorage, 'hatz-room') || 'null');
  } catch {
    return null;
  }
})();
showStartMode();
if (saved && saved.code && saved.code === invite && load(localStorage, 'hatz-name')) {
  if (saved.role === 'host') openRoom(saved.code);
  else if (supported()) joinRoom(saved.code);
}

// Für die Tests
window.__hatz = {
  get session() {
    return session;
  },
  demo,
  view: () => (session ? session.client.view(now()) : null),
};

requestAnimationFrame(frame);
