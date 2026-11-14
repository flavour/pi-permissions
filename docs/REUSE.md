# Source inspection and reuse ledger

## Scope and status

This records the M0 source-revision/license prerequisite from `PLAN.md`, not completion of M0. The source checkouts were inspected read-only. No source implementation, tests, prompts, configuration profiles, or corpus rows have been copied or adapted into this repository by this work. Only this ledger and `THIRD_PARTY_NOTICES.md` are added. The findings below are inspection evidence, not runtime verification or permission to redistribute material with unresolved provenance.

Paths beginning with `~/` refer to `/home/fran/` in the inspected environment. Local file hashes below identify inspected auto-mode bytes where a Git revision cannot be recovered; they are not substitutes for a source commit or license grant.

## Source identities and license findings

| Source | Revision and checkout evidence | License evidence | Reuse status |
| --- | --- | --- | --- |
| `~/code/pi-packages/packages/pi-permission-decisions-judge/` | Repository HEAD `af09a3de8ece7f124c1fd19a692958206fca64cf`; repository-wide `git status --porcelain=v1 --untracked-files=all` was empty. Origin `git@github.com:flavour/pi-packages.git`; upstream `git@github.com:gotgenes/pi-packages.git`. | Package `package.json` declares `MIT`, author Fran Boon, private version `0.1.0`. No package-local LICENSE or repository-root LICENSE was found. The sibling hub's license is not proof of the judge's copyright notice. | Read-only orchestration reference. Before copying, obtain/confirm the applicable MIT notice and copyright ownership for the selected files. |
| `~/code/pi-packages/packages/pi-permission-system/` | Same repository revision and clean checkout as above. | Package-local `LICENSE`: MIT, copyright (c) 2026 MasuRii and Christopher D. Lasher. Package metadata identifies `@gotgenes/pi-permission-system` version `42.0.0`. | Only package metadata/license checked in this pass; no hub implementation or fixtures adopted. Preserve its full MIT text if covered material is later copied. |
| `~/code/auto-mode/plugins/auto-mode/` | Git revision **unavailable**. `~/code/auto-mode/.git` points to `/home/fboon/code/oxeaicoding/.git/worktrees/auto-mode`, which does not exist here. `git rev-parse HEAD`, `git remote -v`, and `git status --short` fail. Cannot assert checkout cleanliness, branch, remote, or commit. | Plugin `package.json` identifies private `@oxeaicoding/auto-mode` version `0.1.0` but has no license field. No project LICENSE/NOTICE was found in the source-tree search excluding dependencies and Git metadata. Root `pyproject.toml` and `setup.py` supplied no license evidence. | Inspection only. Copying code, prompts, profiles, or datasets is deferred pending an applicable license/permission and durable revision provenance. User authorization to inspect/reuse is not itself evidence of third-party rights. |

The license search covered filename matches for license/notice in both source trees, excluding `node_modules` and Git metadata, plus a follow-up search for COPYING/license/notice near the auto-mode root excluding `.venv`. This is not an audit of dependency licenses or of every embedded/externally attributed asset. Dependency license files do not license the containing project.

## Inspected paths and findings

### Existing judge

Paths below are relative to `~/code/pi-packages/packages/pi-permission-decisions-judge/` unless explicitly qualified.

| Inspected material | Finding and intended treatment |
| --- | --- |
| `package.json` | Host and hub peers, workspace catalog dev dependencies, Vitest scripts, and Zod dependency belong to the old packaging. Do not import its toolchain or runtime dependency on the hub. |
| `src/index.ts` | Entry point delegates to extension registration; installing the judge alone does not activate enforcement. M0 needs an independently active Pi gate instead. |
| `src/extension.ts` | Loads configuration on `session_start`, captures processed `before_agent_start.prompt`, resolves the hub service on `PERMISSIONS_READY_CHANNEL`, registers an authorizer once, and disposes on shutdown. No configuration or unresolved service means no registered judge. Replace service lookup/registration and absence behavior, not merely rename the link. |
| `src/judge.ts` | Useful fixed ordering: scope/command checks, floor/opaque checks, bounded state, transport, aggregation, dry-run handling, structured logging. Technical failures produce `defer`; the hub supplies subsequent review. Command recovery walks session entries by tool-call ID. A standalone adapter must use the current call input/cwd and resolve defer to a human or block, never fall through. |
| `src/config.ts` (targeted search) | Default model is `LiquidAI/d1-3B-GGUF:Q8_0`; `dryRun` defaults to false. Do not inherit either as the new model/mode default. Full configuration validation was not audited here. |
| `src/systemone.ts` (targeted search) | Returned `noul` values are clamped with `Math.min`/`Math.max`. Later reuse must reject malformed/out-of-range readings rather than normalize them into valid decisions. Full transport contract was not audited here. |

