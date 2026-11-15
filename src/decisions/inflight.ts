/**
 * Model-only in-flight deduplication.
 *
 * Two *concurrent* requests whose full snapshots, profile identities and
 * session/turn match share one endpoint computation and nothing else. The
 * property that matters: **human approval is never shared**. Review happens
 * after this point and per request, so a sibling can still be rejected,
 * cancelled or timed out independently, and in enforce mode each call still
 * needs its own effective allow.
 *
 * What is shared is a *reading of identical text*, which is why the key is the
 * whole snapshot rather than the command: cwd, timeout, intent, execution facts,
 * the policy verdict in front of it, the profile content identity and the
 * endpoint origin all participate. `requestId` and `toolCallId` deliberately do
 * not, because two distinct tool calls in one turn with byte-identical snapshots
 * are exactly the case this exists for. Repeated side effects across *time* are
 * not shared: an entry exists only while the first computation is in flight, and
 * a retired entry starts new work.
 *
 * Cancellation joins rather than strands: the shared computation is abandoned
 * only once every known caller has aborted, so one caller cancelling cannot
 * deprive an identical sibling of its reading.
 */

interface ShareHandle {
  readonly id: number;
  /** Registered callers, and how many of them have aborted. */
  known: number;
  aborted: number;
  abandoned: boolean;
  /** How many callers are using this computation, for records and status. */
  joiners: number;
  readonly promise: Promise<unknown>;
}

class Share implements ShareHandle {
  known = 0;
  aborted = 0;
  abandoned = false;
  joiners = 0;
  readonly promise: Promise<unknown>;
  private readonly controller = new AbortController();

  constructor(
    readonly id: number,
    create: (signal: AbortSignal) => Promise<unknown>,
    private readonly retire: () => void,
  ) {
    this.promise = (async () => {
      try {
        return await create(this.controller.signal);
      } finally {
        this.retire();
      }
    })();
  }

  abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    this.controller.abort();
  }
}

export interface InflightResult<T> {
  readonly promise: Promise<T>;
  /** True when this caller attached to work another request started. */
  readonly joined: boolean;
  /**
   * How many callers ended up using this computation. Read it after awaiting:
   * the starter sees `2` when an identical sibling joined it, which is the
   * honest record for both sides.
   */
  readonly joiners: () => number;
}

export class InflightShare {
  private readonly entries = new Map<string, Share>();
  private sequence = 0;

  get size(): number {
    return this.entries.size;
  }

  /**
   * Return the computation in flight for `key`, starting one if none exists.
   * The creator's `create` receives a signal that aborts only when every known
   * caller has aborted.
   */
  run<T>(
    key: string,
    create: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): InflightResult<T> {
    const found = this.entries.get(key);
    if (found && !found.abandoned) return this.attach(found, signal, true);
    if (found) this.entries.delete(key);
    const id = ++this.sequence;
    const share = new Share(
      id,
      create as (signal: AbortSignal) => Promise<unknown>,
      () => {
        // Retire before resolving, so a later caller cannot inherit a verdict
        // computed against an earlier endpoint or snapshot state.
        if (this.entries.get(key)?.id === id) this.entries.delete(key);
      },
    );
    this.entries.set(key, share);
    return this.attach(share, signal, false);
  }

  private attach<T>(
    share: Share,
    signal: AbortSignal | undefined,
    joined: boolean,
  ): InflightResult<T> {
    share.joiners++;
    share.known++;
    if (signal) {
      const abort = (): void => {
        if (share.abandoned) return;
        share.aborted++;
        if (share.known > 0 && share.aborted >= share.known) share.abandon();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
    return {
      promise: share.promise as Promise<T>,
      joined,
      joiners: () => share.joiners,
    };
  }

  /** Abandon everything: shutdown/reload must not hand out stale work. */
  clear(): void {
    for (const share of this.entries.values()) share.abandon();
    this.entries.clear();
  }
}
