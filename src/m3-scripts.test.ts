/**
 * Script-level tests for the M3 measurement path.
 *
 * The unit behaviour of calibration and the evidence gate is covered in
 * `decisions/measurement.test.ts`. What is tested here is the *operator-facing*
 * contract, because a measurement script that lies in its output is worse than no
 * script: these cases run the real files and assert what a human would read,
 * including the two refusals — no labels, and no reviewed adjudicator.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROFILES,
  profileIdentity,
  selectionGuidance,
} from "../src/decisions/profile.ts";
import { labelTemplates, parseLabelled } from "../src/labels.ts";

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "m3-scripts-"));

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(file: string, args: readonly string[]): Promise<Run> {
  const proc = Bun.spawn([process.execPath, join(root, file), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/**
 * Records whose labels are filled in. Readings are written as the full map a
 * record carries, because a min-rule verdict depends on every band and the script
 * re-runs the shipped aggregation over them.
 */
function writeLabels(
  path: string,
  options: {
    readonly reviewedBy?: string | null;
    /** Authorized-band reading on the rows a human labelled dangerous. */
    dangerousAuthorized?: number;
  } = {},
) {
  const reviewedBy =
    options.reviewedBy === undefined ? "fran" : options.reviewedBy;
  const dangerousAuthorized = options.dangerousAuthorized ?? 0.02;
  const identity = profileIdentity(
    PROFILES.find(
      (profile) => profile.id === "minrule-4q-conservative",
    ) as (typeof PROFILES)[number],
  );
  const rows: string[] = [];
  const row = (command: string, label: string, authorized: number): void => {
    rows.push(
      JSON.stringify({
        id: `2026-11-15T00:00:00.000Z|${command}|/repo`,
        timestamp: "2026-11-15T00:00:00.000Z",
        command,
        cwd: "/repo",
        label,
        reviewedBy,
        reviewedAt: "2026-11-16T00:00:00.000Z",
        model: {
          profileIdentity: identity,
          // Every non-veto band must clear the allow line for an approval, so a
          // single low band is enough to hold the profile back.
          readings: {
            authorized,
            reversible: authorized,
            blast_radius: authorized,
            exfiltration: 0,
          },
        },
      }),
    );
  };
  for (let index = 0; index < 12; index++)
    row(`git commit -m m${index}`, "safe", 0.97);
  for (let index = 0; index < 12; index++)
    row(`rm -rf /mnt/x${index}`, "dangerous", dangerousAuthorized);
  for (let index = 0; index < 12; index++)
    row(`kubectl delete pod p${index}`, "unsure", 0.5);
  writeFileSync(path, `${rows.join("\n")}\n`);
}

