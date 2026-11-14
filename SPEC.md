# pi-permissions Specification

Status: implementation handoff, 2026-11-14. This document specifies the new standalone extension; it does not claim that it is implemented.

## 1. Goal and agreed scope

Build `pi-permissions`, a standalone Pi extension that mediates **agent-issued bash tool calls** through:

```text
bash tool_call
  -> deterministic policy: allow | deny | continue
  -> Decisions Model (/v1/systemone): allow | deny | defer
  -> [future optional full-LLM reviewer]
  -> human: approve once | reject
```

The extension owns enforcement, configuration, model judgment, review presentation, and decision records. It must not depend on `@gotgenes/pi-permission-system`, its registration events, service locator, authorizer chain, configuration, or runtime. Selectively reuse implementation and tests, not the upstream architecture or tooling.

Agreed constraints:

- Support Pi **1.5.2 only**, using `@earendil-works/pi-coding-agent`. No compatibility shims for older versions.
- Package/extension name: `pi-permissions`. Install from a Git repository; no npm publishing requirement.
- Bun manages dependencies, development scripts, tests, and verification. The installed extension runs in Pi's normal Node runtime; no runtime dependency on Bun APIs.
- Exact dependency versions and a committed Bun lockfile.
- First usable revision covers only the built-in `bash` tool. `read`, `write`, `edit`, custom tools, MCP, subagents, and cross-process delegation are not mediated.
- User-global configuration only. Do not read policy, endpoint, thresholds, or approval rules from the current checkout, even if Pi trusts that checkout.
- Model judgment may deny outright. Provide simple explicit whitelist/blacklist configuration.
- Human review must explain **why** review is needed, not merely ask for permission.
- Session approvals are later work. Future LLM review must fit without redesigning enforcement.
- Ultimately build a substantial evaluation/training corpus from both source projects and new usage. Training implementation is out of the early milestones.

## 2. Security claim and exclusions

This is an application-level permission gate, not a sandbox or a complete system security boundary. Bash scripts, executables, aliases, startup files, environment, symlinks, and files can change between review and execution. A parser cannot prove arbitrary shell effects safe. Display these limitations in the README.

The supported claim is: while this extension is successfully loaded on the verified Pi 1.5.2 execution path, a covered bash call cannot execute until that exact call receives an effective allow decision. A model failure, absent UI, configuration error, or exception inside the gate must not silently approve it.

Do not claim to intercept user-entered `!`/`!!` shell commands, extension `pi.exec`, arbitrary custom tools that spawn commands, external processes, or uncovered file tools. Do not replace Pi's bash executor or implement execution binding/sandboxing in the first revision. Investigate actual shell prefixes and other execution customization before making automatic decisions; unsupported hidden execution context requires human review or an explicit documented user assumption.

Loading the package itself is a prerequisite. If Pi cannot load it, it cannot enforce anything. Installation verification must visibly confirm activation; do not describe a load failure as fail-closed protection. Other extensions may mutate commands or replace bash: verify supported composition, and document unsupported configurations rather than promising enforcement across arbitrary extensions.

### Pi 1.5.2 integration facts

The installed docs and implementation were inspected for this handoff. Preserve these facts in implementation tests:

- Use `tool_call` and explicitly return `{ block: true, reason }` for terminal rejection. Returning nothing continues toward execution. In Pi 1.5.2 an uncaught hook exception also blocks execution and becomes a tool error; catching it and returning nothing would introduce a fail-open bug.
- The standard bash tool receives `command` and optional `timeout`; execution uses the current `ctx.cwd`. Do not use a stale startup `process.cwd()` snapshot.
- `shellCommandPrefix` is prepended **after** the hook, and a custom spawn hook/backend may further replace command, cwd, or environment. Inspect effective settings/tool provenance where exposed; document any facts that cannot be verified. An extension override named `bash` is not necessarily the standard tool.
- `event.input` is mutable. A later extension can change an already-approved call, without argument revalidation. Support an audited non-mutating extension configuration; this gate alone cannot prove it observed the final command across arbitrary extensions.
- `input` supplies raw input and source (`interactive`, `rpc`, `extension`). `before_agent_start.prompt` is processed text without that source. `pi.sendUserMessage()` can create user-role text from an extension. Do not use the old judge's unqualified latest-prompt capture as authorization.
- `ctx.hasUI` is true in both TUI and RPC. Standard review dialogs need explicit timeout and `ctx.signal`; custom TUI dialogs are not RPC support. Test actual supported review capability.
- Nested `ctx.executeTool()` uses enforcement hooks; direct `.execute()`, `pi.exec`, and arbitrary process spawning do not universally do so. User-entered `!`/`!!` and RPC `bash` use the separate `user_bash` event and are excluded here.

