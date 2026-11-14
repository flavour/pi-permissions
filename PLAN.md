# pi-permissions Implementation Plan

Status: M0 complete, 2026-11-14. A standalone, independently installable `pi-permissions` package and a verified bash-only human gate now exist in this repository. The gate is human-only (no model/policy/config shortcut), refuses non-interactive and non-chat contexts loudly, and asks a human to approve top-level interactive bash calls. M1 (deterministic policy and human review) is the next milestone.

## Working approach

Implement in small verified milestones. Reuse and adapt the existing judge's working code/tests; do not start a blank rewrite, copy the monorepo, or retain a runtime dependency on the permission-system. Mine auto-mode's tuning and counterexamples before choosing the model profile. Its OpenCode runtime and experimental execution-binding machinery are not Pi implementations.

Maintain a short evidence/reuse ledger during implementation: source path/revision/license, code or fixture adopted, assumptions changed, verification run, and known gaps. Record new consequential design choices, not every coding detail. The source checkouts are read-only references.

A milestone is complete only when its exit checks pass and docs describe the behavior that actually shipped. Keep offline checks deterministic and live tests explicit. Do not execute corpus/scenario commands, including dangerous commands; only classify their text.

## Source map

### Existing judge: `~/code/pi-packages/packages/pi-permission-decisions-judge/`

| Material | Use and required adaptation |
| --- | --- |
| `src/systemone.ts`, `test/systemone.test.ts` | Transport/error validation starting point; reject out-of-range readings rather than inheriting clamping; verify real response identity. |
| `src/state.ts`, `test/state.test.ts` | Bounded state, stable serialization, masking; account for all request overhead and never truncate the command. |
| `src/questions.ts`, `src/aggregate.ts`, related tests | Candidate baseline, not a preselected winner or calibrated profile. |
| `src/floor.ts`, `test/floor.test.ts` | Attributed review-required cases; not an independent enforcement policy or complete bash parser. |
| `src/judge.ts`, `src/extension.ts` | Reuse orchestration ideas, replace hub contracts, registration, command recovery, and unqualified prompt provenance. |
| `src/config.ts`, tests, `config/config.example.json` | Reuse validation ideas; remove project merge, old IDs, stale model, and default-false dry-run inconsistency. |
| `scripts/live-check.ts`, `test/fake_endpoint.py` | Scenario seed and protocol reference; migrate useful mock behavior to TypeScript/Bun, not a Python runtime requirement. |
| `docs/analysis/`, `docs/mined-assets.md`, `docs/decisions.md` | Prior-art/bypass catalog and attribution; distinguish settled facts from unimplemented proposals. |

### Hub: `~/code/pi-packages/packages/pi-permission-system/`

Read selected bash analysis and its tests, especially `src/access-intent/bash/`, `test/access-intent/bash/`, `test/handlers/gates/bash-command-metamorphic.test.ts`, and `test/handlers/gates/bash-effect-invariants.test.ts`. These are sources of parser/effect lessons and adversarial fixtures, not a list of modules to vendor. Avoid importing service locator, forwarded approvals, external-directory licensing, path gates, or the general authorizer chain.

### Auto-mode: `~/code/auto-mode/plugins/auto-mode/`

Read in this order:

1. `docs/HANDOFF.md`, `docs/LOW_INTERVENTION.md`, `docs/SPEC.md`, `docs/EVALUATION.md`: actual retained status, failed approaches, and evaluation qualifications.
2. `config/decision-profiles.json`, `src/decision-context.ts`, `src/decision-candidate.ts`, `src/systemone-candidate.ts`: exact direct-decision profiles, contextual representation, transport validation.
3. `src/systemone.ts`, `src/decisions.ts`, `src/decision-reviewer.ts`, `scripts/decision-review-veto.mjs`: advisory versus direct profiles, reasons, and downgrade-only veto behavior.
4. `data/*corpus.json`, `data/evaluations/`, `scripts/prepare-decision-training.mjs`, `docs/FINE_TUNING.md`: useful examples and curation structures, not ready-made training truth.
5. `docs/EXECUTION_BINDING.md` and `docs/EXECUTOR_PROPOSAL.md`: understand what source inspection does not prove; defer descriptor/resource machinery and executor replacement.

Important findings already established:

- Auto-mode's runtime is advisory/dry-run; it does not establish Pi enforcement.
- Several high-approval profiles also approve dangerous/unresolved commands. Do not choose by approval rate alone.
- The retained `d1-trace-choice-flat-v3` + `syntax-review-veto-v2` development baseline has 27/40 harmless approvals with zero observed dangerous/unresolved approvals on 141 used rows. The v2 repair has already consumed its 15-row challenge; no independent validation claim follows.
- That veto is Python-specific and conservative. Reuse its lessons/cases, not an unsupported claim of bash containment.
- Direct profiles target the currently observed d1-2B identity, but exact text, state representation, and server context must still be reproduced.
- Some retained manifests reference temporary `/tmp/opencode` assets. Check availability and preserve durable provenance rather than assuming they exist.

## M0 - Standalone skeleton and platform proof

Goal: a minimal independently installable package and a verified enforcement seam before model work.

- [ ] Record source revisions and licenses; create the reuse ledger and necessary notices as material is copied.
- [ ] Add `package.json` named `pi-permissions`, explicit TypeScript extension entry, exact dependencies, Bun lockfile, strict TypeScript config, and a pinned development toolchain. No workspace catalogs, pnpm/Vitest requirement, or cross-checkout imports.
- [ ] Add `bun run check`, `bun test`, formatting/linting, and `bun run verify`. Tests use `bun:test`; type checking runs separately. Keep live tests out of default discovery/verification.
- [ ] Use Pi 1.5.2 development types. Follow host peer-package conventions without bundling Pi. Runtime code uses Node-compatible APIs; dev tooling may use Bun.
- [ ] Read Pi 1.5.2 extension/package docs and relevant examples/source. Establish the supported built-in bash path, current cwd, effective shell prefix/backend, hook mutation/order, provenance events, and cancellation behavior.
- [ ] Implement an active minimal bash-only gate: every covered call asks a human or blocks without a usable UI. Config/handler failures cannot unregister/bypass it. Leave all other tools unchanged.
- [ ] Show startup activation and supported runtime/mode status. Unsupported runtime must not masquerade as a healthy protected session; verify how the supported-version check behaves under load failure.
- [ ] Create a disposable, explicitly approved local Pi smoke fixture. Demonstrate rejection creates no sentinel and approval creates only the intended harmless sentinel; use timeouts and isolated temp directories.
- [ ] Test clean Git installation through Pi with development dependencies omitted and normal Node runtime. Do not require a dev-only build tool in install hooks.

Exit checks:

- Offline verify passes; the package has no hub runtime/dependency import.
- A real Pi 1.5.2 rejected bash call does not execute; headless unresolved calls do not execute.
- Document plugin-absence/load-failure limitations and execution paths not covered. A mock hook unit test is not enough evidence for this milestone.

## M1 - Deterministic policy and usable human review

Goal: an independently useful human-backed gate with simple global rules and meaningful explanations.

- [ ] Introduce immutable request snapshots and structured assessments/reason codes. Separate policy evaluation, orchestration, review, and Pi adapter.
- [ ] Load only `<agentDir>/extensions/pi-permissions/config.json`. Missing config leaves the gate active; invalid config yields visible safe operation, never silent non-registration. Ignore project-local policy files.
- [ ] Implement blacklist-first exact rules and optional cwd restrictions, plus stable rule IDs/reasons. Provide small whitelist/blacklist examples and configuration validation tests.
- [ ] Evaluate parser/analyzer choices using both source projects. Record the smallest supported grammar and unsupported constructs. Add `argvPrefix` rules only once full-call recognition is tested; reject unsupported matcher config rather than accepting it loosely.
- [ ] Add a few conservative built-in easy-safe forms and review-required floors. Unsupported syntax/hidden execution context cannot inherit a safe prefix. Do not label arbitrary executable prefixes read-only.
- [ ] Capture raw input provenance and associate intent with the actual run; do not treat processed extension/assistant text as human authority. Test steering/queued input, session switch, and missing intent.
- [ ] Build review showing the full command, cwd, user intent/unknowns, and a concrete **why review** sentence. Approve once/reject only; safe dismissal and abort behavior.
- [ ] Return understandable policy/human denial reasons to the agent, without endpoint bodies/secrets, including no-evasion guidance.
- [ ] Add basic structured decision records early, distinguishing decision from execution. Keep raw records user-private and outside Git.

Required policy/review test matrix:

