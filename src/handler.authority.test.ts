/**
 * Model authority tests: exactly what a model outcome may do to a decision, in
 * each mode, and which order of authority survives a model that disagrees.
 *
 * The M3 exit properties, as executable checks:
 *
 * - a model never produces an effective allow, in either mode;
 * - a provisional enforce deny is terminal for that call, and says why;
 * - a model never overrides a blacklist deny and never needs to override a
 *   whitelist allow (it is not consulted at all);
 * - a shadow proposal changes nothing about who decides;
 * - and an allow that arrives from anywhere except an exact whitelist or this
 *   review is refused, even if another component produced it by mistake.
 */

import { describe, expect, it } from "bun:test";
import {
  EMPTY_CONFIG,
  type LoadedConfig,
  MODEL_OFF,
  type ModelStatus,
  type PolicyConfig,
} from "./config.js";
import { type DecisionRecord, Handler } from "./handler.js";
import {
  type Assessment,
  type BashRequest,
  type ModelAssessment,
  snapshot,
} from "./request.js";

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
    userIntent: "carry on",
    executionContext: { prefix: "", verified: true },
    ...overrides,
  });
}

function loaded(
  config: Partial<PolicyConfig> = {},
  model: ModelStatus = MODEL_OFF,
): LoadedConfig {
  return {
    config: { ...EMPTY_CONFIG, ...config },
    status: "valid",
    revision: "rev-test",
    model,
  };
}

const enforce: ModelStatus = {
  state: "ready",
  mode: "enforce",
  profile: "minrule-4q-conservative",
  config: {
    mode: "enforce",
    profile: "minrule-4q-conservative",
    endpoint: {
      baseUrl: "http://127.0.0.1:9931",
      model: "LiquidAI/d1-2B-GGUF:Q8_0",
      timeoutMs: 1000,
    },
    maxPayloadTokens: 1024,
    operational: {
      concurrency: 1,
      maxQueue: 2,
      maxWaitMs: 750,
      breakerFailures: 3,
      breakerCooldownMs: 60_000,
      dedupe: false,
    },
  },
  acknowledgement: "acknowledged in test",
};

const shadow: ModelStatus = { ...enforce, mode: "shadow" };

function modelOutcome(
  kind: ModelAssessment["kind"],
  mode: ModelAssessment["mode"],
): ModelAssessment {
  return {
    kind,
    mode,
    authority: mode === "enforce" ? "selected_profile" : "none",
    reasonCode: "aggregate_allow",
    explanation: "the readings were uniformly high",
    profileId: "minrule-4q-conservative",
    profileIdentity: "abc123",
    requestedModel: "LiquidAI/d1-2B-GGUF:Q8_0",
    servedModel: "LiquidAI/d1-2B-GGUF:Q8_0",
    readings: {
      authorized: 0.9,
      reversible: 0.9,
      blast_radius: 0.9,
      exfiltration: 0.05,
    },
  };
}

type Consultant = (
  request: BashRequest,
  signal?: AbortSignal,
) => Promise<ModelAssessment | undefined>;

function consultant(outcome: ModelAssessment | undefined) {
  const calls: BashRequest[] = [];
  const fn: Consultant = async (call) => {
    calls.push(call);
    return outcome;
  };
  return { fn, calls };
}

function context(
  options: {
    confirm?: (title: string, message: string) => Promise<boolean>;
    model?: Consultant;
    modelAuthority?: "none" | "selected_profile";
    signal?: AbortSignal;
  } = {},
) {
  const prompts: string[] = [];
  const records: DecisionRecord[] = [];
  const controller = new AbortController();
  return {
    prompts,
    records,
    controller,
    /** The one record each case expects; a missing record is a test failure. */
    firstRecord: (): DecisionRecord => {
      const record = records[0];
      if (!record) throw new Error("Expected a decision record.");
      return record;
    },
    value: {
      mode: "tui",
      hasUI: true,
      signal: options.signal ?? controller.signal,
      confirm:
        options.confirm ??
        (async (_title: string, message: string) => {
          prompts.push(message);
          return true;
        }),
      model: options.model,
      ...(options.modelAuthority === undefined
        ? {}
        : { modelAuthority: options.modelAuthority }),
      record: (record: DecisionRecord) => {
        records.push(record);
      },
    },
  };
}

