/**
 * Operational bounds seen from the judge: what a bound does to a *request*, and
 * what it must never do to a *decision*.
 *
 * Every case asserts the same two halves: the outcome is a `defer` with a reason
 * that names the bound, and the endpoint was not contacted (or was contacted
 * exactly once) — because a bound that spends a round trip, or that approves or
 * blocks a command, has stopped being an operational bound.
 */

import { afterAll, describe, expect, it } from "bun:test";
import type { Behaviour } from "../../scripts/fixtures/endpoint.js";
import {
  type FixtureEndpoint,
  noulResponse,
  startEndpoint,
} from "../../scripts/fixtures/endpoint.js";
import { CircuitBreaker } from "./breaker.js";
import { EndpointLimiter } from "./limiter.js";
import { getProfile } from "./profile.js";
import { createModelJudge, type ModelJudge } from "./propose.js";
import type { Transport } from "./systemone.js";

const open: FixtureEndpoint[] = [];
afterAll(async () => {
  for (const server of open.splice(0)) await server.close();
});

/** A missing profile is a bug in the test, not something to assert away. */
function profileNamed(id: string) {
  const found = getProfile(id);
  if (!found) throw new Error(`Missing profile: ${id}`);
  return found;
}

const profile = profileNamed("minrule-4q-conservative");

const input = {
  toolName: "bash",
  command: "git status --short",
  cwd: "/home/dev/project",
  userMessage: "check the repo status",
};

