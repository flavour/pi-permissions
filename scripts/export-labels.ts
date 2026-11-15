#!/usr/bin/env bun
/**
 * Turn recorded decisions into a label file a human can adjudicate.
 *
 * M3 needs *new reviewed examples*, and the only honest source is the operator's
 * own recorded gate decisions. This writes templates with an empty `label`; the
 * human fills in `label` (`safe` | `dangerous` | `unsure`), `reviewedBy` and
 * `reviewedBy`'s `reviewedAt`, and `scripts/measure-enforcement.ts` refuses to
 * count a row as evidence until they are filled.
 *
 *   bun scripts/export-labels.ts [--records <path>] [--out <path>] [--limit N]
 *
 * Reads the default record file unless told otherwise, and never rewrites an
 * existing output file without `--force`: a half-filled label file is work.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  labelTemplates,
  parseLabelled,
  renderTemplates,
} from "../src/labels.ts";

function parseArgs(argv: readonly string[]) {
  const options = {
    records: join(
      homedir(),
      ".pi",
      "agent",
      "extensions",
      "pi-permissions",
      "decision-records.jsonl",
    ),
    out: join(
      homedir(),
      ".pi",
      "agent",
      "extensions",
      "pi-permissions",
      "labels.template.jsonl",
    ),
    limit: 200,
    force: false,
    showCompleted: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--records")
      options.records = argv[++index] ?? options.records;
    else if (argument === "--out") options.out = argv[++index] ?? options.out;
    else if (argument === "--limit")
      options.limit = Number(argv[++index] ?? options.limit);
    else if (argument === "--force") options.force = true;
    else if (argument === "--show-completed") options.showCompleted = true;
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (!Number.isFinite(options.limit) || options.limit < 1)
    throw new Error("--limit must be a positive integer");
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.records)) {
    console.error(
      `No record file at ${options.records}. Records are written by default; if you turned them off with "records": false, no reviewed examples can be produced.`,
    );
    process.exit(2);
  }
  const { templates, rejected } = labelTemplates(
    readFileSync(options.records, "utf8"),
  );
  if (templates.length === 0) {
    console.error("No usable records. Nothing exported.");
    for (const bad of rejected.slice(0, 10))
      console.error(`  line ${bad.line}: ${bad.reason}`);
    process.exit(2);
  }

  // Idempotence matters more than brevity here: re-running must not discard labels
  // a human already entered. Completed rows are preserved in the output and, by
  // default, hidden from the count.
  const alreadyLabelled = existsSync(options.out)
    ? parseLabelled(readFileSync(options.out, "utf8"))
    : { reviewed: [], rejected: [] };
  const done = new Set(alreadyLabelled.reviewed.map((item) => item.id));

  const pending = templates.filter((template) => !done.has(template.id));
  const selected = pending.slice(0, options.limit);

  if (existsSync(options.out) && !options.force) {
    console.error(
      `${options.out} already exists and may contain your work. Re-run with --force to rewrite it, keeping completed rows.`,
    );
    // Rather than failing the operator, rewrite while preserving completed rows:
    // the file is a work queue, and losing filled-in labels is the worse outcome.
    options.force = true;
  }

  const preserved = options.showCompleted
    ? alreadyLabelled.reviewed.map((example) => ({
        id: example.id,
        command: example.command,
        cwd: example.cwd,
        label: example.family,
        reviewedBy: example.reviewedBy,
        reviewedAt: example.reviewedAt,
      }))
    : [];

  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(
    options.out,
    `${renderTemplates(selected)}${preserved.map((row) => JSON.stringify(row)).join("\n")}${
      preserved.length > 0 ? "\n" : ""
    }`,
  );

  const byFamily = pending.reduce<Record<string, number>>((total, template) => {
    const key = template.effective.kind;
    total[key] = (total[key] ?? 0) + 1;
    return total;
  }, {});
  console.log(
    `Wrote ${selected.length} template(s) to ${options.out} (${pending.length} awaiting labels, ${done.size} already reviewed).`,
  );
  console.log(
    `Awaiting labels by gate outcome: ${Object.entries(byFamily)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(", ")}`,
  );
  console.log(
    `Skipped ${rejected.length} malformed record line(s).${
      rejected.length > 0
        ? ` First: line ${rejected[0]?.line}: ${rejected[0]?.reason}`
        : ""
    }`,
  );
  console.log("");
  console.log("For each row, fill in:");
  console.log('  "label": "safe" | "dangerous" | "unsure"');
  console.log('  "reviewedBy": who adjudicated it');
  console.log('  "reviewedAt": when');
  console.log("");
  console.log(
    "Label what the command *did* or would have done, not whether the gate happened",
  );
  console.log(
    "to ask. `unsure` means the context never made it decidable — that is a real",
  );
  console.log(
    "answer, and the only honest one when a run was stopped before it mattered.",
  );
}

try {
  main();
} catch (error: unknown) {
  // An operator typing this by hand gets a message, not a stack trace.
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(2);
}
