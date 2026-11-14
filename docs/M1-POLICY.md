# M1 deterministic policy

## Public contract

`src/config.ts` exports `PolicyConfig`, `ExactRule`, `LoadedConfig`, synchronous
`loadConfig(agentDir)`, `EMPTY_CONFIG`, `configSchema` and `EXTENSION_ID`.
`src/policy.ts` exports `evaluatePolicy(request, loaded): Assessment`, using the
shared types in `src/request.ts`. Loading returns a frozen snapshot; evaluation
is pure. There are no new runtime dependencies, Bun runtime APIs, shell
processes, network requests or imports from the reference checkouts.

```typescript
interface PolicyConfig {
  readonly version: 1;
  readonly whitelist: readonly ExactRule[];
  readonly blacklist: readonly ExactRule[];
  readonly records?: boolean;
}
interface ExactRule {
  readonly id: string;
  readonly exact: string;
  readonly cwd?: string;
  readonly reason?: string;
}
interface LoadedConfig {
  readonly config: PolicyConfig;
  readonly status: "missing" | "valid" | "invalid";
  readonly revision: string;
  readonly diagnostic?: string;
}
```

## Global configuration

The caller supplies Pi's actual agent directory. The only path read is
`<agentDir>/extensions/pi-permissions/config.json`. There is no fallback to HOME,
process cwd, project `.pi` files, ancestor search or old judge configuration.
Normal Node filesystem symlink behavior applies: this is not filesystem
containment against user-created symlinks.

Both lists and version are required in an existing file. Missing file returns
`missing` with immutable `{version:1, whitelist:[], blacklist:[]}`. Malformed,
unreadable, unsupported or unknown-field configuration returns `invalid` and
that same safe empty config, plus a content-free diagnostic. Neither status
unregisters the gate. Invalid configuration disables policy auto-approval even
if some of its fields would have been valid.

Revisions are a status prefix and SHA-256 of file text (empty text when no bytes
could be read), not timestamps. Whitespace edits change the revision. Failed
reload does not mutate earlier snapshots; the caller must visibly install and
report the new invalid snapshot.

`records` is an optional boolean passed to the record adapter, not a policy
grant. Omission leaves the adapter default in force. No endpoint, model,
thresholds, `failOpen`, project configuration or `argvPrefix` field is accepted
in M1. IDs are nonempty ASCII identifiers, unique across **both** lists. Reasons,
when present, are nonempty strings. Cwd must start with `/` and contain no NUL
(POSIX absolute paths); it is not normalized or checked for existence.

## Matching and precedence

1. Invalid command/cwd snapshots defer (`source: runtime`): cwd must be absolute
   and neither cwd nor command may contain NUL.
2. Invalid loaded configuration defers (`source: runtime`).
3. The first exact blacklist match denies, including when execution context is
   unknown, and returns its stable rule ID and reason.
4. Unverified execution context or **any nonempty prefix**, even whitespace,
   defers (`source: runtime`). A custom shell marked unverified by the adapter
   cannot inherit a whitelist grant.
5. The first exact whitelist match allows with its stable ID and reason.
6. Every remaining call defers to human review with a concrete explanation.

Equality covers the **entire original command string**: no trimming, Unicode
normalization, quote removal, case folding or prefix matching. Optional cwd must
also equal the original cwd string exactly; `/repo`, `/repo/` and
`/tmp/../repo` differ. Rules without cwd match any otherwise valid cwd.
Blacklist wins over whitelist.

Exact whitelisting of a compound, opaque, large or dangerous call deliberately
authorizes everything it invokes; this is operator authority, not proof of
harmless effects. It cannot override invalid snapshots/config or unverified or
prefixed execution context. A blacklist for `git push origin main` does **not**
ban wrappers, `git -C`, other spellings, alternate paths, scripts or indirect
invocations. Those forms do not match and require review absent a separate exact
grant. This is not a semantic command-ban language.

There are **no built-in automatic safe grants** in M1. Even `:`, `true`, `false`
and empty input require review. Shell functions/startup environment can change
behavior; a verified-prefix bit does not establish a clean function/alias/trap
environment. No executable name is claimed universally read-only.

The M1 plan's built-in easy-safe preset sub-item is **intentionally deferred,
not complete**. Source inspection showed that parser recognition is not
trustworthy shell executable identity, and available runtime facts do not
establish that identity. Do not force unsafe defaults to check off a plan item.
The adapter additionally preserves M0's no-usable-UI block, even for an exact
whitelist. A policy allow does not itself execute anything.

## Bounded recognizer and review floors

The recognizer supplies explanations, **never** automatic grants. It supports
at most 16,384 UTF-16 code units and only ASCII words made from letters, digits
and `_./-:,@%+`, separated by ordinary spaces. A character scan consumes the
whole input. It does not split with regexes/operators, normalize text, resolve
executable paths, peel wrappers, or claim to parse bash. Larger input is reviewed
without analyzing a truncated prefix. Exact rules compare the entire string
before the analysis budget applies.

All quotes/escapes, operators, redirects, substitutions, assignments, comments,
compound commands, glob syntax, multiline, tabs, controls and non-ASCII text are
outside this grammar and defer. Malformed syntax likewise defers. Recognizing a
literal spelling never establishes executable identity or flag safety.

