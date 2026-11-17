// concurrency.ts — per-provider semaphores (§ Module map limits).
//
// A plain counting semaphore, no external dependency. Each named pool is a module-level singleton
// so every caller across the engine shares the same limiter for a given provider.

export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}

export const LIMITS = {
  serper: 5, places: 3, http: 8, firecrawl: 2, playwright: 1, lmstudio: 1, anthropic: 4,
  hunter: 2, leadmagic: 2, dns: 8,
} as const;

export type LimitKey = keyof typeof LIMITS;

const pool = new Map<LimitKey, Semaphore>();

export function semaphoreFor(key: LimitKey): Semaphore {
  let s = pool.get(key);
  if (!s) {
    s = new Semaphore(LIMITS[key]);
    pool.set(key, s);
  }
  return s;
}

/** Test helper: drop every pool's semaphore so limits/counts start fresh between tests. */
export function resetSemaphores(): void {
  pool.clear();
}