Repository `~/code/pi-packages/AGENTS.md`, root `package.json`, tracked judge path listing, and the hub's `package.json`/`LICENSE` were also inspected for repository and license context. No assumption that the judge is a verified Pi 1.5.2 adapter follows from this inspection. In particular, its startup cwd and processed prompt capture are not the new request/provenance contract.

### Auto-mode

Paths below are relative to `~/code/auto-mode/`.

| Inspected material | Finding and intended treatment |
| --- | --- |
| `.git`, `pyproject.toml`, `setup.py`; plugin `package.json`, `index.ts` | Broken worktree metadata; no verified source revision or project license. Plugin entry re-exports `src/index.ts`. |
| `plugins/auto-mode/docs/HANDOFF.md`, `docs/LOW_INTERVENTION.md` | Retained experiments are development evidence. The v1 syntax veto failed destructive method-alias cases; v2 is a repair using an already-consumed challenge, not independent validation. Execution binding/resource work is prototype/proposal material, not production authority. |
| `plugins/auto-mode/docs/SPEC.md` (opening sections through failure behavior), `docs/EVALUATION.md` (opening risk-first evaluation sections) | OpenCode shell interception and native grants are platform-specific. Recorded experiments include materially unresolved calls incorrectly approved; high harmless approval or repeated identical responses is not proof of safety. Reports were read, not rerun or independently validated. |
| `plugins/auto-mode/src/index.ts` | Requires explicit dry-run opt-in, installs an OpenCode transform, captures session context, and cleans up. Missing classifier config disables observation; this is not the new gate's failure behavior. |
| `plugins/auto-mode/src/shell-transform.ts` (installation/execution/cleanup section) | Wraps original shell execution, classifies with cancellation and invocation association, logs, then deliberately calls the original executor for every classification/failure. Borrow the lifecycle/association lessons later, never this advisory fall-through as enforcement. |
| `plugins/auto-mode/config/decision-profiles.json`, `src/decision-candidate.ts` | Exact named wording/layout/model/threshold combinations are experimental variants, not universal defaults. Candidate evaluation separates model decision from missing-evidence downgrade reasons. No profile selected or imported. |
| `plugins/auto-mode/src/decision-context.ts` | Pure context assembly with exact invocation, provenance-bearing evidence, hashes, explicit missing dependencies, and no silent byte-budget truncation. Assembly is not a source collector or proof of dependency completeness. |
| `plugins/auto-mode/src/systemone-candidate.ts` | Builds serialized-string state and validates response identity, answer shape, finite probabilities, sums, and score legends where relevant. This representation must not silently replace the judge's object-state contract in comparisons. |

The reported `d1-trace-choice-flat-v3` plus `syntax-review-veto-v2` result is 27/40 harmless approvals with zero observed dangerous/unresolved approvals on 141 used regression rows; the repaired challenge reports 3/4 harmless approvals. These figures are attributed to the inspected source documentation, not a new measurement. The Python-focused veto implementation and raw reports/corpora were not audited in this pass; no bash containment or calibration claim follows.

## M0: independent minimal adapter, deferred selective reuse

M0 should independently implement the smallest Pi 1.5.2 bash-only human gate. This is limited independence at the host adapter seam, not a decision to rewrite the existing model/state machinery from scratch. It does not supersede the selective-reuse direction in `PLAN.md`.

- Register the covered `tool_call` path without hub readiness, a service locator, or an authorizer chain. Missing/invalid configuration must not unregister it.
- Ask a human for the exact current bash call, or explicitly block without usable review. No model, parser preset, or corpus is necessary to prove this seam.
- Map deny/cancellation/unresolved review to the actual Pi block contract. Internal defer is not permission to return control to execution.
- Obtain platform facts and UI/cancellation behavior from the installed Pi 1.5.2 docs/source and a disposable approved smoke fixture before claiming enforcement. This inspection did not perform that proof.
- Keep raw-input provenance, current cwd, command mutation/order, shell prefix/backend, and standard versus replacement bash explicit. The old judge's processed prompt/session command recovery is not authority for the new adapter.

