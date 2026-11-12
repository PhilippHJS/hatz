// Zeichnet das Spiel auf die Leinwand: nächtlicher Irrgarten, hell ist nur
// der Sichtkreis um die eigene Figur. Wer darin ist, wird gesehen.
//
// Der Garten wird zweimal vorab gemalt, einmal im Dunkeln und einmal im
// Mondlicht. Beide Fassungen liegen als ruhende Bilder unter der Spielfläche,
// die helle ist nur eingeblendet, wenn man das ganze Feld sieht (in der
// Auszeit nach einem Fang und am Rundenende). Pro Bild wird sonst nur der
// Sichtkreis aus der hellen Fassung ausgeschnitten, dazu kommen die
// Irrlichter und Effekte. So bleibt der Aufwand pro Bild klein, auch auf
// großen Bildschirmen ohne schnelle Grafik.

import {
  WISPS, PLAYER_R, WALL_T, TICK_RATE, SHIELD_TICKS, RECOVER_AT, DEFAULT_RULES, ITEMS, ITEM, itemTicks, TRAP_RADIUS,
} from './config.js';
import { drawBadge, drawGlyph } from './itemart.js';
import { PHASE, EVENT, canCatch, fakeSpot } from './sim.js';
import { makeRng } from './rng.js';

const THEME = {
  darkFloor: '#15233f',
  darkDot: 'rgba(120, 150, 200, 0.13)',
  darkHedge: '#2d4673',
  litFloor: '#4d8f70',
  litHedge: '#2e7745',
  litLeaf: '#a9e58d',
  moon: '#f2f0dd',
  ink: '#101a30',
  alarm: '#ff7a6b',
};
const TAU = Math.PI * 2;

