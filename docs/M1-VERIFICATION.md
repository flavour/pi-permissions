# M1 verification and remaining scope

Verified 2026-11-14, normal Node **v24.22.1**, Bun **1.4.4**, Pi **1.5.2**. This is a conservative M1 implementation, not a model release or complete execution sandbox.

## Commands and evidence

- `bun install --frozen-lockfile`: passes; no runtime dependencies. Original exact Biome 2.3.8 toolchain retained; speculative Zod/model dependency removed.
- `bun run verify`: TypeScript, Biome, schema/example consistency and offline tests pass: **193 tests, 707 assertions, zero failures**. Tests only classify command text; they do not execute adversarial/corpus examples.
- `bun run test:pi --consent`: passes through Pi's real managed Git installer into an isolated agent directory, production dependencies only, then normal Node's Pi SDK. Automated UI adapters, no provider or endpoint requests. The only approved operation writes the expected harmless `smoke` sentinel in a disposable directory. Reject, print/JSON/RPC, UI failure, cancellation, throwing hook, replacement bash, prefixed review rejection and extension-load-error scenarios do not execute their sentinels. All cases have zero unexpected lifecycle errors; the intentional throwing extension has its expected load diagnostic.

The smoke initially exposed a fixture defect: its UI Proxy did not provide enumerable `setStatus`/`notify`, which the SDK copies. The fixed fixture now asserts zero lifecycle errors and checks the deliberate hook exception in the returned **tool error**, rather than accidentally passing on an unrelated status-method exception.

Offline regression tests also exposed live prefix/session/tool-call identity mutations surviving review. Approval validation now rechecks command, timeout, cwd, session ID, tool-call ID, shell prefix/path, cancellation and effective tool provenance before recording an effective decision. A later extension can still mutate after this handler returns; this is a documented composition limitation.

## Coverage map

| Requirement | Evidence |
| --- | --- |
| Immutable request and structured assessments | `request.ts`, `gate.test.ts`; separate policy/reviewer/orchestrator/adapter |
| Global-only config, missing/invalid, strict matcher/schema | `config.test.ts`; generated schema/example parity |
| Blacklist wins, stable IDs, exact cwd and complete command | `policy.test.ts`, `extension.test.ts` |
| Shell operators, redirects, substitutions, quotes, comments, wrappers, assignments, malformed, Unicode/control, effectful flags and shadowing | `policy.test.ts`; all unmatched shapes defer, no inferred safe prefixes |
| Raw/processed/queued/missing intent and lifecycle | `gate.test.ts`, `extension.test.ts`; ambiguous provenance stays unknown |
| Whole command/cwd, concrete why, escaping, one-shot responses | `gate.test.ts`, `extension.test.ts` |
| Reject/dismiss/failure/deadline/abort, bounded serialized independent reviews | `gate.test.ts`, `extension.test.ts` |
| Mutation, session navigation/shutdown/input cancellation | `extension.test.ts` |
| No UI and RPC block, actual installation/execution path | `extension.test.ts`, real Pi smoke |
| Private bounded raw records distinct from execution | `records.test.ts`, adapter records-disable test |

## Explicitly deferred / unsupported

- **Built-in easy-safe automatic grants:** the M1 plan item remains open. Even colon/true/false have shell-context assumptions; no executable-name rule is called read-only. Explicit exact whitelists provide useful operator-approved automation instead. `argvPrefix` is rejected, not loosely accepted. See `M1-POLICY.md` for source comparison and grammar.
- Queued/steering input cannot be durably joined to a run through Pi's public API. Only eligible idle interactive text with an unchanged starting user prompt can be shown as conditionally associated context, under audited non-transforming handler composition. No captured text itself authorizes execution.
- The smoke uses the real **nested** hook-mediated SDK path, not a top-level provider-generated tool batch. Both adapter paths use the same policy; neither establishes human provenance automatically. No physical-terminal scrolling/key/rendering or real provider loop is claimed tested.
- No model transport, profiles, shadow/enforce modes, endpoint evaluation or model authority. `decisions.ts` is an empty M2 placeholder; the unfinished speculative client was not shipped.
- No final spawn/resource binding, sandbox, untrusted later extensions, arbitrary SDK backend attestation, or RPC review support. Unknown shell startup/backend/files are displayed. A configured prefix or shell disables automatic whitelist authority.
- Records describe decisions only, with execution explicitly unobserved. Early unsupported-runtime/tool rejection and exceptional adapter failures do not yet emit full records. Shared multi-process record rotation is unsupported.
- Upstream assets were inspected for lessons, not imported without cleared provenance/licenses. The source-evaluation ledger is in `M1-POLICY.md`; no new third-party notices are required for independently written implementation and fixtures.

M1 is independently useful in this conservative form. `PLAN.md` intentionally leaves the preset sub-item open rather than calling it fully complete or pretending that parser recognition proves execution safety.
