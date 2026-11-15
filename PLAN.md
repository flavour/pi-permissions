# pi-permissions Implementation Plan

Status: **M0, M1 (conservative core), M2 and M3 (enforce mode, provisional) complete**, verified 2026-11-16. Global
blacklist-first exact rules, immutable snapshots, provenance-qualified
intent/unknowns, serialized one-shot review, cancellation, and private bounded
decision records ship, plus an optional **shadow** Decisions Model whose every
outcome is a proposal with no authority. Missing/invalid config leaves the gate
active; a malformed model block switches only the model off, with a visible reason.

M1 is not marked fully complete: built-in automatic easy-safe presets are
deliberately deferred because shell/executable identity cannot be established; only
explicit exact whitelists bypass human review. M2 ships no enforcement authority, no
calibration and no held-out evaluation, so no profile is enabled by default and none
is declared a winner. See [`docs/M1-VERIFICATION.md`](docs/M1-VERIFICATION.md),
[`docs/M1-POLICY.md`](docs/M1-POLICY.md), [`docs/M2-MODEL.md`](docs/M2-MODEL.md) and
[`README.md`](README.md) for evidence and limits.

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

- [x] Record source revisions and licenses; create the reuse ledger and necessary notices as material is copied.
- [x] Add `package.json` named `pi-permissions`, explicit TypeScript extension entry, exact dependencies, Bun lockfile, strict TypeScript config, and a pinned development toolchain. No workspace catalogs, pnpm/Vitest requirement, or cross-checkout imports.
- [x] Add `bun run check`, `bun test`, formatting/linting, and `bun run verify`. Tests use `bun:test`; type checking runs separately. Keep live tests out of default discovery/verification.
- [x] Use Pi 1.5.2 development types. Follow host peer-package conventions without bundling Pi. Runtime code uses Node-compatible APIs; dev tooling may use Bun.
- [x] Read Pi 1.5.2 extension/package docs and relevant examples/source. Establish the supported built-in bash path, current cwd, effective shell prefix/backend, hook mutation/order, provenance events, and cancellation behavior.
- [x] Implement an active minimal bash-only gate: every covered call asks a human or blocks without a usable UI. Config/handler failures cannot unregister/bypass it. Leave all other tools unchanged.
- [x] Show startup activation and supported runtime/mode status. Unsupported runtime must not masquerade as a healthy protected session; verify how the supported-version check behaves under load failure.
- [x] Create a disposable, explicitly approved local Pi smoke fixture. Demonstrate rejection creates no sentinel and approval creates only the intended harmless sentinel; use timeouts and isolated temp directories.
- [x] Test clean Git installation through Pi with development dependencies omitted and normal Node runtime. Do not require a dev-only build tool in install hooks.

Exit checks: **all met** — evidence in [`docs/REUSE.md`](docs/REUSE.md) and [`docs/PI-PLATFORM.md`](docs/PI-PLATFORM.md); the Pi smoke asserts rejection leaves no sentinel and approval writes only the intended one.

- Offline verify passes; the package has no hub runtime/dependency import.
- A real Pi 1.5.2 rejected bash call does not execute; headless unresolved calls do not execute.
- Document plugin-absence/load-failure limitations and execution paths not covered. A mock hook unit test is not enough evidence for this milestone.

## M1 - Deterministic policy and usable human review

Goal: an independently useful human-backed gate with simple global rules and meaningful explanations.

