// Kleiner Zufallsgenerator mit Startwert. Gleicher Startwert, gleiche Folge,
// auf jedem Gerät. So entsteht bei allen dasselbe Labyrinth.
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (list) => list[next.int(list.length)];
  next.shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = next.int(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  return next;
}

export const randomSeed = () => (Math.random() * 4294967296) >>> 0;
