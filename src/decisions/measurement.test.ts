/**
 * Measurement tests: the numbers M3 quotes about a profile, and the conditions
 * under which this package refuses to quote them.
 *
 * These exist because the reference projects reported accuracy/approval rates on
 * small or non-held-out sets and shipped profiles that approved dangerous calls.
 * Every case here is about not repeating that: no rate without reviewed labels, no
 * verdict from examples used to choose, and no candidate verdict while a held-out
 * dangerous case was approved.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  calibrationCurve,
  enforcementEvidence,
  formatEvidence,
  MIN_REVIEWED_HELDOUT_PER_FAMILY,
  stratifiedHoldout,
} from "./measurement.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function example(
  score: number,
  family: "safe" | "dangerous" | "unsure",
  reviewed = true,
) {
  return { score, family, reviewed };
}

/**
 * A reviewed held-out set that is also well calibrated: in every score band, the
 * observed share of `safe` labels matches the mean score, so a `candidate` verdict
 * here depends on the thresholds rather than on a lucky fixture. The middle band
 * is half `safe`, half `unsure` for exactly that reason, and nothing outside
 * `safe` is approved.
 */
function cleanHeldout(count = MIN_REVIEWED_HELDOUT_PER_FAMILY) {
  return [
    ...Array.from({ length: count }, () => ({
      ...example(0.97, "safe"),
      approved: true,
    })),
    ...Array.from({ length: count }, () => ({
      ...example(0.02, "dangerous"),
      approved: false,
    })),
    // The middle band is half `safe`, half `unsure`, so its observed safe rate
    // equals its mean score.
    ...Array.from({ length: count }, () => ({
      ...example(0.5, "safe"),
      approved: false,
    })),
    ...Array.from({ length: count }, () => ({
      ...example(0.5, "unsure"),
      approved: false,
    })),
  ];
}

describe("calibration curve", () => {
  it("refuses to report anything when no example was reviewed", () => {
    const curve = calibrationCurve([
      example(0.95, "safe", false),
      example(0.05, "dangerous", false),
    ]);
    expect(curve.usable).toBe(false);
    expect(curve.unusableReason).toContain("no reviewed examples");
    expect(Number.isNaN(curve.expectedCalibrationError)).toBe(true);
    // Author-written synthetic cases can detect regressions; they cannot
    // estimate a false-allow rate, and this is where that is enforced.
  });

  it("places readings in fixed bins and reports the gap against observed safety", () => {
    const curve = calibrationCurve([
      example(0.97, "safe"),
      example(0.96, "safe"),
      example(0.93, "dangerous"),
      example(0.03, "dangerous"),
    ]);
    expect(curve.usable).toBe(true);
    expect(curve.bins.length).toBeGreaterThan(1);
    const top = curve.bins.at(-1);
    if (!top) throw new Error("expected a top bin");
    expect(top.count).toBe(2);
    expect(top.observedSafeRate).toBeCloseTo(1);
    expect(curve.expectedCalibrationError).toBeLessThan(0.5);
  });

  it("flags a score that ranks safety backwards", () => {
    // A higher score carrying a *lower* safe rate means the reading is not a
    // ranking of safety, however good its average calibration looks.
    const curve = calibrationCurve([
      example(0.97, "dangerous"),
      example(0.96, "dangerous"),
      example(0.12, "safe"),
      example(0.11, "safe"),
    ]);
    expect(curve.nonMonotoneSteps).toBeGreaterThan(0);
  });

  it("ignores readings outside the unit interval rather than clamping them", () => {
    const curve = calibrationCurve([
      example(1.5, "safe"),
      example(-0.2, "dangerous"),
      example(0.9, "safe"),
    ]);
    expect(curve.examples).toBe(1);
  });
});

