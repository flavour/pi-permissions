#!/usr/bin/env bun
/**
 * Decide whether a profile's false-allow rate is *known* well enough to let it
 * block on its own — and say so when it is not.
 *
 *   bun scripts/measure-enforcement.ts --labels <path> [--profiles a,b]
 *                                      [--endpoint-url URL] [--out report.json]
 *                                      [--max-calibration-error 0.1] [--offline]
 *
 * Two inputs, because two measurements are needed and they answer different
 * questions:
 *
 * - **Reviewed labels** (`--labels`, from `scripts/export-labels.ts`) are scored
 *   against each profile's live readings. Only reviewed rows count; an
 *   author-written case cannot tell you what a profile would do to a command you
 *   actually ran.
 * - **Synthetic labelled cases** (`LABELLED_CASES`) measure agreement only, and
 *   they are split deterministically so a profile is never judged on the examples
 *   it was selected with. They can detect a regression; they cannot estimate a
 *   false-allow rate, and the report separates them.
 *
 * The verdict is `insufficient-evidence`, `rejected` or `candidate`. `candidate`
 * means the evidence does not object — it does not grant authority, and turning
 * `"mode": "enforce"` on still requires the operator's explicit acknowledgement.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { aggregate } from "../src/decisions/aggregate.ts";
import { aggregateChoice } from "../src/decisions/choice.ts";
import { type EvalCase, SYNTHETIC_CASES } from "../src/decisions/corpus.ts";
import {
  calibrationCurve,
  enforcementEvidence,
  formatEvidence,
  type ScoredExample,
  stratifiedHoldout,
} from "../src/decisions/measurement.ts";
import {
  type DecisionProfile,
  getProfile,
  PROFILES,
  profileIdentity,
  selectionGuidance,
} from "../src/decisions/profile.ts";
import {
  createModelJudge,
  type ModelSettings,
} from "../src/decisions/propose.ts";
import { MINRULE_QUESTIONS } from "../src/decisions/questions.ts";
import { parseLabelled } from "../src/labels.ts";

interface Arguments {
  labels: string;
  profiles: string[];
  endpointUrl: string;
  out: string;
  maxCalibrationError: number;
  offline: boolean;
  showGuidance: boolean;
}

function parseArguments(argv: readonly string[]): Arguments {
  const options: Arguments = {
    labels: "",
    profiles: [],
    endpointUrl: "http://127.0.0.1:9931",
    out: "",
    maxCalibrationError: 0.1,
    offline: true,
    showGuidance: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--labels") options.labels = argv[++index] ?? "";
    else if (argument === "--profiles")
      options.profiles = (argv[++index] ?? "").split(",").filter(Boolean);
    else if (argument === "--endpoint-url") {
      options.endpointUrl = argv[++index] ?? "";
      options.offline = false;
    } else if (argument === "--out") options.out = argv[++index] ?? "";
    else if (argument === "--max-calibration-error")
      options.maxCalibrationError = Number(argv[++index] ?? "0.1");
    else if (argument === "--offline") options.offline = true;
    else if (argument === "--guidance") options.showGuidance = true;
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.showGuidance) return options;
  if (options.labels === "")
    throw new Error(
      "--labels is required: without reviewed labels there is no false-allow rate to report. Use --guidance to see the profiles instead.",
    );
  if (
    !Number.isFinite(options.maxCalibrationError) ||
    options.maxCalibrationError <= 0
  )
    throw new Error("--max-calibration-error must be a positive number");
  return options;
}

const keyFor = (command: string, cwd: string) => `${command}\u0000${cwd}`;

/**
 * Would this profile have approved, and how confident was it while doing so?
 *
 * `approved` comes from the shipped aggregation, not a re-derived approximation:
 * a min-rule with named vetoes approves on the *minimum* reading, so a threshold
 * comparison against one headline number would silently disagree with the gate the
 * profile actually runs inside — usually by under-counting false allows.
 *
 * `score` is the quantity that rule is sensitive to, which makes the calibration
 * curve mean the same thing for both profile kinds:
 * - min-rule: the minimum non-veto reading, i.e. how far the weakest required
 *   band sits from the allow line.
 * - choice: the probability on the winning label, which is what its band compares.
 * A profile that never spoke yields NaN and is reported as unmeasured.
 */