| Later work | Candidate reuse | Required adaptation/verification before adoption |
| --- | --- | --- |
| M1 policy/review | Judge floor/config ideas; selected hub bash fixtures and analysis lessons | Inspect implementations/tests and their attribution first; choose a bounded grammar; exact/global-only rules; blacklist precedence; full-call and per-request review tests. No hub runtime imports. |
| M2 shadow model | Judge client/state/masking/questions/aggregation and selected tests | Resolve judge notice gap; inspect full files/tests; enforce actual model identity and finite in-range readings; budget full payload, preserve whole command; migrate useful fixtures to Bun/TypeScript rather than inherit Python/Vitest requirements. |
| M2 candidate comparison | Auto-mode context/profile/transport ideas and measured counterexamples | Resolve license/revision gap; preserve exact wording, representation, thresholds, model and hashes; compare unsafe and uncertain approvals, not approval rate alone. Keep default authority shadow. |
| M3 resilience | Lifecycle/cancellation/association lessons from both sources | Independent bounded queue/breaker/review tests and real Pi approve/deny/headless checks. Do not import OpenCode transforms or native grants. |
| M4+ corpus/evaluation | Selected attributed fixtures, reports, family/label structures | Inspect each selected asset, resolve rights and external provenance, scan sensitive data, adjudicate labels and preserve failures; already-used challenges remain regressions. |

Deferred/out of scope: hub service locator, forwarded approvals, external-directory permission machinery, generalized authorizer architecture, OpenCode runtime integration, Python execution-binding/descriptor machinery, executor replacement, source collection, training, and wholesale source/toolchain copying.

## Gaps and next evidence

1. Recover a durable auto-mode source commit/remote and establish license/permission for each intended class of copied material. Do not repair the reference checkout as part of this task.
2. Confirm the judge's applicable full MIT/copyright notice; do not substitute the hub's sibling notice or infer copyright years from package authorship.
3. Audit per-file upstream attribution, embedded prompts, fixture origins, and dependency licenses when actual imports are chosen. No blanket source-tree clearance is claimed.
4. Inspect the full judge client/state/config/floor/questions/tests and selected hub bash analysis/tests before porting. They are source-map candidates, not reviewed/adopted modules yet.
5. Inspect auto-mode veto code, raw evaluation manifests, corpus labels/families, and referenced temporary assets before reuse. Availability of `/tmp/opencode` artifacts was not checked here.
6. Prove the Pi 1.5.2 platform seam, install/runtime activation, UI/headless behavior, timeout/cancellation, extension composition, and no-side-effect rejection. No Pi smoke, endpoint call, classifier evaluation, source tests, or candidate command execution was run for this documentation task.

For each future adoption, add a row recording source path/revision (and hash if needed), license/notice evidence, destination, exact code/data/profile adopted, changed assumptions, verification command/result, and remaining gaps. Update `THIRD_PARTY_NOTICES.md` with required verbatim notices **before** redistributing copied material.

## Auto-mode inspected-file fingerprints

SHA-256 over complete local files, including files whose inspection above was limited to named sections. These fingerprints preserve the identity of the observed snapshot without asserting its Git history.

```text
bb6de64a3167fdaf79346311dad3abcd6624c35422a589f2c49023c240f408a5  .git
f3d6acce5e4fd07d875afaab1b6c04ffe31b5c32fd3b15c873fa846c9708d2ef  pyproject.toml
3cc88b3effd03f01e753efe30a71af43fbc19655b94b3c3d2c5ee679316d6b0d  setup.py
d69f3e4a5fd102d2f35716855db7f55c3a796254d9986b1fadeb489c64345293  plugins/auto-mode/package.json
206284adf3e4e0734f607e3b3288c8529d10594a16421a679a2ba7841fd8ffb7  plugins/auto-mode/index.ts
43cfbb2bcaa3687f441c2e79f01dc46dde9c3775ec9431a2a31969ae3c8c6d0a  plugins/auto-mode/docs/HANDOFF.md
060fa60fd1eb92bc6584d930aaae4e23c2f92e160674d0493722d98c18306a7b  plugins/auto-mode/docs/LOW_INTERVENTION.md
0a7306ac3bc80f55036d28370c7d5d65ca476721fda0dedd4578e3032fa45517  plugins/auto-mode/docs/SPEC.md
22c1a5d30bfadaf6191db56d7ce4db920045c3a1a0f5001dfc9fe63c31b115fa  plugins/auto-mode/docs/EVALUATION.md
c511932a45c8bd46c5bc99095b7c0cc51d1f0810efe5f55e48d13a709968ea09  plugins/auto-mode/src/index.ts
23af7e4a52551f61b85e0b1745cf5fa9d77762bc5e36d0adbf42dcdfafb33f10  plugins/auto-mode/src/shell-transform.ts
01bd582a9fe8d84d43091e52dc61616405c4138fb0f937992edf6215fe302641  plugins/auto-mode/config/decision-profiles.json
435329c23b855121d74d7021d2be46747fb10525cca2f4c71ce691a10640f047  plugins/auto-mode/src/decision-candidate.ts
90ad723bb4f2900132df305eb0745c10cddac681f9257d8ae8e4428ec49e6e9d  plugins/auto-mode/src/decision-context.ts
88a575bb478267f07d2d69c60198575aaa07b8e997df669ad02c7467f480fc33  plugins/auto-mode/src/systemone-candidate.ts
```