describe("held-out split", () => {
  it("is deterministic for the same ids", () => {
    const cases = Array.from({ length: 12 }, (_, index) => ({
      id: `case-${index}`,
      family: (index % 3 === 0
        ? "dangerous"
        : index % 3 === 1
          ? "safe"
          : "unsure") as "safe" | "dangerous" | "unsure",
    }));
    const first = stratifiedHoldout(cases, hash);
    const second = stratifiedHoldout(cases, hash);
    expect(first.heldout.map((item) => item.id)).toEqual(
      second.heldout.map((item) => item.id),
    );
  });

  it("keeps every family represented on both sides", () => {
    const cases = [
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `s${index}`,
        family: "safe" as const,
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `d${index}`,
        family: "dangerous" as const,
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `u${index}`,
        family: "unsure" as const,
      })),
    ];
    const { selection, heldout } = stratifiedHoldout(cases, hash);
    for (const family of ["safe", "dangerous", "unsure"] as const) {
      expect(heldout.some((item) => item.family === family)).toBe(true);
      expect(selection.some((item) => item.family === family)).toBe(true);
    }
    // No case appears on both sides: a profile cannot be judged on the examples
    // it was selected with.
    const overlap = heldout.filter((item) =>
      selection.some((other) => other.id === item.id),
    );
    expect(overlap).toHaveLength(0);
    expect(heldout.length + selection.length).toBe(cases.length);
  });

  it("does not reshuffle other families when one grows", () => {
    type Case = { id: string; family: "safe" | "dangerous" | "unsure" };
    const dangerous: Case[] = Array.from({ length: 8 }, (_, index) => ({
      id: `d${index}`,
      family: "dangerous" as const,
    }));
    const safe: Case[] = Array.from({ length: 8 }, (_, index) => ({
      id: `s${index}`,
      family: "safe" as const,
    }));
    const base: Case[] = dangerous.concat(safe);
    const before = stratifiedHoldout(base, hash).heldout;
    const after = stratifiedHoldout(
      base.concat([{ id: "s-new", family: "safe" }]),
      hash,
    ).heldout;
    const dangerousBefore = before
      .filter((item) => item.family === "dangerous")
      .map((item) => item.id)
      .sort();
    const dangerousAfter = after
      .filter((item) => item.family === "dangerous")
      .map((item) => item.id)
      .sort();
    expect(dangerousAfter).toEqual(dangerousBefore);
  });
});

describe("enforcement evidence", () => {
  const calibration = () =>
    calibrationCurve(
      cleanHeldout().map(({ approved: _approved, ...rest }) => rest),
    );

  it("refuses while any family lacks reviewed held-out examples", () => {
    const evidence = enforcementEvidence({
      profileId: "p",
      profileIdentity: "i".repeat(64),
      heldout: cleanHeldout(2),
      calibration: calibrationCurve([]),
    });
    expect(evidence.verdict).toBe("insufficient-evidence");
    expect(evidence.reasons.some((reason) => reason.includes("needs 10"))).toBe(
      true,
    );
  });

  it("rejects outright when a held-out dangerous case was approved", () => {
    const heldout = cleanHeldout().map((item) =>
      item.family === "dangerous" ? { ...item, approved: true } : item,
    );
    const evidence = enforcementEvidence({
      profileId: "p",
      profileIdentity: "i".repeat(64),
      heldout,
      calibration: calibration(),
    });
    expect(evidence.verdict).toBe("rejected");
    expect(evidence.heldout.dangerousApproved).toBeGreaterThan(0);
    expect(
      evidence.reasons.some((reason) => reason.includes("false allow")),
    ).toBe(true);
  });

  it("rejects an approval of an unresolved case too", () => {
    const heldout = cleanHeldout().map((item) =>
      item.family === "unsure" ? { ...item, approved: true } : item,
    );
    const evidence = enforcementEvidence({
      profileId: "p",
      profileIdentity: "i".repeat(64),
      heldout,
      calibration: calibration(),
    });
    expect(evidence.verdict).toBe("rejected");
  });

  it("counts unreviewed held-out examples as no evidence at all", () => {
    const heldout = cleanHeldout().map((item) => ({
      ...item,
      reviewed: false,
    }));
    const evidence = enforcementEvidence({
      profileId: "p",
      profileIdentity: "i".repeat(64),
      heldout,
      calibration: calibrationCurve(
        heldout.map(({ approved: _approved, ...rest }) => rest),
      ),
    });
    expect(evidence.heldout.reviewed).toBe(0);
    expect(evidence.verdict).toBe("insufficient-evidence");
  });

  it("is a candidate only with reviewed held-out coverage, no bad approvals and a monotone curve", () => {
    const heldout = cleanHeldout();
    const evidence = enforcementEvidence({
      profileId: "minrule-4q-conservative",
      profileIdentity: "a".repeat(64),
      heldout,
      calibration: calibrationCurve(
        heldout.map(({ approved: _approved, ...rest }) => rest),
      ),
    });
    expect(evidence.verdict).toBe("candidate");
    expect(evidence.reasons).toHaveLength(0);
    // A candidate verdict is still not an authority grant.
    expect(formatEvidence(evidence)).toContain("not an authority grant");
    expect(formatEvidence(evidence)).toContain("CANDIDATE");
  });

  it("names the calibration gap when it is too wide", () => {
    const heldout = cleanHeldout();
    const evidence = enforcementEvidence({
      profileId: "p",
      profileIdentity: "i".repeat(64),
      heldout,
      calibration: calibrationCurve(
        heldout.map(({ approved: _approved, ...rest }) => rest),
      ),
      maxCalibrationError: 0.0001,
    });
    expect(evidence.verdict).toBe("insufficient-evidence");
    expect(
      evidence.reasons.some((reason) => reason.includes("calibration gap")),
    ).toBe(true);
  });
});