- [x] Introduce immutable request snapshots and structured assessments/reason codes. Separate policy evaluation, orchestration, review, and Pi adapter.
- [x] Load only `<agentDir>/extensions/pi-permissions/config.json`. Missing config leaves the gate active; invalid config yields visible safe operation, never silent non-registration. Ignore project-local policy files.
- [x] Implement blacklist-first exact rules and optional cwd restrictions, plus stable rule IDs/reasons. Provide small whitelist/blacklist examples and configuration validation tests.
- [x] Evaluate parser/analyzer choices using both source projects. Record the smallest supported grammar and unsupported constructs. Add `argvPrefix` rules only once full-call recognition is tested; reject unsupported matcher config rather than accepting it loosely. (`argvPrefix` is rejected in M1.)
- [ ] Add a few conservative built-in easy-safe forms. **Deferred by explicit design decision:** no built-in automatic grants until a defensible shell/executable-context assumption is established; see `docs/M1-POLICY.md`.
- [x] Add review-required floors. Unsupported syntax/hidden execution context cannot inherit a safe prefix. Do not label arbitrary executable prefixes read-only.
- [x] Capture input provenance and conditionally associate idle interactive intent with the actual run; do not treat processed extension/assistant text as human authority. Test steering/queued input, prompt expansion, session switch, and missing intent. Public API lacks durable input IDs; ambiguous cases stay unknown and audited input-handler ordering is required.
- [x] Build review showing the full command, cwd, user intent/unknowns, and a concrete **why review** sentence. Approve once/reject only; safe dismissal and abort behavior.
- [x] Return understandable policy/human denial reasons to the agent, without endpoint bodies/secrets, including no-evasion guidance.
- [x] Add basic structured decision records early, distinguishing decision from execution. Keep raw records user-private and outside Git. Early unsupported runtime/tool and exceptional failures return denial without a full record (documented).

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

- [x] Port client/state/aggregation tests selectively. Replace the Python fake endpoint with a TypeScript fixture supporting malformed data, delays, identity mismatch, and disconnects. **Done.** `scripts/fixtures/endpoint.ts` (TS, no Python) scripts behaviour per response: valid noul/choice bodies, malformed JSON, wrong identity, missing/extra keys, out-of-range readings, HTTP errors, delays, and mid-request disconnects. 30 client tests in `src/decisions/systemone.test.ts` assert each is named by a distinct reason code and never clamped or retried.
- [x] Implement configured endpoint with the working slashless path `http://jetson.lan:9931/v1/systemone`. Do not embed credentials or treat a LAN hostname as a trust guarantee. **Done.** `endpointBase()` normalizes a configured origin to the slashless route (trailing-slash route verified 404 live). Credentials are an `Authorization` header from `MODEL_API_KEY` for scripts; a basic-auth URL is rejected outright. `http://` LAN origins are accepted and documented as carrying no trust: the endpoint is not authenticated, so its readings are treated as an unverified opinion.
- [x] Add an opt-in live contract test using synthetic benign text. The planning probe succeeded and returned `LiquidAI/d1-2B-GGUF:Q8_0`; the trailing-slash route returned 404. Reverify rather than asserting a permanently fixed server identity. **Done.** `MODEL_BASE_URL=... bun run test:live` (`scripts/live-contract-check.ts`) runs the shipped judge over synthetic benign text and *reports* the served identity; it fails only when the endpoint answers as something other than the profile's pinned identity. Verified live 2026-11-14 against `http://jetson.lan:9931`: `LiquidAI/d1-2B-GGUF:Q8_0`, 4/4 keys, 213-278 ms, and the over-budget probe refused with `state_over_budget` instead of truncating.
- [x] Distinguish the old judge's object-state contract from auto-mode's serialized-string-state candidates. Reproduce each candidate's exact representation, wording, criteria, polarity, and aggregation; pin/hash all relevant text. **Done.** `object-state-v1` (JSON object state, four `noul` questions, min-rule with a named exfiltration veto) and `string-state-v1` (serialized string state, one categorical question, argmax) are separate profile kinds with separate state builders. Question text, criteria wording, polarity (`high = safer` for the three min-rule dimensions, inverted for `exfiltration`), thresholds and aggregation are pinned in `src/decisions/profile.ts` + `questions.ts` and folded into `profileIdentity()`; `profile.test.ts` pins the identities, so a wording change changes the hash and invalidates comparisons.
- [x] Compare the old four-question min-rule and the auto-mode direct categorical baseline using existing labelled examples. Report unsafe approvals and uncertain-context approvals, not just average accuracy/coverage. **Done, with a corpus substitution.** The reference corpora were not copied (see `docs/REUSE.md`), so `src/decisions/corpus.ts` holds 17 cases labelled in this repo, labelled as draft synthetic opinions rather than attributed review. `bun run evaluate` reports **unsafe approvals first**, then uncertain-context approvals, terminal denials, deferrals by reason, latency and per-case verdicts, and re-runs each profile to assert no drift. Live result 2026-11-14: conservative 0/0/0 approvals with 16 of 17 reaching a human; judge-band 1 approval, 9 denials; categorical 6 approvals. Drift: none for any profile.
- [x] Select an explicit initial profile or keep multiple named experimental profiles if no defensible winner emerges. No automatic cross-model fallback. Do not transplant the Python veto as a mandatory runtime dependency. **Kept three named profiles; no winner selected.** 17 draft-labelled cases cannot separate them defensibly, and the reference projects' 90-95% figures were not reproducible here, so picking one would be aesthetics. The operator chooses explicitly; unknown ids switch the model off with the known ids listed, and no path falls back to another profile. The exfiltration veto is re-expressed as TypeScript arithmetic inside the min-rule, not a Python dependency.
- [x] Validate full responses: actual identity, keys, answer types, finite in-range readings, distribution sums/legends where relevant. Unknown profile or malformed response defers. **Done.** Response validation is all-or-nothing: reported identity, exact key set, answer `type` per question, readings finite within `0..1` (never clamped), declared labels, distributions summing near 1. Unknown profile, `endpoint.model` mismatching the profile's pinned identity, and `mode: enforce` each switch the model off with a displayed reason and leave exact rules and review untouched.
- [x] Bound state and total payload conservatively; keep the whole call or do not send it. Preserve masking; material information loss is review-required. Do not assume server capacity is discoverable via an undocumented route. **Done.** `maxPayloadTokens` (default 1024) bounds the whole request; on overflow the call becomes `defer (state_over_budget)` with the dropped fields recorded, so a command is never shown with its tail trimmed. Secret-shaped text (PEM, JWT, vendor keys, AWS ids, bearer tokens, credential assignments) is masked to `[masked:<shape>]` and documented as best-effort. No capacity probe: `num_ctx`/`/props` are not assumed, and the measured budget came from a real request that hit llama.cpp's own 2049-token error.
- [x] Implement `off`/`shadow`/`enforce` configuration but ship model authority as shadow until the next milestone. In shadow, log the proposal and show its reason while human decides. **Done; authority not shipped.** `enforce` is schema-legal and refused: config stays valid, the model is off, and the message names M3. In shadow the review shows the proposal, its readings and its reason beside the deterministic why-review. The Pi smoke asserts the dangerous direction: a model `allow` with a human rejection leaves no sentinel, a model `deny` does not block a human approval, and an unavailable endpoint still reaches a human. `createShadowConsultant` returns `undefined` for `off`, so the consultant is structurally absent rather than checked at the call site.
- [x] Record effective decision separately from model proposal, with exact profile and response identity, latency, context omissions, and reason codes. **Done.** `model` and `effective` are separate objects in each JSONL record: model side carries profile id, profile content identity, question text version, state kind, configured and served identity, proposal kind, readings/choices, aggregation, defer reason, latency, payload tokens and dropped fields; the record keeps `execution: "not_observed"` because nothing here observes execution. Off posture writes no `model` field at all.