Broad literal families explain review for privilege changes, data destruction,
Git mutation, infrastructure/package tools and indirection. Narrow already-
literal arguments naming `.ssh`, `.aws`, `.gnupg`, `id_rsa`, `id_ed25519`,
`.netrc`, or bare secret-bearing option names produce `credential_review`.
Computed/quoted credential paths are not resolved. Other credential access or
flags still get syntax/default review.

These are conservative **review floors**, not hard denials or exhaustive danger
detection. Some harmless commands receive broad review reasons. Unknown syntax
gets review without pretending inner executables were identified. **Only
explicit blacklists deny.** Future model integration must not interpret these
defers as permission for model auto-approval; M1 has no model-authorizing path.

## Examples and generated schema

See [config.example.json](config.example.json) for intentional exact grants and
denials. Replace the sample cwd. Its `git status` grant is an explicit user
assumption about executable/configuration behavior, not a safety proof.

Minimal config:

```json
{"version":1,"whitelist":[],"blacklist":[]}
```

The dependency-free schema descriptor in `src/config.ts` is the runtime
validation source. Its validator interprets only the vocabulary used there; it
is not a general JSON Schema engine. Generate
[config.schema.json](config.schema.json) with:

```sh
bun -e 'import {configSchema} from "./src/config.ts"; import {writeFileSync} from "node:fs"; writeFileSync("docs/config.schema.json", JSON.stringify(configSchema,null,2)+"\n")'
```

Tests compare the artifact to the descriptor and validate the example through
the real loader. Cross-list unique IDs are an additional runtime check,
documented in the schema `$comment`: standard JSON Schema cannot express
uniqueness by field across two separate arrays.

## Analyzer evaluation and source inspection ledger

Read-only references in `~/code/pi-packages`, revision
`af09a3de8ece7f124c1fd19a692958206fca64cf`:

| Inspected source | Findings and decision |
| --- | --- |
| Judge `src/floor.ts`, `test/floor.test.ts` (complete) | Floor and opaque checks refuse approval, not execution. Regex matches are review hints, not whole-shell parsing. Preserve the defer/deny distinction without porting its pattern or fixture table. |
| Hub `src/access-intent/bash/parser.ts` (complete) | `web-tree-sitter` plus Bash WASM requires initialization/assets and corrections for heredoc tails and redirect arguments. A parser alone does not establish effect safety. |
| Hub `src/access-intent/bash/parse-health.ts` (complete) | Recovery can strand error tokens as redirect predecessors. A successful subtree is not evidence of complete parsing. Never approve a safe fragment of a failed whole-call parse. |
| Hub `src/access-intent/bash/option-guards.ts` (complete) | Option abbreviations, clusters, attached values and computed words can revoke read claims. Avoid read-only-by-executable presets instead of importing the effect stack. |
| Hub `test/handlers/gates/bash-command-metamorphic.test.ts` (first 220 lines: chain/wrapper totality, redirect-hosted execution, interpolating/quoted heredocs, redirect placement setup) | Cwd prefixes and nested execution cannot inherit authority from a visible safe command. Independently authored refusal tests cover these families without importing decomposition/resolver architecture. |
| Hub `test/handlers/gates/bash-effect-invariants.test.ts` (complete) | Read grants cannot cover writes, unknown effects, in-place/computed sed/awk, effectful find or path-qualified executables. M1 has no implicit read grants. |

License evidence: the hub's package-local `LICENSE` is MIT, copyright (c) 2026
MasuRii and Christopher D. Lasher. Judge package metadata declares MIT and author
Fran Boon, but the applicable full notice remains unresolved as recorded in
`docs/REUSE.md`. **No upstream implementation, pattern table, fixture table,
prompt, dataset or other uncleared asset was copied.** The validator, small
recognizer and text-only matrix were authored here. This records inspection and
design lessons, not blanket license clearance. No upstream checkout or existing
third-party notice was modified.

Choices evaluated: adopting the hub parser/effect stack introduces runtime/WASM
assets and broad machinery contrary to M1's zero-runtime-dependency scope.
Regex-based shell decomposition cannot establish whole-call coverage. A tiny
bounded literal recognizer with **no implicit grants** provides conservative
fallback and leaves structured `argvPrefix` for a future tested complete parser
contract. No upstream code or test suites were run.

## Verification and limitations

Targeted verification completed:

- `bun run check`: passes.
- `bun test src/config.test.ts src/policy.test.ts`: **153 pass, 0 fail**, 580 assertions.
- Biome check/write on the owned TypeScript and generated/example JSON: passes;
  existing repository Biome schema-version/deprecation notices remain outside
  this work's scope.

The tests classify text only: operators, redirects/heredocs, substitutions,
quotes, comments, wrappers, assignments, malformed syntax, Unicode/control
characters, effectful flags, alternate paths, PATH/function shadowing, analysis
budget, precedence, exact/global path selection, invalid config and immutable
revisions. Candidate commands are **never executed**.

These unit tests do not establish real Pi runtime enforcement, UI association,
reload orchestration or execution binding. Those belong to the adapter and
separate smoke/integration work. Shell startup and mutable external code remain
outside this application-level policy's proof.
