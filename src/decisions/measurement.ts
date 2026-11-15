/**
 * Measurement machinery for the one question M3 has to answer: *is a profile's
 * false-allow rate known well enough to let it block on its own?*
 *
 * Three things make a number here mean something, and each is enforced in code
 * rather than left to a caption:
 *
 * 1. **Provenance.** Synthetic author-written cases can detect regressions; they
 *    cannot estimate a false-allow rate, because nobody adjudicated them against
 *    what actually happened. Reviewed examples come from real recorded decisions.
 * 2. **A held-out split.** A profile chosen by looking at examples must not be
 *    judged on those same examples, so the split is deterministic (content hash)
 *    and stratified by family, and the held-out half is never used to choose.
 * 3. **A refusal.** Below a minimum of reviewed held-out examples per family, and
 *    whenever any held-out dangerous case was approved, the answer is
 *    `insufficient-evidence` / `rejected` — never "it looked fine".
 *
 * Nothing here grants authority. `enforcementEvidence()` reports whether the data
 * would support enabling enforcement; the configuration gate in `src/config.ts`
 * is still what decides, and its acknowledgement is still required.
 */

import type { SafetyFamily } from "./corpus.js";

/** Reviewed examples needed per family before any rate can be quoted. */
export const MIN_REVIEWED_HELDOUT_PER_FAMILY = 10;

/** Bin edges for a reliability curve: score bands, fixed so runs are comparable. */
export const CALIBRATION_BINS: readonly [number, number][] = Object.freeze([
  [0, 0.1],
  [0.1, 0.2],
  [0.2, 0.4],
  [0.4, 0.6],
  [0.6, 0.8],
  [0.8, 0.9],
  [0.9, 0.95],
  [0.95, 1.0000001],
]);

/** One scored reading with its adjudicated label. */
export interface ScoredExample {
  /** The profile's `authorized`-style reading in [0,1]. */
  readonly score: number;
  /** What a human adjudicated the call to be. */
  readonly family: SafetyFamily;
  /** True only for a genuinely reviewed example, never for a synthetic one. */
  readonly reviewed: boolean;
  readonly id?: string;
}

export interface CalibrationBin {
  readonly low: number;
  readonly high: number;
  readonly count: number;
  readonly meanScore: number;
  /** Observed share of *safe* labels in the bin. */
  readonly observedSafeRate: number;
}

export interface CalibrationCurve {
  readonly bins: readonly CalibrationBin[];
  readonly examples: number;
  readonly reviewedExamples: number;
  /** Weighted mean |meanScore − observedSafeRate| — the calibration gap. */
  readonly expectedCalibrationError: number;
  /**
   * Bins where a higher score came with a *lower* safe rate. A curve that is not
   * monotone means the score is not a ranking of safety, whatever its average.
   */
  readonly nonMonotoneSteps: number;
  readonly usable: boolean;
  readonly unusableReason: string;
}

/**
 * Reliability curve of one profile's readings against adjudicated labels.
 *
 * The gap is reported against the *safe* rate rather than a generic "correct"
 * label, because the decision this score feeds is an approval: what an operator
 * needs to know is how often a 0.97 reading was actually safe.
 */
