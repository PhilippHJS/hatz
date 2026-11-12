// Tastatur. Gelesen wird die Lage der Taste, nicht ihr Buchstabe, damit WASD
// auf jeder Tastatur an derselben Stelle liegt. Drückt man links und rechts
// zugleich, gilt die zuletzt gedrückte Richtung. E löst das Item auf Vorrat
// aus, und zwar einmal je Tastendruck.

import { packInput } from './physics.js';

const KEYS = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'sprint', ShiftLeft: 'sprint', ShiftRight: 'sprint',
  KeyE: 'use', Enter: 'use',
};

export function createKeyboard(target = window) {
  const held = new Map(); // Taste -> Aktion
  const pressedAt = { up: 0, down: 0, left: 0, right: 0, sprint: 0 };
  let counter = 0;
  let enabled = false;
  let moved = false;
  let use = false; // E gedrückt, aber noch nicht abgeholt

  const isDown = (action) => {
    for (const value of held.values()) if (value === action) return true;
    return false;
  };
  const typing = (event) => {
    const el = event.target;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  };

  target.addEventListener('keydown', (event) => {
    const action = KEYS[event.code];
    if (!action || !enabled || typing(event) || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (event.repeat || held.has(event.code)) return;
    if (action === 'use') {
      use = true;
      return;
    }
    held.set(event.code, action);
    counter += 1;
    pressedAt[action] = counter;
    if (action !== 'sprint') moved = true;
  });
  target.addEventListener('keyup', (event) => {
    if (held.delete(event.code)) event.preventDefault();
  });
  const release = () => held.clear();
  target.addEventListener('blur', release);
  document.addEventListener('visibilitychange', release);

  const axis = (neg, pos) => {
    const n = isDown(neg);
    const p = isDown(pos);
    if (n && p) return pressedAt[neg] > pressedAt[pos] ? -1 : 1;
    return n ? -1 : p ? 1 : 0;
  };

  return {
    code: () => {
      if (!enabled) return packInput(0, 0, false);
      const fire = use;
      use = false;
      return packInput(axis('left', 'right'), axis('up', 'down'), isDown('sprint'), fire);
    },
    setEnabled(on) {
      if (enabled && !on) release();
      if (!on) use = false;
      enabled = on;
    },
    hasMoved: () => moved,
  };
}