/** Judge with its own breaker/limiter, so cases never share health state. */
function judge(
  options: {
    baseUrl: string;
    transport?: Transport;
    concurrency?: number;
    maxQueue?: number;
    maxWaitMs?: number;
    breakerFailures?: number;
    breakerCooldownMs?: number;
    timeoutMs?: number;
    now?: () => number;
  } = { baseUrl: "http://127.0.0.1:1" },
): { j: ModelJudge; breaker: CircuitBreaker; limiter: EndpointLimiter } {
  const breaker = new CircuitBreaker({
    failures: options.breakerFailures ?? 3,
    cooldownMs: options.breakerCooldownMs ?? 60_000,
    ...(options.now ? { now: options.now } : {}),
  });
  const limiter = new EndpointLimiter({
    concurrency: options.concurrency ?? 1,
    maxQueue: options.maxQueue ?? 2,
    maxWaitMs: options.maxWaitMs ?? 1_000,
  });
  const j = createModelJudge({
    settings: () => ({
      profile,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs ?? 1_000,
      maxPayloadTokens: 1024,
    }),
    controls: { limiter, breaker },
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { j, breaker, limiter };
}

async function endpointWith(
  behaviour: Parameters<typeof startEndpoint>[0],
): Promise<FixtureEndpoint> {
  const server = await startEndpoint(behaviour);
  open.push(server);
  return server;
}

const CONFIDENT = {
  authorized: 0.96,
  reversible: 0.95,
  blast_radius: 0.97,
  exfiltration: 0.01,
};

describe("circuit breaker in front of the endpoint", () => {
  it("short-circuits while open without contacting the endpoint", async () => {
    const server = await endpointWith({ kind: "json", body: {} });
    const { j, breaker } = judge({
      baseUrl: server.url,
      breakerFailures: 2,
      now: () => 0,
    });
    breaker.record("counted", "timeout");
    breaker.record("counted", "timeout");
    const before = server.requests.length;
    const proposal = await j.propose(input);
    expect(proposal.kind).toBe("defer");
    expect(proposal.reasonCode).toBe("breaker_open");
    expect(proposal.reason).toContain("not contacted");
    expect(server.requests.length).toBe(before);
    // The proposal explains the wait rather than pretending to be an opinion.
    expect(proposal.breaker?.state).toBe("open");
  });

  it("opens after the configured consecutive failures, then recovers on success", async () => {
    const server = await endpointWith([
      { kind: "status", status: 500 },
      { kind: "status", status: 500 },
      { kind: "json", body: noulResponse(CONFIDENT, profile.model) },
    ]);
    const at = { value: 0 };
    const { j, breaker } = judge({
      baseUrl: server.url,
      breakerFailures: 2,
      breakerCooldownMs: 60_000,
      now: () => at.value,
    });
    expect((await j.propose(input)).reasonCode).toBe("endpoint_http");
    expect((await j.propose({ ...input, command: "echo 2" })).reasonCode).toBe(
      "endpoint_http",
    );
    expect(breaker.state()).toBe("open");

    const short = await j.propose(input);
    expect(short.reasonCode).toBe("breaker_open");
    // Opening the breaker is what stops the next caller paying for a dead endpoint.
    expect(server.requests.length).toBe(2);

    at.value = 60_000;
    const probe = await j.propose(input);
    expect(probe.kind).toBe("allow");
    expect(breaker.state()).toBe("closed");
    expect(server.requests.length).toBe(3);
  });

  it("does not open for an endpoint that answers coherently but wrongly", async () => {
    const server = await endpointWith({
      kind: "json",
      body: noulResponse(CONFIDENT, "Someone/Else:latest"),
    });
    const { j, breaker } = judge({ baseUrl: server.url, breakerFailures: 2 });
    for (let attempt = 0; attempt < 4; attempt++) {
      const proposal = await j.propose({
        ...input,
        command: `echo ${attempt}`,
      });
      expect(proposal.reasonCode).toBe("endpoint_identity");
    }
    // Wrong identity is a configuration fault: the next caller still gets the
    // real reason instead of `breaker_open`, and can still reach a human.
    expect(breaker.state()).toBe("closed");
  });

  it("never counts cancellation as endpoint failure", async () => {
    const server = await endpointWith({ kind: "delay", ms: 5_000 });
    const { j, breaker } = judge({ baseUrl: server.url, breakerFailures: 2 });
    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = new AbortController();
      const pending = j.propose(
        { ...input, command: `echo ${attempt}` },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 5);
      const proposal = await pending;
      expect(proposal.reasonCode).toBe("cancelled");
    }
    expect(breaker.state()).toBe("closed");
  });

  it("records the breaker snapshot so a record can show circuit state", async () => {
    const server = await endpointWith({ kind: "disconnect" });
    const { j } = judge({ baseUrl: server.url, breakerFailures: 2 });
    const proposal = await j.propose(input);
    expect(proposal.breaker?.state).toBeDefined();
    expect(proposal.breaker?.failures).toBe(2);
    expect(proposal.queue?.concurrency).toBe(1);
  });
});

describe("queue bounds in front of the endpoint", () => {
  /** Slow but eventually successful, so a queue actually forms. */
  const slow = (ms: number): Behaviour => ({
    kind: "json",
    body: noulResponse(CONFIDENT, profile.model),
    delayMs: ms,
  });

  it("refuses the next caller rather than queueing without bound", async () => {
    const server = await endpointWith(slow(150));
    const { j, limiter } = judge({
      baseUrl: server.url,
      concurrency: 1,
      maxQueue: 1,
      maxWaitMs: 5_000,
    });
    const inFlight = Array.from({ length: 2 }, (_, index) =>
      j.propose({ ...input, command: `echo ${index}` }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const overflow = await j.propose({ ...input, command: "echo overflow" });
    expect(overflow.reasonCode).toBe("queue_full");
    expect(overflow.reason).toContain("queue is full");
    expect(limiter.snapshot().queued).toBeLessThanOrEqual(1);
    // The two admitted callers still get real proposals.
    expect((await Promise.all(inFlight)).map((p) => p.kind)).toEqual([
      "allow",
      "allow",
    ]);
  });

  it("gives up a waiter on its own deadline instead of holding the hook open", async () => {
    const server = await endpointWith(slow(200));
    const { j } = judge({
      baseUrl: server.url,
      concurrency: 1,
      maxQueue: 2,
      maxWaitMs: 30,
    });
    const slowCall = j.propose({ ...input, command: "echo slow" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    const queued = await j.propose({ ...input, command: "echo queued" });
    expect(queued.reasonCode).toBe("queue_wait");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(queued.reason).toContain("slot freed in time");
    await slowCall;
  });

  it("lets a cancelled waiter go without taking a slot", async () => {
    const server = await endpointWith(slow(150));
    const { j, limiter } = judge({
      baseUrl: server.url,
      concurrency: 1,
      maxQueue: 2,
      maxWaitMs: 5_000,
    });
    const busy = j.propose({ ...input, command: "echo busy" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const controller = new AbortController();
    const waiting = j.propose(
      { ...input, command: "echo waiting" },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect((await waiting).reasonCode).toBe("cancelled");
    expect(limiter.snapshot().queued).toBe(0);
    await busy;
  });
});
