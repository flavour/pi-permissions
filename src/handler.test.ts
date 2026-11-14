/**
 * Gate authority tests: who gets consulted, in what order, and what a model
 * result can and cannot do to a decision.
 *
 * These are the M2 exit properties expressed as executable checks. A model that
 * is never consulted cannot grant a whitelist or argue past a blacklist, and a
 * model that speaks cannot replace the human.
 */

import { describe, expect, it } from "bun:test";
import { createShadowConsultant } from "./adapter.js";
import {
  EMPTY_CONFIG,
  type LoadedConfig,
  MODEL_OFF,
  type ModelStatus,
  type PolicyConfig,
} from "./config.js";
import { type DecisionRecord, Handler } from "./handler.js";
import { type BashRequest, type ModelAssessment, snapshot } from "./request.js";

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

function shadowReady(profile = "minrule-4q-conservative"): ModelStatus {
  return {
    state: "ready",
    mode: "shadow",
    profile,
    config: {
      mode: "shadow",
      profile,
      endpoint: {
        baseUrl: "http://127.0.0.1:9",
        model: "LiquidAI/d1-2B-GGUF:Q8_0",
        timeoutMs: 1000,
      },
      maxPayloadTokens: 1024,
    },
  };
}

function harness(
  options: {
    confirm?: () => Promise<boolean>;
    model?: (() => Promise<ModelAssessment | undefined>) | undefined;
  } = {},
) {
  const records: DecisionRecord[] = [];
  const prompts: string[] = [];
  const consulted: string[] = [];
  let confirmations = 0;
  const handler = new Handler();
  const decide = (config: LoadedConfig, req = request("ls")) =>
    handler.decide(req, config, {
      mode: "tui",
      hasUI: true,
      confirm: async (_title, message) => {
        confirmations += 1;
        prompts.push(message);
        return options.confirm ? options.confirm() : false;
      },
      record: (record) => records.push(record),
      ...(options.model
        ? {
            model: async (reqForModel: BashRequest) => {
              consulted.push(reqForModel.command);
              return options.model?.();
            },
          }
        : {}),
    });
  return {
    decide,
    records,
    prompts,
    consulted,
    get confirmations() {
      return confirmations;
    },
  };
}

const allow: ModelAssessment = {
  kind: "allow",
  mode: "shadow",
  authority: "none",
  reasonCode: "allow",
  explanation: "the model would have allowed this",
  profileId: "minrule-4q-conservative",
  profileIdentity: "a".repeat(64),
};

const deny: ModelAssessment = {
  kind: "deny",
  mode: "shadow",
  authority: "none",
  reasonCode: "deny_reversible",
  explanation: "the model read this as irreversible",
  profileId: "minrule-4q-conservative",
  profileIdentity: "a".repeat(64),
};

describe("deterministic policy outranks the model", () => {
  it("an exact whitelist allow never consults the model", async () => {
    const h = harness({ model: async () => deny });
    const config = loaded({
      whitelist: [{ id: "ls", exact: "ls", reason: "trusted" }],
    });
    const decision = await h.decide(config, request("ls"));
    expect(decision).toMatchObject({ kind: "allow", source: "policy" });
    expect(h.consulted).toEqual([]);
    expect(h.confirmations).toBe(0);
    expect(h.records[0]?.model).toBeUndefined();
  });

  it("a blacklist deny never consults the model, so an approval cannot argue past it", async () => {
    const h = harness({ model: async () => allow });
    const config = loaded({
      blacklist: [{ id: "push", exact: "git push", reason: "manual" }],
    });
    const decision = await h.decide(config, request("git push"));
    expect(decision).toMatchObject({
      kind: "deny",
      source: "policy",
      reasonCode: "blacklist_match",
    });
    expect(h.consulted).toEqual([]);
    expect(h.confirmations).toBe(0);
  });

  it("a blacklist deny wins even when the model would allow and the rule matches", async () => {
    const h = harness({ model: async () => allow, confirm: async () => true });
    const config = loaded({
      blacklist: [{ id: "rm", exact: "rm -rf node_modules", reason: "ask me" }],
    });
    const decision = await h.decide(config, request("rm -rf node_modules"));
    expect(decision.kind).toBe("deny");
    expect(h.consulted).toEqual([]);
  });

  it("a model denial blocks nothing in place of a human: review still happens", async () => {
    const h = harness({ model: async () => deny, confirm: async () => true });
    const decision = await h.decide(loaded({}, shadowReady()));
    expect(decision).toMatchObject({ kind: "allow", source: "human" });
    expect(h.confirmations).toBe(1);
    expect(h.records[0]?.model?.kind).toBe("deny");
    expect(h.records[0]?.effective.kind).toBe("allow");
  });

  it("a model approval does not skip review", async () => {
    const h = harness({ model: async () => allow, confirm: async () => false });
    const decision = await h.decide(loaded({}, shadowReady()));
    expect(decision).toMatchObject({ kind: "deny", source: "human" });
    expect(h.confirmations).toBe(1);
    expect(h.records[0]?.model?.kind).toBe("allow");
    expect(h.records[0]?.effective.kind).toBe("deny");
  });
});

