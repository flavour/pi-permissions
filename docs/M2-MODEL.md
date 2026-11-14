# M2 - Decisions Model in shadow mode

Implemented 2026-11-14. **Every model outcome is a proposal with no authority.** A
shadow `allow` never runs a command, and a shadow `deny` never blocks one in place
of a human. The deterministic gate decides; the model only adds a reading the
reviewer can see and disagree with.

## What ships

| Surface | Behaviour |
| --- | --- |
| `off` | No request is built or sent. The consultant is structurally absent. |
| `shadow` | One request per deferred call; the proposal is shown and recorded. |
| `enforce` | **Refused.** Config is valid, the model is switched off, and the reason is displayed. Authority arrives in M3 with queue, breaker and held-out evidence. |

A deferred call asks the model **once**. There is no retry, no cross-profile
fallback and no second question group: a fifth question would start a new group on
the endpoint and pay a second round trip, so profiles carry three or four.

## Configuration

`<agentDir>/extensions/pi-permissions/config.json`:

```json
{
  "version": 1,
  "whitelist": [],
  "blacklist": [],
  "model": {
    "mode": "shadow",
    "profile": "minrule-4q-conservative",
    "maxPayloadTokens": 1024,
    "endpoint": {
      "baseUrl": "http://jetson.lan:9931",
      "model": "LiquidAI/d1-2B-GGUF:Q8_0",
      "timeoutMs": 1500
    }
  }
}
```

The model block is optional and absent by default, which is `off`. The deterministic
gate is unchanged by anything in it: a malformed, unknown-profile or unreachable
model never disables exact rules or human review.

Configuration errors switch the model off **with a reason**, they do not guess:

- unknown `profile` id → off, with the list of known ids in the docs;
- `endpoint.model` not equal to the profile's pinned identity → off. A profile is a
  claim about one model; measuring a different model under its thresholds is how a
  profile gets credited with numbers that are not its own;
- `mode: "enforce"` → off, until enforcement exists;
- credentials go in `MODEL_API_KEY` (Authorization header) for the scripts. A
  basic-auth URL is rejected: it lands in logs and shell history.

`http://` on a LAN host is accepted and is **not** a trust guarantee. Nothing in
this package authenticates the endpoint, and a host on the local network can answer
anything. The endpoint's readings are treated as an unverified opinion, which is
exactly why they carry no authority.

## Contract

`POST <baseUrl>/v1/systemone` — slashless, as probed live; the trailing-slash route
returns 404. Payload `{ model, state, questions }`; `answers` echo the question keys.

Validation is all-or-nothing per response (`src/decisions/systemone.ts`): reported
identity, the exact key set, answer `type` matching the question, readings finite and
inside `0..1` (**never clamped**), declared choice labels, and distribution sums
near 1. A violation is `endpoint_*` and defers.

Failures are named, never blended. Every `EndpointError` kind becomes
`endpoint_<kind>` — `endpoint_unreachable`, `endpoint_timeout`, `endpoint_http`,
`endpoint_parse`, `endpoint_identity`, `endpoint_range` — and an unexpected failure
becomes `endpoint_unknown` rather than an exception, so the review path never depends
on the model layer succeeding. The remaining defer reason codes are `cancelled`,
`no_command`, `missing_answer`, `state_over_budget`, `context_omitted`,
`floor_never_allow`, `not_wholly_visible`, and the aggregation outcomes
`below_allow`, `veto_uncertain` (min-rule) or `unsafe_not_excluded`,
`dangerous_uncertain`, `unsure`, `undeclared_label` (categorical). An unavailable
endpoint is a `defer` that still reaches the human.

## Profiles

All three are pinned to `LiquidAI/d1-2B-GGUF:Q8_0` and ship as **named experiments**.
No winner has been established on held-out data, so the operator selects one
explicitly and nothing falls back to another profile.

| id | question keys (type) | state | aggregation | thresholds | text version | identity (short) |
| --- | --- | --- | --- | --- | --- | --- |
| `minrule-4q-conservative` | `authorized`, `reversible`, `blast_radius`, `exfiltration` (all `noul`; `exfiltration` is the veto) | `object-state-v1` | `min-rule-named-veto-v1` | `allow` 0.90, `deny` 0.05 | `2026-10-15.1` | `1c5bc7259974` |
| `minrule-4q-judge-band` | identical text and rule | `object-state-v1` | `min-rule-named-veto-v1` | `allow` 0.70, `deny` 0.30 | `2026-10-15.1` | `58bfd5a29ed6` |
| `choice-3way-cleanroom` | `decision` (`choice`: safe / dangerous / unsure) | `string-state-v1` | `choice-argmax-v1` | `allow` 0.90, `unsafeMax` 0.05, `block` 0.90 | `2026-11-14.1` | `7fde62d700b2` |

All three use the endpoint path `/v1/systemone` and pin `LiquidAI/d1-2B-GGUF:Q8_0`.

`profileIdentity()` is a content hash over id, kind, model, route, question text and
criteria and their version, thresholds, state kind and aggregation. Two profiles that differ only by
band therefore have different identities, and any wording change changes the hash —
which is what invalidates a comparison.

The two min-rule profiles reproduce the older project's question wording and
min-rule-with-veto aggregation; `choice-3way-cleanroom` reproduces the auto-mode
candidate's serialized-string state and single categorical question, with wording
written here rather than copied. See [`REUSE.md`](REUSE.md) for what was
reimplemented from specification versus copied.

## Deterministic floors run before the model

