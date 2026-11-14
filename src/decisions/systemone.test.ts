/**
 * Endpoint client tests against a real loopback HTTP server.
 *
 * These exercise the wire contract through `fetch`, not a stub of it: every
 * malformed, hostile or unavailable response shape a LAN endpoint can produce
 * must end in a typed failure that the gate turns into a defer. Nothing here
 * touches an external host, and no test asserts that a bad response was
 * tolerated.
 */

import { afterAll, expect, test } from "bun:test";
import {
  choiceResponse,
  type FixtureEndpoint,
  noulResponse,
  startEndpoint,
} from "../../scripts/fixtures/endpoint.js";
import { getProfile } from "./profile.js";
import {
  askSystemOne,
  EndpointError,
  type EndpointFailureKind,
  parseAnswers,
} from "./systemone.js";

const open: FixtureEndpoint[] = [];

function profile(id: string) {
  const found = getProfile(id);
  if (!found) throw new Error(`missing profile ${id}`);
  return found;
}

const minrule = profile("minrule-4q-conservative");
const choice = profile("choice-3way-cleanroom");

async function endpoint(behaviour: Parameters<typeof startEndpoint>[0]) {
  const server = await startEndpoint(behaviour);
  open.push(server);
  return server;
}

afterAll(async () => {
  for (const server of open.splice(0)) await server.close();
});

const SAFE_READINGS = {
  authorized: 0.95,
  reversible: 0.95,
  blast_radius: 0.95,
  exfiltration: 0.02,
};

test("sends exactly model, state and questions, and reads back verified identity", async () => {
  const server = await endpoint({
    kind: "json",
    body: noulResponse(SAFE_READINGS),
  });
  const result = await askSystemOne({
    baseUrl: server.url,
    path: minrule.endpointPath,
    profile: minrule,
    state: { value: { command: "pwd" }, context: {} },
    questions: minrule.questions,
    timeoutMs: 1000,
  });
  expect(result.model).toBe("LiquidAI/d1-2B-GGUF:Q8_0");
  expect(result.readings).toEqual(SAFE_READINGS);
  expect(result.usage).toEqual({ input_tokens: 120, output_tokens: 0 });
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  expect(server.requests).toHaveLength(1);
  // The wire object is exactly the documented three fields.
  expect(Object.keys(server.requests[0] as object).sort()).toEqual([
    "model",
    "questions",
    "state",
  ]);
});

test("the profile's aggregation metadata never reaches the endpoint", async () => {
  const server = await endpoint({
    kind: "json",
    body: noulResponse(SAFE_READINGS),
  });
  await askSystemOne({
    baseUrl: server.url,
    path: minrule.endpointPath,
    profile: minrule,
    state: {},
    questions: minrule.questions,
    timeoutMs: 1000,
  });
  const sent = JSON.stringify(server.requests[0]);
  expect(sent).not.toContain("unsafeWhenHigh");
  expect(sent).not.toContain("veto");
});

