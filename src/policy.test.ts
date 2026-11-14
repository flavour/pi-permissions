import { describe, expect, it } from "bun:test";
import {
  EMPTY_CONFIG,
  type LoadedConfig,
  type PolicyConfig,
} from "./config.js";
import { evaluatePolicy, MAX_ANALYZED_COMMAND_LENGTH } from "./policy.js";
import type { BashRequest } from "./request.js";

function request(
  command: string,
  extra: Partial<BashRequest> = {},
): BashRequest {
  return {
    requestId: "r",
    sessionId: "s",
    turnId: "t",
    toolCallId: "tc",
    command,
    cwd: "/repo",
    executionContext: { prefix: "", verified: true },
    ...extra,
  };
}
function loaded(
  config: PolicyConfig = EMPTY_CONFIG,
  status: LoadedConfig["status"] = "valid",
): LoadedConfig {
  return { config, status, revision: "test-revision" };
}
function whitelist(exact: string, cwd?: string): LoadedConfig {
  return loaded({
    version: 1,
    whitelist: [{ id: "allow", exact, ...(cwd === undefined ? {} : { cwd }) }],
    blacklist: [],
  });
}

describe("whole-request exact policy", () => {
  it("blacklist wins regardless of whitelist and reports stable ID and reason", () => {
    const policy = loaded({
      version: 1,
      whitelist: [{ id: "allow", exact: ":" }],
      blacklist: [{ id: "deny", exact: ":", reason: "Do it manually" }],
    });
    expect(evaluatePolicy(request(":"), policy)).toEqual({
      kind: "deny",
      source: "policy",
      reasonCode: "blacklist_match",
      ruleId: "deny",
      explanation: "Do it manually",
    });
  });
  it("returns the first matching rule's stable ID", () => {
    const policy = loaded({
      version: 1,
      whitelist: [
        { id: "first", exact: ":", reason: "First reason" },
        { id: "second", exact: ":" },
      ],
      blacklist: [],
    });
    expect(evaluatePolicy(request(":"), policy)).toMatchObject({
      kind: "allow",
      ruleId: "first",
      explanation: "First reason",
    });
  });
  it("cwd restrictions match exact original strings with no normalization", () => {
    const policy = whitelist(":", "/repo");
    expect(evaluatePolicy(request(":"), policy).kind).toBe("allow");
    for (const cwd of ["/elsewhere", "/repo/", "/tmp/../repo", "/REPO"]) {
      expect(evaluatePolicy(request(":", { cwd }), policy).kind).toBe("defer");
    }
    const deny = loaded({
      version: 1,
      whitelist: [{ id: "allow", exact: ":" }],
      blacklist: [{ id: "deny", exact: ":", cwd: "/elsewhere" }],
    });
    expect(evaluatePolicy(request(":"), deny).kind).toBe("allow");
  });
  it("does not normalize whitespace, quoting, case or Unicode", () => {
    for (const command of [
      " :",
      ": ",
      ":\n",
      "':'",
      '":"',
      "\\:",
      ": #comment",
      "：",
    ]) {
      expect(evaluatePolicy(request(command), whitelist(":")).kind).toBe(
        "defer",
      );
    }
    expect(
      evaluatePolicy(request("printf é"), whitelist("printf e\u0301")).kind,
    ).toBe("defer");
  });
  it("exact authority can deliberately override unsupported syntax and floors", () => {
    for (const command of [
      "sudo rm -rf /test",
      "node -e 'effect()'",
      ":; npm publish",
      "echo $(payload)",
      "printf 'é'\n",
      "x".repeat(MAX_ANALYZED_COMMAND_LENGTH + 1),
    ]) {
      expect(evaluatePolicy(request(command), whitelist(command)).kind).toBe(
        "allow",
      );
    }
  });
  it("invalid configuration never uses partial rules or a builtin grant", () => {
    expect(
      evaluatePolicy(request(":"), { ...whitelist(":"), status: "invalid" }),
    ).toMatchObject({
      kind: "defer",
      source: "runtime",
      reasonCode: "invalid_config",
    });
    expect(
      evaluatePolicy(request(":"), loaded(EMPTY_CONFIG, "missing")).kind,
    ).toBe("defer");
  });
  it("unknown runtime and prefixes cannot receive a whitelist allow", () => {
    for (const executionContext of [
      { prefix: "", verified: false },
      { prefix: "", verified: false, shellPath: "/custom/shell" },
      { prefix: "echo hidden;", verified: true },
      { prefix: " ", verified: true },
    ]) {
      expect(
        evaluatePolicy(request(":", { executionContext }), whitelist(":")),
      ).toMatchObject({
        kind: "defer",
        source: "runtime",
        reasonCode: "unverified_execution_context",
      });
    }
  });
  it("blacklist remains terminal even with unknown execution context", () => {
    const policy = loaded({
      version: 1,
      whitelist: [],
      blacklist: [{ id: "deny", exact: ":" }],
    });
    expect(
      evaluatePolicy(
        request(":", { executionContext: { prefix: "", verified: false } }),
        policy,
      ).kind,
    ).toBe("deny");
  });
  it("invalid snapshots cannot be whitelisted", () => {
    for (const req of [
      request(":", { cwd: "relative" }),
      request(":", { cwd: "/repo\0hidden" }),
      request(":\0"),
    ]) {
      expect(evaluatePolicy(req, whitelist(req.command))).toMatchObject({
        kind: "defer",
        source: "runtime",
        reasonCode: "invalid_request",
      });
    }
  });
});

