/**
 * Keeps requests under a provider's tokens-per-minute limit (Groq's free tier
 * allows 8,000 per model). A token bucket per model: each request reserves its
 * estimated size and waits until the bucket has refilled enough to cover it.
 * Waiting here is cheaper than being refused with a 429 and retrying.
 */

export class TokenBucket {
  private available: number;
  private updated: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.available = perMinute;
    this.updated = now();
  }

  private refill(): void {
    const t = this.now();
    this.available = Math.min(this.perMinute, this.available + ((t - this.updated) / 60_000) * this.perMinute);
    this.updated = t;
  }

  /** Milliseconds until `tokens` would be available, without reserving them. */
  waitFor(tokens: number): number {
    this.refill();
    const need = Math.min(tokens, this.perMinute);
    return this.available >= need ? 0 : Math.ceil(((need - this.available) / this.perMinute) * 60_000);
  }

  /**
   * Wait for and take `tokens`. Requests are served in order, so a large scan
   * batch isn't starved by a stream of small ones. A request bigger than the
   * whole bucket waits for a full bucket and then goes.
   */
  async take(tokens: number, signal?: AbortSignal): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
        if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const wait = this.waitFor(tokens);
        if (wait === 0) break;
        await this.sleep(Math.min(wait, 1000));
      }
      this.available -= Math.min(tokens, this.perMinute);
    });
    // A failed (aborted) turn must not block the requests queued behind it.
    this.queue = turn.catch(() => {});
    return turn;
  }

  /** Correct the reservation once the real size is known. */
  settle(estimated: number, actual: number): void {
    this.refill();
    this.available = Math.min(this.perMinute, this.available + estimated - actual);
  }
}
