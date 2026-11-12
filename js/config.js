// Stellschrauben des Spiels. Längen in Feldern, Zeiten in Sekunden.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const PROTOCOL = 3;

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

// Was der Gastgeber im Raum einstellen kann. Jede Einstellung hat drei Stufen,
// die mittlere ist der Normalfall. Übertragen wird nur die Stufe (0, 1, 2).
export const SETTINGS = [
  { key: 'speed', label: 'Tempo', options: ['langsam', 'normal', 'schnell'], values: [0.8, 1, 1.25] },
  { key: 'vision', label: 'Sichtkreis', options: ['klein', 'mittel', 'groß'], values: [2.5, VISION_RADIUS, 5] },
  { key: 'maze', label: 'Labyrinth', options: ['klein', 'mittel', 'groß'], values: [[16, 10], [MAZE_W, MAZE_H], [24, 14]] },
  { key: 'stamina', label: 'Ausdauer', options: ['wenig', 'normal', 'viel'], values: [1.4, SPRINT_SECONDS, 3.4] },
  { key: 'respawn', label: 'Auszeit', options: ['1 s', '3 s', '5 s'], values: [1, RESPAWN_TICKS / TICK_RATE, 5] },
  { key: 'fever', label: 'Jagdfieber', options: ['aus', 'normal', 'stark'], values: [1, HUNT_BOOST, 1.3] },
];
export const ROUND_LENGTHS = [120, ROUND_SECONDS, 300];
export const DEFAULT_LEVELS = SETTINGS.map(() => 1);

// Macht aus beliebigen Daten eine gültige Liste von Stufen.
export function cleanLevels(levels) {
  return SETTINGS.map((setting, i) => {
    const level = Array.isArray(levels) ? levels[i] : undefined;
    return Number.isInteger(level) && level >= 0 && level < setting.values.length ? level : 1;
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
  };
}
export const DEFAULT_RULES = rulesFor(DEFAULT_LEVELS);

// Die drei Irrlichter. Die Zahl der Zacken unterscheidet sie auch ohne Farbe.
export const WISPS = [
  { name: 'Glut', color: '#ff9a45', deep: '#c2541a', lobes: 0 },
  { name: 'Frost', color: '#63b9ff', deep: '#1f6fc4', lobes: 4 },
  { name: 'Malve', color: '#f08bd8', deep: '#a83f93', lobes: 3 },
];
