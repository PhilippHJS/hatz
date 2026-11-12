// Stellschrauben des Spiels. Längen in Feldern, Zeiten in Sekunden.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const PROTOCOL = 4;

export const MAZE_W = 20;
export const MAZE_H = 12;

export const PLAYER_R = 0.27;
export const WALL_T = 0.14; // Dicke der Hecken
export const HIT_R = PLAYER_R + WALL_T / 2; // Abstand, den die Mitte einer Figur zur Heckenmitte hält

export const WALK_SPEED = 4.4;
export const SPRINT_SPEED = 6.6;
export const ACCEL = 0.42; // Anteil, um den sich das Tempo pro Schritt dem Ziel nähert
export const HUNT_BOOST = 1.15; // Jagdfieber: so viel schneller ist, wer seine Beute sieht

export const SPRINT_SECONDS = 2.2; // so lange reicht die volle Ausdauer
export const REGEN_SECONDS = 5.5; // so lange dauert es von leer bis voll
export const REGEN_DELAY = Math.round(0.5 * TICK_RATE); // Schritte Pause, bevor sie sich erholt
export const RECOVER_AT = 0.25; // wer sich leer gesprintet hat, darf ab hier wieder

export const CATCH_DIST = PLAYER_R * 2.1;
export const RESPAWN_TICKS = 3 * TICK_RATE; // Auszeit nach dem Fang, mit Blick aufs ganze Feld
export const SHIELD_TICKS = Math.round(2.5 * TICK_RATE); // Schonfrist nach dem Wiedereinstieg
export const COUNTDOWN_TICKS = 4 * TICK_RATE;
export const ROUND_SECONDS = 180;

// Sichtkreis: Wer näher ist, wird gesehen, auch hinter einer Hecke.
export const VISION_RADIUS = 3.5;

// Was der Gastgeber im Raum einstellen kann. Übertragen wird nur die Stufe
// (0, 1, 2). `normal` ist die Stufe, mit der ein neuer Raum beginnt.
export const SETTINGS = [
  { key: 'items', label: 'Items', options: ['aus', 'an'], values: [false, true], normal: 1 },
  { key: 'speed', label: 'Tempo', options: ['langsam', 'normal', 'schnell'], values: [0.8, 1, 1.25], normal: 1 },
  { key: 'vision', label: 'Sichtkreis', options: ['klein', 'mittel', 'groß'], values: [2.5, VISION_RADIUS, 5], normal: 1 },
  { key: 'maze', label: 'Labyrinth', options: ['klein', 'mittel', 'groß'], values: [[16, 10], [MAZE_W, MAZE_H], [24, 14]], normal: 1 },
  { key: 'stamina', label: 'Ausdauer', options: ['wenig', 'normal', 'viel'], values: [1.4, SPRINT_SECONDS, 3.4], normal: 1 },
  { key: 'respawn', label: 'Auszeit', options: ['1 s', '3 s', '5 s'], values: [1, RESPAWN_TICKS / TICK_RATE, 5], normal: 1 },
  { key: 'fever', label: 'Jagdfieber', options: ['aus', 'normal', 'stark'], values: [1, HUNT_BOOST, 1.3], normal: 1 },
];
export const ROUND_LENGTHS = [120, ROUND_SECONDS, 300];
export const DEFAULT_LEVELS = SETTINGS.map((setting) => setting.normal);

// Macht aus beliebigen Daten eine gültige Liste von Stufen.
export function cleanLevels(levels) {
  return SETTINGS.map((setting, i) => {
    const level = Array.isArray(levels) ? levels[i] : undefined;
    return Number.isInteger(level) && level >= 0 && level < setting.values.length ? level : setting.normal;
  });
}

// Die Regeln einer Runde, aus den Stufen ausgerechnet.
export function rulesFor(levels) {
  const clean = cleanLevels(levels);
  const value = {};
  SETTINGS.forEach((setting, i) => {
    value[setting.key] = setting.values[clean[i]];
  });
  return {
    speed: value.speed, // Faktor auf Geh- und Sprinttempo
    vision: value.vision, // Radius des Sichtkreises
    mazeW: value.maze[0],
    mazeH: value.maze[1],
    sprintSeconds: value.stamina, // so lange reicht die volle Ausdauer
    respawnTicks: Math.round(value.respawn * TICK_RATE),
    huntBoost: value.fever,
    items: value.items, // Kisten mit Items im Labyrinth
  };
}
export const DEFAULT_RULES = rulesFor(DEFAULT_LEVELS);

// Die drei Irrlichter. Die Zahl der Zacken unterscheidet sie auch ohne Farbe.
export const WISPS = [
  { name: 'Glut', color: '#ff9a45', deep: '#c2541a', lobes: 0 },
  { name: 'Frost', color: '#63b9ff', deep: '#1f6fc4', lobes: 4 },
  { name: 'Malve', color: '#f08bd8', deep: '#a83f93', lobes: 3 },
];

// ---------- Items ----------
//
// Kisten liegen im Labyrinth und leuchten auch im Dunkeln. Wer eine berührt und
// nichts auf Vorrat hat, bekommt ein zufälliges Item und löst es mit E aus.
// Wer hinten liegt, bekommt eher die starken (Aufholhilfe).
//
// `weight` gibt an, wie oft das Item kommt: für den Führenden, die Mitte und
// den Letzten. `secret`: Die anderen erfahren nicht, dass es benutzt wurde.
// `icon`: Pfade in einem Feld von 24 × 24, `fill` gefüllt, `line` als Strich.
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