test("a served identity that is not the profile's model is rejected, not substituted", async () => {
  const server = await endpoint({
    kind: "json",
    body: noulResponse(SAFE_READINGS, "LiquidAI/d1-2B-GGUF:Q4_K_M"),
  });
  const error = await askSystemOne({
    baseUrl: server.url,
    path: minrule.endpointPath,
    profile: minrule,
    state: {},
    questions: minrule.questions,
    timeoutMs: 1000,
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(EndpointError);
  expect((error as EndpointError).kind).toBe("identity");
});

test("a response with no identity at all cannot be verified", async () => {
  const body = noulResponse(SAFE_READINGS) as Record<string, unknown>;
  delete body.model;
  const server = await endpoint({ kind: "json", body });
  const error = await askSystemOne({
    baseUrl: server.url,
    path: minrule.endpointPath,
    profile: minrule,
    state: {},
    questions: minrule.questions,
    timeoutMs: 1000,
  }).catch((cause: unknown) => cause);
  expect((error as EndpointError).kind).toBe("identity");
});

test("out-of-range readings fail instead of being clamped", async () => {
  const server = await endpoint({
    kind: "json",
    body: noulResponse({ ...SAFE_READINGS, authorized: 1.4 }),
  });
  const error = await askSystemOne({
    baseUrl: server.url,
    path: minrule.endpointPath,
    profile: minrule,
    state: {},
    questions: minrule.questions,
    timeoutMs: 1000,
  }).catch((cause: unknown) => cause);
  expect((error as EndpointError).kind).toBe("range");
});

test("NaN and Infinity readings are rejected", () => {
  const readings: Record<string, number> = { ...SAFE_READINGS };
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "0.9" as unknown as number,
  ]) {
    const error = (() => {
      try {
        parseAnswers(
          noulResponse({ ...readings, authorized: value }),
          minrule,
          0,
        );
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();
    expect((error as EndpointError).kind).toBe("range");
  }
});

test("missing, extra, wrong-typed and non-object answers all defer", async () => {
  const missing = noulResponse(SAFE_READINGS) as {
    answers: Record<string, unknown>;
  };
  delete missing.answers.blast_radius;
  const extra = noulResponse({
    ...SAFE_READINGS,
    surprise: 0.5,
  } as unknown as Record<string, number>);
  const base = noulResponse(SAFE_READINGS) as {
    answers: Record<string, unknown>;
  };
  const wrongType = {
    ...base,
    answers: {
      ...base.answers,
      authorized: { type: "choice", choice: "safe" },
    },
  };
  for (const body of [missing, extra, wrongType, null, 42, "text", []]) {
    const server = await endpoint({ kind: "json", body });
    const error = await askSystemOne({
      baseUrl: server.url,
      path: minrule.endpointPath,
      profile: minrule,
      state: {},
      questions: minrule.questions,
      timeoutMs: 1000,
    }).catch((cause: unknown) => cause);
    expect((error as EndpointError).kind).toBe("parse");
  }
});

test("malformed JSON, HTTP errors and disconnects are typed failures", async () => {
  const cases: readonly {
    behaviour: Parameters<typeof startEndpoint>[0];
    kind: string;
  }[] = [
    {
      behaviour: { kind: "malformed", text: "<html>proxy error</html>" },
      kind: "parse",
    },
    { behaviour: { kind: "status", status: 500 }, kind: "http" },
    { behaviour: { kind: "status", status: 404 }, kind: "http" },
    { behaviour: { kind: "disconnect" }, kind: "unreachable" },
  ];
  for (const { behaviour, kind } of cases) {
    const server = await endpoint(behaviour);
    const error = await askSystemOne({
      baseUrl: server.url,
      path: minrule.endpointPath,
      profile: minrule,
      state: {},
      questions: minrule.questions,
      timeoutMs: 1000,
    }).catch((cause: unknown) => cause);
    expect((error as EndpointError).kind).toBe(kind as EndpointFailureKind);
  }
});

test("a stalled endpoint hits its own deadline rather than hanging the caller", async () => {
  const server = await endpoint({ kind: "delay", ms: 500 });
  const started = Date.now();
  const error = await askSystemOne({
    baseUrl: server.url,
    path: minrule.endpointPath,
    profile: minrule,
    state: {},
    questions: minrule.questions,
    timeoutMs: 60,
  }).catch((cause: unknown) => cause);
  expect((error as EndpointError).kind).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(2000);
});

test("a refused connection is unreachable, and the detail carries no body", async () => {
  const server = await endpoint({
    kind: "status",
    status: 503,
    body: "sk-secret-material-in-body",
  });
  const error = await askSystemOne({
    baseUrl: server.url,
    path: minrule.endpointPath,
    profile: minrule,
    state: {},
    questions: minrule.questions,
    timeoutMs: 1000,
  }).catch((cause: unknown) => cause);
  expect((error as EndpointError).kind).toBe("http");
  // The reason surfaced to a reviewer must not echo the endpoint body.
  expect((error as EndpointError).detail).not.toContain("sk-secret");
  expect((error as EndpointError).message).toBe("http: status 503");
});

test("choice answers are validated against the declared labels and sum to one", async () => {
  const good = await endpoint({
    kind: "json",
    body: choiceResponse("safe", { safe: 0.93, dangerous: 0.04, unsure: 0.03 }),
  });
  const result = await askSystemOne({
    baseUrl: good.url,
    path: choice.endpointPath,
    profile: choice,
    state: "tool: bash\n",
    questions: choice.questions,
    timeoutMs: 1000,
  });
  expect(result.choices.decision).toBe("safe");
  expect(result.distributions.decision?.safe).toBeCloseTo(0.93);

  const cases: readonly unknown[] = [
    choiceResponse("safe", { safe: 0.5, dangerous: 0.2, unsure: 0.2 }), // sums to 0.9
    choiceResponse("probably", { safe: 0.5, dangerous: 0.5 }), // undeclared label
    choiceResponse("safe", { safe: 1.2, dangerous: -0.2 }), // out of range
    {
      model: choice.model,
      answers: { decision: { type: "choice", choice: "safe" } },
    }, // no distribution
  ];
  for (const body of cases) {
    const server = await endpoint({ kind: "json", body });
    const error = await askSystemOne({
      baseUrl: server.url,
      path: choice.endpointPath,
      profile: choice,
      state: "",
      questions: choice.questions,
      timeoutMs: 1000,
    }).catch((cause: unknown) => cause);
    expect(["parse", "range"]).toContain((error as EndpointError).kind);
  }
});

test("a transport that throws a plain error is still a typed failure", async () => {
  const error = await askSystemOne({
    baseUrl: "http://127.0.0.1:1",
    path: minrule.endpointPath,
    profile: minrule,
    state: {},
    questions: minrule.questions,
    timeoutMs: 1000,
    transport: async () => {
      throw new Error("socket exploded");
    },
  }).catch((cause: unknown) => cause);
  expect((error as EndpointError).kind).toBe("parse");
});

test("latency is measured by the supplied clock, not by wall-clock guessing", async () => {
  const server = await endpoint({
    kind: "json",
    body: noulResponse(SAFE_READINGS),
  });
  let clock = 1000;
  const result = await askSystemOne({
    baseUrl: server.url,
    path: minrule.endpointPath,
    profile: minrule,
    state: {},
    questions: minrule.questions,
    timeoutMs: 1000,
    now: () => {
      clock += 137;
      return clock;
    },
  });
  expect(result.latencyMs).toBe(137);
});