References inside the installed Pi package: `docs/extensions.md`, `docs/packages.md`, `docs/rpc-extension-ui.md`, `examples/extensions/permission-gate.ts`, `dist/core/extensions/runner.js`, `dist/core/tools/bash.js`, and `dist/core/agent-session.js`. Recheck the actual package during implementation rather than depending on line numbers in compiled files.

## 3. Source material and reuse policy

The implementing agent has read access to:

1. `~/code/pi-packages/packages/pi-permission-decisions-judge/`: existing state builder, masking, client, aggregation, floor, config, tests, live-check scenarios, and design research.
2. `~/code/pi-packages/packages/pi-permission-system/`: bash analysis and policy regression cases, approval presentation, and security lessons. Use narrowly selected algorithms/fixtures, not the whole hub.
3. `~/code/auto-mode/plugins/auto-mode/`: OpenCode plugin, measured Decisions Model experiments, evaluation data, review explanations, and training preparation work.
4. Installed Pi 1.5.2 docs/source/examples under `~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/`.

The older judge is a working skeleton, not a definitive spec. Its README/SPEC say dry-run is the default while `src/config.ts` defaults to false; its model pin and some API assumptions are stale. This spec supersedes those decisions. Auto-mode experiments are evidence, not permission to transplant thresholds or OpenCode hooks unchanged.

Keep source revisions, fixture origins, licenses, and attribution for reused code/data. Verify licenses before copying; preserve required copyright and notice text. Do not copy either repository wholesale or import their build tooling. Import only material relevant to bash decisions and preserve contradictory examples for adjudication rather than silently overwriting labels.

## 4. Decision interface and ownership

Keep the decision engine independent of Pi UI and network implementation. Its conceptual input is an immutable request snapshot:

```typescript
type BashRequest = {
  requestId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  command: string;             // exact original, never a display preview
  cwd: string;
  userIntent?: string;        // provenance-qualified, not assistant/tool prose
  executionContext: unknown;  // verified shell/prefix facts or explicit unknowns
};

type Assessment = {
  kind: "allow" | "deny" | "defer";
  source: "policy" | "decisions-model" | "human" | "runtime";
  reasonCode: string;
  explanation: string;
  evidence?: unknown;         // structured readings, rule IDs, profile, etc.
};
```

These are conceptual shapes, not required public TypeScript exports. Use small interfaces with deep implementations: one policy evaluator, one model reviewer, one review adapter, and one orchestrator. Inject transport, clock, record sink, and review adapter for deterministic tests. Return structured decisions; keep UI/network side effects out of policy and aggregation.

Only the Pi adapter maps final decisions to the actual `tool_call` allow/block contract. An internal `defer` **never** means returning control to Pi and letting the tool run: it means trying the next reviewer, then blocking if nobody approves. A terminal human rejection is a deny. Cancellation terminates the request as blocked/cancelled; it is not an allow or a model safety label.

Use a fixed ordered pipeline, not a general plugin registry. A later full-LLM reviewer can implement the same reviewer interface and occupy a slot after model defer and before human review. It cannot override deterministic or Decisions Model terminal denies by default. No full LLM integration is required initially.

## 5. Deterministic policy

### 5.1 Precedence

1. Invalid request/configuration/runtime state: no automatic approval; request human review if usable, otherwise block.
2. Explicit user blacklist match: deny, with matching rule ID and reason.
3. Explicit user whitelist match: allow only if the matcher evaluated the complete request and all matcher restrictions hold.
4. Conservative built-in easy decisions: allow only well-understood safe forms; dangerous or opaque forms bypass model approval and require human review.
5. Remaining supported commands: Decisions Model.

