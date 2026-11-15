/**
 * Circuit breaker for the decision endpoint.
 *
 * The breaker exists to stop a slow or dead endpoint from adding its latency to
 * every gated call, not to decide anything about safety. Opening it is always a
 * `defer` that still reaches a human, and no breaker state can approve a call.
 *
 * Which failures count is a deliberate table (`outcomeFor`), because a counted
 * failure hides the precise reason behind `breaker_open`:
 *
 * - **counted** — `timeout`, `unreachable`, `http`, `parse`, `unknown`: the
 *   endpoint is unhealthy, so the next caller should not pay for it.
 * - **neutral** — `identity`, `range`: the endpoint answered *coherently* but as
 *   the wrong model or with unusable readings. That is a configuration or
 *   identity fault; keeping the specific reason visible matters more than
 *   shielding the endpoint, and each such call already defers.
 * - **neutral** — `cancelled`, `budget`, `queue`, `breaker`, and every
 *   aggregation/floor outcome: none of these is evidence about endpoint health.
 *
 * A success resets the consecutive counter. Cancellation is never a classifier
 * failure. Consecutive counted failures trip the breaker; a cooldown elapses to
 * half-open, where exactly one probe is admitted and everybody else is told to
 * reach a human rather than queue behind the probe.
 */

import type { EndpointFailureKind } from "./systemone.js";

/** Model-step outcomes that are not endpoint failures but still defer. */
export type OperationalKind =
  | "cancelled"
  | "budget"
  | "queue_full"
  | "queue_wait"
  | "breaker_open"
  | "probe_in_flight";

export type FailureKind = EndpointFailureKind | OperationalKind;
export type { EndpointFailureKind };

export type Outcome = "success" | "counted" | "neutral";

/**
 * The counted-failure table, total over the transport/protocol failure kinds.
 * Nothing here is inferred from a free-form reason code, so a new reason code
 * cannot accidentally trip the breaker or hide its own diagnostic.
 */
const COUNTED: Readonly<Record<EndpointFailureKind, Outcome>> = Object.freeze({
  // Cancellation is never endpoint ill-health.
  cancelled: "neutral",
  timeout: "counted",
  unreachable: "counted",
  http: "counted",
  // A non-JSON body is a sick service, not a coherent wrong answer.
  parse: "counted",
  unknown: "counted",
  // Coherent responses that cannot be trusted: the specific reason stays
  // visible instead of becoming `breaker_open` for the next caller.
  identity: "neutral",
  range: "neutral",
});

export function outcomeFor(kind: EndpointFailureKind): Outcome {
  return COUNTED[kind] ?? "neutral";
}

export interface BreakerOptions {
  /** Consecutive counted failures that open the circuit. */
  readonly failures: number;
  readonly cooldownMs: number;
  readonly now?: () => number;
}

export type BreakerState = "closed" | "open" | "half-open";

/**
 * Whether this caller may contact the endpoint now. `probe: true` means this
 * caller *is* the single half-open probe and therefore owns releasing it if the
 * request never reaches the endpoint.
 */
export type BreakerDecision =
  | { readonly send: true; readonly probe: boolean }
  | {
      readonly send: false;
      readonly reason: "breaker_open" | "probe_in_flight";
      readonly retryInMs: number;
    };

export interface BreakerSnapshot {
  readonly state: BreakerState;
  readonly consecutive: number;
  readonly failures: number;
  readonly cooldownMs: number;
  readonly retryInMs: number;
  readonly trips: number;
  readonly lastCounted?: FailureKind;
}

/** Not thread-safe across processes: one breaker per endpoint per Pi process. */
export class CircuitBreaker {
  private readonly failures: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private consecutive = 0;
  private openedAt = -1;
  private probeInFlight = false;
  private trips = 0;
  private lastCounted: FailureKind | undefined;

  constructor(options: BreakerOptions) {
    this.failures = Math.max(1, Math.trunc(options.failures));
    this.cooldownMs = Math.max(1, Math.trunc(options.cooldownMs));
    this.now = options.now ?? Date.now;
  }

  /** Elapsed cooldown becomes half-open; nothing here mutates state. */
  state(): BreakerState {
    if (this.openedAt < 0) return "closed";
    return this.now() - this.openedAt >= this.cooldownMs ? "half-open" : "open";
  }

  /**
   * Admit or refuse one request. In half-open the first caller is the single
   * probe and arms it; later callers are refused rather than queued behind it.
   */
  gate(): BreakerDecision {
    const state = this.state();
    if (state === "open")
      return {
        send: false,
        reason: "breaker_open",
        retryInMs: this.openedAt + this.cooldownMs - this.now(),
      };
    if (state === "half-open") {
      if (this.probeInFlight)
        return { send: false, reason: "probe_in_flight", retryInMs: 0 };
      this.probeInFlight = true;
      return { send: true, probe: true };
    }
    return { send: true, probe: false };
  }

  /** Give the probe slot back when the probe never reached the endpoint. */
  release(): void {
    this.probeInFlight = false;
  }

  record(outcome: Outcome, kind?: EndpointFailureKind): void {
    if (outcome === "success") {
      this.consecutive = 0;
      this.openedAt = -1;
      this.probeInFlight = false;
      return;
    }
    if (outcome === "neutral") {
      // Neutral neither trips nor heals the circuit. The probe is released
      // explicitly by its owner, so a refused sibling cannot clear it.
      return;
    }
    this.consecutive++;
    this.lastCounted = kind;
    this.probeInFlight = false;
    if (this.consecutive >= this.failures) {
      this.openedAt = this.now();
      this.trips++;
    }
  }

  snapshot(): BreakerSnapshot {
    const state = this.state();
    return {
      state,
      consecutive: this.consecutive,
      failures: this.failures,
      cooldownMs: this.cooldownMs,
      retryInMs:
        state === "open"
          ? Math.max(0, this.openedAt + this.cooldownMs - this.now())
          : 0,
      trips: this.trips,
      ...(this.lastCounted === undefined
        ? {}
        : { lastCounted: this.lastCounted }),
    };
  }
}