function approveEstimate(
  profile: DecisionProfile,
  readings: Record<string, number> | null,
): { approved: boolean; score: number } {
  if (readings === null || Object.keys(readings).length === 0)
    return { approved: false, score: Number.NaN };

  if (profile.kind === "choice") {
    const entries = Object.entries(readings);
    const top = entries.reduce(
      (best, entry) => (entry[1] > best[1] ? entry : best),
      ["", Number.NEGATIVE_INFINITY] as [string, number],
    );
    const verdict = aggregateChoice(top[0] as never, readings, {
      allow: profile.thresholds.allow,
      unsafeMax: profile.thresholds.unsafeMax,
      block: profile.thresholds.block,
    });
    return { approved: verdict.kind === "allow", score: top[1] };
  }

  const verdict = aggregate(readings, profile.thresholds);
  const nonVeto = MINRULE_QUESTIONS.filter((question) => !question.veto)
    .map((question) => readings[question.key])
    .filter((value): value is number => typeof value === "number");
  return {
    approved: verdict.kind === "allow",
    score: nonVeto.length > 0 ? Math.min(...nonVeto) : Number.NaN,
  };
}

/**
 * One profile's `authorized`-style reading per command, from a live endpoint.
 *
 * Floors are skipped: a comparison here is evidence about the model, while the
 * live gate never skips them — which is also why a good number below is a
 * candidate status and never an authority grant.
 */
async function liveReadings(
  profile: DecisionProfile,
  endpointUrl: string,
  items: readonly { command: string; cwd: string; userRequest: string }[],
): Promise<Record<string, Record<string, number> | null>> {
  const settings: ModelSettings = {
    profile,
    baseUrl: endpointUrl,
    timeoutMs: 5000,
    maxPayloadTokens: 4096,
  };
  const judge = createModelJudge({
    floors: "measurement",
    settings: () => settings,
  });
  const readings: Record<string, Record<string, number> | null> = {};
  for (const item of items) {
    const proposal = await judge.propose({
      toolName: "bash",
      command: item.command,
      cwd: item.cwd,
      userMessage: item.userRequest,
    });
    // `answered: false` means there was no number at all — a floor, a breaker, a
    // timeout. Storing null keeps that distinguishable from a reading of 0.
    readings[keyFor(item.command, item.cwd)] = proposal.answered
      ? (proposal.readings ?? null)
      : null;
  }
  return readings;
}