A blacklist wins over a whitelist regardless of list order. There must be no built-in irreversible deny that cannot be understood/configured by the operator; use review-required floors for dangerous shapes unless an explicit blacklist denies them. Whitelist rules are intentional user authority, not learned model output. Exact whitelisting of an opaque command is an explicit override of the review floor; show/document that it trusts everything that command invokes. Never let a whitelist override a blacklist or an invalid execution snapshot.

### 5.2 Simple configuration, conservative matching

Expose `whitelist` and `blacklist` arrays with stable rule IDs, optional explanations, and an initially small matcher language:

- `exact`: equality against the entire original command string; no whitespace, quoting, or Unicode normalization that changes semantics. Optional absolute `cwd` restriction.
- `argvPrefix`: a literal token prefix, only for a confidently parsed **single simple command**, with the complete syntax accounted for. No hidden trailing pipeline, redirect, substitution, compound command, or wrapper may inherit this match. Optional absolute `cwd` restriction. A bare executable prefix grants every accepted argument form: explain this prominently.

An illustrative rule is `{ "id": "deny-push", "argvPrefix": ["git", "push"], "reason": "Push manually" }`. This is not a semantic ban on every way to invoke Git: wrappers, `git -C`, alternate executable paths, substitutions, and scripts must not be claimed to match it unless explicitly supported and tested. Unrecognized forms must not become built-in safe decisions.

Do not ship permissive glob/substring matching or regex-based shell decomposition disguised as a security parser. Start with exact rules and add structured prefix rules only after their parser contract is tested. A config containing an unsupported matcher is invalid, not silently ignored. Configuration examples must describe matching limits.

### 5.3 Whole-command reasoning

A safe prefix is not a safe call. Account for shell operators, pipelines, redirections, substitutions, multiline input, comments, assignments, wrappers, and path/executable identity before using a built-in or structured allow. If analysis is incomplete, unsupported, inconsistent, or over budget, route to human review, not model approval on a safe-looking fragment.

Adopt a maintained shell parser or a clearly bounded conservative analyzer after evaluating existing source. Do not implement the full permission-system parser stack simply to preserve feature parity. The milestone must state its supported grammar and test its refusal behavior.

Early easy-safe presets should be few and flag-aware (for example, narrowly supported Git inspection invocations); even `git diff`, `find`, `sed`, and `awk` have effectful flags. Never whitelist an executable name as universally read-only. Cwd, command resolution, repo configuration, and executable hooks limit what can be proved. User-controlled executable shadowing must not silently satisfy a built-in safe preset.

Review-required floor examples: privilege escalation, disk formatting, destructive Git operations, broad recursive deletion, credential access/transmission, deployment/infrastructure mutation, publish operations, unknown interpreter/script execution, and unaccounted-for shell indirection. These are reviewed shapes, not a guarantee of exhaustive semantic detection. Carry attributed bypass fixtures from both source projects.

## 6. User-global configuration and modes

Canonical location: `<agentDir>/extensions/pi-permissions/config.json`, using Pi's `getAgentDir()` rather than a hard-coded home path. Do not consume the old judge or hub's configs. Configuration selects rules, endpoint, profile, budgets, breaker/concurrency limits, record settings, and model mode.

- Missing config: active gate with conservative defaults; model network calls disabled until configured, unmatched commands require review. Do **not** inherit the old judge's 'register nothing' behavior.
- Invalid/unreadable config or unsupported schema version: visible actionable error; no whitelist/model automatic approval from a partial config. Human-only operation or headless blocking remains active.
- Read a coherent validated snapshot, not partially reloaded mutable state. Reload applies atomically; failed reload must visibly enter a safe posture. No in-flight request changes policy underneath its own snapshot.
- Unknown fields and invalid threshold relationships are errors, not clamped/ignored input.
- No `failOpen`, remote policy loading, automatic policy writing, or automatic durable grants.

Model modes: `off`, `shadow`, `enforce`. Initial default is `shadow` when an endpoint/profile is configured, otherwise `off`. In shadow mode the model records what it would allow/deny, but every model-stage request still goes to human review. Deterministic blacklist/whitelist decisions remain effective; this is model shadowing, not bypassing the entire gate. Enforce is an explicit user choice with measured profile limitations visible.

Commit an example config without private data, a schema generated from one validation source, and documented defaults. Exact configuration keys beyond the rules/modes above may be finalized during implementation, but docs, schema, and runtime must agree.

