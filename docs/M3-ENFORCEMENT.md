# M3 — Enforcement mode, provisional

Implemented 2026-11-16.

**`enforce` lets a model *deny* terminally. It never lets a model *allow*
silently.** In every mode, an approval path ends at a human. That single sentence
is the reason this milestone exists, and most of the code here is machinery for
keeping it true under failure, reload, and time pressure.

A profile may be configured `enforce`, but no profile in this package is
`operational`: every one is `provisional`, and `enforce` additionally requires an
explicit acknowledgement in the config file. The acknowledgement is not a
formality — see [Why acknowledgement is required](#why-acknowledgement-is-required).

---

## What `enforce` changes, and what it cannot

| Situation | `shadow` | `enforce` |
| --- | --- | --- |
| Model says **allow** | recorded; human reviews | **provisional**; human still reviews |
| Model says **deny** | recorded; human reviews | **terminal deny** — call blocked, no review |
| Model says **unsure** / defers | human reviews | human reviews |
| Endpoint down, slow, breaker open | human reviews | human reviews |
| Anything the model asserts | no authority | authority to **block**, only |

The asymmetry is deliberate. A false deny costs one round trip to a human who can
override it. A false allow costs whatever the command does to the machine. The
gate is allowed to be over-cautious on the model's word and is never allowed to be
trusting on it.

Ordering is fixed and identical in both modes: **global blacklist → global
whitelist → model (if consulted) → human review**. A model never sees a call that
deterministic policy already decided, and no model result — `deny`, `allow`, or
garbage — can bypass the blacklist.

## The operational controls

Four pieces of machinery sit between the gate and the endpoint. Each exists
because its absence made a *worse* failure more likely, and each is inert when the
model is off.

**Circuit breaker** (`src/decisions/breaker.ts`). A dead endpoint must not add its
full timeout to every gated command. Consecutive failures trip the breaker; while
open, calls defer immediately with `breaker_open`, so the human pays no endpoint
latency. Half-open probes let it recover. Trips are recorded and visible in
`/permissions`.

**Concurrency limiter** (`src/decisions/limiter.ts`). Endpoint capacity is small
and shared with whatever else uses it. Waiters queue; a caller whose own deadline
passes while queued gives up with `queue_deadline` rather than holding the hook
open past the point where the answer is useful. A cancelled caller is never
counted as a timeout — conflating them would make a user's Ctrl-C look like an
endpoint outage in every subsequent diagnosis.

**In-flight sharing** (`src/decisions/inflight.ts`). Identical concurrent calls
share one *computation*. They never share a decision, a review, or a record. Keys
are content-addressed and scoped to the profile identity, so a verdict from one
profile can never be served to another. Entries are dropped when settled and on
shutdown; an abandoned entry is not resurrected by a late joiner.

**Deadline discipline** (`src/decisions/systemone.ts`). Each request gets its own
deadline measured from its own start, not from a shared beginning. Retries happen
only within the remaining window. A transport that ignores abort signals cannot
deliver to an aborted caller.

### Review queue

`src/ask.ts` bounds the review queue and expires queued work rather than showing
a stale prompt. If the queue is full, the caller is told to retry *only after
consulting the user* — the gate does not silently drop the request and does not
run it. Expiry uses a per-item deadline; nothing is measured from a shared start
time, so one long wait cannot shorten everyone else's window.

---

## Authority: the rules that cannot be configured away

`src/adapter.ts` is the only place a model result becomes something the gate can
act on. Its guarantees:

- A model `allow` yields `{ kind: "allow", provisional: true }` at most. The
  handler treats provisional allows as *route to review*, never as run.
- `modelAuthority` is `none` unless the posture is `enforce` **and** the profile
  is known **and** its identity matches. A stale snapshot cannot widen authority.
- A model `deny` is terminal **only** in `enforce`. In `shadow` the same verdict
  is recorded and the human still decides.
- Every failure mode is a `defer` with a distinct reason code: `endpoint_down`,
  `timeout`, `parse`, `range`, `breaker_open`, `queue_deadline`,
  `payload_too_large`, `aborted`, `identity_mismatch`. Distinctness matters: an
  operator reading a record must be able to tell a user's cancellation from an
  endpoint outage.
- A model result is ignored after the underlying call has already been decided —
  a late answer cannot rewrite a settled one.

`src/handler.ts` enforces the rest: the model is consulted after deterministic
rules, its verdict is recorded with the profile identity and all readings, and
`enforce` denials carry the reason the model gave.

## Configuration

```json
{
  "model": {
    "mode": "enforce",
    "profile": "minrule-4q-conservative",
    "enforceAcknowledgement": "I understand this profile is provisional and its allows may be wrong",
    "endpoint": { "baseUrl": "http://127.0.0.1:9931", "model": "…", "timeoutMs": 2000 },
    "maxPayloadTokens": 1024,
    "operational": { "dedupe": true, "concurrency": 1, "maxQueue": 2, "breakerFailures": 3 }
  }
}
```

- `mode: "enforce"` without the exact acknowledgement string is **rejected**: the
  config falls back to model-off with a diagnostic naming the problem. Not a
  warning in a log nobody reads.
- A rejected or malformed `model` block switches the model off and says why. It
  never half-loads.
- Changing the acknowledgement text is an operator action with a real cost, so the
  string is checked exactly.

`/permissions` prints the live posture without reading raw records: mode, profile
and identity, endpoint health, breaker state, queue depth, last reason code.

## Reload semantics

A config edit swaps in a **new runtime object** (`src/runtime.ts`); the previous
one keeps serving requests already in flight. No half-initialised runtime can
serve a decision, and a request is never evaluated against two postures. This is
tested by firing a command during a reload and asserting the old posture's outcome
is used.

---

## Evidence: how a profile could ever stop being provisional

M3's real deliverable is not the code path — it is an answer to *"is this
profile's false-allow rate known well enough to block on?"* The reference projects
reported accuracy numbers on small, non-held-out sets and shipped profiles that
approved dangerous commands. `src/decisions/measurement.ts` exists to make that
particular mistake unavailable.

Three rules, each enforced in code:

1. **Provenance.** Author-written cases (the `SYNTHETIC_CASES` corpus) can detect
   a regression. They cannot estimate a false-allow rate, because nobody
   adjudicated them against what happened. Only rows a named human adjudicated
   count as evidence, and `calibrationCurve` returns `usable: false` with that
   reason when there are none.
2. **A held-out split.** `stratifiedHoldout` splits by family using a content
   hash, so the same cases and seed always give the same halves, adding a case to
   one family cannot reshuffle another family's assignment, and no case appears on
   both sides. A profile is never judged on the examples it was chosen with.
3. **A refusal.** Below 10 reviewed held-out examples per family, or if *any*
   held-out dangerous case was approved, or any unresolved case was approved, the
   verdict is `insufficient-evidence` or `rejected`. Never "it looked fine".

`scripts/export-labels.ts` writes the label templates; `src/labels.ts` refuses a
row as reviewed unless a human filled in a label **and** named who adjudicated it.
A held-out rate with no attributable source is a number with no source, and the
measurement module will not quote one.

`scripts/measure-enforcement.ts` produces the report. Two things about it are
worth stating because they are where the shortcuts usually creep in:

- **`approved` is computed by the shipped aggregation**, not by thresholding the
  headline reading. A min-rule with named vetoes approves on the *minimum* band,
  so comparing `authorized >= 0.9` disagrees with the gate the profile actually
  runs inside — and disagrees in the direction that hides false allows.
- **The calibration score means the same thing for both profile kinds**: for
  min-rule it is the weakest required band's distance from the allow line; for
  choice it is the probability on the winning label. Both are what the profile's
  own decision rule is sensitive to.

Verdicts: `insufficient-evidence` → `rejected` → `candidate`. `candidate` means
the evidence did not object. It does not grant authority: turning `enforce` on is
still a config edit with an acknowledgement, and a `candidate` profile still ships
as provisional.

Guidance for choosing between profiles is in code, not prose:
`selectionGuidance(profile)` states each one's decision rule and tradeoff, and
carries the fact that none is operational. `bun scripts/measure-enforcement.ts
--guidance` prints it.

---

## Verification

`bun run verify` (typecheck, lint, tests) and
`PI_PERMISSIONS_SMOKE=1 bun scripts/pi-smoke.ts` (real Pi host).

### Unit and integration: 419 pass, 0 fail (24 files, 1473 assertions)

M3-specific suites: `handler.authority.test.ts` (who is consulted, and what a
model result may do), `adapter.enforce.test.ts` (authority rule and every failure
rule), `decisions/breaker.test.ts`, `decisions/limiter.test.ts`,
`decisions/inflight.test.ts`, `decisions/propose.controls.test.ts`,
`decisions/measurement.test.ts` (13), `labels.test.ts` (12), `m3-scripts.test.ts`
(10), plus `ask.test.ts` queue bounds and `extension.test.ts` reload.

### Live host: 22 scenarios, exit 0, `hookErrors: 0`, `loadErrors: 0`

| Scenario | confirms | isError | endpoint calls | breaker trips |
| --- | --- | --- | --- | --- |
| `shadow-model-approval-rejected` | 1 | true | 1 | 0 |
| `shadow-model-denial-not-terminal` | 1 | false | 1 | 0 |
| `shadow-endpoint-unavailable` | 1 | true | 1 | 0 |
| `model-off-asks-nothing` | 1 | true | 0 | 0 |
| `enforce-model-deny-terminal` | **0** | **true** | 1 | 0 |
| `enforce-model-allow-still-reviewed` | 1 | false | 1 | 0 |
| `enforce-model-allow-rejected` | 1 | true | 1 | 0 |
| `enforce-endpoint-grants-nothing` | 1 | true | 1 | 0 |
| `enforce-dedup-shares-computation-only` | **2** | false | **1** | 0 |
| `dedupe-off-asks-the-endpoint-each-time` | 2 | false | 2 | 0 |
| `enforce-breaker-opens-in-the-live-gate` | 3 | false | **2** | **1** |

The rows worth reading twice:

- `enforce-model-deny-terminal`: **0 confirmations** and `isError: true`. The call
  was blocked with no human involved — the one thing `enforce` adds.
- `enforce-model-allow-still-reviewed`: **1 confirmation**. The model approved and
  the human still had to say yes.
- `enforce-dedup-shares-computation-only`: **1 endpoint call, 2 confirmations**.
  Sharing a computation does not share an approval. `dedupe-off-…` is the control
  that proves the sharing is real: same shape, dedupe off, 2 endpoint calls.
  (Pi 1.5.2 does dispatch concurrent tool calls here; the fixture holds its
  response so the two calls genuinely overlap.)
- `enforce-breaker-opens-in-the-live-gate`: 3 calls, **2** endpoint requests,
  **1** trip. Two failures opened the breaker; the third call deferred to the human
  without contacting the endpoint.

`model-off-asks-nothing` is the invariant for M1's world: with the model off,
**0** endpoint calls, and behaviour identical to before M2/M3.

### Measurement

Offline measurement runs against recorded readings only — the script will not
invent a number, and refuses a row whose recorded profile identity differs.
`m3-scripts.test.ts` exercises the real scripts and asserts the three outcomes:
`REJECTED` when a held-out dangerous command would have been approved,
`INSUFFICIENT-EVIDENCE` when the calibration gap is too wide even though the
families separate cleanly, and `CANDIDATE` (with its disclaimer) when the evidence
supports it. The last case exists so the refusal is a threshold rather than a
ratchet.

`bun run test:live` remains opt-in and requires `MODEL_BASE_URL`; it did not run
here, and no number in this document comes from it.

### Not established

- **No profile has a measured held-out false-allow rate.** The 17 labelled cases
  in `SYNTHETIC_CASES` (6 safe, 7 dangerous, 4 unsure) are synthetic, authored in
  this repo, and labelled by expectation rather than by adjudication against what
  happened. Everything above measures *machinery*, not profile quality.
  `provisional` is therefore the correct status for every profile, and no amount of
  passing machinery tests changes it.
- **No reviewed examples exist yet.** Producing them is an operator task:
  `scripts/export-labels.ts`, label the rows, then `scripts/measure-enforcement.ts`.
- Endpoint throughput under real load is unmeasured; the limiter's bounds are
  chosen to be conservative, not tuned.

## Where the risk actually sits

The M3 code is not the risky part. The risky part is a future reader — human or
agent — who sees `mode: "enforce"` and concludes the model has been trusted with
approvals. It has not. If you are changing this and the distinction stops being
obvious in the code, that is the bug to fix.