// `canvas` zeigt alles, was sich bewegt. Darunter liegen `back` mit dem
// dunklen Garten und `wide` mit dem hellen, der bei Bedarf eingeblendet wird.
export function createRenderer(canvas, back, wide) {
  const ctx = canvas.getContext('2d');
  const backCtx = back.getContext('2d');
  const wideCtx = wide.getContext('2d');
  const lit = document.createElement('canvas');
  const dark = document.createElement('canvas');
  const litCtx = lit.getContext('2d');
  const darkCtx = dark.getContext('2d');
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let cw = 0;
  let ch = 0;
  let dpr = 1;
  let s = 40; // Kantenlänge eines Feldes in CSS-Pixeln
  let ox = 0;
  let oy = 0;
  let pad = 0;
  let insets = { top: 0, right: 0, bottom: 0, left: 0 };
  let painted = ''; // wofür die beiden Fassungen gerade gemalt sind
  let maze = null;
  let lastNow = 0;
  let round = -1;

  const actors = [0, 1, 2].map(() => ({
    alpha: 0, trail: [], lookX: 0, lookY: 1, blink: 2 + Math.random() * 3, tp: -1, wob: Math.random() * 10,
    arrow: null, fake: false, // Pfeil auf diese Figur: Winkel und ob er gerade lügt
  }));
  const particles = [];
  const pops = [];
  const rings = [];
  const strikes = []; // Blitzeinschläge
  const badges = []; // aufsteigende Item-Plaketten
  const boxSeen = new Map(); // Kiste -> wann sie zum ersten Mal zu sehen war
  let shake = 0;
  let lastJolt = '';
  let rules = DEFAULT_RULES; // Regeln der Runde, die gerade gezeigt wird
  let flash = 0;
  let flashColor = '#fff';
  let wideShown = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cw = Math.max(1, Math.round(rect.width));
    ch = Math.max(1, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cw * ch * dpr * dpr > 4.5e6) dpr = Math.max(1, Math.sqrt(4.5e6 / (cw * ch)));
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    back.width = canvas.width;
    back.height = canvas.height;
    wide.width = canvas.width;
    wide.height = canvas.height;
    painted = '';
  }

  function setInsets(next) {
    if (next.top !== insets.top || next.right !== insets.right || next.bottom !== insets.bottom || next.left !== insets.left) {
      insets = { ...next };
      painted = '';
    }
  }

  function layout(m) {
    const availW = Math.max(120, cw - insets.left - insets.right);
    const availH = Math.max(80, ch - insets.top - insets.bottom);
    s = Math.floor(Math.min(availW / m.W, availH / m.H) * dpr) / dpr;
    ox = insets.left + (availW - s * m.W) / 2;
    oy = insets.top + (availH - s * m.H) / 2;
    pad = Math.ceil(s * 0.5);
  }

  function wallPath(g, m, dy) {
    g.beginPath();
    for (const seg of m.segments) {
      g.moveTo(seg.x1, seg.y1 + dy);
      g.lineTo(seg.x2, seg.y2 + dy);
    }
  }

  // Malt den ganzen Garten in eine der beiden Fassungen.
  function paintScene(g, target, m, isLit) {
    target.width = Math.round((m.W * s + pad * 2) * dpr);
    target.height = Math.round((m.H * s + pad * 2) * dpr);
    g.setTransform(dpr * s, 0, 0, dpr * s, pad * dpr, pad * dpr);
    const rng = makeRng(m.seed ^ 0x5eed);

    g.fillStyle = isLit ? THEME.litFloor : THEME.darkFloor;
    g.beginPath();
    g.roundRect(-0.12, -0.12, m.W + 0.24, m.H + 0.24, 0.22);
    g.fill();

    if (isLit) {
      // Rasenflecken, damit der Boden nicht wie eine Fläche wirkt
      for (let y = 0; y < m.H; y += 1) {
        for (let x = 0; x < m.W; x += 1) {
          const tone = rng();
          g.fillStyle = tone < 0.5 ? `rgba(255, 255, 220, ${0.02 + tone * 0.05})` : `rgba(0, 20, 30, ${(tone - 0.5) * 0.14})`;
          g.fillRect(x, y, 1, 1);
          for (let i = 0; i < 3; i += 1) {
            g.fillStyle = `rgba(190, 235, 170, ${0.1 + rng() * 0.12})`;
            g.beginPath();
            g.arc(x + rng(), y + rng(), 0.018 + rng() * 0.02, 0, TAU);
            g.fill();
          }
        }
      }
    } else {
      g.fillStyle = THEME.darkDot;
      for (let y = 0; y < m.H; y += 1) {
        for (let x = 0; x < m.W; x += 1) {
          g.beginPath();
          g.arc(x + 0.5, y + 0.5, 0.035, 0, TAU);
          g.fill();
        }
      }
    }

    // Hecken: Schatten, Körper, belaubte Oberseite
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (isLit) {
      g.strokeStyle = 'rgba(6, 30, 28, 0.42)';
      g.lineWidth = WALL_T * 1.35;
      wallPath(g, m, 0.08);
      g.stroke();
    }
    g.strokeStyle = isLit ? THEME.litHedge : THEME.darkHedge;
    g.lineWidth = WALL_T;
    wallPath(g, m, 0);
    g.stroke();

    // Buckel entlang der Hecken, in beiden Fassungen an derselben Stelle
    const bumps = makeRng(m.seed ^ 0xb0b);
    for (const seg of m.segments) {
      const len = seg.x2 - seg.x1 + (seg.y2 - seg.y1);
      const count = Math.round(len * 3.2);
      for (let i = 0; i <= count; i += 1) {
        const f = count ? i / count : 0;
        const jx = (bumps() - 0.5) * 0.05;
        const jy = (bumps() - 0.5) * 0.05;
        const x = seg.x1 + (seg.x2 - seg.x1) * f + jx;
        const y = seg.y1 + (seg.y2 - seg.y1) * f + jy;
        const r = WALL_T * (0.52 + bumps() * 0.22);
        g.fillStyle = isLit ? THEME.litHedge : THEME.darkHedge;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
        if (isLit) {
          g.fillStyle = `rgba(169, 229, 141, ${0.6 + bumps() * 0.4})`;
          g.beginPath();
          g.arc(x - 0.012, y - 0.022, r * 0.62, 0, TAU);
          g.fill();
        } else {
          bumps();
        }
      }
    }
  }

  function ensureScene(m) {
    const key = `${m.seed}|${m.W}x${m.H}|${cw}|${ch}|${dpr}|${insets.top}|${insets.right}|${insets.bottom}|${insets.left}`;
    if (key === painted) return;
    painted = key;
    maze = m;
    layout(m);
    paintScene(litCtx, lit, m, true);
    paintScene(darkCtx, dark, m, false);
    backCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    backCtx.clearRect(0, 0, cw, ch);
    backCtx.drawImage(dark, ox - pad, oy - pad, dark.width / dpr, dark.height / dpr);
    wideCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wideCtx.clearRect(0, 0, cw, ch);
    wideCtx.drawImage(lit, ox - pad, oy - pad, lit.width / dpr, lit.height / dpr);
  }

  const sx = (x) => ox + x * s;
  const sy = (y) => oy + y * s;

  // Liegt die Stelle (x, y) im Sichtkreis von `me`? Dieselbe Regel wie im Spiel.
  function inSight(me, x, y) {
    const dx = me.x - x;
    const dy = me.y - y;
    return dx * dx + dy * dy <= rules.vision * rules.vision;
  }

  function blobPath(x, y, r, lobes, wob, now) {
    const amp = lobes === 4 ? 0.12 : lobes === 3 ? 0.14 : 0;
    const phase = lobes === 3 ? Math.PI * 1.5 : 0;
    ctx.beginPath();
    const steps = 40;
    for (let k = 0; k <= steps; k += 1) {
      const th = (k / steps) * TAU;
      const rr = r * (1 + amp * Math.cos(lobes * th + phase) + (calm ? 0 : 0.035 * Math.sin(3 * th + now * 0.005 + wob)));
      const px = x + Math.cos(th) * rr;
      const py = y + Math.sin(th) * rr;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function drawWisp(p, actor, alpha, now, dt) {
    const wisp = WISPS[p.slot];
    const x = sx(p.x);
    const y = sy(p.y);
    const r = PLAYER_R * s;
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (speed > 0.6) {
      const k = Math.min(1, dt * 14);
      actor.lookX += (p.vx / speed - actor.lookX) * k;
      actor.lookY += (p.vy / speed - actor.lookY) * k;
    }
    const shielded = p.shield > 0;
    const a = alpha * (shielded && Math.floor(now / 110) % 2 === 0 ? 0.45 : 1);

    // Schweif
    for (const pt of actor.trail) {
      const age = (now - pt.t) / pt.life;
      if (age >= 1) continue;
      ctx.globalAlpha = a * (1 - age) * 0.42;
      ctx.fillStyle = wisp.color;
      ctx.beginPath();
      ctx.arc(sx(pt.x), sy(pt.y), r * (0.9 - age * 0.7), 0, TAU);
      ctx.fill();
    }

    // Schein
    ctx.globalCompositeOperation = 'lighter';
    const glowR = r * (p.hot ? 3.1 : 2.5);
    const glow = ctx.createRadialGradient(x, y, r * 0.4, x, y, glowR);
    glow.addColorStop(0, wisp.color);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = a * (p.hot ? 0.55 + (calm ? 0 : 0.15 * Math.sin(now * 0.02)) : 0.38);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, glowR, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // Körper
    ctx.globalAlpha = a;
    const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.38, r * 0.1, x, y, r * 1.15);
    body.addColorStop(0, '#fffbe8');
    body.addColorStop(0.45, wisp.color);
    body.addColorStop(1, wisp.deep);
    blobPath(x, y, r, wisp.lobes, actor.wob, now);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.lineWidth = Math.max(1, s * 0.022);
    ctx.strokeStyle = 'rgba(16, 26, 48, 0.55)';
    ctx.stroke();

    // Augen schauen in Laufrichtung
    actor.blink -= dt;
    if (actor.blink < -0.12) actor.blink = 2.5 + Math.random() * 3.5;
    const closed = actor.blink < 0 ? 0.15 : p.ex ? 0.45 : p.hot ? 0.7 : 1;
    const ex = actor.lookX * r * 0.3;
    const ey = actor.lookY * r * 0.3 + (p.ex ? r * 0.08 : 0);
    ctx.fillStyle = THEME.ink;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(x + ex + side * r * 0.3, y + ey - r * 0.05, r * 0.13, r * 0.2 * closed, 0, 0, TAU);
      ctx.fill();
    }
    if (closed > 0.5) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(x + ex + side * r * 0.3 - r * 0.04, y + ey - r * 0.13, r * 0.045, 0, TAU);
        ctx.fill();
      }
    }

    if (shielded) {
      ctx.globalAlpha = alpha * 0.7;
      ctx.strokeStyle = THEME.moon;
      ctx.lineWidth = Math.max(1.5, s * 0.03);
      ctx.beginPath();
      ctx.arc(x, y, r * (1.5 + 0.25 * (p.shield / SHIELD_TICKS)), 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Die eigene Figur in der Auszeit: blasser Schatten am Ort des Fangs, der
  // Ring darum läuft ab, bis es weitergeht.
  function drawGhost(p, actor, now, dt) {
    drawWisp(p, actor, 0.3, now, dt);
    const x = sx(p.x);
    const y = sy(p.y);
    const r = PLAYER_R * s;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2.5, s * 0.055);
    ctx.strokeStyle = 'rgba(242, 240, 221, 0.25)';
    ctx.beginPath();
    ctx.arc(x, y, r * 1.7, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = THEME.moon;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.7, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, p.dead / rules.respawnTicks));
    ctx.stroke();
  }

  // schießt etwas über und federt zurück, nie unter null
  const ease = (t) => Math.max(0, 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2);

  // Was hinter der Figur liegt: Schein des Sterns, Flamme der Rakete
  function auraBack(p, alpha, now) {
    const x = sx(p.x);
    const y = sy(p.y);
    const r = PLAYER_R * s;
    if (p.star > 0) {
      const hue = calm ? 45 : (now / 5) % 360;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha;
      const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3.4);
      g.addColorStop(0, `hsla(${hue}, 100%, 72%, 0.75)`);
      g.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.4, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    if (p.ph > 0) {
      const speed = Math.hypot(p.vx, p.vy);
      const ux = speed > 0.3 ? -p.vx / speed : 0;
      const uy = speed > 0.3 ? -p.vy / speed : 1;
      const len = r * (1.5 + (calm ? 0.2 : Math.random() * 0.6)) * (speed > 0.3 ? 1 : 0.6);
      const baseX = x + ux * r * 0.4;
      const baseY = y + uy * r * 0.4;
      const tipX = x + ux * (r + len);
      const tipY = y + uy * (r + len);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha;
      const g = ctx.createLinearGradient(baseX, baseY, tipX, tipY);
      g.addColorStop(0, 'rgba(255, 244, 180, 1)');
      g.addColorStop(0.45, 'rgba(255, 150, 60, 0.85)');
      g.addColorStop(1, 'rgba(255, 60, 40, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(baseX - uy * r * 0.62, baseY + ux * r * 0.62);
      ctx.quadraticCurveTo(x + ux * (r + len * 0.4) - uy * r * 0.5, y + uy * (r + len * 0.4) + ux * r * 0.5, tipX, tipY);
      ctx.quadraticCurveTo(x + ux * (r + len * 0.4) + uy * r * 0.5, y + uy * (r + len * 0.4) - ux * r * 0.5, baseX + uy * r * 0.62, baseY - ux * r * 0.62);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // Was vor der Figur liegt: Strahlen des Sterns, Lähmung, Tarnkappe
  function auraFront(p, alpha, now) {
    const x = sx(p.x);
    const y = sy(p.y);
    const r = PLAYER_R * s;
    if (p.star > 0) {
      ctx.save();
      ctx.globalAlpha = alpha * 0.95;
      ctx.strokeStyle = ITEMS[ITEM.star].color;
      ctx.lineWidth = Math.max(2, s * 0.045);
      ctx.lineCap = 'round';
      const turn = calm ? 0 : now * 0.0022;
      ctx.beginPath();
      for (let k = 0; k < 10; k += 1) {
        const th = (k / 10) * TAU + turn;
        const outer = r * (k % 2 ? 2.0 : 2.45);
        ctx.moveTo(x + Math.cos(th) * r * 1.5, y + Math.sin(th) * r * 1.5);
        ctx.lineTo(x + Math.cos(th) * outer, y + Math.sin(th) * outer);
      }
      ctx.stroke();
      ctx.restore();
    }
    if (p.fz > 0 && p.frozenBy === 1) {
      // Blitz: bläulich erstarrt, Funken springen
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(127, 240, 255, 0.28)';
      ctx.beginPath();
      ctx.arc(x, y, r * 1.3, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = '#e6fdff';
      ctx.lineWidth = Math.max(1.5, s * 0.032);
      ctx.lineJoin = 'miter';
      const rnd = makeRng((Math.floor(now / 70) * 31 + p.slot * 977) >>> 0);
      ctx.beginPath();
      for (let k = 0; k < 6; k += 1) {
        const th = rnd() * TAU;
        let px = x + Math.cos(th) * r * 0.9;
        let py = y + Math.sin(th) * r * 0.9;
        ctx.moveTo(px, py);
        for (let j = 1; j <= 3; j += 1) {
          const rr = r * (0.9 + j * 0.38);
          const side = (rnd() - 0.5) * r * 0.7;
          px = x + Math.cos(th) * rr - Math.sin(th) * side;
          py = y + Math.sin(th) * rr + Math.cos(th) * side;
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
      ctx.restore();
    } else if (p.fz > 0) {
      // Falle: Ranken halten die Figur fest
      ctx.save();
      ctx.globalAlpha = alpha;
      drawGlyph(ctx, ITEM.trap, x, y + r * 0.95, r * 2.2, 'rgba(185, 198, 218, 0.95)');
      ctx.strokeStyle = '#5aa845';
      ctx.lineWidth = Math.max(2, s * 0.05);
      ctx.lineCap = 'round';
      for (let k = 0; k < 3; k += 1) {
        ctx.beginPath();
        ctx.ellipse(x, y + r * 0.1, r * 1.28, r * 0.5, (k * TAU) / 6 + 0.35, 0, TAU);
        ctx.stroke();
      }
      ctx.fillStyle = '#a9e58d';
      for (let k = 0; k < 6; k += 1) {
        const th = (k / 6) * TAU + 0.4;
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(th) * r * 1.2, y + Math.sin(th) * r * 0.75, r * 0.2, r * 0.1, th, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
    if (p.cloak > 0) {
      // nur für die eigene Figur (und im Vorschaubild): flimmernder Rand
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = ITEMS[ITEM.cloak].color;
      ctx.lineWidth = Math.max(1.5, s * 0.035);
      ctx.setLineDash([r * 0.32, r * 0.24]);
      ctx.lineDashOffset = calm ? 0 : -now * 0.03;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.45, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Kisten: leuchten überall, auch im Dunkeln. Wer schon etwas auf Vorrat
  // hat, sieht sie blasser, denn aufheben kann er sie gerade nicht.
  function drawBoxes(view, me, now) {
    const dim = me && me.item >= 0 && me.dead === 0;
    const present = new Set();
    for (const [id, bx, by] of view.boxes) {
      present.add(id);
      if (!boxSeen.has(id)) {
        boxSeen.set(id, now);
        for (let i = 0; i < (calm ? 4 : 14); i += 1) {
          const ang = Math.random() * TAU;
          const v = 1 + Math.random() * 2.5;
          particles.push({ x: bx, y: by, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, t: now, life: 500 + Math.random() * 400, size: 0.03 + Math.random() * 0.04, color: '#ffe48a' });
        }
      }
      const born = ease(Math.min(1, (now - boxSeen.get(id)) / 450));
      const bob = calm ? 0 : Math.sin(now * 0.004 + id * 1.7) * 0.05;
      const x = sx(bx);
      const y = sy(by + bob);
      const a = dim ? 0.42 : 1;
      // Schein
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const pulse = calm ? 0.5 : 0.5 + 0.5 * Math.sin(now * 0.005 + id);
      const glowR = s * (0.75 + 0.15 * pulse) * born;
      const g = ctx.createRadialGradient(x, y, 0, x, y, glowR);
      g.addColorStop(0, `rgba(255, 214, 102, ${0.6 * a})`);
      g.addColorStop(1, 'rgba(255, 214, 102, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, glowR, 0, TAU);
      ctx.fill();
      ctx.restore();
      // Kiste
      const size = s * 0.48 * born;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(x, y);
      ctx.rotate(calm ? 0 : Math.sin(now * 0.003 + id) * 0.06);
      ctx.fillStyle = '#c98a43';
      ctx.strokeStyle = THEME.ink;
      ctx.lineWidth = Math.max(1.5, s * 0.03);
      ctx.beginPath();
      ctx.roundRect(-size / 2, -size / 2, size, size, size * 0.18);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#8f5a28';
      ctx.fillRect(-size / 2 + 1, -size * 0.12, size - 2, size * 0.24);
      ctx.fillStyle = '#ffd66a';
      ctx.font = `700 ${size * 0.82}px "Grenze Gotisch", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = size * 0.12;
      ctx.strokeText('?', 0, size * 0.04);
      ctx.fillText('?', 0, size * 0.04);
      ctx.restore();
    }
    for (const id of boxSeen.keys()) if (!present.has(id)) boxSeen.delete(id);
  }

  // Gepflanzte Hecken: wachsen in einem Augenblick heran und welken am Ende.
  // Die Blüten in der Farbe dessen, der sie gepflanzt hat, machen sie kenntlich.
  function drawHedges(view) {
    const total = itemTicks(ITEM.hedge);
    for (const [id, side, index, ticks, owner] of view.hedges) {
      let x1;
      let y1;
      let x2;
      let y2;
      if (side === 0) {
        y1 = Math.floor(index / maze.W);
        x1 = index % maze.W;
        x2 = x1 + 1;
        y2 = y1;
      } else {
        y1 = Math.floor(index / (maze.W + 1));
        x1 = index % (maze.W + 1);
        x2 = x1;
        y2 = y1 + 1;
      }
      const grow = ease(Math.min(1, (total - ticks) / 18));
      const wither = Math.min(1, ticks / 24);
      const k = Math.max(0, grow * wither);
      if (k <= 0) continue;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const half = 0.5 * Math.min(1, k);
      const ex = (x2 - x1) * half;
      const ey = (y2 - y1) * half;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(6, 30, 28, 0.45)';
      ctx.lineWidth = WALL_T * s * 1.4 * k;
      ctx.beginPath();
      ctx.moveTo(sx(cx - ex), sy(cy - ey + 0.08));
      ctx.lineTo(sx(cx + ex), sy(cy + ey + 0.08));
      ctx.stroke();
      ctx.strokeStyle = THEME.litHedge;
      ctx.lineWidth = WALL_T * s * 1.15 * k;
      ctx.beginPath();
      ctx.moveTo(sx(cx - ex), sy(cy - ey));
      ctx.lineTo(sx(cx + ex), sy(cy + ey));
      ctx.stroke();
      const rnd = makeRng((id * 7919) >>> 0);
      for (let i = 0; i <= 4; i += 1) {
        const f = i / 4 - 0.5;
        const px = cx + (x2 - x1) * f * Math.min(1, k) + (rnd() - 0.5) * 0.05;
        const py = cy + (y2 - y1) * f * Math.min(1, k) + (rnd() - 0.5) * 0.05;
        const rr = WALL_T * s * (0.62 + rnd() * 0.22) * k;
        ctx.fillStyle = THEME.litHedge;
        ctx.beginPath();
        ctx.arc(sx(px), sy(py), rr, 0, TAU);
        ctx.fill();
        ctx.fillStyle = THEME.litLeaf;
        ctx.beginPath();
        ctx.arc(sx(px) - rr * 0.1, sy(py) - rr * 0.2, rr * 0.62, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = WISPS[owner] ? WISPS[owner].color : THEME.moon;
      for (let i = 0; i < 3; i += 1) {
        const f = (i - 1) * 0.32;
        ctx.beginPath();
        ctx.arc(sx(cx + (x2 - x1) * f * Math.min(1, k)) + (rnd() - 0.5) * s * 0.08, sy(cy + (y2 - y1) * f * Math.min(1, k)) - s * 0.03, s * 0.045 * k, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // Eigene Fallen: nur für den, der sie gelegt hat, und nur angedeutet
  function drawTraps(view, now) {
    for (const [, tx, ty] of view.traps) {
      const x = sx(tx);
      const y = sy(ty);
      ctx.save();
      ctx.globalAlpha = 0.55 + (calm ? 0 : 0.15 * Math.sin(now * 0.004));
      ctx.strokeStyle = ITEMS[ITEM.trap].color;
      ctx.lineWidth = Math.max(1.2, s * 0.025);
      ctx.setLineDash([s * 0.06, s * 0.06]);
      ctx.beginPath();
      ctx.arc(x, y, TRAP_RADIUS * s, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      drawGlyph(ctx, ITEM.trap, x, y, s * 0.42, ITEMS[ITEM.trap].color);
      ctx.restore();
    }
  }

  function label(text, x, y, size, alpha, weight = 700) {
    ctx.font = `${weight} ${size}px "Alegreya Sans", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(3, size * 0.28);
    ctx.strokeStyle = 'rgba(16, 26, 48, 0.8)';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = THEME.moon;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  }

  function drawRoleMarks(p, alpha, role, text, now) {
    const x = sx(p.x);
    const y = sy(p.y);
    const r = PLAYER_R * s;
    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeStyle = THEME.moon;
    ctx.lineWidth = Math.max(1.5, s * 0.032);
    if (!role) {
      // weder Jäger noch Beute
    } else if (role === 'prey') {
      // Zielring: gestrichelt, dreht sich langsam
      const turn = calm ? 0 : now * 0.0012;
      ctx.setLineDash([r * 0.55, r * 0.38]);
      ctx.lineDashOffset = -turn * r * 2;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.75, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      // Zackenkranz: Gefahr
      const pulse = calm ? 0 : 0.08 * Math.sin(now * 0.012);
      ctx.beginPath();
      const spikes = 12;
      for (let k = 0; k <= spikes * 2; k += 1) {
        const th = (k / (spikes * 2)) * TAU + (calm ? 0 : now * 0.0008);
        const rr = r * (k % 2 === 0 ? 2.0 + pulse : 1.6);
        if (k === 0) ctx.moveTo(x + Math.cos(th) * rr, y + Math.sin(th) * rr);
        else ctx.lineTo(x + Math.cos(th) * rr, y + Math.sin(th) * rr);
      }
      ctx.closePath();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const size = Math.max(11, s * 0.24);
    label(p.name, x, y + r * 2.2, size, alpha);
    if (text) label(text, x, y + r * 2.2 + size * 1.05, size * 0.82, alpha * 0.8, 500);
  }

  function drawOwnMarks(me, now) {
    const x = sx(me.x);
    const y = sy(me.y);
    const r = PLAYER_R * s;

    // Ausdauer als Balken unter der Figur: hell auf dunklem Grund, damit er sich
    // vom Rasen und von den Hecken abhebt. Wird sie knapp, färbt er sich gelb,
    // leer gesprintet rot mit der Marke, ab der es wieder geht.
    const w = Math.max(54, s * 1.2);
    const h = Math.max(8, s * 0.15);
    const left = x - w / 2;
    const top = y + r * 1.55;
    const full = me.st >= 0.999;
    const blink = me.ex && !calm && Math.floor(now / 160) % 2 === 0;
    ctx.globalAlpha = full ? 0.85 : 1;
    ctx.fillStyle = 'rgba(16, 26, 48, 0.95)';
    ctx.beginPath();
    ctx.roundRect(left - 3, top - 3, w + 6, h + 6, (h + 6) / 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = me.ex ? THEME.alarm : 'rgba(242, 240, 221, 0.85)';
    ctx.stroke();
    if (me.st > 0.01) {
      ctx.fillStyle = me.ex ? (blink ? '#ffb1a6' : THEME.alarm) : me.st < 0.3 ? '#f3c95a' : THEME.moon;
      ctx.beginPath();
      ctx.roundRect(left, top, Math.max(h, w * me.st), h, h / 2);
      ctx.fill();
    }
    if (me.ex) {
      ctx.fillStyle = THEME.moon;
      ctx.fillRect(left + w * RECOVER_AT - 1, top - 1, 2, h + 2);
    }
    ctx.globalAlpha = 1;

    // Gelähmt: Ring läuft ab, bis es weitergeht
    if (me.fz > 0) {
      const total = me.frozenBy === 1 ? itemTicks(ITEM.bolt) : itemTicks(ITEM.trap);
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(2.5, s * 0.055);
      ctx.strokeStyle = 'rgba(242, 240, 221, 0.25)';
      ctx.beginPath();
      ctx.arc(x, y, r * 1.85, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = me.frozenBy === 1 ? ITEMS[ITEM.bolt].color : '#a9e58d';
      ctx.beginPath();
      ctx.arc(x, y, r * 1.85, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, me.fz / total));
      ctx.stroke();
    }
  }

  // Pfeile zu allem, was man fangen darf (mit Stern sind es zwei). Auf
  // Unsichtbare zeigt keiner, bei falscher Fährte zeigt er auf die falsche
  // Stelle. Der Pfeil schwenkt, statt zu springen, damit man merkt, wenn sich
  // etwas ändert.
  function drawArrows(view, me, now, dt) {
    const x = sx(me.x);
    const y = sy(me.y);
    const r = PLAYER_R * s;
    for (const p of view.players) {
      if (p.mine) continue;
      const actor = actors[p.slot];
      const catchable = view.phase !== PHASE.END && canCatch(view.ringDir, me, p) && p.cloak === 0;
      if (!catchable) {
        actor.arrow = null;
        actor.fake = false;
        continue;
      }
      const fake = p.decoy > 0;
      const spot = fake ? fakeSpot(maze, p.x, p.y) : p;
      const dx = spot.x - me.x;
      const dy = spot.y - me.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const target = Math.atan2(dy, dx);
      if (actor.fake && !fake && actor.arrow !== null) {
        // Die falsche Fährte endet: Jetzt merkt der Jäger, dass er reingelegt wurde
        pops.push({ x: me.x + Math.cos(actor.arrow) * 1.1, y: me.y + Math.sin(actor.arrow) * 1.1 - 0.2, text: 'Falsche Fährte!', color: ITEMS[ITEM.decoy].color, t: now, size: 0.38, body: true });
      }
      actor.fake = fake;
      if (actor.arrow === null) actor.arrow = target;
      else {
        let diff = target - actor.arrow;
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        actor.arrow += diff * Math.min(1, dt * 9);
      }
      if (d <= 0.9 && !fake) continue;
      const ux = Math.cos(actor.arrow);
      const uy = Math.sin(actor.arrow);
      const dist = r * 2.3 + (calm ? 0 : Math.sin(now * 0.006) * r * 0.16);
      const tipX = x + ux * (dist + r * 1.05);
      const tipY = y + uy * (dist + r * 1.05);
      const bx = x + ux * dist;
      const by = y + uy * dist;
      const w = r * 0.68;
      ctx.globalAlpha = actor.alpha > 0.5 ? 0.45 : 0.95;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(bx - uy * w, by + ux * w);
      ctx.lineTo(bx + ux * r * 0.32, by + uy * r * 0.32);
      ctx.lineTo(bx + uy * w, by - ux * w);
      ctx.closePath();
      ctx.fillStyle = WISPS[p.slot].color;
      ctx.fill();
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1.5, s * (me.star > 0 ? 0.05 : 0.035));
      ctx.strokeStyle = me.star > 0 ? ITEMS[ITEM.star].color : 'rgba(16, 26, 48, 0.85)';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawEffects(now, dt) {
    for (let i = rings.length - 1; i >= 0; i -= 1) {
      const ring = rings[i];
      const age = (now - ring.t) / ring.life;
      if (age >= 1) {
        rings.splice(i, 1);
        continue;
      }
      if (age < 0) continue;
      ctx.globalAlpha = (1 - age) * 0.8;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = Math.max(1.5, s * 0.05 * (1 - age));
      ctx.beginPath();
      ctx.arc(sx(ring.x), sy(ring.y), s * (ring.from + (ring.to - ring.from) * (1 - (1 - age) * (1 - age))), 0, TAU);
      ctx.stroke();
    }
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      const age = (now - p.t) / p.life;
      if (age >= 1) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 3 * dt;
      p.vy *= 1 - 3 * dt;
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), s * p.size * (1 - age * 0.6), 0, TAU);
      ctx.fill();
    }
    for (let i = pops.length - 1; i >= 0; i -= 1) {
      const pop = pops[i];
      const age = (now - pop.t) / 1100;
      if (age >= 1) {
        pops.splice(i, 1);
        continue;
      }
      const size = s * (pop.size || 0.62);
      ctx.font = pop.body ? `700 ${size}px "Alegreya Sans", system-ui, sans-serif` : `700 ${size}px "Grenze Gotisch", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = age < 0.7 ? 1 : (1 - age) / 0.3;
      const y = sy(pop.y) - s * (0.5 + age * 0.7);
      ctx.lineWidth = size * 0.2;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(16, 26, 48, 0.85)';
      ctx.strokeText(pop.text, sx(pop.x), y);
      ctx.fillStyle = pop.color;
      ctx.fillText(pop.text, sx(pop.x), y);
    }
    // Blitzeinschläge: von oben auf jede gelähmte Figur
    for (let i = strikes.length - 1; i >= 0; i -= 1) {
      const strike = strikes[i];
      const age = (now - strike.t) / 420;
      if (age >= 1) {
        strikes.splice(i, 1);
        continue;
      }
      const rnd = makeRng(strike.seed);
      const x0 = sx(strike.x) + (rnd() - 0.5) * s * 2;
      const y0 = Math.min(sy(strike.y) - s * 6, oy - s * 0.5);
      const x1 = sx(strike.x);
      const y1 = sy(strike.y);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const [width, color] of [[s * 0.22, 'rgba(127, 240, 255, 0.35)'], [s * 0.07, 'rgba(240, 255, 255, 0.95)']]) {
        ctx.globalAlpha = 1 - age;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, width * (1 - age * 0.5));
        ctx.lineJoin = 'miter';
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        const jag = makeRng(strike.seed + 1);
        for (let k = 1; k < 9; k += 1) {
          const f = k / 9;
          ctx.lineTo(x0 + (x1 - x0) * f + (jag() - 0.5) * s * 0.7, y0 + (y1 - y0) * f);
        }
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      ctx.restore();
    }
    // Plaketten der Items steigen über der Figur auf
    for (let i = badges.length - 1; i >= 0; i -= 1) {
      const badge = badges[i];
      const age = (now - badge.t) / 1300;
      if (age >= 1) {
        badges.splice(i, 1);
        continue;
      }
      const grow = ease(Math.min(1, age * 4));
      const alpha = age < 0.75 ? 1 : (1 - age) / 0.25;
      drawBadge(ctx, badge.item, sx(badge.x), sy(badge.y) - s * (0.75 + age * 0.7), s * 0.62 * grow, alpha);
    }
    ctx.globalAlpha = 1;
  }

  function burst(x, y, color, count, speed, now) {
    for (let i = 0; i < (calm ? Math.ceil(count / 4) : count); i += 1) {
      const ang = Math.random() * TAU;
      const v = speed * (0.4 + Math.random());
      particles.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, t: now, life: 400 + Math.random() * 500, size: 0.04 + Math.random() * 0.06, color });
    }
  }

  function locate(x, y, color, now) {
    for (let i = 0; i < 2; i += 1) rings.push({ x, y, color, t: now + i * 180, life: 800, from: 1.6, to: 0.35 });
  }

  // Ein Ereignis: Fang, Item, Falle, Kiste. `view` ist der Stand, wie ihn
  // dieses Gerät gerade sieht. Gezeigt wird nur, was man auch sehen kann.
  function effect(e, view, now, spectate) {
    if (!maze) return;
    const me = !spectate && view.slot >= 0 ? view.players[view.slot] : null;
    const mine = Boolean(me) && e.by === view.slot;
    const everything = spectate || view.phase === PHASE.END || (me && (me.dead > 0 || me.sight > 0));
    const seen = (x, y) => everything || (me && inSight(me, x, y));
    const item = ITEMS[e.item];

    if (e.kind === EVENT.CATCH) {
      const involved = me && (e.by === view.slot || e.of === view.slot);
      if (!involved && !seen(e.x, e.y)) return;
      const color = WISPS[e.of].color;
      burst(e.x, e.y, color, 28, 4.5, now);
      rings.push({ x: e.x, y: e.y, color, t: now, life: 520, from: 0.2, to: 1.5 });
      pops.push({ x: e.x + 0.45, y: e.y + 0.1, text: '−1', color, t: now });
      pops.push({ x: e.x - 0.45, y: e.y - 0.15, text: '+1', color: WISPS[e.by].color, t: now });
      if (me && e.of === view.slot) {
        flash = 1;
        flashColor = WISPS[e.by].color;
        shake = 1;
      } else if (me && e.by === view.slot) {
        shake = 0.5;
      }
      return;
    }

    if (e.kind === EVENT.PICK) {
      if (mine) {
        burst(e.x, e.y, '#ffe48a', 22, 3.5, now);
        rings.push({ x: e.x, y: e.y, color: '#ffd66a', t: now, life: 500, from: 0.2, to: 1.1 });
        badges.push({ item: e.item, x: me.x, y: me.y, t: now });
        pops.push({ x: me.x, y: me.y - 1.25, text: item ? item.name : '', color: item ? item.color : THEME.moon, t: now + 120, size: 0.36, body: true });
      } else if (seen(e.x, e.y)) {
        burst(e.x, e.y, '#ffe48a', 12, 2.5, now);
      }
      return;
    }

    if (e.kind === EVENT.FAIL) {
      if (mine) pops.push({ x: me.x, y: me.y - 0.9, text: 'Kein Platz für eine Hecke', color: THEME.moon, t: now, size: 0.32, body: true });
      return;
    }

    if (e.kind === EVENT.TRAP) {
      const victimIsMe = me && e.of === view.slot;
      if (!victimIsMe && !mine && !seen(e.x, e.y)) return;
      burst(e.x, e.y, '#b9c6da', 18, 3, now);
      burst(e.x, e.y, '#a9e58d', 12, 2, now);
      rings.push({ x: e.x, y: e.y, color: '#b9c6da', t: now, life: 420, from: 1.2, to: 0.3 });
      badges.push({ item: ITEM.trap, x: e.x, y: e.y, t: now });
      if (victimIsMe) {
        shake = 0.8;
        flash = 0.6;
        flashColor = '#5aa845';
      }
      return;
    }

    if (e.kind !== EVENT.USE || !item) return;
    if (item.secret && !mine) return; // Falle und falsche Fährte bleiben geheim
    const at = view.players[e.by];
    const userSeen = mine || seen(e.x, e.y);
    if (userSeen) {
      rings.push({ x: e.x, y: e.y, color: item.color, t: now, life: 600, from: 0.3, to: 1.7 });
      badges.push({ item: e.item, x: mine ? me.x : e.x, y: mine ? me.y : e.y, t: now });
    }
    switch (e.item) {
      case ITEM.bolt:
        flash = 0.85;
        flashColor = '#bff7ff';
        for (const p of view.players) {
          if (p.slot === e.by || p.dead > 0) continue;
          const visible = p.mine || (seen(p.x, p.y) && p.cloak === 0);
          if (visible) strikes.push({ x: p.x, y: p.y, t: now, seed: (Math.random() * 1e9) >>> 0 });
        }
        if (me && !mine && me.dead === 0) shake = 0.7;
        break;
      case ITEM.flip:
        for (const p of view.players) {
          if (p.dead > 0 || (!p.mine && !seen(p.x, p.y))) continue;
          rings.push({ x: p.x, y: p.y, color: item.color, t: now, life: 700, from: 2.2, to: 0.4 });
          rings.push({ x: p.x, y: p.y, color: item.color, t: now + 160, life: 700, from: 2.2, to: 0.4 });
        }
        break;
      case ITEM.star:
        if (userSeen) burst(e.x, e.y, item.color, 36, 5, now);
        break;
      case ITEM.cloak:
        if (userSeen) burst(e.x, e.y, '#c9bfff', 26, 2.2, now);
        break;
      case ITEM.rocket:
        if (userSeen) burst(e.x, e.y, '#ffb36b', 20, 3, now);
        break;
      case ITEM.sight:
        if (mine) rings.push({ x: e.x, y: e.y, color: item.color, t: now, life: 900, from: 0.5, to: Math.max(maze.W, maze.H) });
        break;
      case ITEM.hedge:
        if (userSeen) burst(e.x, e.y, '#a9e58d', 14, 2, now);
        break;
      case ITEM.decoy:
        if (mine) burst(e.x, e.y, item.color, 14, 2, now);
        break;
      default:
        break;
    }
    if (at && at.mine && e.item === ITEM.rocket) shake = 0.25;
  }

  function draw(view, now, { spectate = false, tags = true } = {}) {
    const dt = Math.min(0.05, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!view || !view.ready) {
      if (painted) {
        painted = '';
        backCtx.setTransform(1, 0, 0, 1, 0, 0);
        backCtx.clearRect(0, 0, back.width, back.height);
      }
      return;
    }
    ensureScene(view.maze);
    rules = view.rules || DEFAULT_RULES;

    const me = !spectate && view.slot >= 0 ? view.players[view.slot] : null;
    // Das ganze Feld sieht, wer gerade aussetzt oder Mondschein hat, und jeder am Rundenende.
    const whole = !spectate && (!me || me.dead > 0 || me.sight > 0 || view.phase === PHASE.END);
    if (view.round !== round) {
      round = view.round;
      particles.length = 0;
      pops.length = 0;
      rings.length = 0;
      strikes.length = 0;
      badges.length = 0;
      boxSeen.clear();
      for (const actor of actors) {
        actor.trail.length = 0;
        actor.tp = -1;
        actor.arrow = null;
        actor.fake = false;
      }
    }

    // Erschütterung, wenn man fängt oder gefangen wird: alle Bilder rücken gemeinsam
    let jolt = '';
    if (shake > 0 && !calm) {
      const jx = (Math.random() - 0.5) * shake * s * 0.22;
      const jy = (Math.random() - 0.5) * shake * s * 0.22;
      jolt = `translate(${jx.toFixed(1)}px, ${jy.toFixed(1)}px)`;
    }
    shake = Math.max(0, shake - dt * 3.5);
    if (jolt !== lastJolt) {
      lastJolt = jolt;
      canvas.style.transform = jolt;
      back.style.transform = jolt;
      wide.style.transform = jolt;
    }

    if (whole !== wideShown) {
      wideShown = whole;
      wide.style.opacity = whole ? '1' : '0';
    }

    // Sichtkreise: nur dort die helle Fassung des Gartens zeigen
    const R = rules.vision * s;
    if (!whole) {
      const lights = me ? [me] : view.players.filter((p) => p.dead === 0);
      // nichts davon reicht über den Garten hinaus
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(sx(-0.12), sy(-0.12), (maze.W + 0.24) * s, (maze.H + 0.24) * s, 0.22 * s);
      ctx.clip();
      ctx.save();
      ctx.beginPath();
      for (const p of lights) {
        ctx.moveTo(sx(p.x) + R, sy(p.y));
        ctx.arc(sx(p.x), sy(p.y), R, 0, TAU);
      }
      ctx.clip();
      for (const p of lights) {
        // nur den Ausschnitt der hellen Fassung übertragen, den der Kreis braucht
        const px0 = Math.max(0, Math.floor((pad + (p.x - rules.vision) * s) * dpr) - 2);
        const py0 = Math.max(0, Math.floor((pad + (p.y - rules.vision) * s) * dpr) - 2);
        const px1 = Math.min(lit.width, Math.ceil((pad + (p.x + rules.vision) * s) * dpr) + 2);
        const py1 = Math.min(lit.height, Math.ceil((pad + (p.y + rules.vision) * s) * dpr) + 2);
        if (px1 > px0 && py1 > py0) {
          ctx.drawImage(lit, px0, py0, px1 - px0, py1 - py0, ox - pad + px0 / dpr, oy - pad + py0 / dpr, (px1 - px0) / dpr, (py1 - py0) / dpr);
        }
      }
      for (const p of lights) {
        const cx = sx(p.x);
        const cy = sy(p.y);
        if (me) {
          // zum Rand hin etwas dunkler, der Rand selbst bleibt eine klare Kante
          const fade = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
          fade.addColorStop(0, 'rgba(21, 35, 63, 0)');
          fade.addColorStop(0.62, 'rgba(21, 35, 63, 0)');
          fade.addColorStop(1, 'rgba(21, 35, 63, 0.45)');
          ctx.fillStyle = fade;
          ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
        }
        // warmer Schein um die Figur
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.8);
        glow.addColorStop(0, 'rgba(255, 244, 200, 0.24)');
        glow.addColorStop(1, 'rgba(255, 244, 200, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
      }
      ctx.restore();
      if (me) {
        ctx.lineWidth = Math.max(1.5, s * 0.03);
        ctx.strokeStyle = 'rgba(242, 240, 221, 0.3)';
        ctx.beginPath();
        ctx.arc(sx(me.x), sy(me.y), R, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Wer ist zu sehen?
    for (const p of view.players) {
      const actor = actors[p.slot];
      const out = p.dead > 0;
      // Unsichtbare sieht niemand, außer am Rundenende und im Vorschaubild
      const hidden = p.cloak > 0 && !p.mine && !spectate && view.phase !== PHASE.END;
      const visible = !out && !hidden && (whole || spectate || p.mine || inSight(me, p.x, p.y));
      actor.alpha += ((visible ? 1 : 0) - actor.alpha) * Math.min(1, dt * (visible ? 18 : 10));
      if (out && !p.mine) actor.alpha = 0;
      if (actor.tp !== p.tp) {
        if (actor.tp !== -1 || view.phase === PHASE.COUNTDOWN) actor.trail.length = 0;
        if (p.mine) locate(p.x, p.y, WISPS[p.slot].color, now);
        if (!visible) actor.alpha = 0;
        actor.tp = p.tp;
      }
      if (out) actor.trail.length = 0;
      const last = actor.trail[actor.trail.length - 1];
      if (!out && view.phase === PHASE.PLAY && (!last || Math.abs(last.x - p.x) + Math.abs(last.y - p.y) > 0.045)) {
        actor.trail.push({ x: p.x, y: p.y, t: now, life: p.sp ? 330 : 210 });
      }
      // Funken der Rakete und Glitzer des Sterns, nur wo man die Figur sieht
      if (visible && view.phase === PHASE.PLAY && !calm) {
        const speed = Math.hypot(p.vx, p.vy);
        if (p.ph > 0) {
          const ux = speed > 0.3 ? -p.vx / speed : 0;
          const uy = speed > 0.3 ? -p.vy / speed : 1;
          for (let i = 0; i < Math.ceil(dt * 120); i += 1) {
            particles.push({
              x: p.x + ux * 0.35 + (Math.random() - 0.5) * 0.15, y: p.y + uy * 0.35 + (Math.random() - 0.5) * 0.15,
              vx: ux * (2 + Math.random() * 2) + (Math.random() - 0.5) * 1.5, vy: uy * (2 + Math.random() * 2) + (Math.random() - 0.5) * 1.5,
              t: now, life: 260 + Math.random() * 260, size: 0.04 + Math.random() * 0.05,
              color: ['#fff2b0', '#ffb347', '#ff6b3d', '#9aa3b5'][Math.floor(Math.random() * 4)],
            });
          }
        }
        if (p.star > 0 && Math.random() < dt * 25) {
          const ang = Math.random() * TAU;
          particles.push({ x: p.x + Math.cos(ang) * 0.45, y: p.y + Math.sin(ang) * 0.45, vx: Math.cos(ang) * 0.6, vy: Math.sin(ang) * 0.6 - 0.4, t: now, life: 600, size: 0.035, color: `hsl(${(now / 5 + ang * 60) % 360}, 100%, 75%)` });
        }
      }
      while (actor.trail.length && now - actor.trail[0].t > actor.trail[0].life) actor.trail.shift();
    }
    if (me && view.phase === PHASE.COUNTDOWN && Math.floor(now / 1000) !== Math.floor((now - dt * 1000) / 1000)) {
      locate(me.x, me.y, WISPS[me.slot].color, now);
    }

    // Gepflanzte Hecken, Kisten und eigene Fallen liegen unter den Figuren
    drawHedges(view);
    if (me && view.phase === PHASE.PLAY) drawTraps(view, now);
    if (view.phase === PHASE.PLAY || view.phase === PHASE.COUNTDOWN) drawBoxes(view, me, now);

    // Erst die anderen, die eigene Figur zuoberst
    const order = view.players.filter((p) => !p.mine).concat(view.players.filter((p) => p.mine));
    for (const p of order) {
      const actor = actors[p.slot];
      if (p.mine && p.dead > 0) {
        drawGhost(p, actor, now, dt);
        continue;
      }
      if (actor.alpha < 0.02) continue;
      // Die eigene Figur unter der Tarnkappe bleibt für einen selbst blass zu sehen
      const alpha = actor.alpha * (p.cloak > 0 ? 0.38 : 1);
      auraBack(p, actor.alpha, now);
      drawWisp(p, actor, alpha, now, dt);
      auraFront(p, actor.alpha, now);
    }
    if (me) {
      const playing = view.phase === PHASE.PLAY || view.phase === PHASE.COUNTDOWN;
      if (me.dead === 0 && playing) {
        drawOwnMarks(me, now);
        drawArrows(view, me, now, dt);
      }
      if (tags && view.phase !== PHASE.END) {
        for (const p of view.players) {
          if (p.mine || actors[p.slot].alpha < 0.05) continue;
          const role = canCatch(view.ringDir, me, p) ? 'prey' : canCatch(view.ringDir, p, me) ? 'hunter' : null;
          const text = p.star > 0 ? 'Stern, jagt dich' : role === 'prey' ? 'deine Beute' : role === 'hunter' ? 'jagt dich' : '';
          drawRoleMarks(p, actors[p.slot].alpha, role, text, now);
        }
      }
    }
    if (tags && view.phase === PHASE.END) {
      for (const p of view.players) label(p.name, sx(p.x), sy(p.y) + PLAYER_R * s * 1.5, Math.max(11, s * 0.24), 1);
    }

    drawEffects(now, dt);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (flash > 0) {
      const g = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.25, cw / 2, ch / 2, Math.max(cw, ch) * 0.7);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, flashColor);
      ctx.globalAlpha = flash * 0.5;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cw, ch);
      ctx.globalAlpha = 1;
      flash = Math.max(0, flash - dt * 2.2);
    }
  }

  resize();
  return { draw, resize, setInsets, effect, cell: () => s, tickRate: TICK_RATE };
}