## 7. Decisions Model contract and state

### 7.1 Endpoint verification

User-provided address: `jetson.lan:9931/v1/systemone/`.

A harmless live probe on 2026-11-14 established:

- `POST http://jetson.lan:9931/v1/systemone/` returned 404 (`File Not Found`).
- `POST http://jetson.lan:9931/v1/systemone` succeeded.
- Response identity was `LiquidAI/d1-2B-GGUF:Q8_0`.
- A `noul` question used `instructions` (plural), `criteria.true`/`criteria.false`, keyed `questions`, and shared `state: {value, context}`. Response had keyed `answers`, plus optional usage.

Use the working slashless URL in the example configuration and document normalization of the known endpoint's trailing slash. This probe verifies reachability/shape, not classifier quality, capacity, latency, or suitability of a profile. Never run scenario commands: integration tests send text only.

```json
{
  "state": {"value": "printf hello", "context": "The user asked to print hello."},
  "questions": {
    "safe": {
      "type": "noul",
      "instructions": "Is this command read-only?",
      "criteria": {
        "true": "The command only prints text and does not modify files or services.",
        "false": "The command modifies files or services."
      }
    }
  }
}
```

This is the probe payload, **not** a prescribed production question set. The server can answer without a requested model. If a model is requested, response identity still wins.

### 7.2 State and intent

Supply the entire command, cwd, bounded user-intent context, and only justified execution facts. Never truncate the call and judge the remaining prefix. Reduce optional context first; if the call cannot fit the configured conservative budget, review without sending it. Token estimates are estimates; include question/criteria overhead and server capacity, not just command length. Do not invent a capability-discovery endpoint that the server does not expose.

Authorization evidence comes from the user's own instructions with provenance. Assistant messages, tool results, generated summaries, environment variables, and extension-generated prompts cannot grant authority. Capture/qualify real user input using Pi 1.5.2 events; invalidate/update intent on new input, session changes, branches, and compaction rather than retaining stale instructions. Missing intent is an explicit unknown. Preserve the complete local request separately from any masked model-visible form.

Keep source-project masking for recognized secrets in outbound state. If masking removes meaning material to the decision, require review instead of claiming the masked call was judged faithfully. Do not upload file contents, environment dumps, tool output, or the entire session by default. Optional future evidence expansion needs explicit limits and provenance. A corpus intake of existing files does not authorize sending all of them to the endpoint.

### 7.3 Profiles, questions, aggregation

Evaluate the old judge's four-question min-rule against auto-mode's measured candidates before choosing the first profile. Reuse exact instructions, criteria, polarity declarations, and aggregation code when importing a profile; do not combine thresholds from one experiment with wording from another.

Auto-mode's retained evidence provides an important warning: the raw profiles produced unsafe approvals. Its retained development baseline is `d1-trace-choice-flat-v3` plus `syntax-review-veto-v2`: 27/40 harmless approvals and zero observed dangerous/unresolved approvals on 141 already-used regression rows. The repaired 15-row challenge adds 3/4 harmless approvals with zero other approvals, but was already used to repair v1's destructive method-alias misses. These are not independent holdout results or a proven winning profile. The veto is Python-focused; it is not a bash safety parser and must not become a mandatory Python runtime dependency by accident.

Start comparisons with `config/decision-profiles.json`, `src/systemone-candidate.ts`, `src/decision-candidate.ts`, `scripts/decision-review-veto.mjs`, and `docs/EVALUATION.md` under auto-mode. Its direct categorical profile uses safe >= 0.90 and dangerous <= 0.05 for approval, dangerous >= 0.90 for denial, otherwise review; these values belong to its exact text/model/aggregation and are not universal defaults. Auto-mode also sends serialized-string state in some adapters, whereas the old judge and the live probe accept `{value, context}`. Preserve the exact request representation when reproducing a profile; changing representation is a new evaluation variant.

A profile identifies question/criteria text revision or hash, question types, polarity, aggregation version, thresholds, model identity, and server build/metadata where available. If build metadata is unavailable, record that explicitly; do not fabricate reproducibility. Unknown/missing model identity, malformed or unsupported answers, non-finite/out-of-range probabilities, missing keys, or an unrecognized profile yield defer. Reject malformed readings rather than silently clamping them.

