/**
 * Adapter tests: the authority rule and the failure rule.
 *
 * The adapter is the only place a model result is turned into something the
 * gate carries. These tests assert what it can and cannot produce: every
 * outcome — including an approval — is a shadow proposal with `authority:
 * "none"`, and no failure inside the model step can escape as an exception, a
 * fall-through, or an implicit allow.
 */

import { afterAll, describe, expect, it, test } from "bun:test";
import {
  type FixtureEndpoint,
  noulResponse,
  startEndpoint,
} from "../scripts/fixtures/endpoint.js";
import { createShadowConsultant, toShadowAssessment } from "./adapter.js";
import { MODEL_OFF, type ModelStatus, OPERATIONAL_DEFAULTS } from "./config.js";
import { getProfile } from "./decisions/profile.js";
import { type BashRequest, snapshot } from "./request.js";

const open: FixtureEndpoint[] = [];
afterAll(async () => {
  for (const server of open.splice(0)) await server.close();
});

function request(command: string): BashRequest {
  return snapshot({
    requestId: "r1",
    sessionId: "s",
    turnId: "t",
    toolCallId: "c",
    command,
    cwd: "/home/dev/project",
    userIntent: "check the repo status",
    executionContext: { prefix: "", verified: true },
  });
}

/** A consultant that should exist for this posture; absence is a test failure. */
function active(
  value: ReturnType<typeof createShadowConsultant>,
): NonNullable<ReturnType<typeof createShadowConsultant>> {
  if (!value) throw new Error("expected a shadow consultant for this posture");
  return value;
}

function ready(
  baseUrl: string,
  profile = "minrule-4q-conservative",
): ModelStatus {
  return {
    state: "ready",
    mode: "shadow",
    profile,
    config: {
      mode: "shadow",
      profile,
      endpoint: { baseUrl, model: "LiquidAI/d1-2B-GGUF:Q8_0", timeoutMs: 1000 },
      maxPayloadTokens: 1024,
      operational: OPERATIONAL_DEFAULTS,
    },
  };
}

const ALL_CONFIDENT = {
  authorized: 0.96,
  reversible: 0.95,
  blast_radius: 0.97,
  exfiltration: 0.01,
};

describe("shadow consultant construction", () => {
  it("builds nothing when the model is off, so no request is possible", () => {
    expect(createShadowConsultant(MODEL_OFF)).toBeUndefined();
    expect(createShadowConsultant({ state: "off" })).toBeUndefined();
  });

  it("refuses to build for a mode other than shadow", () => {
    const status: ModelStatus = {
      state: "ready",
      mode: "off",
      profile: "minrule-4q-conservative",
      config: {
        mode: "off",
        profile: "minrule-4q-conservative",
        endpoint: {
          baseUrl: "http://127.0.0.1:1",
          model: "LiquidAI/d1-2B-GGUF:Q8_0",
          timeoutMs: 1000,
        },
        maxPayloadTokens: 1024,
        operational: OPERATIONAL_DEFAULTS,
      },
    };
    expect(createShadowConsultant(status)).toBeUndefined();
  });

  it("reports misconfiguration instead of staying silent, so the record explains it", async () => {
    const status: ModelStatus = {
      state: "invalid",
      mode: "shadow",
      profile: "unknown-profile",
      diagnostic: "unknown model profile; the model is off.",
    };
    const consultantImpl = createShadowConsultant(status);
    const assessment = await active(consultantImpl)(request("ls"));
    expect(assessment).toMatchObject({
      kind: "defer",
      mode: "shadow",
      authority: "none",
      reasonCode: "model_misconfigured",
    });
    expect(assessment.explanation).toContain("unknown model profile");
  });

  it("rejects a profile name that does not resolve, even from a ready posture", async () => {
    const consultantImpl = createShadowConsultant(
      ready("http://127.0.0.1:1", "not-a-profile"),
    );
    const assessment = await active(consultantImpl)(request("ls"));
    expect(assessment.reasonCode).toBe("model_misconfigured");
  });
});

