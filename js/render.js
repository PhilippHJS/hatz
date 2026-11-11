// Zeichnet das Spiel auf die Leinwand: nächtlicher Irrgarten, hell ist nur,
// was die eigene Figur sieht.
//
// Der Garten wird zweimal vorab gemalt, einmal im Mondlicht und einmal im
// Dunkeln. Pro Bild entscheidet eine weiche Lichtmaske, wo welche Fassung zu
// sehen ist. Darüber kommen die Irrlichter und Effekte.

import { WISPS, PLAYER_R, WALL_T, VISION_RADIUS, TICK_RATE, SHIELD_TICKS } from './config.js';
import { visibility, wallPosts } from './vision.js';
import { canSee } from './maze.js';
import { PHASE } from './sim.js';
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
const LIGHT_DIV = 3; // die Lichtmaske ist gröber als das Bild, das macht ihre Ränder weich
const TAU = Math.PI * 2;

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const lit = document.createElement('canvas');
  const dark = document.createElement('canvas');
  const mix = document.createElement('canvas');
  const light = document.createElement('canvas');
  const litCtx = lit.getContext('2d');
  const darkCtx = dark.getContext('2d');
  const mixCtx = mix.getContext('2d');
  const lightCtx = light.getContext('2d');
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
  let posts = null;
  let lastNow = 0;
  let round = -1;

  const actors = [0, 1, 2].map(() => ({
    alpha: 0, trail: [], lookX: 0, lookY: 1, blink: 2 + Math.random() * 3, tp: -1, wob: Math.random() * 10, calmFor: 9,
  }));
  const particles = [];
  const pops = [];
  const rings = [];
  let shake = 0;
  let flash = 0;
  let flashColor = '#fff';
  const poly = [];

  function resize() {
    const rect = canvas.getBoundingClientRect();
    cw = Math.max(1, Math.round(rect.width));
    ch = Math.max(1, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cw * ch * dpr * dpr > 4.5e6) dpr = Math.max(1, Math.sqrt(4.5e6 / (cw * ch)));
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
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
    const key = `${m.seed}|${cw}|${ch}|${dpr}|${insets.top}|${insets.right}|${insets.bottom}|${insets.left}`;
    if (key === painted) return;
    painted = key;
    maze = m;
    posts = wallPosts(m);
    layout(m);
    paintScene(litCtx, lit, m, true);
    paintScene(darkCtx, dark, m, false);
    mix.width = lit.width;
    mix.height = lit.height;
    light.width = Math.ceil(lit.width / (LIGHT_DIV * dpr));
    light.height = Math.ceil(lit.height / (LIGHT_DIV * dpr));
  }

  const sx = (x) => ox + x * s;
  const sy = (y) => oy + y * s;

  function addLight(px, py, radius) {
    visibility(maze, posts, px, py, radius, poly);
    const q = 1 / LIGHT_DIV;
    const cx = (pad + px * s) * q;
    const cy = (pad + py * s) * q;
    const grad = lightCtx.createRadialGradient(cx, cy, 0, cx, cy, radius * s * q);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.85, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    lightCtx.fillStyle = grad;
    lightCtx.beginPath();
    for (let i = 0; i < poly.length; i += 2) {
      const x = (pad + poly[i] * s) * q;
      const y = (pad + poly[i + 1] * s) * q;
      if (i === 0) lightCtx.moveTo(x, y);
      else lightCtx.lineTo(x, y);
    }
    lightCtx.closePath();
    lightCtx.fill();
  }

  // Sieht `me` die Stelle (x, y)? Etwas großzügig, damit niemand am Rand flackert.
  function inSight(me, x, y) {
    if (canSee(maze, me.x, me.y, x, y, VISION_RADIUS)) return true;
    const d = PLAYER_R * 0.8;
    return canSee(maze, me.x, me.y, x + d, y, VISION_RADIUS) || canSee(maze, me.x, me.y, x - d, y, VISION_RADIUS)
      || canSee(maze, me.x, me.y, x, y + d, VISION_RADIUS) || canSee(maze, me.x, me.y, x, y - d, VISION_RADIUS);
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

  function drawRoleMarks(p, alpha, role, now) {
    const x = sx(p.x);
    const y = sy(p.y);
    const r = PLAYER_R * s;
    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeStyle = THEME.moon;
    ctx.lineWidth = Math.max(1.5, s * 0.032);
    if (role === 'prey') {
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
    label(role === 'prey' ? 'deine Beute' : 'jagt dich', x, y + r * 2.2 + size * 1.05, size * 0.82, alpha * 0.8, 500);
  }

  function drawOwnMarks(me, actor, prey, preyAlpha, now, dt, phase) {
    const x = sx(me.x);
    const y = sy(me.y);
    const r = PLAYER_R * s;

    // Ausdauer als Bogen um die Figur, blendet aus, wenn sie voll ist
    actor.calmFor = me.st >= 1 ? actor.calmFor + dt : 0;
    const show = Math.max(0, Math.min(1, 1.6 - actor.calmFor * 2));
    if (show > 0) {
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(2, s * 0.05);
      ctx.globalAlpha = show * 0.28;
      ctx.strokeStyle = THEME.moon;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.55, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = show * 0.95;
      ctx.strokeStyle = me.ex ? THEME.alarm : THEME.moon;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.55, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(me.st, 0.001));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Pfeil zur Beute, in ihrer Farbe
    if (prey && phase !== PHASE.END) {
      const dx = prey.x - me.x;
      const dy = prey.y - me.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0.9) {
        const ux = dx / d;
        const uy = dy / d;
        const dist = r * 2.3 + (calm ? 0 : Math.sin(now * 0.006) * r * 0.16);
        const tipX = x + ux * (dist + r * 1.05);
        const tipY = y + uy * (dist + r * 1.05);
        const bx = x + ux * dist;
        const by = y + uy * dist;
        const w = r * 0.68;
        ctx.globalAlpha = preyAlpha > 0.5 ? 0.45 : 0.95;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(bx - uy * w, by + ux * w);
        ctx.lineTo(bx + ux * r * 0.32, by + uy * r * 0.32);
        ctx.lineTo(bx + uy * w, by - ux * w);
        ctx.closePath();
        ctx.fillStyle = WISPS[prey.slot].color;
        ctx.fill();
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(1.5, s * 0.035);
        ctx.strokeStyle = 'rgba(16, 26, 48, 0.85)';
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
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
      const size = s * 0.62;
      ctx.font = `700 ${size}px "Grenze Gotisch", serif`;
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
    ctx.globalAlpha = 1;
  }

  function locate(x, y, color, now) {
    for (let i = 0; i < 2; i += 1) rings.push({ x, y, color, t: now + i * 180, life: 800, from: 1.6, to: 0.35 });
  }

  // Ein Fang. `view` ist der Stand, wie ihn dieses Gerät gerade sieht.
  function effect(e, view, now, spectate) {
    if (!maze || e.type !== 'catch') return;
    const me = view.slot >= 0 ? view.players[view.slot] : null;
    const involved = me && (e.by === view.slot || e.of === view.slot);
    if (!spectate && !involved && !(me && inSight(me, e.x, e.y))) return;
    const color = WISPS[e.of].color;
    const rng = Math.random;
    for (let i = 0; i < (calm ? 8 : 28); i += 1) {
      const ang = rng() * TAU;
      const v = 1.5 + rng() * 5.5;
      particles.push({ x: e.x, y: e.y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, t: now, life: 450 + rng() * 500, size: 0.05 + rng() * 0.07, color });
    }
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
  }

  function draw(view, now, { spectate = false, tags = true } = {}) {
    const dt = Math.min(0.05, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!view || !view.ready) return;
    ensureScene(view.maze);

    const me = !spectate && view.slot >= 0 ? view.players[view.slot] : null;
    const allLit = spectate || !me || view.phase === PHASE.END;
    if (view.round !== round) {
      round = view.round;
      particles.length = 0;
      pops.length = 0;
      rings.length = 0;
      for (const actor of actors) {
        actor.trail.length = 0;
        actor.tp = -1;
      }
    }

    // Lichtmaske
    lightCtx.setTransform(1, 0, 0, 1, 0, 0);
    lightCtx.globalCompositeOperation = 'source-over';
    lightCtx.clearRect(0, 0, light.width, light.height);
    lightCtx.globalCompositeOperation = 'lighter';
    if (allLit) for (const p of view.players) addLight(p.x, p.y, VISION_RADIUS);
    else addLight(me.x, me.y, VISION_RADIUS);

    mixCtx.setTransform(1, 0, 0, 1, 0, 0);
    mixCtx.globalCompositeOperation = 'copy';
    mixCtx.imageSmoothingEnabled = true;
    mixCtx.imageSmoothingQuality = 'high';
    mixCtx.drawImage(light, 0, 0, light.width, light.height, 0, 0, light.width * LIGHT_DIV * dpr, light.height * LIGHT_DIV * dpr);
    mixCtx.globalCompositeOperation = 'source-in';
    mixCtx.drawImage(lit, 0, 0);
    // warmer Schein rund um jede Lichtquelle, nur dort, wo ohnehin Licht ist
    mixCtx.globalCompositeOperation = 'source-atop';
    for (const p of view.players) {
      if (!allLit && p !== me) continue;
      const cx = (pad + p.x * s) * dpr;
      const cy = (pad + p.y * s) * dpr;
      const glow = mixCtx.createRadialGradient(cx, cy, 0, cx, cy, s * dpr * 3.2);
      glow.addColorStop(0, 'rgba(255, 244, 200, 0.26)');
      glow.addColorStop(1, 'rgba(255, 244, 200, 0)');
      mixCtx.fillStyle = glow;
      mixCtx.fillRect(cx - s * dpr * 3.2, cy - s * dpr * 3.2, s * dpr * 6.4, s * dpr * 6.4);
    }
    mixCtx.globalCompositeOperation = 'source-over';

    // Erschütterung, wenn man fängt oder gefangen wird
    let jx = 0;
    let jy = 0;
    if (shake > 0 && !calm) {
      jx = (Math.random() - 0.5) * shake * s * 0.22;
      jy = (Math.random() - 0.5) * shake * s * 0.22;
    }
    shake = Math.max(0, shake - dt * 3.5);
    ctx.setTransform(dpr, 0, 0, dpr, jx * dpr, jy * dpr);

    const lw = lit.width / dpr;
    const lh = lit.height / dpr;
    ctx.drawImage(dark, ox - pad, oy - pad, lw, lh);
    ctx.drawImage(mix, ox - pad, oy - pad, lw, lh);

    // Wer ist zu sehen?
    for (const p of view.players) {
      const actor = actors[p.slot];
      const visible = allLit || p.mine || inSight(me, p.x, p.y);
      actor.alpha += ((visible ? 1 : 0) - actor.alpha) * Math.min(1, dt * (visible ? 16 : 7));
      if (actor.tp !== p.tp) {
        if (actor.tp !== -1 || view.phase === PHASE.COUNTDOWN) actor.trail.length = 0;
        if (p.mine) locate(p.x, p.y, WISPS[p.slot].color, now);
        if (!visible) actor.alpha = 0;
        actor.tp = p.tp;
      }
      const last = actor.trail[actor.trail.length - 1];
      if (view.phase === PHASE.PLAY && (!last || Math.abs(last.x - p.x) + Math.abs(last.y - p.y) > 0.045)) {
        actor.trail.push({ x: p.x, y: p.y, t: now, life: p.sp ? 330 : 210 });
      }
      while (actor.trail.length && now - actor.trail[0].t > actor.trail[0].life) actor.trail.shift();
    }
    if (me && view.phase === PHASE.COUNTDOWN && Math.floor(now / 1000) !== Math.floor((now - dt * 1000) / 1000)) {
      locate(me.x, me.y, WISPS[me.slot].color, now);
    }

    // Erst die anderen, die eigene Figur zuoberst
    const order = view.players.filter((p) => !p.mine).concat(view.players.filter((p) => p.mine));
    for (const p of order) {
      const actor = actors[p.slot];
      if (actor.alpha < 0.02) continue;
      drawWisp(p, actor, actor.alpha, now, dt);
    }
    if (me) {
      const prey = view.players[view.prey];
      drawOwnMarks(me, actors[me.slot], prey, actors[prey.slot].alpha, now, dt, view.phase);
      if (tags && view.phase !== PHASE.END) {
        for (const p of view.players) {
          if (p.mine || actors[p.slot].alpha < 0.05) continue;
          drawRoleMarks(p, actors[p.slot].alpha, p.slot === view.prey ? 'prey' : 'hunter', now);
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