The aggregation result must be explainable as allow, deny, or defer with question/evidence and reason codes. Readings are model outputs, not calibrated safety probabilities. No threshold is 'calibrated' without a held-out labelled evaluation for that exact profile. An explicit enforce mode may use a provisional profile, clearly labelled as such; the shipped default remains shadow.

Where the chosen profile supports it, send all its questions for one request together. If an evidence-backed cascade uses additional calls, document and test its bounded stages/latency; do not add unbounded question fan-out or a second LLM in revision one.

### 7.4 Resilience

All transport, timeout, HTTP, JSON/shape, profile, and budget failures defer with distinct reasons. No model technical failure is a semantic denial. Enforce finite request and total queue/review budgets appropriate to the host; user cancellation cancels pending transport/review work.

Initial transport retries: **zero**. A reset can indicate an over-limit request; never blindly retry it. Add a circuit breaker (starting configuration: three consecutive transport/service failures, 60-second cooldown, one half-open probe) and bounded endpoint concurrency (initially one). Make those operational defaults configurable and label them uncalibrated. Success resets failure state; cancellations do not become classifier failures. Define which failure kinds open the breaker and test that table.

Bound queue length/wait time. A request cannot hang indefinitely behind endpoint work or an abandoned dialog. Identical concurrent requests may share **model computation only** when intent, command, cwd, execution facts, policy/profile, session and turn all match. Do not share human approval, consume one-shot approval twice, reuse across turns, or treat non-idempotent repeated calls as one approved action. Deduplication can follow the initial limiter if it complicates correctness.

## 8. Human review and denial explanation

Review is a first-class module owned here, not delegated to the old hub. At minimum show:

- Exact command (scrollable/expandable, not a misleading truncated preview) and cwd.
- A clear sentence answering **why this reached human review**: model uncertainty with relevant readings, opaque command, protected shape, endpoint unavailable, profile mismatch, missing intent, config error, or shadow mode.
- The known user intent, with absent/shortened context labelled.
- Any suggested model verdict and its limitations, clearly distinguished from an authoritative policy rule.
- Approve once and reject; cancellation/dismissal defaults to rejection/blocking.

Sanitize terminal control sequences without changing the underlying decision snapshot; label visual escaping. Serialize dialogs and keep each approval attached to its toolCallId and exact snapshot. Test parallel calls, queued cancellation, session switch/reload, and shutdown. Approval must not release unrelated queued requests.

Final denies return a concise reason to the agent: rule or model finding, why blocked, and that it must not evade the decision by rewording/wrapping the command. Tell it to explain the need to the user or request an explicit policy change. Do not return secrets or raw endpoint error bodies. Deny need not open a confirmation dialog; a visible denial/status and the tool error must make the outcome intelligible.

If no usable human interaction channel exists (including print/headless modes or a disconnected/unsupported RPC UI), unresolved requests are blocked with a reason. Do not treat `hasUI` alone as proof that an interactive human will answer. An RPC client that genuinely supports review can be supported only with explicit tests; otherwise fail closed there.

Later session approvals must be narrow, explicit, reviewable, and revocable. They must not override a blacklist, persist invisibly across sessions, or be learned from model allows. Do not delay the first revision to implement them.

## 9. Records and corpus readiness

Emit structured records with request IDs, source decision, reason codes, timings, effective mode, rule/profile/config revision, actual model identity, readings, failures, review explanation, final human response, and cancellation. Keep model proposal distinct from effective decision; keep requested action distinct from later execution result. Never mark a blocked or cancelled action as executed.

The user authorizes broad reuse/intake of available examples, with sensitive-data scan and cleanup later. Prefer rich **local** records over losing evidence, but:

- Raw captures live in a user-private data directory outside the Git checkout, ignored if any development fixtures are local. Apply restrictive file/directory permissions where supported.
- Provide retention/disable controls and bounded storage; do not copy credentials, raw logs, or whole sessions into committed fixtures by accident.
- Separate unreviewed/raw intake, curated fixtures, evaluation splits, and exported training sets. Capture provenance, source license/revision, prompt/question text, model/build, label source, and schema version.
- Human approval is evidence of authorization, not automatically a universal safety label. Human rejection, a heuristic, a model verdict, and an adjudicated label remain distinguishable.
- Before committing, publishing, or exporting datasets, scan/redact secrets and sensitive identifiers and resolve license/provenance questions. Corpus cleanup may occur later; raw data must not accidentally escape before it.

