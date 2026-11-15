import { describe, expect, it } from "bun:test";
import {
  CircuitBreaker,
  type EndpointFailureKind,
  outcomeFor,
} from "./breaker.js";

/** A clock the test owns, so cooldown behaviour is not a sleep race. */
function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function breaker(failures = 3, cooldownMs = 60_000, at = clock()) {
  return { b: new CircuitBreaker({ failures, cooldownMs, now: at.now }), at };
}

const ALL_FAILURES: readonly EndpointFailureKind[] = [
  "unreachable",
  "timeout",
  "http",
  "parse",
  "identity",
  "range",
  "cancelled",
  "unknown",
];

describe("breaker failure table", () => {
  it("is total over every endpoint failure kind, so none is silently neutral", () => {
    for (const kind of ALL_FAILURES) expect(outcomeFor(kind)).toBeDefined();
  });

  it("counts transport/protocol illness and nothing else", () => {
    for (const kind of [
      "timeout",
      "unreachable",
      "http",
      "parse",
      "unknown",
    ] as const)
      expect(outcomeFor(kind)).toBe("counted");
  });

  it("treats a coherent-but-wrong answer as neutral", () => {
    // An endpoint serving the wrong model is a configuration fault whose reason
    // must stay visible; `identity` for every caller is more useful than
    // `breaker_open` for the next one.
    expect(outcomeFor("identity")).toBe("neutral");
    expect(outcomeFor("range")).toBe("neutral");
    // Cancellation is never classifier failure.
    expect(outcomeFor("cancelled")).toBe("neutral");
  });
});

describe("circuit breaker state", () => {
  it("stays closed below the threshold and does not accumulate across a success", () => {
    const { b } = breaker(3);
    b.record("counted", "timeout");
    b.record("counted", "timeout");
    expect(b.state()).toBe("closed");
    b.record("success");
    b.record("counted", "timeout");
    expect(b.state()).toBe("closed");
    expect(b.snapshot().consecutive).toBe(1);
  });

  it("opens on the third consecutive counted failure and refuses the next caller", () => {
    const at = clock(1_000);
    const { b } = breaker(3, 60_000, at);
    for (const kind of ["timeout", "unreachable", "http"] as const)
      b.record("counted", kind);
    expect(b.state()).toBe("open");
    const gate = b.gate();
    expect(gate.send).toBe(false);
    if (!gate.send) {
      expect(gate.reason).toBe("breaker_open");
      expect(gate.retryInMs).toBe(60_000);
    }
    expect(b.snapshot().lastCounted).toBe("http");
    expect(b.snapshot().trips).toBe(1);
  });

  it("does not open from neutral outcomes, however many", () => {
    const { b } = breaker(3);
    for (let i = 0; i < 10; i++) b.record("neutral", "identity");
    expect(b.state()).toBe("closed");
    expect(b.snapshot().consecutive).toBe(0);
  });

  it("opens on the configured consecutive count, not on a total", () => {
    const { b } = breaker(3);
    b.record("counted", "timeout");
    b.record("counted", "timeout");
    b.record("success");
    b.record("counted", "timeout");
    b.record("counted", "timeout");
    expect(b.state()).toBe("closed");
    b.record("counted", "timeout");
    expect(b.state()).toBe("open");
  });

  it("half-opens after exactly the cooldown and admits exactly one probe", () => {
    const at = clock(0);
    const { b } = breaker(3, 60_000, at);
    for (let i = 0; i < 3; i++) b.record("counted", "timeout");
    expect(b.gate().send).toBe(false);
    at.advance(59_999);
    expect(b.state()).toBe("open");
    expect(b.gate().send).toBe(false);
    at.advance(1);
    expect(b.state()).toBe("half-open");
    const probe = b.gate();
    expect(probe).toEqual({ send: true, probe: true });
    // A second caller must not join the probe: it reaches a human instead.
    const second = b.gate();
    expect(second.send).toBe(false);
    if (!second.send) expect(second.reason).toBe("probe_in_flight");
  });

  it("closes on a successful probe and re-opens on a failed one", () => {
    const at = clock(0);
    const { b } = breaker(3, 60_000, at);
    for (let i = 0; i < 3; i++) b.record("counted", "timeout");
    at.advance(60_000);
    expect(b.gate().send).toBe(true);
    b.record("counted", "timeout");
    expect(b.state()).toBe("open");
    at.advance(60_000);
    expect(b.gate().send).toBe(true);
    b.record("success");
    expect(b.state()).toBe("closed");
    expect(b.snapshot().consecutive).toBe(0);
    // Closed again means the next caller is not told to wait.
    expect(b.gate().send).toBe(true);
  });

  it("returns the probe slot when the probe never reached the endpoint", () => {
    const at = clock(0);
    const { b } = breaker(2, 1_000, at);
    b.record("counted", "timeout");
    b.record("counted", "timeout");
    at.advance(1_000);
    expect(b.gate()).toEqual({ send: true, probe: true });
    // The caller was cancelled before dialling: nobody learned anything, so the
    // probe slot must not be burned for a whole cooldown.
    b.release();
    expect(b.gate()).toEqual({ send: true, probe: true });
  });

  it("reports a live retry window rather than a fixed guess", () => {
    const at = clock(0);
    const { b } = breaker(2, 10_000, at);
    b.record("counted", "timeout");
    b.record("counted", "timeout");
    at.advance(4_000);
    const snapshot = b.snapshot();
    expect(snapshot.state).toBe("open");
    expect(snapshot.retryInMs).toBe(6_000);
  });

  it("clamps nonsense limits to something safe rather than disabling itself", () => {
    const zero = new CircuitBreaker({ failures: 0, cooldownMs: 0 });
    zero.record("counted", "timeout");
    expect(zero.state()).toBe("open");
  });
});