Exit checks: offline client/state/profile tests pass; a live smoke response is validated; no shadow model allow or deny authorizes/blocks in place of human review; state/profile changes invalidate comparisons rather than silently inheriting thresholds. **All met** (315 offline tests; live contract check above; Pi smoke shadow scenarios; `profileIdentity` plus the `drift`/`comparable` guards in `src/decisions/compare.ts`).

Not met by this milestone, and why: no held-out labelled corpus, no calibration, and no false-allow rate, so no profile is defensibly better than another and none is enabled by default. Enforcement, bounded concurrency, queue limits and the breaker remain M3.

## M3 - Dependable enforcement and failure behavior

Goal: make explicit model enforcement safe enough to enable deliberately, with bounded operational behavior and honest measured limitations.

- [x] Activate model allow/deny only in explicit enforce mode. Terminal model denies carry specific reasons; model defer reaches human. Preserve blacklist precedence and whitelist authority.
- [x] Implement bounded endpoint concurrency (initially one), queue length/wait deadline, total request timeout, and cancellation propagation. Never indefinitely block the Pi hook on abandoned endpoint/UI work.
- [x] Implement the breaker: start with three consecutive operational failures, 60-second cooldown, single half-open probe. Specify counted failure kinds, reset behavior, and cancellation treatment. Zero automatic retries, especially after resets/size refusals.
- [x] Ensure deterministic rules/floors still run when the endpoint is down or breaker open. There is no `failOpen` option.
- [x] Serialize reviews with independent request association, bounded lifetime, cancellation, and cleanup. Implement standard dialogs or explicitly tested custom TUI; only claim RPC support after testing its response/deadline path.
- [x] Add failure/race tests: HTTP/timeout/reset/non-JSON/partial answers, wrong identity/profile, over-budget state, exhausted queue, repeated failures/cooldown, cancellation before/during send/review, reload/session switch/shutdown.
- [x] Optional model-only in-flight deduplication: key the full snapshot, profile, and session/turn. Defer it if it risks sharing consent or approving repeat side effects; never deduplicate human approval.
- [x] Make configuration reload atomic and failures visible. Verify active status, selected mode/profile, endpoint health, and recent review reason can be inspected without reading raw JSONL.
- [~] Evaluate the selected profile on new reviewed examples not used to tune it. *Machinery complete: `scripts/export-labels.ts` produces label templates, `src/labels.ts` admits a row as reviewed only with a named adjudicator, `src/decisions/measurement.ts` enforces provenance, a deterministic stratified held-out split, and a `insufficient-evidence`/`rejected` refusal; `scripts/measure-enforcement.ts` reports the verdict. **No reviewed examples exist yet**, so no held-out false-allow rate has been measured and every profile stays provisional. The measuring half is done; the reviewing half is an operator task.* Document any false allows/denies and the sample's limits. If unsafe approvals remain, keep model enforcement experimental/shadow by default rather than tuning away the warning.
- [~] Re-run clean Git installation, real Pi approve/deny/headless smoke tests, and a live model contract/evaluation run. *Clean install, 419 tests, and 22 real-host scenarios (including every enforce path) pass; `docs/M3-ENFORCEMENT.md` records commands, identities and outcomes. The live model contract/evaluation run is opt-in via `MODEL_BASE_URL` and has not been run, so no profile number is claimed.* Write a concise verification report with commands, runtime/profile identities, outcomes, and gaps.

