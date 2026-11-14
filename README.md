# pi-permissions

Standalone **Pi 1.5.2** built-in bash gate: global exact rules followed by one-shot
human review. No hub dependency and no Bun runtime dependency. An optional
**shadow** Decisions Model can annotate a review with a proposal; it has **no
authority** — a model `allow` never runs a command and a model `deny` never blocks
one. See [`docs/M2-MODEL.md`](docs/M2-MODEL.md).

## Install and verify activation

Install this repository through Pi's Git package installer (`pi install git:https://<your-repository-url>`), then start/reload Pi. Look for **`pi-permissions: ACTIVE built-in bash gate`**, the runtime version, mode and config status. Unsupported versions stay blocked while the extension is loaded. A package that fails to load cannot protect anything: inspect Pi's load diagnostics and verify activation after every reload.

Use Pi's package manager to remove the same Git source to uninstall, or restore a known-good Git revision to roll back. Removing/disabling the package removes its protection. Private configuration and records are not automatically deleted.

## Policy

Only `<agentDir>/extensions/pi-permissions/config.json` is read, using Pi's `getAgentDir()`. Project policy files are never read. Missing config keeps human review active. Invalid/unreadable config displays a warning and disables automatic grants, **not the gate**. A coherent configuration snapshot is loaded for each request; editing it cannot change a review already in progress.

```json
{
  "version": 1,
  "whitelist": [
    { "id": "inspect-here", "exact": "git status --short", "cwd": "/absolute/trusted/project", "reason": "My reviewed local inspection command" }
  ],
  "blacklist": [
    { "id": "push-manually", "exact": "git push", "reason": "Push manually outside the agent" }
  ],
  "records": true
}
```

See [`docs/config.example.json`](docs/config.example.json) and [`docs/config.schema.json`](docs/config.schema.json). Unknown fields, duplicate rule IDs, unsupported matchers (including `argvPrefix`), and invalid cwd scopes are errors. Arrays may be omitted. `records` defaults to true.

- **Blacklist first:** when both lists match, deny with the rule ID/reason.
- **Exact means the entire original string**, without trimming, quote removal, Unicode/path normalization or whitespace folding. Optional `cwd` is also exact and absolute; it is not recursive containment.
- An exact whitelist intentionally trusts **all** effects of that invocation: scripts, substitutions, dependencies, shell startup and mutable repository configuration. It is operator authority, not proof of read-only behavior.
- `git push` does **not** ban `git -C x push`, `/usr/bin/git push`, wrappers, scripts or whitespace variants. These unmatched variants reach review; the agent is told not to evade denials.
- Prefix/custom-shell execution contexts cannot inherit an exact whitelist. The prefix and configured shell are disclosed for human review. Replacement bash tools and unsupported Pi runtimes are blocked.
- Even whitelisted calls are blocked outside the supported interactive TUI. Print, JSON and RPC are not supported review channels.

No built-in command-name “read-only” grants ship. The bounded literal recognizer produces specific review reasons, not automatic authority. Source inspection found that parsing `git`, `find`, `sed`, etc. cannot attest their executable, flags, configuration or shell startup context. Built-in easy-safe presets and structured prefix matching are deliberately deferred; see [`docs/M1-POLICY.md`](docs/M1-POLICY.md).

## Human review

Unmatched calls show the **complete command**, cwd, request ID, concrete **why review**, known input context (or explicit unknown), shell prefix and execution unknowns. Approve once or reject. Controls and bidi characters are visibly escaped without changing the original snapshot. Dialogs are serialized, bounded to 16 pending requests, with a 60-second total queue+review deadline. Escape/dismissal, timeout, UI failure, cancellation and late answers cannot approve a call. Reviews are cancelled on new input, session navigation, compaction and shutdown. An approval never releases a sibling request.

Input provenance is deliberately conservative. Only fresh, unqueued `interactive` input that exactly matches the starting user prompt is eligible as context. Prompt expansion, extension/RPC text, queued/steering input, stale history and summaries are never promoted to human authority. Pi does not expose a durable input ID; this conditional association assumes audited input-handler ordering (earlier handlers can transform text). Displayed intent is context, **not an independent authorization grant**. Unknown intent still permits an explicit human review of the exact call.

## Private records

Raw decisions go to `<agentDir>/pi-permissions-records/decisions.jsonl` (0700 directory, 0600 files). Set `"records": false` to disable. Records include full commands and associated intent, so they may contain secrets: do not export or commit them. The sink refuses Git-contained or insecure record directories and symlink files. It keeps a current and previous file, each at most 1 MiB; individual oversized records fail closed. Delete both files to purge retained data. Record-write failures block, rather than silently losing an approval record. Multi-process writes to the same agent directory are not a supported recording configuration.

A record is a **decision**, never evidence that execution occurred: `execution: "not_observed"`. Blocked/cancelled decisions must not be labelled executed. Early unsupported-runtime/tool-provenance and exceptional gate failures return a tool denial but do not yet emit a full decision record.

## Boundary and limitations

This is an application-level hook, **not a sandbox**. Covered built-in bash calls (including hook-mediated nested execution) must receive an effective rule or human allow. There is no special exemption for nested calls, and they do not establish human intent. Files, executables, aliases/functions, PATH, startup files, symlinks and backend/spawn hooks are not execution-bound. Tool metadata is not final-executor attestation. Supported use assumes the ordinary local Pi shell backend and trusted, non-mutating extension composition. A later hook can mutate an already-approved command; the extension cannot prevent that. Changes observed while awaiting review invalidate approval.

Other tools, subagents/external processes, direct tool `.execute()`, extension `pi.exec`, and user `!`/`!!` shell commands are **not covered**. A loaded gate cannot compensate for its own absence/load failure. Long-dialog terminal rendering/scrolling and physical key handling are not verified by automated adapters; inspect the whole command before approving.

## Development and verification

Pinned Bun 1.4.4; Node >=22 for runtime; Pi development types 1.5.2.

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run verify
bun run test:pi --consent           # opt-in disposable Git install + real Node/Pi SDK smoke
bun run evaluate                     # profile comparison over labelled cases (fake endpoint)
MODEL_BASE_URL=http://host:port bun run test:live   # opt-in endpoint contract check
```

Offline tests classify candidate text only, never execute corpus commands. The opt-in smoke uses automated UI adapters and only an isolated harmless sentinel operation; it is not proof of physical human confirmation or a top-level provider loop. Its model scenarios talk only to a `127.0.0.1` fixture, and every other socket is blocked. See [`docs/PI-PLATFORM.md`](docs/PI-PLATFORM.md) for exact isolation, tested paths and gaps, and [`PLAN.md`](PLAN.md) for remaining milestones.
