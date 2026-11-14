/**
 * Aggregation tests for both candidate shapes.
 *
 * The failures being guarded against are the ones that actually happened in the
 * reference projects: a rule that approves when one axis is confident and
 * another is not, a threshold that silently defaults, a missing reading treated
 * as a neutral value, and a veto that never blocks because the comparison is
 * inverted.
 */

import { expect, test } from "bun:test";
import { aggregate, unsafeReading } from "./aggregate.js";
import { aggregateChoice } from "./choice.js";
import { getProfile } from "./profile.js";

function _profile(id: string) {
  const found = getProfile(id);
  if (!found) throw new Error(`missing profile ${id}`);
  return found;
}

function minrule(id: string) {
  const found = getProfile(id);
  if (!found || found.kind !== "minrule")
    throw new Error(`missing minrule profile ${id}`);
  return found;
}

function categorical(id: string) {
  const found = getProfile(id);
  if (!found || found.kind !== "choice")
    throw new Error(`missing choice profile ${id}`);
  return found;
}

const CONSERVATIVE = minrule("minrule-4q-conservative").thresholds;

function readings(overrides: Partial<Record<string, number>> = {}) {
  return {
    authorized: 0.95,
    reversible: 0.95,
    blast_radius: 0.95,
    exfiltration: 0.02,
    ...overrides,
  };
}

test("polarity conversion is declared, not guessed", () => {
  // The three scored questions are phrased so high is good.
  expect(unsafeReading("reversible", 0.9)).toBeCloseTo(0.1);
  // The veto question is phrased the other way round.
  expect(unsafeReading("exfiltration", 0.9)).toBeCloseTo(0.9);
});

test("four confident safe readings allow", () => {
  const verdict = aggregate(readings(), CONSERVATIVE);
  expect(verdict.kind).toBe("allow");
  if (verdict.kind === "allow") expect(verdict.minReading).toBe(0.95);
});

test("one confident unsafe reading on a scored question denies with its own label", () => {
  const verdict = aggregate(readings({ reversible: 0.02 }), CONSERVATIVE);
  expect(verdict.kind).toBe("deny");
  if (verdict.kind === "deny") {
    expect(verdict.key).toBe("reversible");
    expect(verdict.label).toBe("not undoable or regenerable");
  }
});

test("a confident exfiltration reading denies on its own", () => {
  const verdict = aggregate(
    readings({
      authorized: 0.99,
      reversible: 0.99,
      blast_radius: 0.99,
      exfiltration: 0.97,
    }),
    CONSERVATIVE,
  );
  expect(verdict.kind).toBe("deny");
  if (verdict.kind === "deny") expect(verdict.key).toBe("exfiltration");
});

test("an uncertain exfiltration reading defers instead of being averaged away", () => {
  const verdict = aggregate(readings({ exfiltration: 0.3 }), CONSERVATIVE);
  expect(verdict).toEqual({
    kind: "defer",
    reason: "veto_uncertain",
    key: "exfiltration",
    reading: 0.3,
  });
});

test("mid-range readings are never turned into a guessed decision", () => {
  for (const value of [0.31, 0.5, 0.69, 0.85]) {
    const verdict = aggregate(readings({ reversible: value }), CONSERVATIVE);
    expect(verdict.kind).toBe("defer");
    if (verdict.kind === "defer") expect(verdict.reason).toBe("below_allow");
  }
});

test("a missing reading defers instead of being read as zero or one", () => {
  for (const key of [
    "authorized",
    "reversible",
    "blast_radius",
    "exfiltration",
  ]) {
    const partial = { ...readings() };
    delete partial[key as keyof typeof partial];
    const verdict = aggregate(partial, CONSERVATIVE);
    expect(verdict.kind).toBe("defer");
    if (verdict.kind === "defer") {
      expect(verdict.reason).toBe("missing_answer");
      expect(verdict.key).toBe(key);
    }
  }
});

test("the band comes from the profile, so the same readings can differ between profiles", () => {
  const mid = readings({
    authorized: 0.74,
    reversible: 0.74,
    blast_radius: 0.74,
  });
  expect(aggregate(mid, minrule("minrule-4q-judge-band").thresholds).kind).toBe(
    "allow",
  );
  expect(aggregate(mid, CONSERVATIVE).kind).toBe("defer");
});

test("an inverted band can never produce an allow, because denials are evaluated first", () => {
  // A mis-set band is a configuration mistake, so the conservative outcome wins:
  // this must block or defer, and must never approve.
  const verdict = aggregate(readings({ authorized: 0.2 }), {
    allow: 0.9,
    deny: 0.95,
  });
  expect(verdict.kind).not.toBe("allow");
});

const CHOICE_BAND = categorical("choice-3way-cleanroom").thresholds;

test("a confident categorical safe approves", () => {
  const verdict = aggregateChoice(
    "safe",
    { safe: 0.95, dangerous: 0.03, unsure: 0.02 },
    CHOICE_BAND,
  );
  expect(verdict.kind).toBe("allow");
});

test("a categorical safe below the band defers rather than approving", () => {
  const verdict = aggregateChoice(
    "safe",
    { safe: 0.72, dangerous: 0.01, unsure: 0.27 },
    CHOICE_BAND,
  );
  expect(verdict.kind).toBe("defer");
  if (verdict.kind === "defer") expect(verdict.reasonCode).toBe("below_allow");
});

test("a categorical safe is refused when the dangerous reading is not negligible", () => {
  // The reference projects' failure mode: the model is confident about one axis
  // while the other axis still says unsafe. Min-rule semantics apply here too.
  const verdict = aggregateChoice(
    "safe",
    { safe: 0.92, dangerous: 0.07, unsure: 0.01 },
    CHOICE_BAND,
  );
  expect(verdict.kind).toBe("defer");
  if (verdict.kind === "defer")
    expect(verdict.reasonCode).toBe("unsafe_not_excluded");
});

test("a confident dangerous answer denies", () => {
  const verdict = aggregateChoice(
    "dangerous",
    { safe: 0.04, dangerous: 0.95, unsure: 0.01 },
    CHOICE_BAND,
  );
  expect(verdict).toMatchObject({ kind: "deny", reasonCode: "dangerous" });
});

test("an uncertain categorical answer defers, and so does any label outside the set", () => {
  expect(
    aggregateChoice(
      "unsure",
      { safe: 0.4, dangerous: 0.3, unsure: 0.3 },
      CHOICE_BAND,
    ).kind,
  ).toBe("defer");
  const outside = aggregateChoice(
    "probably_fine" as Parameters<typeof aggregateChoice>[0],
    { safe: 0.99, dangerous: 0.0, unsure: 0.0 },
    CHOICE_BAND,
  );
  expect(outside.kind).toBe("defer");
  if (outside.kind === "defer")
    expect(outside.reasonCode).toBe("undeclared_label");
});

test("a categorical dangerous below the block band defers instead of denying", () => {
  const verdict = aggregateChoice(
    "dangerous",
    { safe: 0.55, dangerous: 0.35, unsure: 0.1 },
    CHOICE_BAND,
  );
  expect(verdict.kind).toBe("defer");
  if (verdict.kind === "defer")
    expect(verdict.reasonCode).toBe("dangerous_uncertain");
});