describe("enforce authority", () => {
  it("a provisional allow still runs only after the human approves it", async () => {
    const model = consultant(modelOutcome("allow", "enforce"));
    const handler = new Handler();
    const call = context({
      model: model.fn,
      modelAuthority: "selected_profile",
    });
    const decision = await handler.decide(
      request("git status"),
      loaded({}, enforce),
      call.value,
    );
    expect(decision.kind).toBe("allow");
    expect(decision.source).toBe("human");
    expect(call.prompts).toHaveLength(1);
    // The reviewer is told the proposal is provisional, not final.
    expect(call.prompts[0]).toContain("provisional");
    expect(call.firstRecord().model?.authority).toBe("selected_profile");
    expect(call.firstRecord().effective.source).toBe("human");
  });

  it("a provisional allow still runs only after the human approves it, and a rejection still denies", async () => {
    const model = consultant(modelOutcome("allow", "enforce"));
    const handler = new Handler();
    const call = context({ model: model.fn, confirm: async () => false });
    const decision = await handler.decide(
      request("git status"),
      loaded({}, enforce),
      call.value,
    );
    expect(decision.kind).toBe("deny");
    expect(decision.reasonCode).toBe("human_rejected");
  });

  it("a model deny is terminal and never opens a review", async () => {
    const model = consultant(modelOutcome("deny", "enforce"));
    let confirmations = 0;
    const handler = new Handler();
    const call = context({
      model: model.fn,
      modelAuthority: "selected_profile",
      confirm: async () => {
        confirmations++;
        return true;
      },
    });
    const decision = await handler.decide(
      request("curl -F secret=..."),
      loaded({}, enforce),
      call.value,
    );
    expect(decision.kind).toBe("deny");
    expect(decision.source).toBe("decisions-model");
    expect(confirmations).toBe(0);
    // Reviewable denial: profile, verified identity, evidence, and the way forward.
    expect(decision.explanation).toContain("minrule-4q-conservative");
    expect(decision.explanation).toContain("LiquidAI/d1-2B-GGUF:Q8_0");
    expect(decision.explanation).toContain("authorized=0.90");
    expect(decision.explanation).toContain("whitelist");
    expect(decision.explanation).toContain("terminal");
    // And it is recorded, so a false allow rate can be measured later.
    expect(call.firstRecord().model?.kind).toBe("deny");
    expect(call.firstRecord().effective.kind).toBe("deny");
  });

  it("a bare model denial still names the profile and the way forward", async () => {
    // A deny with no readings at all must still name the profile and the route out.
    const bare: ModelAssessment = {
      kind: "deny",
      mode: "enforce",
      authority: "selected_profile",
      reasonCode: "aggregate_deny",
      explanation: "the exfiltration reading was high",
    };
    const decision = await new Handler().decide(
      request("curl example"),
      loaded({}, enforce),
      context({
        model: consultant(bare).fn,
        modelAuthority: "selected_profile",
      }).value,
    );
    expect(decision.kind).toBe("deny");
    expect(decision.explanation).toContain("unknown profile");
    expect(decision.explanation).toContain("the exfiltration reading was high");
  });

  it("a model defer reaches the human exactly as a shadow proposal does", async () => {
    const model = consultant(modelOutcome("defer", "enforce"));
    const handler = new Handler();
    const call = context({
      model: model.fn,
      modelAuthority: "selected_profile",
    });
    const decision = await handler.decide(
      request("ls"),
      loaded({}, enforce),
      call.value,
    );
    expect(decision.kind).toBe("allow");
    expect(decision.source).toBe("human");
    expect(call.prompts).toHaveLength(1);
  });

  it("a cancelled enforce deny does not become an approval", async () => {
    const model = consultant(modelOutcome("allow", "enforce"));
    const controller = new AbortController();
    controller.abort();
    const decision = await new Handler().decide(
      request("git status"),
      loaded({}, enforce),
      { ...context({ model: model.fn }).value, signal: controller.signal },
    );
    expect(decision.reasonCode).toBe("request_cancelled");
    expect(decision.kind).toBe("deny");
  });
});