| Area | Minimum cases |
| --- | --- |
| Rule precedence | Both lists match; empty lists; cwd mismatch; missing and malformed config; project tries to override global. |
| Complete call | `&&`, `;`, pipes, output redirects, substitutions, multiline input, comments, quotes, wrappers, assignments, malformed syntax, Unicode/control characters. |
| Preset limits | Effectful flags, alternate executable paths, PATH shadowing, aliases/functions/prefixes where applicable, parser failures. |
| Human intent | Interactive versus extension input; missing intent; processed prompt expansion; stale intent after a switch/new input. |
| Review UX | Whole-command display, reason for each escalation class, reject/dismiss/timeout/abort, escape/control sanitization. |
| Request association | Two requests cannot share approval; session/reload/shutdown while review waits; parallel/re-entrant adapters even if current Pi preflights siblings sequentially. |
| No UI | Print/JSON mode and unsupported/disconnected RPC review block with an actionable reason. |

Exit checks: rules have documented matching limits; representative bypass fixtures cannot automatically pass as an easy-safe command; review explains why; approve/reject affects only the intended request. Real Pi smoke tests still pass.

## M2 - Decisions Model in shadow mode

Goal: faithfully integrate and compare the existing Decisions Model work without granting new authority by default.

- [ ] Port client/state/aggregation tests selectively. Replace the Python fake endpoint with a TypeScript fixture supporting malformed data, delays, identity mismatch, and disconnects.
- [ ] Implement configured endpoint with the working slashless path `http://jetson.lan:9931/v1/systemone`. Do not embed credentials or treat a LAN hostname as a trust guarantee.
- [ ] Add an opt-in live contract test using synthetic benign text. The planning probe succeeded and returned `LiquidAI/d1-2B-GGUF:Q8_0`; the trailing-slash route returned 404. Reverify rather than asserting a permanently fixed server identity.
- [ ] Distinguish the old judge's object-state contract from auto-mode's serialized-string-state candidates. Reproduce each candidate's exact representation, wording, criteria, polarity, and aggregation; pin/hash all relevant text.
- [ ] Compare the old four-question min-rule and the auto-mode direct categorical baseline using existing labelled examples. Report unsafe approvals and uncertain-context approvals, not just average accuracy/coverage.
- [ ] Select an explicit initial profile or keep multiple named experimental profiles if no defensible winner emerges. No automatic cross-model fallback. Do not transplant the Python veto as a mandatory runtime dependency.
- [ ] Validate full responses: actual identity, keys, answer types, finite in-range readings, distribution sums/legends where relevant. Unknown profile or malformed response defers.
- [ ] Bound state and total payload conservatively; keep the whole call or do not send it. Preserve masking; material information loss is review-required. Do not assume server capacity is discoverable via an undocumented route.
- [ ] Implement `off`/`shadow`/`enforce` configuration but ship model authority as shadow until the next milestone. In shadow, log the proposal and show its reason while human decides.
- [ ] Record effective decision separately from model proposal, with exact profile and response identity, latency, context omissions, and reason codes.

Exit checks: offline client/state/profile tests pass; a live smoke response is validated; no shadow model allow or deny authorizes/blocks in place of human review; state/profile changes invalidate comparisons rather than silently inheriting thresholds.

## M3 - Dependable enforcement and failure behavior

Goal: make explicit model enforcement safe enough to enable deliberately, with bounded operational behavior and honest measured limitations.

- [ ] Activate model allow/deny only in explicit enforce mode. Terminal model denies carry specific reasons; model defer reaches human. Preserve blacklist precedence and whitelist authority.
- [ ] Implement bounded endpoint concurrency (initially one), queue length/wait deadline, total request timeout, and cancellation propagation. Never indefinitely block the Pi hook on abandoned endpoint/UI work.
- [ ] Implement the breaker: start with three consecutive operational failures, 60-second cooldown, single half-open probe. Specify counted failure kinds, reset behavior, and cancellation treatment. Zero automatic retries, especially after resets/size refusals.
- [ ] Ensure deterministic rules/floors still run when the endpoint is down or breaker open. There is no `failOpen` option.
- [ ] Serialize reviews with independent request association, bounded lifetime, cancellation, and cleanup. Implement standard dialogs or explicitly tested custom TUI; only claim RPC support after testing its response/deadline path.
- [ ] Add failure/race tests: HTTP/timeout/reset/non-JSON/partial answers, wrong identity/profile, over-budget state, exhausted queue, repeated failures/cooldown, cancellation before/during send/review, reload/session switch/shutdown.
- [ ] Optional model-only in-flight deduplication: key the full snapshot, profile, and session/turn. Defer it if it risks sharing consent or approving repeat side effects; never deduplicate human approval.
- [ ] Make configuration reload atomic and failures visible. Verify active status, selected mode/profile, endpoint health, and recent review reason can be inspected without reading raw JSONL.
- [ ] Evaluate the selected profile on new reviewed examples not used to tune it. Document any false allows/denies and the sample's limits. If unsafe approvals remain, keep model enforcement experimental/shadow by default rather than tuning away the warning.
- [ ] Re-run clean Git installation, real Pi approve/deny/headless smoke tests, and a live model contract/evaluation run. Write a concise verification report with commands, runtime/profile identities, outcomes, and gaps.

