// Stellschrauben des Spiels. Längen in Feldern, Zeiten in Sekunden.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const PROTOCOL = 1;

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
export const SHIELD_TICKS = Math.round(2.5 * TICK_RATE); // Schonfrist nach dem Wiedereinstieg
export const COUNTDOWN_TICKS = 4 * TICK_RATE;
export const ROUND_SECONDS = 180;

export const VISION_RADIUS = 7.5;

// Die drei Irrlichter. Die Zahl der Zacken unterscheidet sie auch ohne Farbe.
export const WISPS = [
  { name: 'Glut', color: '#ff9a45', deep: '#c2541a', lobes: 0 },
  { name: 'Frost', color: '#63b9ff', deep: '#1f6fc4', lobes: 4 },
  { name: 'Malve', color: '#f08bd8', deep: '#a83f93', lobes: 3 },
];
