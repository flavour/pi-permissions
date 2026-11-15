/**
 * Per-process endpoint runtime.
 *
 * Concurrency limits, the circuit breaker and the deduplication registry are
 * only meaningful *per endpoint*: a limiter for a dead endpoint must not block a
 * reconfigured live one, and a breaker must not carry failures across an
 * endpoint change. So they are created from a validated configuration snapshot
 * and reused only while that snapshot's origin and limits match.
 *
 * A reload swaps in a new runtime instead of mutating the old one, so a request
 * already in flight keeps the accounting it started with. Nothing here is
 * shared across processes; a second Pi process gets its own breaker.
 */

import type { ModelConfig, ModelOperationalConfig } from "./config.js";
import { CircuitBreaker } from "./decisions/breaker.js";
import { InflightShare } from "./decisions/inflight.js";
import { EndpointLimiter } from "./decisions/limiter.js";
import type { EndpointControls } from "./decisions/propose.js";

export interface EndpointRuntime extends EndpointControls {
  readonly origin: string;
  readonly operational: ModelOperationalConfig;
  readonly share: InflightShare;
}

export interface EndpointStatus {
  readonly origin: string;
  readonly breaker: ReturnType<CircuitBreaker["snapshot"]>;
  readonly queue: ReturnType<EndpointLimiter["snapshot"]>;
  readonly sharedComputations: number;
}

export class GateRuntime {
  private current: EndpointRuntime | undefined;

  /** The controls for this snapshot, rebuilt if the origin or limits moved. */
  controls(config: ModelConfig): EndpointRuntime {
    const origin = config.endpoint.baseUrl;
    const existing = this.current;
    if (
      existing &&
      existing.origin === origin &&
      sameLimits(existing.operational, config.operational)
    )
      return existing;
    const next: EndpointRuntime = {
      origin,
      operational: config.operational,
      limiter: new EndpointLimiter({
        concurrency: config.operational.concurrency,
        maxQueue: config.operational.maxQueue,
        maxWaitMs: config.operational.maxWaitMs,
      }),
      breaker: new CircuitBreaker({
        failures: config.operational.breakerFailures,
        cooldownMs: config.operational.breakerCooldownMs,
      }),
      share: new InflightShare(),
    };
    // Abandon the previous endpoint's work: it belongs to a configuration the
    // operator has replaced, and its verdicts must not reach a new request.
    this.current?.share.clear();
    this.current = next;
    return next;
  }

  status(): EndpointStatus | undefined {
    const runtime = this.current;
    if (!runtime) return undefined;
    return {
      origin: runtime.origin,
      breaker: runtime.breaker.snapshot(),
      queue: runtime.limiter.snapshot(),
      sharedComputations: runtime.share.size,
    };
  }

  /** Shutdown or an unusable configuration: no abandoned work may be reused. */
  clear(): void {
    this.current?.share.clear();
    this.current = undefined;
  }
}

function sameLimits(
  a: ModelOperationalConfig,
  b: ModelOperationalConfig,
): boolean {
  return (
    a.concurrency === b.concurrency &&
    a.maxQueue === b.maxQueue &&
    a.maxWaitMs === b.maxWaitMs &&
    a.breakerFailures === b.breakerFailures &&
    a.breakerCooldownMs === b.breakerCooldownMs &&
    a.dedupe === b.dedupe
  );
}
