// Verbindung zwischen den Geräten.
//
// Zwei Wege, die sich ergänzen:
//
//   1. Vermittler. Jedes Gerät hängt an mehreren öffentlichen, kostenlosen
//      MQTT-Diensten zugleich. Darüber finden sich die Geräte, und darüber
//      läuft das Spiel, solange es keinen besseren Weg gibt. Es reicht, wenn
//      ein Dienst erreichbar ist.
//   2. Direktverbindung (WebRTC). Sobald sich Gastgeber und Mitspieler über
//      die Vermittler gefunden haben, bauen sie eine direkte Leitung auf.
//      Die ist viel schneller und trägt dann das Spiel. Klappt sie nicht
//      (manche Netze lassen das nicht zu), bleibt es beim Weg über die
//      Vermittler, nur etwas träger.
//
// Die Vermittler sind öffentlich, deshalb ist dort alles verschlüsselt
// (AES-GCM). Schlüssel und Kanalname entstehen aus dem Raumcode: Wer den Code
// nicht kennt, findet den Raum nicht und kann nichts mitlesen.

export const DEFAULT_RELAYS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://mqtt.eclipseprojects.io:443/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 5;
const RELAY_EVERY = 3; // über Vermittler nur jeder dritte Spielstand (20 pro Sekunde)
const GATHER_MS = 3500; // so lange höchstens auf die eigenen Adressen warten
const RTC_PATIENCE_MS = 12000;
const RTC_ATTEMPTS = 3;

const enc = new TextEncoder();
const dec = new TextDecoder();
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const random = (count) => crypto.getRandomValues(new Uint8Array(count));

export const makeId = () => toHex(random(6));
export function makeRoomCode() {
  return [...random(CODE_LENGTH)].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}
export function cleanCode(text) {
  const code = String(text || '').toUpperCase().replace(/[^A-Z]/g, '');
  return code.length === CODE_LENGTH ? code : '';
}
export function supported() {
  return Boolean(globalThis.mqtt && globalThis.crypto && crypto.subtle && typeof WebSocket === 'function');
}
const rtcSupported = () => typeof RTCPeerConnection === 'function';

// ---------- Verschlüsselung ----------

async function roomSecrets(room) {
  const base = await crypto.subtle.importKey('raw', enc.encode(`hatz:${room}`), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('hatz-raum-v1'), iterations: 120000 },
    base,
    42 * 8,
  ));
  return {
    key: await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']),
    topic: `hatz1/${toHex(bits.slice(32, 42))}`,
  };
}

// `label` bindet die Nachricht an ihren Kanal, damit sie woanders nicht gilt.
async function seal(key, label, text) {
  const iv = random(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, enc.encode(text));
  const out = new Uint8Array(12 + data.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(data), 12);
  return out;
}

async function unseal(key, label, bytes) {
  if (bytes.length < 12 + 16 + 2) return null;
  try {
    const data = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(label) },
      key,
      bytes.subarray(12),
    );
    const value = JSON.parse(dec.decode(data));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// ---------- Vermittler ----------