Exit checks: all first-release criteria in `SPEC.md` are mapped to named tests or documented live verification. `bun run verify` is green offline. A user can intentionally enable enforce and understand its provisional status; no evaluation is described as calibrated without supporting held-out evidence.

## M4 - Evaluation and operator workflow (five phases)

Goal: operators can explain a recorded decision, reproduce its local computation,
and compare explicit profile variants without changing production policy or
executing candidate commands. Keep this work scoped to reusable evaluation, not
training or new enforcement authority. Complete M4a-M4e in order; each phase should
ship a useful independently verified capability.

Starting point: M3 already provides private bounded decision records,
`scripts/export-labels.ts`, `src/labels.ts`, `src/decisions/measurement.ts`, and
`scripts/measure-enforcement.ts`; M2 provides profile identities and comparison
machinery. Extend these rather than creating a second record, label, or scoring
pipeline. Existing records and exported labels are not necessarily sufficient to
reconstruct an exact outbound request. M3's missing reviewed examples and live
verification remain explicit gaps, not prerequisites to building offline tooling
and not completed merely by shipping M4 commands.

### M4a - Durable capture and privacy contract

Goal: preserve enough evidence for faithful replay without silently collecting or
exporting more private data.

- [ ] Inventory existing records, label exports, state builders, and profile hashes against replay requirements. Document which historical fields are recoverable and which are absent; never reconstruct missing intent, execution facts, or endpoint responses as if observed.
- [ ] Define a versioned capture/run manifest linking the immutable request, intent provenance, execution-context unknowns, policy/config identity, exact model-visible state and question text, profile identity, response/validation outcome, proposal, and effective decision. Capture raw request and masked outbound representation separately. Exclude credentials and authorization headers entirely.
- [ ] Record code revision, configured/served model identity, available server/build metadata, budgets, omissions, timestamps, and artifact hashes. Mark unavailable metadata explicitly; a model name alone is not a reproducible server build.
- [ ] Add explicit opt-in exact replay capture, with disable/delete/retention controls and bounded storage. Keep default decision logging useful without requiring richer capture; reuse private-directory protections and reject unsafe destinations rather than silently falling back into the checkout.
- [ ] Provide a deliberate sanitized export path with secret/sensitive-identifier scanning and a reviewable manifest. Redaction creates a derived artifact with a new identity and declared losses; it must not be described as an exact replay of the private original. No automatic upload, commit, or endpoint call.
- [ ] Test schema/version validation, corrupt or missing artifacts, rotation and retention, disabled capture, unsafe paths/permissions, credential exclusion, and hash mismatch. Document compatibility with existing M3 records and label exports.

