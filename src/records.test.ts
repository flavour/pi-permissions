import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord } from "./handler.js";
import { writeRecord } from "./records.js";
import { snapshot } from "./request.js";

let agentDir: string;
let directory: string;
let current: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "permissions-records-"));
  directory = join(agentDir, "pi-permissions-records");
  current = join(directory, "decisions.jsonl");
});
afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

function record(
  command = "synthetic text only",
  requestId = "one",
): DecisionRecord {
  return {
    type: "decision",
    timestamp: "2026-01-01T00:00:00.000Z",
    request: snapshot({
      requestId,
      sessionId: "session",
      turnId: "turn",
      toolCallId: requestId,
      command,
      cwd: "/work",
      userIntent: "raw intent",
      executionContext: { prefix: "", verified: true },
    }),
    policy: {
      kind: "defer",
      source: "policy",
      reasonCode: "no_automatic_grant",
      explanation: "Needs human review.",
    },
    effective: {
      kind: "allow",
      source: "human",
      reasonCode: "human_approved",
      explanation: "Human approved once.",
    },
    configRevision: "missing:synthetic",
    execution: "not_observed",
  };
}

describe("private bounded local decision records", () => {
  it("stores complete raw decision facts as JSONL without claiming execution", () => {
    const first = record("synthetic\n\u001bsecret", "first");
    const second = record("another", "second");
    writeRecord(agentDir, first);
    writeRecord(agentDir, second);
    const lines = readFileSync(current, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual(first);
    expect(JSON.parse(lines[1] ?? "")).toEqual(second);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(current).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing regular file to owner-only access", () => {
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(current, "", { mode: 0o644 });
    chmodSync(current, 0o644);
    writeRecord(agentDir, record());
    expect(statSync(current).mode & 0o777).toBe(0o600);
  });

  it("refuses an exposed directory without writing raw data", () => {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o755);
    expect(() => writeRecord(agentDir, record())).toThrow("private");
    expect(existsSync(current)).toBe(false);
  });

  it("refuses symlink directories and symlink current files", () => {
    const elsewhere = join(agentDir, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, directory);
    expect(() => writeRecord(agentDir, record())).toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(directory);
    mkdirSync(directory, { mode: 0o700 });
    const target = join(elsewhere, "target");
    writeFileSync(target, "untouched");
    symlinkSync(target, current);
    expect(() => writeRecord(agentDir, record())).toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("rejects a record larger than the byte limit, without truncating it", () => {
    expect(() => writeRecord(agentDir, record("é".repeat(524_288)))).toThrow(
      "limit",
    );
    expect(existsSync(current)).toBe(false);
  });

  it("rotates whole records into only two bounded owner-only files", () => {
    const large = "x".repeat(600_000);
    writeRecord(agentDir, record(large, "one"));
    writeRecord(agentDir, record(large, "two"));
    writeRecord(agentDir, record(large, "three"));
    expect(readdirSync(directory).sort()).toEqual([
      "decisions.jsonl",
      "decisions.previous.jsonl",
    ]);
    const previous = join(directory, "decisions.previous.jsonl");
    expect(JSON.parse(readFileSync(current, "utf8"))).toEqual(
      record(large, "three"),
    );
    expect(JSON.parse(readFileSync(previous, "utf8"))).toEqual(
      record(large, "two"),
    );
    for (const file of [current, previous]) {
      expect(statSync(file).size).toBeLessThanOrEqual(1_048_576);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
