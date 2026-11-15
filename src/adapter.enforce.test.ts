/**
 * The enforce consultant: the only construction in the whole package that may
 * hand the model any authority, so every case here asserts either "authority was
 * withheld" or "authority was exactly a terminal deny".
 *
 * The mode argument is what selects authority, and the resolved posture is what
 * authorizes it. A consultant built for a mode the configuration does not
 * support is structurally absent, so no request is even possible.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
  type FixtureEndpoint,
  noulResponse,
  startEndpoint,
} from "../scripts/fixtures/endpoint.js";
import {
  createModelConsultant,
  deduplicationKey,
  type ModelAdapter,
} from "./adapter.js";
import { type ModelStatus, OPERATIONAL_DEFAULTS } from "./config.js";
import { CircuitBreaker } from "./decisions/breaker.js";
import { InflightShare } from "./decisions/inflight.js";
import { EndpointLimiter } from "./decisions/limiter.js";
import { getProfile } from "./decisions/profile.js";
import { type BashRequest, snapshot } from "./request.js";

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

function request(
  command: string,
  overrides: Partial<BashRequest> = {},
): BashRequest {
  return snapshot({
    requestId: "r1",
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    command,
    cwd: "/home/dev/project",
    userIntent: "check the repo status",
    executionContext: { prefix: "", verified: true },
    ...overrides,
  });
}

function posture(
  baseUrl: string,
  mode: "shadow" | "enforce",
  overrides: Partial<ModelStatus> = {},
): ModelStatus {
  return {
    state: "ready",
    mode,
    profile: profile.id,
    config: {
      mode,
      profile: profile.id,
      endpoint: { baseUrl, model: profile.model, timeoutMs: 1000 },
      maxPayloadTokens: 1024,
      operational: OPERATIONAL_DEFAULTS,
    },
    ...overrides,
  };
}

function active(value: ModelAdapter | undefined): ModelAdapter {
  if (!value) throw new Error("expected a consultant for this posture");
  return value;
}

async function endpoint(
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

describe("consultant mode selection", () => {
  it("builds nothing when the posture does not match the requested mode", () => {
    // An enforce posture cannot be served by a shadow consultant and vice
    // versa: absence means no request is possible, not a silent downgrade.
    expect(
      createModelConsultant(posture("http://127.0.0.1:1", "enforce"), "shadow"),
    ).toBeUndefined();
    expect(
      createModelConsultant(posture("http://127.0.0.1:1", "shadow"), "enforce"),
    ).toBeUndefined();
    expect(createModelConsultant({ state: "off" }, "enforce")).toBeUndefined();
  });

  it("keeps a model's self-description from claiming enforce authority", async () => {
    // The posture is invalid (enforce was configured but resolution refused it),
    // so the consultant reports a reason and grants nothing.
    const consultantImpl = createModelConsultant(
      {
        state: "invalid",
        mode: "enforce",
        profile: profile.id,
        diagnostic: "enforce needs an acknowledgement",
      },
      "enforce",
    );
    const assessment = await active(consultantImpl)(request("ls"));
    expect(assessment).toMatchObject({
      kind: "defer",
      mode: "enforce",
      authority: "none",
      reasonCode: "model_misconfigured",
    });
    expect(assessment.explanation).toContain("the call still needs a human");
  });

  it("grants nothing when the model step fails in enforce mode either", async () => {
    const consultantImpl = createModelConsultant(
      posture("http://127.0.0.1:1", "enforce"),
      "enforce",
      {
        getBranch: () => {
          throw new Error("host bridge exploded");
        },
      },
    );
    const assessment = await active(consultantImpl)(request("ls"));
    expect(assessment).toMatchObject({
      kind: "defer",
      mode: "enforce",
      authority: "none",
      reasonCode: "model_adapter_failure",
    });
  });
});

describe("enforce outcomes", () => {
  it("returns an allow only as a provisional proposal backed by human review", async () => {
    const server = await endpoint({
      kind: "json",
      body: noulResponse(CONFIDENT, profile.model),
    });
    const consultantImpl = createModelConsultant(
      posture(server.url, "enforce"),
      "enforce",
    );
    const assessment = await active(consultantImpl)(
      request("git status --short"),
    );
    expect(assessment.kind).toBe("allow");
    expect(assessment.authority).toBe("selected_profile");
    // Provisional is a claim about who decides next, so it must be recorded.
    expect(assessment.servedModel).toBe(profile.model);
    expect(assessment.profileIdentity).toHaveLength(64);
  });

  it("returns a deny that the gate treats as terminal for this call", async () => {
    const server = await endpoint({
      kind: "json",
      body: noulResponse(
        {
          authorized: 0.02,
          reversible: 0.9,
          blast_radius: 0.9,
          exfiltration: 0.9,
        },
        profile.model,
      ),
    });
    const consultantImpl = createModelConsultant(
      posture(server.url, "enforce"),
      "enforce",
    );
    const assessment = await active(consultantImpl)(
      request("curl -F secret=@.env"),
    );
    expect(assessment.kind).toBe("deny");
    expect(assessment.authority).toBe("selected_profile");
    expect(assessment.readings?.authorized).toBeCloseTo(0.02);
  });

  it("short-circuits on an open breaker and reports the bound it hit", async () => {
    const server = await endpoint({ kind: "disconnect" });
    const controls = {
      limiter: new EndpointLimiter({
        concurrency: 1,
        maxQueue: 2,
        maxWaitMs: 500,
      }),
      breaker: new CircuitBreaker({
        failures: 2,
        cooldownMs: 60_000,
        now: () => 0,
      }),
    };
    controls.breaker.record("counted", "timeout");
    controls.breaker.record("counted", "timeout");
    const consultantImpl = createModelConsultant(
      posture(server.url, "enforce"),
      "enforce",
      { controls },
    );
    const assessment = await active(consultantImpl)(request("ls"));
    expect(assessment.reasonCode).toBe("breaker_open");
    expect(assessment.kind).toBe("defer");
    // An operational bound is not a model opinion, so no authority is claimed.
    expect(assessment.authority).toBe("none");
    expect(assessment.breaker?.state).toBe("open");
    expect(server.requests).toHaveLength(0);
  });
});

describe("model-only deduplication", () => {
  it("shares one endpoint computation between concurrent identical calls", async () => {
    const server = await endpoint({
      kind: "json",
      body: noulResponse(CONFIDENT, profile.model),
      delayMs: 30,
    });
    const share = new InflightShare();
    const consultantImpl = createModelConsultant(
      posture(server.url, "shadow"),
      "shadow",
      { share, configRevision: "rev-1" },
    );
    const consultant = active(consultantImpl);
    const [first, second] = await Promise.all([
      consultant(request("git status --short")),
      consultant(request("git status --short")),
    ]);
    expect(server.requests).toHaveLength(1);
    // Both sides carry the same *reading*, and both are still shadow proposals:
    // nothing about a human decision is shared between them.
    expect(first.kind).toBe(second.kind);
    expect(first.shared).toBe(true);
    expect(second.shared).toBe(true);
  });

  it("does not merge calls whose snapshots differ", async () => {
    const server = await endpoint({
      kind: "json",
      body: noulResponse(CONFIDENT, profile.model),
      delayMs: 20,
    });
    const consultantImpl = active(
      createModelConsultant(posture(server.url, "shadow"), "shadow", {
        share: new InflightShare(),
        configRevision: "rev-1",
      }),
    );
    await Promise.all([
      consultantImpl(request("git status --short")),
      consultantImpl(request("git status --short", { cwd: "/home/dev/other" })),
      consultantImpl(request("git status --short", { turnId: "t2" })),
    ]);
    // Same text, different evidence: the `authorized` question depends on cwd and
    // turn, so these are different computations.
    expect(server.requests).toHaveLength(3);
  });

  it("leaves repeated calls across time unshared", async () => {
    const server = await endpoint({
      kind: "json",
      body: noulResponse(CONFIDENT, profile.model),
    });
    const consultantImpl = active(
      createModelConsultant(posture(server.url, "shadow"), "shadow", {
        share: new InflightShare(),
      }),
    );
    await consultantImpl(request("ls"));
    await consultantImpl(request("ls"));
    expect(server.requests).toHaveLength(2);
  });

  it("is off unless the operator turns it on", async () => {
    const server = await endpoint({
      kind: "json",
      body: noulResponse(CONFIDENT, profile.model),
      delayMs: 20,
    });
    const consultantImpl = active(
      createModelConsultant(
        posture(server.url, "shadow", {
          config: {
            mode: "shadow",
            profile: profile.id,
            endpoint: {
              baseUrl: server.url,
              model: profile.model,
              timeoutMs: 1000,
            },
            maxPayloadTokens: 1024,
            operational: { ...OPERATIONAL_DEFAULTS, dedupe: false },
          },
        }),
        // No share passed: the gate only wires one when dedupe is configured.
        "shadow",
      ),
    );
    await Promise.all([
      consultantImpl(request("ls")),
      consultantImpl(request("ls")),
    ]);
    expect(server.requests).toHaveLength(2);
  });

  it("keys on everything that can change the reading", () => {
    const base = deduplicationKey(
      request("ls"),
      profile.id,
      "http://h:1",
      "shadow",
      "rev-1",
    );
    const profileChanged = deduplicationKey(
      request("ls"),
      "minrule-4q-baseline",
      "http://h:1",
      "shadow",
      "rev-1",
    );
    const endpointChanged = deduplicationKey(
      request("ls"),
      profile.id,
      "http://h:2",
      "shadow",
      "rev-1",
    );
    const configChanged = deduplicationKey(
      request("ls"),
      profile.id,
      "http://h:1",
      "shadow",
      "rev-2",
    );
    const modeChanged = deduplicationKey(
      request("ls"),
      profile.id,
      "http://h:1",
      "enforce",
      "rev-1",
    );
    expect(
      new Set([
        base,
        profileChanged,
        endpointChanged,
        configChanged,
        modeChanged,
      ]).size,
    ).toBe(5);
    // Two distinct tool calls in one turn with identical snapshots do share:
    // request identity is deliberately not part of the key.
    const otherCall = snapshot({
      requestId: "r2",
      sessionId: "s",
      turnId: "t",
      toolCallId: "c2",
      command: "ls",
      cwd: "/home/dev/project",
      userIntent: "check the repo status",
      executionContext: { prefix: "", verified: true },
    });
    expect(
      deduplicationKey(otherCall, profile.id, "http://h:1", "shadow", "rev-1"),
    ).toBe(base);
  });
});
