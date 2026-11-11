// Sichtfeld: die Fläche, die man von einem Punkt aus sehen kann, als Vieleck.
// Strahlen gehen knapp links und rechts an jedem Heckenende vorbei, dazu ein
// gleichmäßiger Fächer für die Rundung am Rand der Sichtweite.

import { castRay, hWall, vWall } from './maze.js';

const EPS = 1e-4;
const FAN = 56;

// Gitterpunkte, an denen mindestens eine Hecke hängt
export function wallPosts(m) {
  const posts = [];
  for (let y = 0; y <= m.H; y += 1) {
    for (let x = 0; x <= m.W; x += 1) {
      const touches = (x > 0 && hWall(m, x - 1, y)) || (x < m.W && hWall(m, x, y))
        || (y > 0 && vWall(m, x, y - 1)) || (y < m.H && vWall(m, x, y));
      if (touches) posts.push(x, y);
    }
  }
  return posts;
}

const angles = [];

// Liefert das Sichtvieleck als flache Liste [x0, y0, x1, y1, ...].
export function visibility(m, posts, px, py, radius, out = []) {
  angles.length = 0;
  const reach = (radius + 1) * (radius + 1);
  for (let i = 0; i < posts.length; i += 2) {
    const dx = posts[i] - px;
    const dy = posts[i + 1] - py;
    if (dx * dx + dy * dy > reach) continue;
    const a = Math.atan2(dy, dx);
    angles.push(a - EPS, a + EPS);
  }
  for (let i = 0; i < FAN; i += 1) angles.push(-Math.PI + (i * 2 * Math.PI) / FAN);
  angles.sort((a, b) => a - b);

  out.length = 0;
  for (let i = 0; i < angles.length; i += 1) {
    const dx = Math.cos(angles[i]);
    const dy = Math.sin(angles[i]);
    const t = castRay(m, px, py, dx, dy, radius);
    out.push(px + dx * t, py + dy * t);
  }
  return out;
}
