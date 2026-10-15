/**
 * Deterministic pseudo-random numbers for the demo seed. Every area of the data
 * set asks for its own named stream, so adding a customer does not change the
 * amounts of the requests that come after it.
 */
export class Rng {
  private state: number;

  constructor(seed: string) {
    // FNV-1a hash of the stream name: small, stable across platforms and Node versions.
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    this.state = h >>> 0 || 0x9e3779b9;
  }

  /** mulberry32: uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error('Rng.pick called with an empty list');
    return items[Math.floor(this.next() * items.length)];
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/** The one seed value of the whole data set. Change it and every run produces a different (still fictional) centre. */
export const DATASET_SEED = 'typease-demo-v1';
export const stream = (name: string) => new Rng(`${DATASET_SEED}:${name}`);
