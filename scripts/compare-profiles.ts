#!/usr/bin/env bun
/**
 * Compare decision profiles on the synthetic labelled cases.
 *
 * This is the M2 comparison tool. It exists because the reference projects
 * chose profiles on approval rate alone and shipped profiles that approved
 * dangerous calls: this prints the unsafe approvals first and refuses to call a
 * comparison meaningful when the corpus, profile identity or served model
 * changed between runs.
 *
 * It sends case *text* to the configured endpoint. It never executes a case, and
 * the model's answer is a proposal about text, not a permission. Nothing here
 * changes gate behaviour: profile choice still comes from the operator's config.
 *
 *   bun run scripts/compare-profiles.ts                       # fake endpoint, all profiles
 *   bun run scripts/compare-profiles.ts --live http://host:port
 *   bun run scripts/compare-profiles.ts --live http://host:port --profile minrule-4q-conservative
 *   bun run scripts/compare-profiles.ts --json
 */

import {
  drift,
  evaluateProfile,
  formatComparison,
  type ProfileSummary,
} from "../src/decisions/compare.js";
import { SYNTHETIC_CASES } from "../src/decisions/corpus.js";
import {
  type DecisionProfile,
  getProfile,
  PROFILES,
} from "../src/decisions/profile.js";
import {
  createModelJudge,
  type ModelSettings,
} from "../src/decisions/propose.js";
import {
  choiceResponse,
  noulResponse,
  startEndpoint,
} from "./fixtures/endpoint.js";

interface Args {
  readonly live?: string;
  readonly profileIds: readonly string[];
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const profileIds: string[] = [];
  let live: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--live") live = argv[++index];
    else if (argument === "--profile") profileIds.push(argv[++index] ?? "");
    else if (argument === "--json") json = true;
    else {
      console.error(`unknown argument: ${String(argument)}`);
      process.exit(2);
    }
  }
  return {
    ...(live === undefined ? {} : { live }),
    profileIds: profileIds.length > 0 ? profileIds : PROFILES.map((p) => p.id),
    json,
  };
}

/**
 * A deterministic fake keyed on the command text, so the comparison mechanics
 * (identity pinning, refusal to mix runs, reporting shape) can be exercised with
 * no network. It is not evidence about any model and says so in the output.
 */
function scripted(profile: DecisionProfile, command: string): unknown {
  const dangerous =
    /(rm -rf|reset --hard|push --force|--force|publish|sudo|curl -F|curl -T)/.test(
      command,
    );
  const opaque =
    /(deploy\.sh|while read|docker system prune|curl -s -X POST)/.test(command);
  if (profile.kind === "choice") {
    const probabilities = dangerous
      ? { safe: 0.1, dangerous: 0.85, unsure: 0.05 }
      : opaque
        ? { safe: 0.3, dangerous: 0.2, unsure: 0.5 }
        : { safe: 0.9, dangerous: 0.05, unsure: 0.05 };
    const choice =
      probabilities.dangerous >= probabilities.safe &&
      probabilities.dangerous >= probabilities.unsure
        ? "dangerous"
        : opaque
          ? "unsure"
          : "safe";
    return choiceResponse(choice, probabilities, profile.model);
  }
  return noulResponse(
    dangerous
      ? {
          authorized: 0.4,
          reversible: 0.05,
          blast_radius: 0.2,
          exfiltration:
            dangerous && /curl -F|curl -T/.test(command) ? 0.9 : 0.2,
        }
      : opaque
        ? {
            authorized: 0.5,
            reversible: 0.6,
            blast_radius: 0.6,
            exfiltration: 0.2,
          }
        : {
            authorized: 0.95,
            reversible: 0.95,
            blast_radius: 0.95,
            exfiltration: 0.02,
          },
    profile.model,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const profiles = args.profileIds
    .map((id) => getProfile(id))
    .filter((profile): profile is DecisionProfile => profile !== undefined);
  if (profiles.length === 0) {
    console.error("no known profiles selected; see docs/M2-MODEL.md");
    process.exit(2);
  }

  let endpoint: Awaited<ReturnType<typeof startEndpoint>> | undefined;
  let baseUrl = args.live;
  if (baseUrl === undefined) {
    endpoint = await startEndpoint({ kind: "json", body: {} });
    baseUrl = endpoint.url;
  }

  const summaries: ProfileSummary[] = [];
  const driftReports: (readonly string[])[] = [];
  for (const profile of profiles) {
    const settings: ModelSettings = {
      profile,
      baseUrl,
      timeoutMs: 4000,
      maxPayloadTokens: 1024,
    };
    const judge = createModelJudge({
      // Floors are skipped so these numbers describe the model. The live gate
      // never skips them, which is why a comparison here is evidence about a
      // candidate and never a reason to enable enforcement.
      floors: "measurement",
      settings: () => settings,
      ...(endpoint
        ? {
            transport: async (_url: string, payload: unknown) => {
              const sent = payload as { state: unknown };
              const command =
                typeof sent.state === "string"
                  ? sent.state
                  : String(
                      (sent.state as { value?: { command?: string } }).value
                        ?.command ?? "",
                    );
              return scripted(profile, command);
            },
          }
        : {}),
    });
    const first = await evaluateProfile(judge, SYNTHETIC_CASES, {
      floors: "measurement",
    });
    summaries.push(first);
    // Re-run guard: identical inputs must produce identical verdicts. Anything
    // else means the reading moved under us and no effect size can be claimed.
    const second = await evaluateProfile(judge, SYNTHETIC_CASES, {
      floors: "measurement",
    });
    driftReports.push(drift(first, second));
  }

  if (args.json) {
    console.log(JSON.stringify({ corpus: "synthetic", summaries }, null, 2));
  } else {
    console.log(formatComparison(summaries, "src/decisions/corpus.ts"));
    profiles.forEach((profile, index) => {
      const problems = driftReports[index] ?? [];
      console.log(
        problems.length === 0
          ? `\nre-run of ${profile.id}: no drift, verdicts reproduced`
          : `\nre-run of ${profile.id}: DRIFT — ${problems.length} case(s) changed: ${problems.slice(0, 5).join("; ")}`,
      );
    });
    console.log(
      "\nFloors were skipped for these numbers (the live gate does not skip them), so they describe the model alone.",
    );
    if (endpoint)
      console.log(
        "\nThese numbers came from a scripted fake endpoint. They exercise the comparison only; they say nothing about any real model.",
      );
    else
      console.log(
        `\nMeasured against ${baseUrl}. Labels are draft synthetic judgements, not ground truth: no enforcement decision may rest on these counts.`,
      );
  }

  await endpoint?.close();
}

await main();