function checksum(bytes) {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Hält die Verbindung zu allen Vermittlern. Dieselbe Nachricht kommt über
// mehrere Wege an und wird nur einmal weitergereicht. Nebenbei wird gemessen,
// welcher Vermittler am schnellsten liefert: Eilige Nachrichten gehen nur über
// die beiden besten, um die kostenlosen Dienste nicht unnötig zu belasten.
function createRelay({ urls, topics, isProbe, onMessage, onChange }) {
  const seen = new Map(); // Nachricht -> Zeit der ersten Ankunft
  const pace = urls.map(() => ({ late: null, at: 0 }));
  const clients = urls.map((url, index) => {
    const client = globalThis.mqtt.connect(url, {
      clientId: `hz${toHex(random(8))}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000,
      connectTimeout: 10000,
      queueQoSZero: false,
      resubscribe: false,
    });
    client.on('connect', () => {
      client.subscribe(topics, { qos: 0 });
      onChange();
    });
    client.on('close', onChange);
    client.on('error', () => {});
    client.on('message', (topic, payload) => {
      const bytes = new Uint8Array(payload);
      const key = `${topic}|${bytes.length}|${checksum(bytes)}`;
      const now = performance.now();
      const first = seen.get(key);
      if (isProbe(topic)) {
        const late = first === undefined ? 0 : now - first;
        pace[index].late = pace[index].late === null ? late : pace[index].late * 0.8 + late * 0.2;
        pace[index].at = now;
      }
      if (first !== undefined) return;
      seen.set(key, now);
      if (seen.size > 800) {
        for (const [old, at] of seen) {
          if (now - at < 20000 && seen.size <= 400) break;
          seen.delete(old);
        }
      }
      onMessage(topic, bytes);
    });
    return client;
  });

  function fastest(count) {
    const now = performance.now();
    return clients
      .map((client, index) => ({ client, score: pace[index].late !== null && now - pace[index].at < 6000 ? pace[index].late : 1e6 + index }))
      .filter((entry) => entry.client.connected)
      .sort((a, b) => a.score - b.score)
      .slice(0, count)
      .map((entry) => entry.client);
  }

  return {
    total: urls.length,
    up: () => clients.filter((client) => client.connected).length,
    publish(topic, bytes, fast) {
      const list = fast ? fastest(2) : clients.filter((client) => client.connected);
      for (const client of list) client.publish(topic, bytes, { qos: 0 });
    },
    stop() {
      for (const client of clients) {
        try {
          client.end(true);
        } catch {
          // war schon zu
        }
      }
    },
  };
}

// Gemeinsames Gerüst für Gastgeber und Mitspieler.
function createBase({ room, urls, topicsFor, onPacket, onStatus }) {
  const base = { secrets: null, relay: null, stopped: false, everUp: false, failed: !supported() };
  let incoming = Promise.resolve();
  let reported = '';

  base.status = (extra = {}) => {
    const up = base.relay ? base.relay.up() : 0;
    return { up, total: base.relay ? base.relay.total : urls.length, failed: base.failed, everUp: base.everUp, ...extra };
  };
  base.report = (extra) => {
    if (base.stopped) return;
    const status = base.status(extra);
    const text = JSON.stringify(status);
    if (text === reported) return;
    reported = text;
    onStatus(status);
  };

  // Verschlüsselt und verschickt über die Vermittler.
  base.post = (channel, msg, fast) => {
    if (!base.relay || !base.secrets || base.stopped) return;
    const { key, topic } = base.secrets;
    seal(key, channel, typeof msg === 'string' ? msg : JSON.stringify(msg))
      .then((bytes) => {
        if (!base.stopped && base.relay) base.relay.publish(`${topic}/${channel}`, bytes, fast);
      })
      .catch(() => {});
  };

  base.ready = (async () => {
    if (base.failed) return;
    base.secrets = await roomSecrets(room);
    if (base.stopped) return;
    const prefix = base.secrets.topic.length + 1;
    base.relay = createRelay({
      urls,
      topics: topicsFor(base.secrets.topic),
      isProbe: (topic) => topic.endsWith('/b') || topic.includes('/k/'),
      onMessage(topic, bytes) {
        const channel = topic.slice(prefix);
        // Der Reihe nach entschlüsseln, damit nichts überholt wird
        incoming = incoming
          .then(() => unseal(base.secrets.key, channel, bytes))
          .then((msg) => {
            if (msg && !base.stopped) onPacket(channel, msg);
          })
          .catch(() => {});
      },
      onChange() {
        if (base.relay && base.relay.up() > 0) base.everUp = true;
        base.report();
      },
    });
  })().catch(() => {
    base.failed = true;
  }).finally(() => base.report());

  base.stop = () => {
    base.stopped = true;
    if (base.relay) base.relay.stop();
  };
  return base;
}

function gathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    let early = null;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(early);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', found);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    // Sobald die Adresse nach außen bekannt ist, reicht eine kurze Nachfrist.
    const found = (event) => {
      if (event.candidate && event.candidate.type === 'srflx' && !early) early = setTimeout(done, 400);
    };
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', found);
  });
}

function closePeer(peer) {
  if (peer.dc) {
    peer.dc.onopen = null;
    peer.dc.onclose = null;
    peer.dc.onmessage = null;
    try {
      peer.dc.close();
    } catch {
      // schon zu
    }
  }
  if (peer.pc) {
    peer.pc.ondatachannel = null;
    try {
      peer.pc.close();
    } catch {
      // schon zu
    }
  }
  peer.dc = null;
  peer.pc = null;
  peer.direct = false;
}

// ---------- Gastgeber ----------

// `host` ist der Spielleiter aus host.js, `localId` die Kennung des Spiels im
// eigenen Fenster (das braucht kein Netz).
export function createHostNet({ room, urls = DEFAULT_RELAYS, host, localId, now, useRtc = true, onStatus = () => {}, onConflict = () => {} }) {
  const peers = new Map(); // Kennung -> { pc, dc, direct, heardDirect }
  let myEpoch = null;

  const peerOf = (id) => {
    let peer = peers.get(id);
    if (!peer) {
      peer = { pc: null, dc: null, direct: false, heardDirect: 0, attempt: -1 };
      peers.set(id, peer);
    }
    return peer;
  };
  const report = () => base.report({ direct: [...peers].filter(([, peer]) => peer.direct).map(([id]) => id) });

  async function answer(id, msg) {
    if (!useRtc || !rtcSupported() || !msg.sdp || msg.sdp.type !== 'offer') return;
    const peer = peerOf(id);
    if (msg.n <= peer.attempt) return; // schon bekannt (kam über mehrere Vermittler)
    closePeer(peer);
    peer.attempt = msg.n;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peer.pc = pc;
    pc.ondatachannel = (event) => {
      const dc = event.channel;
      peer.dc = dc;
      dc.onopen = () => {
        peer.direct = true;
        peer.heardDirect = now();
        report();
      };
      dc.onclose = () => {
        if (peer.dc !== dc) return;
        peer.direct = false;
        report();
      };
      dc.onmessage = (ev) => {
        peer.heardDirect = now();
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        host.handle(id, data, now());
      };
    };
    try {
      await pc.setRemoteDescription(msg.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      if (peer.pc !== pc) return;
      base.post(`h/${id}`, { t: 'rtc', n: msg.n, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }, false);
    } catch {
      if (peer.pc === pc) closePeer(peer);
    }
  }

  const base = createBase({
    room,
    urls,
    onStatus,
    topicsFor: (topic) => [`${topic}/c/+`, `${topic}/k/+`, `${topic}/b`],
    onPacket(channel, msg) {
      if (channel === 'b') {
        // Ein Raumsignal, das nicht von uns stammt: Der Code ist schon vergeben.
        if (myEpoch !== null && msg.h !== undefined && msg.h !== myEpoch) onConflict();
        return;
      }
      const id = channel.slice(2);
      if (!id || id === localId) return;
      peerOf(id);
      if (msg.t === 'rtc') answer(id, msg);
      else host.handle(id, msg, now());
    },
  });

  const waitingOnRelay = () => host.slots.some((slot) => slot.kind === 'human' && slot.online && slot.id !== localId && !(peers.get(slot.id) || {}).direct);

  host.addLine({
    sendTo(id, msg) {
      if (id === localId) return false;
      const peer = peers.get(id);
      if (peer && peer.direct && peer.dc.readyState === 'open') peer.dc.send(JSON.stringify(msg));
      else base.post(`h/${id}`, msg, false);
      return true;
    },
    broadcast(msg, fast, tick) {
      if (msg.h !== undefined) myEpoch = msg.h;
      let text = null;
      for (const peer of peers.values()) {
        if (!peer.direct || peer.dc.readyState !== 'open') continue;
        if (text === null) text = JSON.stringify(msg);
        try {
          peer.dc.send(text);
        } catch {
          // Leitung gerade zugegangen
        }
      }
      if (!fast) base.post('b', text === null ? msg : text, false);
      else if (tick % RELAY_EVERY === 0 && waitingOnRelay()) base.post('h', text === null ? msg : text, true);
    },
    isDirect: (id) => Boolean((peers.get(id) || {}).direct),
  });

  // Eine Direktleitung, über die nichts mehr kommt, ist tot.
  const watchdog = setInterval(() => {
    for (const peer of peers.values()) {
      if (peer.direct && now() - peer.heardDirect > 6000) {
        closePeer(peer);
        report();
      }
    }
    report();
  }, 1000);

  return {
    isDirect: (id) => Boolean((peers.get(id) || {}).direct),
    status: () => base.status(),
    stop() {
      clearInterval(watchdog);
      for (const peer of peers.values()) closePeer(peer);
      base.stop();
    },
  };
}

// ---------- Mitspieler ----------

export function createGuestNet({ room, urls = DEFAULT_RELAYS, id, now, useRtc = true, onMessage, onStatus = () => {} }) {
  const peer = { pc: null, dc: null, direct: false };
  let attempt = 0;
  let attemptAt = 0;
  let tries = 0;
  let hostSeen = 0;
  let heardDirect = 0;
  let retryAt = 0;
  let busy = false;

  const report = () => base.report({ direct: peer.direct, hostSeen: hostSeen > 0 && now() - hostSeen < 6000 });

  function giveUp(delayMs) {
    closePeer(peer);
    busy = false;
    retryAt = tries < RTC_ATTEMPTS ? now() + delayMs : Infinity;
    report();
  }

  async function dial() {
    if (!useRtc || !rtcSupported() || busy || peer.direct) return;
    busy = true;
    tries += 1;
    attempt = Math.max(attempt + 1, Date.now()); // wächst auch über ein Neuladen hinweg
    attemptAt = now();
    const n = attempt;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peer.pc = pc;
    const dc = pc.createDataChannel('hatz', { ordered: false, maxRetransmits: 0 });
    peer.dc = dc;
    dc.onopen = () => {
      peer.direct = true;
      busy = false;
      tries = 0;
      heardDirect = now();
      report();
    };
    dc.onclose = () => {
      if (peer.dc !== dc) return;
      giveUp(1500);
    };
    dc.onmessage = (ev) => {
      heardDirect = now();
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      onMessage(data);
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      if (peer.pc !== pc || n !== attempt) return;
      base.post(`k/${id}`, { t: 'rtc', n, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }, false);
    } catch {
      if (peer.pc === pc) giveUp(4000);
    }
  }

  const base = createBase({
    room,
    urls,
    onStatus,
    topicsFor: (topic) => [`${topic}/b`, `${topic}/h`, `${topic}/h/${id}`],
    onPacket(channel, msg) {
      hostSeen = now();
      if (msg.t === 'rtc') {
        if (msg.n === attempt && peer.pc && msg.sdp && msg.sdp.type === 'answer' && peer.pc.signalingState === 'have-local-offer') {
          peer.pc.setRemoteDescription(msg.sdp).catch(() => giveUp(4000));
        }
        return;
      }
      onMessage(msg);
    },
  });

  const timer = setInterval(() => {
    const t = now();
    const hostThere = hostSeen > 0 && t - hostSeen < 6000;
    if (peer.direct && t - heardDirect > 4000) giveUp(1000);
    else if (busy && t - attemptAt > RTC_PATIENCE_MS) giveUp(3000);
    else if (!busy && !peer.direct && hostThere && t >= retryAt) dial();
    report();
  }, 500);

  return {
    link: {
      send(msg, fast) {
        if (peer.direct && peer.dc.readyState === 'open') {
          try {
            peer.dc.send(JSON.stringify(msg));
            return;
          } catch {
            // Leitung gerade zugegangen: über die Vermittler
          }
        }
        base.post(`${fast ? 'c' : 'k'}/${id}`, msg, fast);
      },
      direct: () => peer.direct,
    },
    status: () => base.status({ direct: peer.direct, hostSeen: hostSeen > 0 && now() - hostSeen < 6000 }),
    stop() {
      clearInterval(timer);
      closePeer(peer);
      base.stop();
    },
  };
}
