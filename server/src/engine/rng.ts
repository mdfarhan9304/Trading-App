/**
 * Deterministic pseudo-random number generator.
 *
 * WHY NOT Math.random()
 * ---------------------
 * `Math.random()` cannot be seeded in JavaScript, so a run can never be repeated.
 * The assignment requires the feed to be "repeatable enough to demonstrate and test
 * important cases", and our cross-tier candle test depends on replaying the exact
 * same trade stream three times. That is impossible without a seeded generator.
 *
 * WHY mulberry32
 * --------------
 * It is a 32-bit generator that fits in five lines, has no dependencies, passes the
 * randomness tests that matter for simulation, and is fully portable: the same seed
 * yields the same sequence on any machine and any Node version. We are simulating a
 * market, not generating cryptographic keys, so statistical quality at this level is
 * more than sufficient. A heavier library (e.g. Mersenne Twister) would add a
 * dependency for no benefit we can observe.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal (mean 0, stddev 1). */
  normal(): number;
  /** Exponential with the given mean. Used for Poisson inter-arrival times. */
  exponential(mean: number): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
}

export function createRng(seed: number): Rng {
  // Mix the seed so that adjacent seeds (1, 2, 3) produce unrelated streams
  // rather than similar ones.
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