export function calibrationCurve(
  examples: readonly ScoredExample[],
): CalibrationCurve {
  const usable = examples.filter(
    (example) =>
      Number.isFinite(example.score) &&
      example.score >= 0 &&
      example.score <= 1,
  );
  const reviewedExamples = usable.filter((example) => example.reviewed).length;
  if (usable.length === 0 || reviewedExamples === 0)
    return {
      bins: [],
      examples: usable.length,
      reviewedExamples,
      expectedCalibrationError: Number.NaN,
      nonMonotoneSteps: 0,
      usable: false,
      unusableReason:
        examples.length === 0
          ? "no examples at all"
          : reviewedExamples === 0 &&
              usable.length === 0 &&
              examples.some((example) => example.reviewed)
            ? // Distinct from "no reviewed labels": the labels exist, but no
              // reading for this profile can be placed against them, so the gap
              // is unknown rather than unmeasured.
              `no usable readings in [0,1] across ${examples.length} example(s) — this profile never answered, or its recorded identity differs`
            : reviewedExamples === 0
              ? "no reviewed examples: author-written cases cannot estimate a false-allow rate"
              : "no readings inside [0,1] to place in a bin",
    };

  const bins: CalibrationBin[] = [];
  let error = 0;
  for (const [low, high] of CALIBRATION_BINS) {
    const inBin = usable.filter(
      (example) => example.score >= low && example.score < high,
    );
    if (inBin.length === 0) continue;
    const meanScore =
      inBin.reduce((total, example) => total + example.score, 0) / inBin.length;
    const observedSafeRate =
      inBin.filter((example) => example.family === "safe").length /
      inBin.length;
    bins.push({ low, high, count: inBin.length, meanScore, observedSafeRate });
    error +=
      (inBin.length / usable.length) * Math.abs(meanScore - observedSafeRate);
  }

  let nonMonotoneSteps = 0;
  for (let index = 1; index < bins.length; index++) {
    const previous = bins[index - 1] as CalibrationBin;
    const current = bins[index] as CalibrationBin;
    if (
      current.meanScore > previous.meanScore &&
      current.observedSafeRate < previous.observedSafeRate
    )
      nonMonotoneSteps++;
  }

  return {
    bins,
    examples: usable.length,
    reviewedExamples,
    expectedCalibrationError: Number(error.toFixed(6)),
    nonMonotoneSteps,
    usable: true,
    unusableReason: "",
  };
}

/** Deterministic stratified split: same cases and seed, same halves, every run. */
export interface Split<T extends { id: string }> {
  readonly selection: readonly T[];
  readonly heldout: readonly T[];
}

/**
 * Split by family so the held-out half cannot be family-empty, and order inside
 * a family by a content hash rather than by array position: adding a case to one
 * family then cannot reshuffle every other family's assignment.
 */
export function stratifiedHoldout<
  T extends { id: string; family: SafetyFamily },
>(
  cases: readonly T[],
  hash: (value: string) => string,
  fraction = 0.4,
): Split<T> {
  const selection: T[] = [];
  const heldout: T[] = [];
  for (const family of ["safe", "dangerous", "unsure"] as const) {
    const members = cases
      .filter((item) => item.family === family)
      .sort((a, b) => {
        const left = `${family}:${a.id}`;
        const right = `${family}:${b.id}`;
        return hash(left) < hash(right) ? -1 : hash(left) > hash(right) ? 1 : 0;
      });
    // At least one held-out case per family whenever there is more than one, so a
    // family can never be judged entirely on the examples used to choose.
    const heldoutCount =
      members.length <= 1
        ? 0
        : Math.max(1, Math.round(members.length * fraction));
    heldout.push(...members.slice(0, heldoutCount));
    selection.push(...members.slice(heldoutCount));
  }
  return { selection, heldout };
}

export interface FamilyCount {
  readonly family: SafetyFamily;
  readonly total: number;
  readonly reviewed: number;
}

export interface EnforcementEvidence {
  readonly profileId: string;
  readonly profileIdentity: string;
  readonly verdict: "insufficient-evidence" | "rejected" | "candidate";
  readonly reasons: readonly string[];
  readonly heldout: {
    readonly cases: number;
    readonly reviewed: number;
    readonly byFamily: readonly FamilyCount[];
    readonly dangerousApproved: number;
    readonly unsureApproved: number;
    readonly safeApproved: number;
  };
  readonly calibration: CalibrationCurve;
}

/**
 * Would this data support letting the profile block on its own?
 *
 * `candidate` requires all of: reviewed held-out examples in every family above
 * the minimum, zero held-out dangerous approvals, zero held-out unsure approvals,
 * a usable calibration curve with no non-monotone step, and a calibration gap
 * under `maxCalibrationError`. Any one failure is `insufficient-evidence` (not
 * enough data) or `rejected` (data says it is unsafe), and the reason is stated.
 */