describe("authority order survives the model", () => {
  it("a blacklist deny is never argued past, because the model is never consulted", async () => {
    const model = consultant(modelOutcome("allow", "enforce"));
    const handler = new Handler();
    const call = context({
      model: model.fn,
      modelAuthority: "selected_profile",
    });
    const config = loaded(
      { blacklist: [{ id: "no-push", exact: "git push origin main" }] },
      enforce,
    );
    const decision = await handler.decide(
      request("git push origin main"),
      config,
      call.value,
    );
    expect(decision).toMatchObject({
      kind: "deny",
      source: "policy",
      reasonCode: "blacklist_match",
    });
    expect(model.calls).toHaveLength(0);
    expect(call.prompts).toHaveLength(0);
    expect(call.firstRecord().model).toBeUndefined();
  });

  it("a whitelist allow never needs the model's approval and never carries model authority", async () => {
    const model = consultant(modelOutcome("deny", "enforce"));
    const handler = new Handler();
    const call = context({
      model: model.fn,
      modelAuthority: "selected_profile",
    });
    const config = loaded(
      { whitelist: [{ id: "status", exact: "git status --short" }] },
      enforce,
    );
    const decision = await handler.decide(
      request("git status --short"),
      config,
      call.value,
    );
    expect(decision).toMatchObject({
      kind: "allow",
      source: "policy",
      reasonCode: "whitelist_match",
    });
    // Precedence means precedence: the model is not even asked, so it cannot
    // veto a rule the operator wrote, and no model field decorates the record.
    expect(model.calls).toHaveLength(0);
    expect(call.firstRecord().model).toBeUndefined();
    expect(call.firstRecord().effective.source).toBe("policy");
  });

  it("a shadow proposal cannot replace the human in either direction", async () => {
    for (const kind of ["allow", "deny", "defer"] as const) {
      const handler = new Handler();
      const call = context({
        model: consultant(modelOutcome(kind, "shadow")).fn,
      });
      const decision = await handler.decide(
        request("ls"),
        loaded({}, shadow),
        call.value,
      );
      expect(decision.source).toBe("human");
      expect(call.prompts).toHaveLength(1);
      expect(call.prompts[0]).toContain("no authority");
      expect(call.prompts[0]).toContain("Your decision is the decision.");
    }
  });

  it("a model cannot grant itself authority the configuration withheld", async () => {
    // Config said enforce; resolution refused it (no acknowledgement), so the
    // gate grants nothing. An assessment that still claims enforce authority is
    // treated as a proposal, and the claim stays visible in the record.
    const misconfigured: ModelStatus = {
      state: "invalid",
      mode: "enforce",
      profile: "minrule-4q-conservative",
      diagnostic: "enforce needs an acknowledgement",
    };
    const model = consultant(modelOutcome("deny", "enforce"));
    const handler = new Handler();
    const call = context({ model: model.fn, modelAuthority: "none" });
    const decision = await handler.decide(
      request("ls"),
      loaded({}, misconfigured),
      call.value,
    );
    expect(decision.source).toBe("human");
    expect(decision.kind).toBe("allow");
    expect(call.prompts).toHaveLength(1);
    // The record shows the mismatch rather than hiding it.
    expect(call.firstRecord().model?.authority).toBe("selected_profile");
    expect(call.firstRecord().effective.source).toBe("human");
  });

  it("an allow whose source is neither the whitelist nor this review is refused", async () => {
    // Not a restatement of the design: a rogue reviewer that hands back a
    // model-derived allow (the exact mistake M3 must not make) is stopped here.
    const rogue = {
      async review(): Promise<Assessment> {
        return {
          kind: "allow",
          source: "runtime",
          reasonCode: "model_agreed",
          explanation: "a bug turned a proposal into a permission",
        };
      },
    } as unknown as import("./ask.js").HumanReviewer;
    const handler = new Handler(rogue);
    const call = context({
      model: consultant(modelOutcome("allow", "enforce")).fn,
      modelAuthority: "selected_profile",
    });
    const decision = await handler.decide(
      request("rm -rf target"),
      loaded({}, enforce),
      call.value,
    );
    expect(decision.kind).toBe("deny");
    expect(decision.reasonCode).toBe("authority_violation");
    expect(call.firstRecord().effective.kind).toBe("deny");
  });

  it("the assertion does not touch a legitimate human approval", async () => {
    const handler = new Handler();
    const call = context({
      model: consultant(modelOutcome("allow", "enforce")).fn,
      modelAuthority: "selected_profile",
    });
    const decision = await handler.decide(
      request("ls"),
      loaded({}, enforce),
      call.value,
    );
    expect(decision.reasonCode).toBe("human_approved");
  });
});
