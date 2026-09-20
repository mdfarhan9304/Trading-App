// seeded rng — Math.random() can't replay a market
export interface Rng {
  next(): number;
  normal(): number;
  exponential(mean: number): number;
  int(min: number, max: number): number;
  chance(probability: number): boolean;
}

export function createRng(seed: number): Rng {
  let state = (seed ^ 0x9e3779b9) >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const normal = (): number => {
    // Box-Muller transform. We generate one value per call and discard the second;
    // caching it would save a few operations but makes the generator's state harder
    // to reason about, and this is not a hot path.
    let u = next();
    // Guard against log(0), which would produce Infinity.
    while (u === 0) u = next();
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const exponential = (mean: number): number => {
    let u = next();
    while (u === 0) u = next();
    return -Math.log(u) * mean;
  };

  const int = (min: number, max: number): number => {
    return min + Math.floor(next() * (max - min + 1));
  };

  const chance = (probability: number): boolean => next() < probability;

  return { next, normal, exponential, int, chance };
}