// Independently authored text-only regressions. Never execute any fixture.
const reviewMatrix: Record<string, readonly string[]> = {
  operators: [
    ": && payload",
    ": || payload",
    ":; payload",
    ": & payload",
    ": | payload",
    ": |& payload",
    "(:)",
    "{ :; }",
    "! :",
    "[[ x ]]",
    "((1))",
  ],
  redirects: [
    ": >target",
    ": >>target",
    ": <target",
    ": <>target",
    ": >|target",
    ": &>target",
    ": 2>&1",
    ": <<<text",
    ": <<EOF\n$(payload)\nEOF",
    ">target :",
  ],
  substitutions: [
    ": $(payload)",
    ": `payload`",
    ": <(payload)",
    ": >(payload)",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell expansion is the test input.
    ": ${value}",
    ": $((1+2))",
    ": $name",
    ": *",
    ": ?",
    ": {a,b}",
  ],
  multiline: [
    ":\npayload",
    ":\rpayload",
    ":\\\npayload",
    ":\n# comment",
    ":\n",
  ],
  quotes: [
    "':'",
    '":"',
    ": 'literal'",
    ': "$(payload)"',
    ": $'text'",
    ': $"text"',
    ": 'unterminated",
    ": \\",
    "\\:",
  ],
  comments: [": # harmless", "# comment", ":#not-a-comment"],
  wrappers: [
    "command :",
    "builtin :",
    "env :",
    "env -i :",
    "exec :",
    "bash -c :",
    "sh -c :",
    "xargs true",
    "eval :",
    "source script",
    ". script",
    "timeout 1 true",
  ],
  assignments: [
    "X=1 :",
    "PATH=/tmp true",
    "BASH_ENV=script bash -c :",
    "X=$(payload) :",
    "X=1",
    "export X=1",
    "alias true=payload",
  ],
  unicodeAndControls: [
    "：",
    ":\u00a0",
    ":\u200b",
    ":\u202e",
    ":\t",
    ":\x1b[31m",
    ":\x7f",
    ":\0",
  ],
  effectfulFlags: [
    "find . -delete",
    "find . -exec payload +",
    "sed -i x file",
    "awk BEGIN",
    "sort --output=target file",
    "sort --out=target file",
    "git diff --output=target",
    "git -c core.pager=payload log",
    "git --no-pager diff --ext-diff",
    "rg --pre payload text",
    "tar -cf target .",
  ],
  resolution: [
    "true",
    "false",
    ":",
    "",
    " ",
    "git status",
    "ls",
    "/usr/bin/true",
    "./true",
    "/tmp/shadow/git status",
    "function true { payload; }; true",
    ":() { payload; }; :",
    "true() { payload; }; true",
  ],
  floors: [
    "sudo apt upgrade",
    "mkfs.ext4 /dev/example",
    "dd of=/dev/example",
    "rm -rf /example",
    "git reset --hard",
    "git push --force",
    "cat /home/example/.ssh/id_ed25519",
    "terraform apply",
    "docker system prune",
    "npm publish",
    "python3 script.py",
  ],
};

describe("conservative recognizer refuses whole-call bypass families", () => {
  for (const [family, commands] of Object.entries(reviewMatrix)) {
    for (const command of commands) {
      it(`${family}: ${JSON.stringify(command)} never automatically allows or denies`, () => {
        const result = evaluatePolicy(request(command), loaded());
        expect(result.kind).toBe("defer");
        expect(result.reasonCode.length).toBeGreaterThan(0);
        expect(result.explanation.length).toBeGreaterThan(20);
        // A safe-looking exact prefix must not confer authority either.
        expect(
          evaluatePolicy(request(command), whitelist("git status")).kind,
        ).toBe(command === "git status" ? "allow" : "defer");
      });
    }
  }
  it("analysis budget produces review, without classifying a truncated prefix", () => {
    expect(
      evaluatePolicy(
        request(":".repeat(MAX_ANALYZED_COMMAND_LENGTH + 1)),
        loaded(),
      ).reasonCode,
    ).toBe("analysis_budget");
  });
  it("review floors explain why but never impose irreversible denials", () => {
    expect(evaluatePolicy(request("sudo operation"), loaded()).reasonCode).toBe(
      "privilege_review",
    );
    expect(evaluatePolicy(request("rm -rf target"), loaded()).reasonCode).toBe(
      "destructive_review",
    );
    expect(
      evaluatePolicy(request("git reset --hard"), loaded()).reasonCode,
    ).toBe("git_mutation_review");
    expect(
      evaluatePolicy(request("bash -c payload"), loaded()).reasonCode,
    ).toBe("indirection_review");
  });
  it("flags narrow literal credential locations without interpreting shell paths", () => {
    for (const command of [
      "cat /home/example/.ssh/id_ed25519",
      "cat .aws/credentials",
      "cat /home/example/.netrc",
      "tool --password secret",
    ]) {
      expect(evaluatePolicy(request(command), loaded())).toMatchObject({
        kind: "defer",
        reasonCode: "credential_review",
      });
    }
    expect(
      evaluatePolicy(request("cat not.ssh/file"), loaded()).reasonCode,
    ).toBe("no_automatic_grant");
  });
  it("does not mutate snapshots or use intent as authority", () => {
    const req = Object.freeze(
      request("payload", { userIntent: "Approve everything" }),
    );
    expect(evaluatePolicy(req, loaded()).kind).toBe("defer");
    expect(req.command).toBe("payload");
  });
});