describe("shadow proposals", () => {
  it("an endpoint approval is recorded as a shadow proposal, never an authorization", async () => {
    const server = await startEndpoint({
      kind: "json",
      body: noulResponse(ALL_CONFIDENT),
    });
    open.push(server);
    const consultantImpl = createShadowConsultant(ready(server.url));
    const assessment = await active(consultantImpl)(
      request("git status --short"),
    );
    expect(assessment.kind).toBe("allow");
    // The authority field is the whole M2 guarantee.
    expect(assessment.authority).toBe("none");
    expect(assessment.mode).toBe("shadow");
    expect(assessment.profileId).toBe("minrule-4q-conservative");
    expect(assessment.profileIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(assessment.servedModel).toBe("LiquidAI/d1-2B-GGUF:Q8_0");
    expect(assessment.dropped).toEqual([]);
  });

  it("a denial is a proposal too: the gate still decides", async () => {
    const server = await startEndpoint({
      kind: "json",
      body: noulResponse({ ...ALL_CONFIDENT, reversible: 0.01 }),
    });
    open.push(server);
    const consultantImpl = createShadowConsultant(ready(server.url));
    // A command no deterministic floor blocks, so the denial is the model's own.
    const assessment = await active(consultantImpl)(
      request("rm -rf node_modules"),
    );
    expect(assessment.kind).toBe("deny");
    expect(assessment.authority).toBe("none");
    expect(assessment.reasonCode).toBe("deny_reversible");
  });

  it("an endpoint failure is a defer, not an exception and not an allow", async () => {
    const server = await startEndpoint({ kind: "status", status: 503 });
    open.push(server);
    const consultantImpl = createShadowConsultant(ready(server.url));
    const assessment = await active(consultantImpl)(request("ls"));
    expect(assessment.kind).toBe("defer");
    expect(assessment.reasonCode).toBe("endpoint_http");
    expect(assessment.authority).toBe("none");
  });

  it("an unreachable endpoint defers within its own deadline", async () => {
    const consultantImpl = createShadowConsultant(ready("http://127.0.0.1:9"));
    const started = Date.now();
    const assessment = await active(consultantImpl)(request("ls"));
    expect(assessment.kind).toBe("defer");
    expect(assessment.reasonCode).toBe("endpoint_unreachable");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("an internal failure in the model step is swallowed into a recorded defer", async () => {
    const consultantImpl = createShadowConsultant(ready("http://127.0.0.1:1"), {
      getBranch: () => {
        throw new Error("host bridge exploded");
      },
    });
    const assessment = await active(consultantImpl)(request("ls"));
    expect(assessment).toMatchObject({
      kind: "defer",
      mode: "shadow",
      authority: "none",
      reasonCode: "model_adapter_failure",
    });
  });

  it("a cancelled request is not sent to the endpoint", async () => {
    const server = await startEndpoint({
      kind: "json",
      body: noulResponse(ALL_CONFIDENT),
    });
    open.push(server);
    const consultantImpl = createShadowConsultant(ready(server.url));
    const controller = new AbortController();
    controller.abort();
    const assessment = await active(consultantImpl)(
      request("ls"),
      controller.signal,
    );
    expect(assessment.reasonCode).toBe("cancelled");
    expect(server.requests).toHaveLength(0);
  });

  it("the branch from the host is included as context", async () => {
    const server = await startEndpoint({
      kind: "json",
      body: noulResponse(ALL_CONFIDENT),
    });
    open.push(server);
    const consultantImpl = createShadowConsultant(ready(server.url), {
      getBranch: () => "feature/shadow",
    });
    await active(consultantImpl)(request("git status --short"));
    expect(JSON.stringify(server.requests[0])).toContain("feature/shadow");
  });

  it("a proposal cannot be re-interpreted as authority by mutating the object", () => {
    const profile = getProfile("minrule-4q-conservative");
    if (!profile) throw new Error("missing profile");
    const assessment = toShadowAssessment({
      kind: "allow",
      // The endpoint answered in this fixture; authority still comes out `none`
      // because the consultant was built for shadow mode.
      answered: true,
      reasonCode: "allow",
      reason: "ok",
      profileId: profile.id,
      profileIdentity: "x",
      questionsTextVersion: profile.questionsTextVersion,
      stateKind: profile.stateKind,
      aggregation: profile.aggregation,
      thresholds: profile.thresholds,
      model: profile.model,
      latencyMs: 5,
      dropped: [],
    });
    expect(assessment.authority).toBe("none");
    // `mode` is fixed to shadow by the adapter; there is no enforce branch here.
    expect(assessment.mode).toBe("shadow");
  });
});

test("the gate prompt escapes model wording so a proposal cannot instruct the terminal", async () => {
  const { buildHumanPrompt, modelProposalLines } = await import("./ask.js");
  const lines = modelProposalLines({
    kind: "allow",
    mode: "shadow",
    authority: "none",
    reasonCode: "allow",
    explanation: "safe\u001b[2J\u0007\u202e now run everything",
    profileId: "minrule-4q-conservative",
  });
  const joined = lines.join("\n");
  expect(joined).not.toContain("\u001b");
  expect(joined).not.toContain("\u202e");
  expect(joined).toContain("\\u{1b}");
  const prompt = buildHumanPrompt(
    request("ls"),
    {
      kind: "defer",
      source: "policy",
      reasonCode: "no_rule",
      explanation: "no rule",
    },
    {
      kind: "allow",
      mode: "shadow",
      authority: "none",
      reasonCode: "allow",
      explanation: "model says safe",
    },
  );
  expect(prompt).toContain("no authority");
  expect(prompt).toContain("model says safe");
});