Exit checks: a deterministic fixture round-trips into a durable private bundle;
its request/profile/payload hashes verify; incomplete historical records are
labelled non-replayable with reasons; sanitized export cannot silently replace the
exact original. Offline verification makes no network calls.

### M4b - Offline replay and decision explanation

Goal: answer why a call was allowed, denied, or reviewed using recorded evidence,
without contacting the model or invoking bash.

- [ ] Add a read-only inspect/replay command for an explicit capture path and request ID. Show deterministic rule/floor reasons, model proposal and validation/defer reason, effective source/outcome, intent unknowns, omissions, and `execution: not_observed` separately.
- [ ] Replay response validation and aggregation from captured response evidence using the recorded profile contract. Re-evaluate policy/state construction only when the matching implementation/config is available; otherwise explain the compatibility gap rather than claiming the current implementation reproduces history.
- [ ] Distinguish evidence inspection, verified local replay, and a current-code counterfactual. Report recorded versus recomputed outcomes and field-level differences, including changed profile text, masking, budgets, or policy.
- [ ] Refuse unsupported schemas, tampered artifacts, unavailable profile implementations, and incomplete captures with actionable reasons. Display untrusted command/response text with terminal-control sanitization, not shell interpolation.
- [ ] Test exact replay, historical-version refusal, malformed responses, model defer/failure, policy-only records, shadow/enforce distinctions, and changed-code diffs. Use a transport stub that fails the test if any network call occurs.

Exit checks: known allow/deny/defer fixtures reproduce their recorded local
outcomes; an incomplete record can still be inspected but never passes as exact
replay; inspecting dangerous command text neither executes it nor sends it out.

### M4c - Explicit scenario variants and repeatable live runs

Goal: compare deliberate experiments without editing live operator configuration
or overwriting baseline evidence.

- [ ] Add a scenario override/diff command using explicit input artifacts and a validated experiment config. Allow documented overrides such as profile, intent, cwd, execution-context facts, or budgets; each override creates a separately identified derived scenario and preserves its parent and original provenance.
- [ ] Distinguish offline re-aggregation of compatible captured readings from fresh model evaluation. A changed question/state/model requires a new response, not reuse of incompatible readings. User-authored intent/context overrides are experimental assumptions, not newly verified human authority.
- [ ] Make endpoint access an explicit live option with a specified endpoint/profile, bounded concurrency/deadlines, cancellation, and zero automatic retries. Do not inherit production enforce authority, write production config, or run candidate commands. Show what will be sent and require explicit consent for private raw artifacts.
- [ ] Persist immutable run manifests, exact transmitted payloads, validated response evidence, operational failures, latency, profile/model/build identities, and artifact hashes under privacy controls. Store no credentials; refuse accidental baseline overwrite and dangling temporary-file dependencies.
- [ ] Detect outcome/reading drift across repeated comparable runs. Separate server/profile/state changes from repeated-run variance; label runs with unavailable build metadata only partially comparable, and never imply bit-for-bit live reproducibility.
- [ ] Test scenario isolation, incompatible response reuse, explicit network opt-in, cancellation/failure persistence, manifest integrity, and comparison eligibility with deterministic endpoint fixtures. Keep any real live check opt-in and synthetic by default.

Exit checks: an operator can derive a scenario, inspect its diff, and compare two
mocked runs from durable artifacts; baseline captures and production policy stay
unchanged. A separate documented live command produces the same artifact format.

### M4d - Attributed regression intake and reviewed datasets

Goal: supply trustworthy inputs for reports without confusing imported opinions,
human authorization clicks, or previously used cases with independent evidence.

