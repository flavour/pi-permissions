/**
 * Bounded endpoint concurrency: one in-flight request by default, a bounded
 * queue in front of it, and a deadline on waiting for a slot.
 *
 * Why it exists: the Pi hook must not hang indefinitely behind endpoint work.
 * Every refusal here is a typed `QueueError` that becomes a `defer` reaching a
 * human — never an allow, and never a technical denial of the command itself.
 *
 * Slot accounting is synchronous on purpose. `grant()` claims the slot before it
 * resolves its caller, so two simultaneous completions can never admit two
 * waiters against one slot. A cancelled caller never consumes a slot and never
 * becomes an endpoint failure; a cancelled *running* request has its signal
 * propagated to the transport and releases its slot when the task settles, which
 * is bounded by the request timeout.
 */

export type QueueFailure = "queue_full" | "queue_wait" | "cancelled";

export class QueueError extends Error {
  readonly kind: QueueFailure;
  constructor(kind: QueueFailure, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "QueueError";
    this.kind = kind;
  }
}

export interface LimiterOptions {
  /** Concurrent endpoint requests. Shipped default is one. */
  readonly concurrency: number;
  /** Callers allowed to wait for a slot; beyond this, immediate refusal. */
  readonly maxQueue: number;
  /** How long a caller may wait for a slot before it must reach a human. */
  readonly maxWaitMs: number;
  readonly now?: () => number;
}

export interface LimiterSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly concurrency: number;
  readonly maxQueue: number;
  readonly maxWaitMs: number;
}

interface Waiter {
  readonly deadline: number;
  grant(): void;
  expire(): void;
}

/** Single-process only: one limiter per endpoint per Pi process. */
export class EndpointLimiter {
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private active = 0;
  private readonly waiting = new Set<Waiter>();

  constructor(options: LimiterOptions) {
    this.concurrency = Math.max(1, Math.trunc(options.concurrency));
    this.maxQueue = Math.max(0, Math.trunc(options.maxQueue));
    this.maxWaitMs = Math.max(1, Math.trunc(options.maxWaitMs));
    this.now = options.now ?? Date.now;
  }

  /**
   * Run `task` with at most `concurrency` tasks in flight, FIFO. The task
   * receives the caller's signal so cancellation reaches the transport instead
   * of only the caller's own await.
   */
  async run<T>(
    task: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new QueueError("cancelled", "before queueing");
    if (this.active >= this.concurrency) {
      if (this.waiting.size >= this.maxQueue)
        throw new QueueError(
          "queue_full",
          `${this.waiting.size} callers already waiting`,
        );
      await this.reserve(signal);
    } else {
      this.active++;
    }
    try {
      return await task(signal);
    } finally {
      this.active--;
      this.grantNext();
    }
  }

  /** Wait for a slot. `grant()` claims it, so a resolved wait owns a slot. */
  private reserve(signal?: AbortSignal): Promise<void> {
    const deadline = this.now() + this.maxWaitMs;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        deadline,
        grant: () => finish(),
        expire: () =>
          finish(new QueueError("queue_wait", "no free slot in time")),
      };
      const finish = (error?: QueueError): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiting.delete(waiter);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void =>
        finish(new QueueError("cancelled", "while queued"));
      this.waiting.add(waiter);
      timer = setTimeout(waiter.expire, Math.max(1, deadline - this.now()));
      signal?.addEventListener("abort", onAbort, { once: true });
      // A slot may have freed between the caller's check and its queueing.
      this.grantNext();
    });
  }

  private grantNext(): void {
    while (this.active < this.concurrency) {
      const next = this.waiting.values().next().value as Waiter | undefined;
      if (!next) return;
      // A deadline can pass a tick before its timer runs: retire it, do not
      // spend a slot on a caller that will not use it faithfully.
      if (this.now() >= next.deadline) {
        next.expire();
        continue;
      }
      // Claim the slot synchronously: this promise's continuation is a
      // microtask, and another completion could grant a second waiter before it.
      this.active++;
      next.grant();
      return;
    }
  }

  snapshot(): LimiterSnapshot {
    return {
      active: this.active,
      queued: this.waiting.size,
      concurrency: this.concurrency,
      maxQueue: this.maxQueue,
      maxWaitMs: this.maxWaitMs,
    };
  }
}