export const ITEMS = [
  {
    id: 'sight', name: 'Mondschein', color: '#d6e6ff', seconds: 6, weight: [4, 3, 1],
    hint: 'Du siehst kurz das ganze Feld.',
    icon: { fill: ['M14.6 3.1A9.2 9.2 0 1 0 21 15.2 7.4 7.4 0 0 1 14.6 3.1z', circle(19, 5.5, 1.2), circle(21.2, 9.6, 0.8)] },
  },
  {
    id: 'cloak', name: 'Tarnkappe', color: '#a796ff', seconds: 6, weight: [3, 3, 3],
    hint: 'Niemand sieht dich, auch der Pfeil deines Jägers verschwindet.',
    icon: { fill: ['M12 2.2 6.4 16.2h11.2z', 'M3.6 15.6h16.8a1.9 1.9 0 0 1 0 3.8H3.6a1.9 1.9 0 0 1 0-3.8z'] },
  },
  {
    id: 'rocket', name: 'Rakete', color: '#ff6b57', seconds: 2.5, weight: [1, 2, 3],
    hint: 'Du fliegst kurz durch Hecken.',
    icon: {
      fill: [
        'M12 1.8c3.2 2.6 4.6 6.4 4.6 10.2v3.6H7.4V12c0-3.8 1.4-7.6 4.6-10.2z',
        'M7.4 11.6 4 15.6v3.2l3.4-1.6zM16.6 11.6 20 15.6v3.2l-3.4-1.6z',
        'M9.6 17.4h4.8L12 22.6z',
      ],
    },
  },
  {
    id: 'star', name: 'Stern', color: '#ffd23f', seconds: 6, weight: [0.5, 1.5, 4],
    hint: 'Du jagst beide und kannst nicht gefangen werden.',
    icon: { fill: ['M12 2.2l2.95 6.05 6.65.95-4.8 4.65 1.15 6.6L12 17.3l-5.95 3.15 1.15-6.6L2.4 9.2l6.65-.95z'] },
  },
  {
    id: 'bolt', name: 'Blitz', color: '#7ff0ff', seconds: 1, weight: [1, 2, 3],
    hint: 'Alle anderen sind eine Sekunde gelähmt.',
    icon: { fill: ['M13.6 1.8 4.4 13.4h6.3L9.2 22.2l10.4-12.4h-6.4z'] },
  },
  {
    id: 'flip', name: 'Kehrtwende', color: '#5fe3a1', seconds: 8, weight: [2, 3, 3],
    hint: 'Der Ring dreht sich um: Wer dich jagt, wird deine Beute.',
    icon: {
      line: ['M3.5 8h12.5', 'M20.5 16H8'],
      fill: ['M14.6 3.8 20.2 8l-5.6 4.2zM9.4 11.8 3.8 16l5.6 4.2z'],
    },
  },
  {
    id: 'hedge', name: 'Hecke', color: '#a6dd5a', seconds: 5, weight: [3, 3, 2],
    hint: 'Hinter dir wächst der Gang zu.',
    icon: { fill: [circle(7.6, 14.2, 4.6), circle(16.4, 14.2, 4.6), circle(12, 9.2, 5.4), 'M4.2 15h15.6v4.6H4.2z'] },
  },
  {
    id: 'trap', name: 'Falle', color: '#b9c6da', seconds: 2, weight: [4, 3, 2], secret: true,
    hint: 'Eine unsichtbare Falle hält den Nächsten fest, der darüberläuft.',
    icon: { fill: ['M2.6 11.2h18.8a9.4 9.4 0 0 1-18.8 0z', 'M2.6 11.6 4.2 6.4l1.6 5.2 1.6-5.2 1.6 5.2 1.6-5.2 1.6 5.2 1.6-5.2 1.6 5.2 1.6-5.2 1.6 5.2 1.6-5.2 1.6 5.2z'] },
  },
  {
    id: 'decoy', name: 'Falsche Fährte', color: '#e8c396', seconds: 8, weight: [4, 3, 2], secret: true,
    hint: 'Der Pfeil deines Jägers zeigt auf eine falsche Stelle.',
    icon: {
      fill: [
        'M5.2 15.6c0-2.4 1.1-4.2 2.6-4.2s2.6 1.8 2.6 4.2-1.1 4.6-2.6 4.6-2.6-2.2-2.6-4.6z',
        circle(5.8, 9.4, 1), circle(8, 8.6, 1), circle(10.1, 9.4, 1),
        'M13.6 10c0-2.4 1.1-4.2 2.6-4.2s2.6 1.8 2.6 4.2-1.1 4.6-2.6 4.6-2.6-2.2-2.6-4.6z',
        circle(14.2, 3.8, 1), circle(16.4, 3, 1), circle(18.5, 3.8, 1),
      ],
    },
  },
];
export const ITEM = Object.fromEntries(ITEMS.map((item, index) => [item.id, index]));
export const itemTicks = (index) => Math.round(ITEMS[index].seconds * TICK_RATE);

export const BOX_RADIUS = 0.5; // so nah muss man an eine Kiste heran
export const BOX_RESPAWN_TICKS = 7 * TICK_RATE; // so lange dauert es bis zur nächsten Kiste
export const TRAP_RADIUS = 0.42; // so nah löst eine Falle aus
export const TRAP_LIFE_TICKS = 45 * TICK_RATE; // so lange wartet eine Falle
export const boxCount = (cells) => Math.max(2, Math.round(cells / 80));