Capture the minimum durable schema early so later corpus work does not require reconstructing discarded context. Large-scale mining, curation, and training are later phases.

## 10. Tooling, installation, and verification

Use Bun scripts for `check` (TypeScript checking), `test` (`bun test`), formatting/linting, and `verify` (offline checks). `bun test` does not replace type checking. Live integration/evaluation must be a separate opt-in script so `verify` is repeatable without LAN/server access. Pin the Bun version/toolchain and host development types; do not use workspace catalogs or relative runtime imports into either source repository.

Declare `pi.extensions` explicitly. Host-provided Pi modules are peer/development dependencies, not bundled duplicate runtime dependencies. Pi's packaging docs recommend wildcard peer declarations for host-provided modules; use exact 1.5.2 development pins and an explicit tested-runtime/startup support check rather than installing another host copy to enforce an exact peer. Document the single-version support contract even if the peer declaration follows that convention. Other runtime libraries belong in `dependencies`, because Git installs do not install devDependencies. Test clean Git installation with Pi's real installer and normal runtime, not just importing the source under Bun. The user should not need either source checkout or Bun at extension runtime.

Package docs must include activation/status verification, global config location, whitelist/blacklist examples with limits, model shadow/enforce behavior, human-review explanations, headless behavior, known uncovered execution paths, and uninstall/rollback. No npm publishing pipeline or monorepo issue-template onboarding is needed.

## 11. Acceptance criteria

The first dependable standalone release must demonstrate all of the following:

1. Clean Git install loads in Pi 1.5.2, with no permission-system dependency or Bun-only runtime import.
2. Every covered bash call is gated before execution; an unresolved/failed gate cannot fall through to execution. Non-bash tools are left unchanged and explicitly out of scope.
3. Blacklist precedes whitelist; rules are global-only; invalid/missing config cannot disable the gate.
4. Exact/structured matcher limits and supported grammar are documented and enforced, including adversarial prefix/suffix/redirect/wrapper tests.
5. Model allows and denies are effective only in enforce mode; shadow proposals do not decide execution. Unknown profiles/readings and all technical failures defer.
6. Dangerous/opaque/incomplete-analysis shapes require review unless the user has explicitly whitelisted the exact/fully matched call. Blacklists remain terminal.
7. Review always states why, shows the whole call, and binds approve/reject to one request. Dismissal/cancellation/headless/disconnected UI cannot approve.
8. Breaker, bounded endpoint concurrency, timeouts, cancellation, and parallel review races are covered by deterministic tests.
9. Real endpoint tests verify actual response identity and contract; deterministic/profile evaluations report failures and drift rather than claiming calibration from a smoke test.
10. Local records retain model proposal, effective decision, provenance, and human feedback without committing raw sensitive material.
11. Offline `bun run verify` succeeds; live tests and a real Pi 1.5.2 smoke test have separately recorded results and known limitations.

Later evaluation/training completeness is not a prerequisite for the first shadow-capable milestone. Enabling automatic model decisions requires an explicitly selected, evaluated profile and honest documentation of residual error.

## 12. Later corpus and model improvement (high-level only)

Build a large corpus from both repositories, attributed hub bypass cases, live shadow captures, adversarial mutations, realistic safe commands, and human-adjudicated middle cases. Deduplicate by families and keep related variants out of both training and held-out evaluation. Track intent-sensitive contrast pairs, shell-obfuscation families, false allows, false denies, review burden, latency, and operational failures.

Evaluate traditional SFT and, as an alternative research path, the approach described at <https://www.cmpnd.ai/blog/weight-space-programming-dspy.html>. This is a future investigation, not a current dependency or an endorsement of unverified claims. Define measurable improvement and safety regression gates before selecting a training method. Version datasets, models, prompts, and thresholds together; retain a rollback profile. Do not let the model modify whitelist/blacklist policy.

Future optional features: narrow session approvals, a full-LLM reviewer on defer, richer controlled evidence, and additional tool coverage. Each requires its own acceptance criteria and must not silently widen this bash-only contract.