function guidance() {
  for (const profile of PROFILES) {
    console.log(`\n### ${profile.id}`);
    console.log(`identity ${profileIdentity(profile).slice(0, 16)}…`);
    console.log(selectionGuidance(profile));
  }
  console.log("");
  console.log(
    "Choosing between them requires measurement, not preference: run",
  );
  console.log("  bun scripts/export-labels.ts   then label the rows");
  console.log("  bun scripts/measure-enforcement.ts --labels <file>");
  console.log(
    "and compare held-out false-allow counts. Any profile without a measured",
  );
  console.log(
    "held-out rate stays a proposal feeding human review; it does not become",
  );
  console.log("a blocker on the strength of its description.");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.showGuidance) {
    guidance();
    return;
  }

  if (!existsSync(args.labels)) {
    console.error(
      `No labels file at ${args.labels}. Produce one with scripts/export-labels.ts, fill in label/reviewedBy/reviewedAt, then re-run.`,
    );
    process.exit(2);
  }
  const parsed = parseLabelled(readFileSync(args.labels, "utf8"));
  if (parsed.reviewed.length === 0) {
    console.error(
      `No reviewed examples in ${args.labels}. Fill in label + reviewedBy on the rows written by scripts/export-labels.ts, or the report has nothing honest to say.`,
    );
    console.error(`Rejected ${parsed.rejected.length} row(s).`);
    process.exit(2);
  }
  console.log(
    `Reviewed examples: ${parsed.reviewed.length} (rejected ${parsed.rejected.length})`,
  );

  const selected =
    args.profiles.length > 0
      ? args.profiles.map((id) => {
          const profile = getProfile(id);
          if (!profile) throw new Error(`Unknown profile: ${id}`);
          return profile;
        })
      : [...PROFILES];

  const report: unknown[] = [];
  for (const profile of selected) {
    // Live readings for the reviewed commands, when an endpoint was supplied.
    // Offline, the labelled rows still measure coverage and approvals; only the
    // calibration gap needs a live endpoint, and it is reported as unavailable.
    let readings: Record<string, Record<string, number> | null>;
    if (!args.offline) {
      readings = await liveReadings(
        profile,
        args.endpointUrl,
        parsed.reviewed.map((example) => ({
          command: example.command,
          cwd: example.cwd,
          userRequest: "",
        })),
      );
    } else {
      // Offline, the only honest readings are the ones already recorded under
      // this profile's identity. Anything else would be inventing a number.
      readings = Object.fromEntries(
        parsed.reviewed
          .filter(
            (example) =>
              example.readings !== null &&
              example.profileIdentity === profileIdentity(profile),
          )
          .map((example) => [
            keyFor(example.command, example.cwd),
            example.readings,
          ]),
      );
    }

    const scored: (ScoredExample & { approved: boolean })[] =
      parsed.reviewed.map((example) => {
        const estimate = approveEstimate(
          profile,
          readings[keyFor(example.command, example.cwd)] ?? null,
        );
        return {
          score: estimate.score,
          family: example.family,
          reviewed: true,
          // "Approved" means this profile's own rule would have let the call run.
          // A profile that never spoke did not approve: the gate reached a human.
          approved: estimate.approved,
        };
      });

    const calibration = calibrationCurve(scored);
    // Say what a verdict is *not* based on. A profile that never answered has no
    // false-allow rate at all, and "insufficient evidence" must not read as
    // "measured and mediocre".
    const withReading = scored.filter((item) =>
      Number.isFinite(item.score),
    ).length;
    console.log(
      withReading === 0
        ? `\nProfile ${profile.id}: no readings available${
            args.offline
              ? " offline (recorded readings carry a different profile identity)"
              : " (the endpoint never answered)"
          } — nothing measured.`
        : ``,
    );
    const evidence = enforcementEvidence({
      profileId: profile.id,
      profileIdentity: profileIdentity(profile),
      heldout: scored,
      calibration,
      maxCalibrationError: args.maxCalibrationError,
    });
    console.log("");
    if (withReading > 0) console.log(formatEvidence(evidence));
    report.push({
      profileId: profile.id,
      profileIdentity: profileIdentity(profile),
      endpoint: args.offline ? "offline-recorded-readings" : args.endpointUrl,
      readingsAvailable: withReading,
      evidence,
    });
  }

  // Synthetic cases, split so selection and measurement never share a case. They
  // are reported apart because they measure agreement with an author's expectation,
  // not behaviour against commands someone ran.
  const synthetic: readonly EvalCase[] = SYNTHETIC_CASES;
  const split = stratifiedHoldout(
    synthetic.map((item) => ({ id: item.id, family: item.family })),
    (value) => createHash("sha256").update(value).digest("hex"),
  );
  console.log("");
  console.log(
    `Synthetic labelled cases: ${synthetic.length} total, ${split.selection.length} used for selection, ${split.heldout.length} held out.`,
  );
  console.log(
    "These cannot estimate a false-allow rate — no human adjudicated them against",
  );
  console.log("what happened — so no verdict above depends on them.");

  if (args.out !== "") {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(
      args.out,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          labelsFile: args.labels,
          reviewedExamples: parsed.reviewed.length,
          synthetic: {
            total: synthetic.length,
            selection: split.selection.map((item) => item.id),
            heldout: split.heldout.map((item) => item.id),
          },
          profiles: report,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\nReport written to ${args.out}`);
  }

  const anyCandidate = report.some(
    (entry) =>
      (entry as { evidence: { verdict: string } }).evidence.verdict ===
      "candidate",
  );
  if (!anyCandidate) {
    console.log(
      "\nNo profile is supported by measured evidence for autonomous blocking.",
    );
    console.log(
      "They may still be configured as shadow or enforce-provisional: in both",
    );
    console.log(
      "modes every allow passes a human, which is the failure mode this guards.",
    );
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(2);
  });
}

export {
  main as measureEnforcementMain,
  parseArguments as parseMeasureArguments,
};