Some commands are not the model's call to make, and asking wastes a round trip.
These floors are code, not prompts, and they apply to every profile:

- `floor_never_allow` — commands whose effect cannot be established as reviewable:
  privilege escalation, filesystem/block-device destruction, removing Git metadata,
  discarding a working tree, force-mutating a remote. Pattern table in
  `src/decisions/floor.ts`; each rule is named in the record.
- `not_wholly_visible` — a call the reviewer cannot be shown in full.

A floor hit is a `defer`, not a denial: the human still decides. A floor is also
never an auto-allow — the only paths that skip review are exact operator whitelist
rules.

A floor hit is a `defer` with that reason. It is not a denial: the human still
decides. Floors are the reason the model cannot be the only safety layer, and the
reason comparison numbers are reported with `floors enforce` versus
`floors measurement` labels — a run without floors describes the model, a run with
them describes the shipped gate.

## State budget

State is what dominates latency (roughly 200 ms for four questions on a ~150 token
prompt versus ~2.5 s with a large state), so it is bounded and **kept whole or not
sent**. `maxPayloadTokens` (default 1024) bounds the total request. When the budget
is exhausted, fields are dropped in a documented order and the proposal becomes
`defer (state_over_budget)` with the omissions recorded — the model is never shown a
silently truncated command, because a command missing its tail is a different
command.

Secret-shaped text (PEM blocks, JWTs, vendor API keys, AWS access key ids, bearer
tokens, credential assignments) is masked to `[masked:<shape>]` before it is sent.
This is a privacy mitigation, not a guarantee: an unusual or encoded secret passes
through, and masking changes what the model reads.

## Records

`model` and `effective` are separate objects in each JSONL record, because they answer
different questions: what the model proposed, and what the gate decided.

The model side carries `kind`, `mode`, the constant `authority: "none"`, `reasonCode`,
a display-safe `explanation` (never an endpoint body or credential), `profileId`,
`profileIdentity`, `questionsTextVersion`, `stateKind`, `aggregation`,
`requestedModel`, `servedModel` — written only when the endpoint's reported identity
was verified equal, so its absence means the identity was not established — plus
`latencyMs`, `readings`/`choices`, and `dropped`, the context the payload ladder
omitted, where empty means nothing was lost.

An `off` posture writes no `model` field at all, rather than a row of nulls that would
look like a failed attempt. `execution` stays `not_observed` in every record: nothing
in this package observes whether the shell ran.

## Commands

```sh
MODEL_BASE_URL=http://host:port bun run test:live   # opt-in contract check, no execution
bun run evaluate                                    # profiles over the labelled cases (fake endpoint)
MODEL_BASE_URL=http://host:port bun run evaluate --live
bun run evaluate --live --profile minrule-4q-judge-band
```

`test:live` runs the shipped client against synthetic benign text and reports the
served identity rather than asserting a constant one — the endpoint changed model and
build during planning, so a fixed expectation would either rot or hide a swap. It
exits non-zero when the endpoint answers as something other than the profile's pinned
identity.

## Measured, 2026-11-14, `http://jetson.lan:9931`

Floors skipped, so these describe the model alone. Labels are **draft synthetic
judgements written for this repo**, not ground truth, and no case was executed.

| profile | cases | approvals (safe/dangerous/unsure) | unsafe approvals | terminal denies | reached human |
| --- | --- | --- | --- | --- | --- |
| `minrule-4q-conservative` | 17 | 0/0/0 | 0 | 1 | 16 |
| `minrule-4q-judge-band` | 17 | 1/0/0 | 0 | 9 | 8 |
| `choice-3way-cleanroom` | 17 | 6/0/0 | 0 | 4 | 13 |

Unsafe approvals are the first column that matters: a profile that approves what its
labels call dangerous is not usable for enforcement whatever its safe approval rate.
Zero here is not a safety result — 17 draft-labelled cases cannot support one.

The operative number is the last column. `minrule-4q-conservative` sent **16 of 17**
cases to a human, and the one it did not approve was a terminal denial. On this corpus
the model removes essentially no review burden; it adds a round trip. The wider bands
approve more and deny more, and the categorical profile approved 6 cases on its own
argmax — `unsafe_not_excluded` is the defer that fires when the safe label wins but
the dangerous mass is not below `unsafeMax`, so a narrow margin still reaches a
human.

Re-runs reproduced every verdict (`no drift`) for all three profiles, so these counts
are stable for this endpoint and these profiles. Stability is not accuracy.

## Latency

Measured on the same endpoint, four questions, ~150 token state: **190-290 ms** per
call. A ~2.5 k token state cost ~2.5 s, which is why the payload budget exists and why
state that does not fit is refused rather than trimmed. Requests are not concurrent:
one deferred call at a time, since reviews are serialized anyway. Bounded queue and
breaker behaviour are M3 work; today a slow endpoint adds its latency to the review
queue and nothing else.

## What is not claimed

- No calibration. No held-out corpus, no false-allow rate, no comparison against a
  human baseline. Three named profiles ship because no defensible winner emerged.
- The model never authorizes or blocks. Enforcement, breaker, queue limits and
  in-flight deduplication are M3.
- The 17 labelled cases are synthetic and authored in this repo. Their labels are
  draft opinions, deliberately not attributed to any human review process.
- Masking is best-effort. Treat everything in a deferred command as possibly sent.
- `execution` in a record is `not_observed`. The model's proposal and the gate's
  effective decision are separate fields for the same reason.