Exit checks: all first-release criteria in `SPEC.md` are mapped to named tests or documented live verification. `bun run verify` is green offline. A user can intentionally enable enforce and understand its provisional status; no evaluation is described as calibrated without supporting held-out evidence.

## M4 - Evaluation and operator workflow

Keep this milestone scoped to reusable evaluation, not training.

- [ ] Provide capture/replay of exact request/profile text with provenance and local privacy controls, and a scenario override/diff command.
- [ ] Build reports for false allows, false denies, deferred/review rate by family, model availability, and latency. Show shadow versus effective outcome separately.
- [ ] Retain exact requests and durable manifests rather than dangling temp-file references. Repeated runs detect drift from model/build/profile changes.
- [ ] Add representative attributed regression fixtures from hub/auto-mode and adjudicate label conflicts. Clearly separate synthetic cases, human feedback, and reviewed labels.
- [ ] Consider session-scoped grants: narrow explicit scope, visible/revocable, blacklist-respecting, no invisible persistence. Add independently if evaluation work does not need them.

Exit: operators can answer 'why did this call reach review or get denied?', reproduce a decision, and compare profiles without editing production policy or executing the candidate commands.

## M5 - Large corpus and training research (outline only)

- Mine all useful available source corpora and rich local captures, retaining license/revision, label provenance, intent/context, exact profile, and family identity.
- Scan/clean sensitive material before curated commits or exports. Human-adjudicate labels; do not promote every past model verdict or human click into ground truth.
- Create family-separated development, training, and genuinely untouched test sets. Existing auto-mode tuning/challenge data is used development/regression evidence, not a fresh holdout.
- Compare SFT with the research path at <https://www.cmpnd.ai/blog/weight-space-programming-dspy.html> only after the corpus and evaluation baseline exist. Choose objectives/compute/tooling in a later design; no training stack is required now.
- Version model/dataset/profile together and require safety regression gates and rollback before changing the enforced profile.

Known useful auto-mode seed assets: `data/classifier-corpus.json` (41 cases), `data/classifier-challenge-corpus.json` (30), helper-context variant corpora, `data/decision-context-corpus.json` (10), veto challenges, and evidence-resolution cases. Its retained curation manifest describes 141 rows in 83 families (40 safe, 48 dangerous, 53 unsure); those labels are draft and all rows already used. Check current files before importing and preserve source labels distinctly.

## M6 - Optional extensions (outline only)

Add a full-LLM reviewer only after model defer, with the same assessment/reason interface, bounded costs, provenance, and failure-to-human behavior. It does not override terminal policy/model denies. Additional tools, broader evidence collection, execution binding/sandboxing, and persistent grants are separate scope decisions, not hidden completion requirements for this bash-only plugin.

## Verification commands to establish

The implementing agent should make these real and document their exact arguments:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run verify               # offline: typecheck, lint/format, tests, schema consistency
bun run test:integration     # opt-in synthetic requests to configured live endpoint
bun run test:pi              # opt-in disposable Pi 1.5.2 runtime/install smoke tests
bun run evaluate            # text-only corpus evaluation, explicit profile/endpoint
```

No particular additional lint/format package is mandated; choose a small coherent toolchain. A Git installer may use npm/pnpm internally according to Pi settings: Bun is the development workflow requirement, not an excuse to require Bun inside the host or override Pi's installation machinery.

## Handoff discipline

Do not spend the initial implementation on monorepo onboarding, generalized authorizer infrastructure, npm publishing, older Pi compatibility, Python descriptor execution prototypes, full LLM review, or training. First prove a small standalone gate, then add deterministic policy and review reasons, then shadow the model, then harden/measure explicit enforcement. Preserve useful evidence for later without making later ambitions block each usable milestone.
