/**
 * Configuration tests for the M2 model block.
 *
 * The rules under test are the ones that keep a misconfiguration from becoming
 * either a silent loss of protection or an unintended grant of authority:
 * a rejected model block switches the model off and says why, `enforce` grants
 * authority only against an explicit acknowledgement, and a profile's
 * calibration cannot be borrowed by another profile.
 */

import { describe, expect, it, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENFORCE_ACKNOWLEDGEMENT,
  loadConfig,
  MODEL_OFF,
  OPERATIONAL_DEFAULTS,
} from "./config.js";
import { PROFILES } from "./decisions/profile.js";

function directory() {
  return mkdtempSync(join(tmpdir(), "pi-permissions-model-"));
}

function put(agent: string, value: unknown): void {
  const target = join(agent, "extensions/pi-permissions");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "config.json"), JSON.stringify(value));
}

const base = { version: 1, whitelist: [], blacklist: [] };

const shadow = {
  mode: "shadow",
  profile: "minrule-4q-conservative",
  endpoint: {
    baseUrl: "http://jetson.lan:9931",
    model: "LiquidAI/d1-2B-GGUF:Q8_0",
    timeoutMs: 1500,
  },
};

function withModel(model: unknown) {
  return { ...base, model };
}

describe("model configuration posture", () => {
  it("no model block means the model is off and nothing else changes", () => {
    const agent = directory();
    put(agent, base);
    const loaded = loadConfig(agent);
    expect(loaded.status).toBe("valid");
    expect(loaded.model).toEqual(MODEL_OFF);
  });

  it("explicit off is off", () => {
    const agent = directory();
    put(agent, withModel({ ...shadow, mode: "off" }));
    expect(loadConfig(agent).model).toEqual(MODEL_OFF);
  });

  it("a valid shadow block resolves to a ready posture with the profile config", () => {
    const agent = directory();
    put(agent, withModel(shadow));
    const loaded = loadConfig(agent);
    expect(loaded.status).toBe("valid");
    expect(loaded.model.state).toBe("ready");
    expect(loaded.model.mode).toBe("shadow");
    expect(loaded.model.profile).toBe("minrule-4q-conservative");
    expect(loaded.model.config?.endpoint.timeoutMs).toBe(1500);
  });

  it("enforce without the acknowledgement stays off and keeps the gate intact", () => {
    const agent = directory();
    put(agent, withModel({ ...shadow, mode: "enforce" }));
    const loaded = loadConfig(agent);
    expect(loaded.status).toBe("valid");
    expect(loaded.model.state).toBe("invalid");
    expect(loaded.model.config).toBeUndefined();
    expect(loaded.model.diagnostic).toContain("enforceAcknowledgement");
    // Losing the model must not lose the deterministic gate.
    expect(loaded.config.version).toBe(1);
  });

  it("enforce with the exact acknowledgement is ready and carries its bounds", () => {
    const agent = directory();
    put(
      agent,
      withModel({
        ...shadow,
        mode: "enforce",
        enforceAcknowledgement: ENFORCE_ACKNOWLEDGEMENT,
      }),
    );
    const loaded = loadConfig(agent);
    expect(loaded.model.state).toBe("ready");
    expect(loaded.model.mode).toBe("enforce");
    expect(loaded.model.acknowledgement).toBe(ENFORCE_ACKNOWLEDGEMENT);
    expect(loaded.model.config?.operational).toEqual(OPERATIONAL_DEFAULTS);
  });

  it("an acknowledgement that is merely similar grants nothing", () => {
    const agent = directory();
    put(
      agent,
      withModel({
        ...shadow,
        mode: "enforce",
        enforceAcknowledgement: "i understand this profile is provisional",
      }),
    );
    expect(loadConfig(agent).model.state).toBe("invalid");
  });

  it("enforce is off rather than borrowing a mismatched endpoint identity", () => {
    const agent = directory();
    put(
      agent,
      withModel({
        ...shadow,
        mode: "enforce",
        enforceAcknowledgement: ENFORCE_ACKNOWLEDGEMENT,
        endpoint: { ...shadow.endpoint, model: "Someone/Else:latest" },
      }),
    );
    const loaded = loadConfig(agent);
    expect(loaded.model.state).toBe("invalid");
    expect(loaded.model.diagnostic).toContain("pinned model identity");
  });

  it("enforce requires a bounded request rather than an unbounded one", () => {
    const agent = directory();
    put(
      agent,
      withModel({
        ...shadow,
        mode: "enforce",
        enforceAcknowledgement: ENFORCE_ACKNOWLEDGEMENT,
        maxPayloadTokens: 4096,
      }),
    );
    const loaded = loadConfig(agent);
    expect(loaded.model.state).toBe("invalid");
    expect(loaded.model.diagnostic).toContain("bounded request");
  });

  it("operational bounds resolve from config and cannot approve anything", () => {
    const agent = directory();
    put(
      agent,
      withModel({
        ...shadow,
        operational: {
          concurrency: 2,
          maxQueue: 0,
          maxWaitMs: 100,
          breakerFailures: 5,
          breakerCooldownMs: 30000,
          dedupe: true,
        },
      }),
    );
    const config = loadConfig(agent).model.config;
    expect(config?.operational).toEqual({
      concurrency: 2,
      maxQueue: 0,
      maxWaitMs: 100,
      breakerFailures: 5,
      breakerCooldownMs: 30000,
      dedupe: true,
    });
  });

  it("an out-of-range operational bound invalidates the config instead of clamping", () => {
    const agent = directory();
    put(agent, withModel({ ...shadow, operational: { concurrency: 0 } }));
    expect(loadConfig(agent).status).toBe("invalid");
    put(agent, withModel({ ...shadow, operational: { dedupe: "yes" } }));
    expect(loadConfig(agent).status).toBe("invalid");
  });

  it("an unknown profile switches the model off without disabling deterministic policy", () => {
    const agent = directory();
    put(agent, withModel({ ...shadow, profile: "my-clever-prompt" }));
    const loaded = loadConfig(agent);
    expect(loaded.status).toBe("valid");
    expect(loaded.model.state).toBe("invalid");
    expect(loaded.model.diagnostic).toContain("unknown model profile");
    // The gate itself is unchanged: exact rules still decide, human review stands.
    expect(loaded.config.whitelist).toEqual([]);
  });

  it("a configured served identity that differs from the profile's is refused", () => {
    const agent = directory();
    put(
      agent,
      withModel({
        ...shadow,
        endpoint: { ...shadow.endpoint, model: "LiquidAI/d1-2B-GGUF:Q4_K_M" },
      }),
    );
    const loaded = loadConfig(agent);
    expect(loaded.model.state).toBe("invalid");
    expect(loaded.model.diagnostic).toContain("pinned model identity");
  });

  it("every shipped profile can be configured, so the documented IDs are real", () => {
    for (const profile of PROFILES) {
      const agent = directory();
      put(
        agent,
        withModel({
          ...shadow,
          profile: profile.id,
          endpoint: { ...shadow.endpoint, model: profile.model },
        }),
      );
      expect(loadConfig(agent).model.state).toBe("ready");
    }
  });

  it("a malformed model block invalidates the config and switches everything off", () => {
    for (const model of [
      { mode: "shadow" }, // no profile or endpoint
      { ...shadow, endpoint: { baseUrl: "http://x", model: "m", extra: 1 } },
      { ...shadow, mode: "sometimes" },
      { ...shadow, unknownField: true },
      "shadow",
      [],
    ]) {
      const agent = directory();
      put(agent, withModel(model));
      const loaded = loadConfig(agent);
      expect(loaded.status).toBe("invalid");
      expect(loaded.config).toEqual({
        version: 1,
        whitelist: [],
        blacklist: [],
      });
      expect(loaded.model).toEqual(MODEL_OFF);
      expect(loaded.diagnostic).toContain("automatic approval is disabled");
    }
  });

  it("a URL with a path, query or embedded credentials is rejected", () => {
    for (const baseUrl of [
      "http://host:1/path",
      "http://host:1?q=2",
      "http://user:password@host:1",
      "file:///etc/passwd",
      "http://host with spaces:1",
    ]) {
      const agent = directory();
      put(
        agent,
        withModel({ ...shadow, endpoint: { ...shadow.endpoint, baseUrl } }),
      );
      expect(loadConfig(agent).status).toBe("invalid");
    }
  });

  it("timeouts and payload budgets outside sane bounds are rejected rather than honoured", () => {
    for (const endpoint of [
      { ...shadow.endpoint, timeoutMs: 0 },
      { ...shadow.endpoint, timeoutMs: 600_000 },
    ]) {
      const agent = directory();
      put(agent, withModel({ ...shadow, endpoint }));
      expect(loadConfig(agent).status).toBe("invalid");
    }
    for (const maxPayloadTokens of [0, 8, 100_000]) {
      const agent = directory();
      put(agent, withModel({ ...shadow, maxPayloadTokens }));
      expect(loadConfig(agent).status).toBe("invalid");
    }
  });

  it("the posture follows the exact content revision, so a reload cannot inherit it", () => {
    const agent = directory();
    put(agent, withModel(shadow));
    const ready = loadConfig(agent);
    put(agent, base);
    const off = loadConfig(agent);
    expect(ready.revision).not.toBe(off.revision);
    expect(ready.model.state).toBe("ready");
    expect(off.model).toEqual(MODEL_OFF);
  });

  test("adding a model block does not loosen rule validation", () => {
    // A model block is additive: rule validation still rejects a duplicate ID,
    // so a model cannot be used to argue a rule through.
    const agent = directory();
    put(agent, {
      ...withModel(shadow),
      whitelist: [
        { id: "same", exact: "ls" },
        { id: "same", exact: "pwd" },
      ],
    });
    expect(loadConfig(agent).status).toBe("invalid");
  });
});