- [ ] Import a small representative set of bash-relevant hub/auto-mode regression fixtures, not the large M5 corpus. Check source availability/license first and extend the reuse ledger with revision, original case ID, adaptations, source label, and prior tuning/evaluation exposure.
- [ ] Extend the existing label workflow with stable scenario/family IDs, adjudicator, rationale, context sufficiency, and explicit label provenance. Keep synthetic labels, imported draft labels, human approval/rejection feedback, and reviewed labels distinct; an approval is not evidence of safe execution.
- [ ] Preserve conflicting source labels and adjudication history. Keep unresolved cases explicitly unresolved; document the review rubric for safe/dangerous/unsure and distinguish these safety classes from regression/leakage families.
- [ ] Audit and, where necessary, extend M3 splitting before claiming held-out evidence: related variants must stay in one regression/leakage family, assignments must be persisted, and reviewed additions must not silently reshuffle or reclassify already exposed cases as fresh holdout.
- [ ] Keep all previously used auto-mode tuning/challenge rows in development/regression evidence. Reserve genuinely new reviewed families before profile selection; record access/exposure, and retire any holdout used to tune a profile.
- [ ] Scan/redact before committing curated fixtures; retain private originals outside Git with derived-artifact links. Test duplicate/conflict handling, missing attribution, unreviewed-label exclusion, family leakage, stable split manifests, and sensitive fixture rejection.

Exit checks: a small attributed regression dataset and adjudication guide exist;
reporting can distinguish reviewed evidence from draft/synthetic evidence; related
cases cannot cross selection/holdout boundaries. If no independent reviewed data
exists, measurement still returns `insufficient-evidence` without blocking the
regression workflow.

### M4e - Reports and operator verification

Goal: combine captures, replay, runs, and labels into an honest end-to-end workflow.

- [ ] Extend existing comparison/measurement code with machine-readable and concise human reports. Lead with dangerous and unsure approvals, then false denies, model deferrals, actual human-review rate, availability/failures by reason, and latency distributions; show counts and denominators by safety class and regression family.
- [ ] Report model proposals separately from effective policy/model/human/runtime outcomes. Distinguish a model defer from completed human review, and failures/cancellation from semantic denials; do not infer execution from an effective allow.
- [ ] Define false-allow/false-deny denominators explicitly, exclude unresolved labels from binary error estimates, and report unsure approvals separately. Separate draft regression summaries from reviewed held-out measurements; include sample limits/uncertainty and never call raw model readings calibrated probabilities.
- [ ] Compare only compatible dataset/split/profile/run identities, or display explicit non-comparability reasons. Expose changes in payload, questions, masking, model/build metadata, and missing responses rather than folding them into a single accuracy number.
- [ ] Document exact commands for private capture, inspection, offline replay, derived-scenario diff, explicit live evaluation, label adjudication, and profile comparison. Include sanitized example outputs and rollback/deletion instructions; register shipped scripts in `package.json` without implying proposed commands already exist.
- [ ] Add an offline end-to-end fixture covering capture through report, with policy allow/deny, shadow/enforce, model failure, cancellation, unreviewed/conflicting labels, insufficient evidence, and drift. Re-run `bun run verify`; if capture touches the runtime, also re-run real Pi smoke tests to prove record failures cannot grant authority or change one-shot consent.
- [ ] Write a verification report listing commands, artifact/schema/profile identities, observed outcomes, and remaining operator/live-review gaps. Run optional live verification only with explicit endpoint consent and preserve its manifest; do not silently close M3's evidence gaps.

Exit checks: operators can explain one recorded decision, verify or explicitly
refuse its replay, compare a derived scenario, and generate a provenance-qualified
report without executing candidate commands or changing production policy. Empty
or contaminated holdouts yield no calibration/safety claim. All offline checks
pass and live verification remains separately opt-in.

Session-scoped grants are not part of M4: evaluation does not need additional
authority. Consider them later as an independent design with narrow explicit scope,
visible revocation, blacklist precedence, and no invisible persistence.

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
MODEL_BASE_URL=http://host:port bun run test:live  # opt-in synthetic requests to configured live endpoint
bun run test:pi              # opt-in disposable Pi 1.5.2 runtime/install smoke tests
bun run evaluate            # text-only corpus evaluation, explicit profile/endpoint
```

No particular additional lint/format package is mandated; choose a small coherent toolchain. A Git installer may use npm/pnpm internally according to Pi settings: Bun is the development workflow requirement, not an excuse to require Bun inside the host or override Pi's installation machinery.

## Handoff discipline

Do not spend the initial implementation on monorepo onboarding, generalized authorizer infrastructure, npm publishing, older Pi compatibility, Python descriptor execution prototypes, full LLM review, or training. First prove a small standalone gate, then add deterministic policy and review reasons, then shadow the model, then harden/measure explicit enforcement. Preserve useful evidence for later without making later ambitions block each usable milestone.
