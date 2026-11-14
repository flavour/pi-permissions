import { isAbsolute } from "node:path";
import type { ExactRule, LoadedConfig } from "./config.js";
import type { Assessment, BashRequest } from "./request.js";

/** Bound analysis work, not exact-rule matching. No command is truncated. */
export const MAX_ANALYZED_COMMAND_LENGTH = 16_384;

function review(
  reasonCode: string,
  explanation: string,
  source: "policy" | "runtime" = "policy",
): Assessment {
  return { kind: "defer", source, reasonCode, explanation };
}

function matches(rule: ExactRule, request: BashRequest): boolean {
  return (
    rule.exact === request.command &&
    (rule.cwd === undefined || rule.cwd === request.cwd)
  );
}

/**
 * Recognize only space-separated ASCII literal words. This is NOT bash parsing:
 * a refusal means we know nothing about executable units within the string.
 * No splitting on operators, quote removal, wrapper peeling or prefix grants.
 */
function literalWords(command: string): readonly string[] | undefined {
  const words: string[] = [];
  let word = "";
  for (const character of command) {
    if (character === " ") {
      if (word !== "") words.push(word);
      word = "";
      continue;
    }
    const code = character.charCodeAt(0);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        "_./-:,@%+".includes(character)
      )
    )
      return undefined;
    word += character;
  }
  if (word !== "") words.push(word);
  return words;
}

/** Pure policy: only explicit blacklists deny; every other refusal needs review. */
export function evaluatePolicy(
  request: BashRequest,
  loaded: LoadedConfig,
): Assessment {
  if (
    typeof request.command !== "string" ||
    typeof request.cwd !== "string" ||
    !isAbsolute(request.cwd) ||
    request.cwd.includes("\0") ||
    request.command.includes("\0")
  ) {
    return review(
      "invalid_request",
      "The command or absolute working-directory snapshot is invalid; review is required.",
      "runtime",
    );
  }
  if (loaded.status === "invalid") {
    return review(
      "invalid_config",
      "Global policy configuration is invalid or unreadable; automatic approval is disabled until it is corrected.",
      "runtime",
    );
  }
  const blacklist = loaded.config.blacklist.find((rule) =>
    matches(rule, request),
  );
  if (blacklist) {
    return {
      kind: "deny",
      source: "policy",
      reasonCode: "blacklist_match",
      ruleId: blacklist.id,
      explanation:
        blacklist.reason ??
        "An explicit global blacklist rule forbids this exact command and working-directory scope.",
    };
  }
  if (
    request.executionContext?.verified !== true ||
    request.executionContext.prefix !== ""
  ) {
    return review(
      "unverified_execution_context",
      "The shell execution context is unverified or has a command prefix; an exact whitelist cannot approve a different effective invocation.",
      "runtime",
    );
  }
  const whitelist = loaded.config.whitelist.find((rule) =>
    matches(rule, request),
  );
  if (whitelist) {
    return {
      kind: "allow",
      source: "policy",
      reasonCode: "whitelist_match",
      ruleId: whitelist.id,
      explanation:
        whitelist.reason ??
        "An explicit global whitelist authorizes this entire exact command and working-directory scope, including everything it invokes.",
    };
  }
  if (request.command.length > MAX_ANALYZED_COMMAND_LENGTH) {
    return review(
      "analysis_budget",
      "The whole command exceeds the bounded recognizer's analysis budget; no prefix was classified or approved.",
    );
  }
  for (const character of request.command) {
    const code = character.charCodeAt(0);
    if (code < 32 || code > 126) {
      return review(
        "unsupported_characters",
        "The call contains multiline, control, or non-ASCII text outside the literal recognizer; review the entire original command.",
      );
    }
  }
  const words = literalWords(request.command);
  if (words === undefined) {
    return review(
      "unsupported_syntax",
      "Quotes, operators, substitutions, assignments, comments or other shell syntax are outside the literal recognizer; no safe-looking fragment authorizes this call.",
    );
  }
  const head = words[0];
  if (head === undefined) {
    return review(
      "empty_command",
      "Empty or space-only input has no built-in grant; review is required rather than assuming shell startup has no effects.",
    );
  }
  // Broad review families, not semantic bans or exhaustive effect analysis.
  // Inspect only already-recognized literal words; do not infer expanded paths.
  if (
    words.some(
      (word) =>
        [".ssh", ".aws", ".gnupg"].some(
          (segment) =>
            word === segment ||
            word.startsWith(`${segment}/`) ||
            word.endsWith(`/${segment}`) ||
            word.includes(`/${segment}/`),
        ) ||
        ["id_rsa", "id_ed25519", ".netrc"].some(
          (name) => word === name || word.endsWith(`/${name}`),
        ) ||
        ["--token", "--password", "--api-key"].includes(word),
    )
  ) {
    return review(
      "credential_review",
      "A literal argument names a credential location or secret-bearing option; a human must review access or disclosure before execution.",
    );
  }
  if (["sudo", "doas", "su"].includes(head)) {
    return review(
      "privilege_review",
      "This invocation may change privileges; a human must authorize the full call.",
    );
  }
  if (
    ["rm", "dd", "wipefs", "mkfs"].includes(head) ||
    head.startsWith("mkfs.")
  ) {
    return review(
      "destructive_review",
      "This command can delete or overwrite data or filesystem metadata; a human must review its targets and effects.",
    );
  }
  if (
    head === "git" &&
    words.some((word) =>
      ["push", "reset", "clean", "rebase", "checkout", "restore"].includes(
        word,
      ),
    )
  ) {
    return review(
      "git_mutation_review",
      "This Git invocation may publish or discard work; a human must review the exact arguments and repository context.",
    );
  }
  if (
    [
      "aws",
      "gcloud",
      "az",
      "terraform",
      "kubectl",
      "pulumi",
      "docker",
      "podman",
      "npm",
      "pnpm",
      "yarn",
      "cargo",
      "twine",
    ].includes(head)
  ) {
    return review(
      "external_effects_review",
      "This tool may run configured code, publish, or mutate infrastructure; executable spelling alone does not establish safe effects.",
    );
  }
  if (
    [
      "bash",
      "sh",
      "dash",
      "zsh",
      "fish",
      "python",
      "python3",
      "node",
      "perl",
      "ruby",
      "eval",
      "exec",
      "env",
      "command",
      "builtin",
      "xargs",
      "source",
      ".",
    ].includes(head)
  ) {
    return review(
      "indirection_review",
      "This wrapper or interpreter may execute other code or change command resolution; the recognizer does not inspect its payload.",
    );
  }
  return review(
    "no_automatic_grant",
    "No exact whitelist matches. Bare executable names, paths, flags and even colon/true/false do not prove safety in a mutable shell environment; review is required.",
  );
}