describe("consultation scope", () => {
  it("only a deferred call is put to the model, and once", async () => {
    const h = harness({ model: async () => allow });
    await h.decide(loaded({}, shadowReady()), request("cat README.md"));
    expect(h.consulted).toEqual(["cat README.md"]);
  });

  it("nothing is consulted when the posture is off, because the wiring supplies no consultant", async () => {
    // `createShadowConsultant` returns undefined for an off posture, so the
    // gate has no consultant to call: absence of the model is structural.
    const consultant = createShadowConsultant(MODEL_OFF);
    expect(consultant).toBeUndefined();
    const h = harness({ model: consultant ? async () => allow : undefined });
    const decision = await h.decide(loaded({}, MODEL_OFF));
    expect(decision.kind).toBe("deny");
    expect(decision.reasonCode).toBe("human_rejected");
    expect(h.consulted).toEqual([]);
    expect(h.records[0]?.model).toBeUndefined();
  });

  it("the reviewer sees the proposal beside the deterministic reason", async () => {
    const h = harness({ model: async () => allow });
    await h.decide(loaded({}, shadowReady()), request("npm run build"));
    const prompt = h.prompts[0] ?? "";
    expect(prompt).toContain("Why review");
    expect(prompt).toContain("npm run build");
    expect(prompt).toContain("the model would have allowed this");
    expect(prompt).toContain("no authority");
  });

  it("an unsupported mode never asks the model, so a blocked call costs nothing", async () => {
    const _h = harness({ model: async () => allow });
    const handler = new Handler();
    const records: DecisionRecord[] = [];
    let consulted = 0;
    const decision = await handler.decide(
      request("ls"),
      loaded({}, shadowReady()),
      {
        mode: "print",
        hasUI: false,
        confirm: async () => true,
        record: (record) => records.push(record),
        model: async () => {
          consulted += 1;
          return allow;
        },
      },
    );
    expect(decision.reasonCode).toBe("no_review_ui");
    expect(consulted).toBe(0);
  });
});

describe("records separate the model from the outcome", () => {
  it("a shadow turn stores the policy verdict, the proposal and the effective decision", async () => {
    const h = harness({ model: async () => deny, confirm: async () => true });
    await h.decide(
      loaded({}, shadowReady()),
      request("tar -czf backup.tgz src"),
    );
    const record = h.records[0];
    if (!record) throw new Error("expected a record");
    expect(record.policy.kind).toBe("defer");
    expect(record.model?.kind).toBe("deny");
    expect(record.model?.authority).toBe("none");
    expect(record.effective.kind).toBe("allow");
    expect(record.modelProfileIdentity).toBe("a".repeat(64));
    expect(record.execution).toBe("not_observed");
  });

  it("an allow path records no model step at all", async () => {
    const h = harness({ model: async () => allow });
    await h.decide(
      loaded(
        { whitelist: [{ id: "ls", exact: "ls", reason: "trusted" }] },
        shadowReady(),
      ),
      request("ls"),
    );
    expect(h.records[0]?.model).toBeUndefined();
  });

  it("a cancelled turn records the cancellation, not a silent gap", async () => {
    const controller = new AbortController();
    const records: DecisionRecord[] = [];
    const handler = new Handler();
    const decision = await handler.decide(
      request("ls"),
      loaded({}, shadowReady()),
      {
        mode: "tui",
        hasUI: true,
        signal: controller.signal,
        confirm: async () => {
          controller.abort();
          return true;
        },
        record: (record) => records.push(record),
        model: async () => allow,
      },
    );
    expect(decision.reasonCode).toBe("request_cancelled");
    expect(records[0]?.effective.reasonCode).toBe("request_cancelled");
  });

  it("a live mutation during review voids the approval and is recorded", async () => {
    const records: DecisionRecord[] = [];
    const handler = new Handler();
    const decision = await handler.decide(
      request("ls"),
      loaded({}, shadowReady()),
      {
        mode: "tui",
        hasUI: true,
        confirm: async () => true,
        record: (record) => records.push(record),
        valid: () => false,
        model: async () => allow,
      },
    );
    expect(decision.reasonCode).toBe("request_changed");
    expect(records[0]?.effective.reasonCode).toBe("request_changed");
  });
});