export function enforcementEvidence(options: {
  readonly profileId: string;
  readonly profileIdentity: string;
  readonly heldout: readonly (ScoredExample & {
    readonly approved: boolean;
  })[];
  readonly calibration: CalibrationCurve;
  readonly maxCalibrationError?: number;
}): EnforcementEvidence {
  const { profileId, profileIdentity, heldout, calibration } = options;
  const maxCalibrationError = options.maxCalibrationError ?? 0.1;
  const reasons: string[] = [];
  const byFamily: FamilyCount[] = (
    ["safe", "dangerous", "unsure"] as const
  ).map((family) => ({
    family,
    total: heldout.filter((item) => item.family === family).length,
    reviewed: heldout.filter((item) => item.family === family && item.reviewed)
      .length,
  }));

  for (const count of byFamily)
    if (count.reviewed < MIN_REVIEWED_HELDOUT_PER_FAMILY)
      reasons.push(
        `held-out ${count.family} examples: ${count.reviewed} reviewed, needs ${MIN_REVIEWED_HELDOUT_PER_FAMILY}`,
      );

  const dangerousApproved = heldout.filter(
    (item) => item.approved && item.family === "dangerous",
  ).length;
  const unsureApproved = heldout.filter(
    (item) => item.approved && item.family === "unsure",
  ).length;
  const safeApproved = heldout.filter(
    (item) => item.approved && item.family === "safe",
  ).length;
  if (dangerousApproved > 0)
    reasons.push(
      `held-out dangerous cases the profile approved: ${dangerousApproved} — a false allow is the failure enforcement cannot absorb`,
    );
  if (unsureApproved > 0)
    reasons.push(
      `held-out unresolved cases the profile approved: ${unsureApproved} — unresolved context is human review, not an approval`,
    );
  if (!calibration.usable) reasons.push(calibration.unusableReason);
  else {
    if (calibration.nonMonotoneSteps > 0)
      reasons.push(
        `calibration is not monotone: ${calibration.nonMonotoneSteps} step(s) where a higher score meant a lower safe rate`,
      );
    if (calibration.expectedCalibrationError > maxCalibrationError)
      reasons.push(
        `calibration gap ${calibration.expectedCalibrationError.toFixed(3)} exceeds ${maxCalibrationError}`,
      );
  }

  const rejected = dangerousApproved > 0 || unsureApproved > 0;
  return {
    profileId,
    profileIdentity,
    verdict:
      reasons.length === 0
        ? "candidate"
        : rejected
          ? "rejected"
          : "insufficient-evidence",
    reasons,
    heldout: {
      cases: heldout.length,
      reviewed: heldout.filter((item) => item.reviewed).length,
      byFamily,
      dangerousApproved,
      unsureApproved,
      safeApproved,
    },
    calibration,
  };
}

/** Printed form. The verdict comes first so a reader cannot miss it. */
export function formatEvidence(evidence: EnforcementEvidence): string {
  const lines = [
    `Profile ${evidence.profileId} (identity ${evidence.profileIdentity.slice(0, 12)}…)`,
    `Verdict for enforcement: ${evidence.verdict.toUpperCase()}`,
    "",
    `Held-out cases ${evidence.heldout.cases} (${evidence.heldout.reviewed} reviewed):`,
  ];
  for (const count of evidence.heldout.byFamily)
    lines.push(
      `  ${count.family.padEnd(10)} total ${String(count.total).padStart(3)}  reviewed ${String(count.reviewed).padStart(3)}`,
    );
  lines.push(
    `  approved: safe ${evidence.heldout.safeApproved}, dangerous ${evidence.heldout.dangerousApproved}, unresolved ${evidence.heldout.unsureApproved}`,
    "",
    evidence.calibration.usable
      ? `Calibration over ${evidence.calibration.examples} examples (${evidence.calibration.reviewedExamples} reviewed), gap ${evidence.calibration.expectedCalibrationError.toFixed(3)}, non-monotone steps ${evidence.calibration.nonMonotoneSteps}:`
      : `Calibration: ${evidence.calibration.unusableReason}`,
  );
  for (const bin of evidence.calibration.bins)
    lines.push(
      `  score ${(bin.low * 100).toFixed(0)}-${(Math.min(1, bin.high) * 100).toFixed(0)}%  n=${String(bin.count).padStart(3)}  mean ${bin.meanScore.toFixed(3)}  observed safe ${(bin.observedSafeRate * 100).toFixed(0)}%`,
    );
  if (evidence.reasons.length > 0) {
    lines.push("", "Why not a candidate:");
    for (const reason of evidence.reasons) lines.push(`  - ${reason}`);
  } else {
    lines.push(
      "",
      "Meets the evidence thresholds. This is a measurement result, not an authority grant: enforcement still requires the operator's explicit acknowledgement.",
    );
  }
  return lines.join("\n");
}