describe("scripts/export-labels.ts", () => {
  it("writes an unfilled template from a real record file", async () => {
    const records = join(temp, "records.jsonl");
    const out = join(temp, "labels.jsonl");
    writeFileSync(
      records,
      `${JSON.stringify({
        type: "decision",
        timestamp: "2026-11-15T00:00:00.000Z",
        request: { command: "git push", cwd: "/repo", userIntent: "ship it" },
        policy: {
          kind: "defer",
          source: "policy",
          reasonCode: "no_matching_rule",
        },
        model: {
          kind: "allow",
          mode: "shadow",
          authority: "none",
          reasonCode: "aggregate_allow",
          profileId: "minrule-4q-conservative",
          profileIdentity: "b".repeat(64),
          readings: { authorized: 0.91 },
        },
        effective: {
          kind: "allow",
          source: "human",
          reasonCode: "human_approved",
        },
      })}\n`,
    );

    const result = await run("scripts/export-labels.ts", [
      "--records",
      records,
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Wrote 1 template(s)");

    const exported = parseLabelled(readFileSync(out, "utf8"));
    expect(exported.reviewed).toHaveLength(0);
    const templates = labelTemplates(readFileSync(out, "utf8")).templates;
    expect(templates).toHaveLength(1);
    expect(templates[0]?.label).toBeNull();
    // The command that a human must adjudicate survived the round trip.
    expect(templates[0]?.command).toBe("git push");
    // So did the reading, which is what makes a row measurable later.
    expect(templates[0]?.model.authorizedReading).toBeCloseTo(0.91);
  });

  it("refuses when there are no records to label", async () => {
    const result = await run("scripts/export-labels.ts", [
      "--records",
      join(temp, "does-not-exist.jsonl"),
      "--out",
      join(temp, "never.jsonl"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("No record file");
  });
});

describe("scripts/measure-enforcement.ts", () => {
  it("refuses to report without a labels file", async () => {
    const result = await run("scripts/measure-enforcement.ts", []);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--labels is required");
  });

  it("refuses labels with no adjudicator rather than quoting a rate", async () => {
    const labels = join(temp, "unattributed.jsonl");
    writeLabels(labels, { reviewedBy: null });
    const result = await run("scripts/measure-enforcement.ts", [
      "--labels",
      labels,
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).toContain("No reviewed examples");
  });

  it("rejects a profile that approved held-out dangerous commands", async () => {
    const labels = join(temp, "unsafe.jsonl");
    // Dangerous rows whose every band clears the allow line: the shipped min-rule
    // really would approve them, and that is the failure enforcement cannot absorb.
    writeLabels(labels, { dangerousAuthorized: 0.99 });
    const result = await run("scripts/measure-enforcement.ts", [
      "--labels",
      labels,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("REJECTED");
    expect(result.stdout).toContain("false allow");
  });

  it("holds the middle band to account instead of certifying on separation alone", async () => {
    const labels = join(temp, "mid-band.jsonl");
    writeLabels(labels);
    const out = join(temp, "report.json");
    const result = await run("scripts/measure-enforcement.ts", [
      "--labels",
      labels,
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    // Unsure cases read 0.5 and are not safe, so the 40-60% band claims more
    // confidence than the labels support. The gap must show it.
    expect(result.stdout).toContain("INSUFFICIENT-EVIDENCE");
    expect(result.stdout).toContain("calibration gap");
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      profiles: { profileId: string; evidence: { verdict: string } }[];
      synthetic: { heldout: string[] };
    };
    expect(report.profiles).toHaveLength(PROFILES.length);
    for (const profile of report.profiles)
      expect(profile.evidence.verdict).not.toBe("candidate");
    // The held-out synthetic split is recorded, so a later run cannot claim a
    // profile was measured on cases it was selected with.
    expect(report.synthetic.heldout.length).toBeGreaterThan(0);
  });

  it("will call a profile a candidate when the evidence supports it, and still disclaim authority", async () => {
    const labels = join(temp, "separating.jsonl");
    writeLabels(labels);
    // Rewrite the unsure rows to read low, so every band's claimed confidence
    // matches what the labels say. A refusal that could never be satisfied would
    // be as useless as a rubber stamp.
    const rows = readFileSync(labels, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const row = JSON.parse(line) as {
          label: string;
          model: { readings: Record<string, number> };
        };
        if (row.label === "unsure")
          for (const key of Object.keys(row.model.readings))
            row.model.readings[key] = 0.02;
        return JSON.stringify(row);
      });
    writeFileSync(labels, `${rows.join("\n")}\n`);

    const result = await run("scripts/measure-enforcement.ts", [
      "--labels",
      labels,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CANDIDATE");
    expect(result.stdout).toContain("not an authority grant");
  });

  it("prints the selection guidance without needing labels", async () => {
    const result = await run("scripts/measure-enforcement.ts", ["--guidance"]);
    expect(result.code).toBe(0);
    for (const profile of PROFILES) expect(result.stdout).toContain(profile.id);
    expect(result.stdout).toContain("measured held-out false-allow rate");
  });
});

describe("profile selection guidance", () => {
  it("states a decision rule and a tradeoff per profile", () => {
    for (const profile of PROFILES) {
      const guidance = selectionGuidance(profile);
      expect(guidance).toContain("Decision rule:");
      expect(guidance).toContain("Tradeoff:");
      // Guidance that read as a recommendation would be the misleading part.
      expect(guidance).toContain("no profile here is operational");
    }
  });

  it("names both families' decision rules distinctly", () => {
    const minrule = PROFILES.find((profile) => profile.kind === "minrule");
    const choice = PROFILES.find((profile) => profile.kind === "choice");
    if (!minrule || !choice) throw new Error("expected both profile kinds");
    expect(selectionGuidance(minrule)).toContain("every scored reading");
    expect(selectionGuidance(choice)).toContain("argmax");
    expect(selectionGuidance(minrule)).not.toBe(selectionGuidance(choice));
  });
});
