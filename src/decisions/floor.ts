/**
 * Deterministic floors that keep clearly unsafe calls out of the model. A floor
 * hit is a `never_allow` decision, never an auto-allow. These are lessons mined
 * from the hub bash analyzer, not its parser.
 */

export interface FloorRule {
  name: string;
  pattern: RegExp;
}

export interface Refusal {
  reason: "never_allow" | "not_wholly_visible";
  rule: string;
}

const NEVER_ALLOW: readonly FloorRule[] = [
  { name: "privilege escalation", pattern: /(^|[\s;&|])sudo\s/i },
  {
    name: "filesystem format or signature wipe",
    pattern: /\b(?:mkfs(?:\.[-z0-9_+-]+)?|wipefs)\b/i,
  },
  {
    name: "block device overwrite",
    pattern: /\bdd\b[^\n;&|]*\bof\s*=["']?\/dev\//i,
  },
  {
    name: "recursive delete of a home or root path",
    pattern:
      /\brm\b[^\n;&|]*(?:-[a-z]*[rf][a-z]*\s+)+(?:["']?(?:\/|~|\$HOME)\/?["']?|\/(?:home|root|etc|usr|var)\b)/i,
  },
  {
    name: "remove git metadata",
    pattern: /\brm\b[^\n;&|]*\s(?:\.git|\.git\/|["']\.git["'])/i,
  },
  {
    name: "discard working tree",
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+[^\n]*-[a-z]*f)/i,
  },
  {
    name: "force push",
    pattern:
      /\bgit\s+push\b[^\n;&|]*(?:--force(?!-with-lease)\b|(?<=\s)-f(?=\s|$))/i,
  },
  {
    name: "credential file read or send",
    pattern: /(?:~|\$HOME)?\/\.ssh\/|\/\.aws\/credentials|id_rsa|id_ed25519/i,
  },
  {
    name: "secret in the command line",
    pattern:
      /(?:--token|--password|--api-key|AWS_SECRET_ACCESS_KEY|GH_TOKEN|OPENAI_API_KEY)\s*[=\s]/i,
  },
  {
    name: "cloud or infrastructure mutation",
    pattern:
      /\b(?:aws|gcloud|az|terraform|kubectl|heroku)\b[^\n;&|]*\b(?:delete|destroy|apply|deploy|terminate|remove|rm|rb|prune|drop)\b/i,
  },
  {
    name: "service or container teardown",
    pattern: /\b(?:docker|podman)\s+(?:system\s+prune|rm\s+-af?)/i,
  },
  {
    name: "package publish",
    pattern: /\b(?:npm|pnpm|yarn|cargo|twine)\s+publish\b/i,
  },
];

const OPAQUE_SHAPES: readonly FloorRule[] = [
  {
    name: "shell -c wrapper",
    pattern: /\b(?:bash|sh|zsh|dash|fish)\s+-[a-z]*c\b/i,
  },
  { name: "eval", pattern: /(^|[\s;&|])eval\b/i },
  {
    name: "interpreter -c",
    pattern: /\b(?:python[23]?|node|perl|ruby|php)\s+-[ec]\b/i,
  },
  { name: "xargs", pattern: /(^|[\s;&|])xargs\b/i },
  { name: "find -exec", pattern: /\bfind\b[^\n;&|]*-exec\b/i },
  { name: "command substitution", pattern: /\$\(|`[^`\n]+`/ },
  {
    name: "piped interpreter",
    pattern: /\|\s*(?:bash|sh|zsh|python[23]?|node)\b/i,
  },
];

export function floorRefusal(command: string): Refusal | undefined {
  for (const rule of NEVER_ALLOW) {
    if (rule.pattern.test(command)) {
      return { reason: "never_allow", rule: rule.name };
    }
  }
  return undefined;
}

export function opaqueRefusal(command: string): Refusal | undefined {
  for (const rule of OPAQUE_SHAPES) {
    if (rule.pattern.test(command)) {
      return { reason: "not_wholly_visible", rule: rule.name };
    }
  }
  return undefined;
}
