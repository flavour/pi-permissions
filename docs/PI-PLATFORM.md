# Pi 1.5.2 platform boundary and opt-in smoke

## Reproduce

Prerequisites: Linux, normal Node (tested with v24.22.1), Bun (tested with 1.4.4), Git, and an installed **Pi 1.5.2**. This is an opt-in integration smoke, not part of ordinary offline unit tests:

```sh
PI_PERMISSIONS_SMOKE=1 bun scripts/pi-smoke.ts
# equivalent consent:
bun scripts/pi-smoke.ts --consent
```

The default host is `~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent`. Override its package root with `PI_SMOKE_HOST`. Wrong host versions fail before execution. Without consent the script exits 2.

The Bun coordinator launches the installed CLI and SDK in **normal Node subprocesses**. It never calls `prompt`, invokes a provider, or sends a model request. It seeds explicitly synthetic assistant history through `SessionManager`, then calls the real `AgentSession.extensionRunner.createToolContext(...).executeTool('bash', ...)` nested-tool path. This is not a direct call to the gate handler and not a real model-issued top-level call. Pi requires an issuing assistant message even for nested calls; an empty session returns `No assistant message issued this call` before tool hooks.

**Every UI response is an automated adapter, not human approval.** The fixture labels these in output. Its single approved operation writes the literal `smoke` to a sentinel inside a fresh temporary workspace. Rejection, print, JSON, RPC, throwing UI, cancellation, throwing hook, custom bash, and a rejected prefix case must leave their sentinels absent. No dangerous or corpus commands run.

## Installation and isolation

The script copies tracked and untracked non-ignored working-tree files to a disposable Git repository, so uncommitted package/source changes are tested. It waits up to 60 seconds for `package.json` and `src/extension.ts`. It does not commit or modify the real repository.

Pi 1.5.2's `dist/utils/git.js` does **not** accept `git:file://...`: the generic parser accepts http(s), ssh, git protocols or recognized hosted sources. To test a genuine managed Git install without a server, the script invokes:

```text
node <installed-pi>/dist/bundle/cli.js install git:https://smoke.invalid/owner/package
```

A private Git `url.file://<snapshot>.insteadOf` rewrite maps that URL to the disposable repository. No request goes to `smoke.invalid`. Pi itself clones, installs dependencies, records settings, and later discovers `src/extension.ts` from that clone.

The temporary settings select Bun as Pi's dependency manager. The actual Pi install arguments are `bun install --omit=dev --omit=peer`. The fixture rejects runtime npm dependencies and verifies that no dependency packages were installed beneath the isolated agent directory. Extension imports must resolve from the host's jiti mappings; neither the working tree's `node_modules` nor its dev dependencies accompany the clone. This proves dependency-free loading for this package, not arbitrary third-party packages.

The npm backend was also tried: although Pi passes `npm install --omit=dev --legacy-peer-deps --no-audit --no-fund`, npm still tries to resolve omitted development dependency metadata with this Bun-lock-only repository. In a fresh offline cache it fails `ENOTCACHED`; that is not evidence that runtime dependencies are necessary. The smoke therefore uses Bun's locked production install.

Children receive an environment allowlist rather than inherited credentials. HOME, XDG config/cache, Pi agent directory, npm cache, Git config, cwd and temporary storage are disposable; system/global user Git configs and terminal credential prompts are disabled. npm is offline and lifecycle scripts are disabled. SDK `fetch` throws defensively, and there is no model invocation. This is environmental isolation, **not an OS network namespace or sandbox**. PATH supplies trusted installed executables. Child deadlines are 60 seconds (CLI) and 90 seconds (SDK); the temporary tree is removed in `finally` on success/failure. Hard termination of the coordinator itself can still leave a temp directory.

## Host findings (installed documentation and source)

References are relative to the installed Pi package: `docs/sdk.md`, `docs/extensions.md`, `docs/packages.md`; SDK examples `05-tools`, `06-extensions`, `10-settings`, `12-full-control`; extension examples `permission-gate`, `timed-confirm`; and the corresponding `dist/core` implementations.

- **Hook order:** argument preparation/validation precede `tool_call`; execution emits `tool_execution_start`, then `tool_call`, then updates, `tool_result`, `tool_execution_end`. Blocked calls skip execution and `tool_result`, but still emit an error end event. The fixture checks this order on the real nested-tool path.
- **Composition/mutation:** handlers run in extension load order then registration order. `tool_call.input` is mutable and later handlers see earlier changes. Those mutations affect execution and are **not revalidated**. A gate cannot attest that a later trusted extension will not alter an approved command. This package is not a security boundary against other extensions.
- **Hook errors:** a thrown `tool_call` hook blocks the tool; the agent can continue. Other event/factory errors generally report diagnostics and allow the host to keep running. The smoke distinguishes blocked results from mere absence of a sentinel and requires the affirmative case to reach execution.
- **cwd:** `ctx.cwd` is the session working directory. Built-in shell execution uses `ctx.cwd || factoryCwd`; however a configured spawn hook can change cwd, command and env afterwards. There is no filesystem race/symlink or final spawn descriptor attestation.
- **Prefix:** `shellCommandPrefix` comes from effective merged settings via `pi.getSettings()`. Shell prefix transformation is part of host shell execution, not necessarily part of `event.input.command`. A review must disclose the effective prefix rather than silently presenting only the raw command. The smoke uses a harmless prefix and rejects the call.
- **Backends:** `createBashTool` accepts pluggable `operations` and `spawnHook`; a built-in-looking interface alone does not attest the local backend, executable, environment or remote target. `user_bash` (`!` / `!!`) is a distinct path and does not use `tool_call`. Extension `pi.exec`, direct process calls and other tools are outside a bash-only hook.
- **Provenance:** `pi.getAllTools()` exposes `sourceInfo`; ordinary bash has `source: 'builtin'`, `path: 'builtin:bash'`. An extension registering the name `bash` silently replaces the built-in and has extension provenance. SDK `customTools` have source `sdk`. Name matching alone is insufficient. The smoke registers a custom bash whose execution must never be reached.
- **Modes:** TUI is `mode: 'tui', hasUI: true`; print/JSON have no UI. RPC has **hasUI true** but delegates dialogs to an external client. A human-only gate must check both mode and hasUI, not merely hasUI. The smoke's RPC adapter would answer yes if called, but must not be called.
- **Cancellation:** dialogs accept `{ signal, timeout }`; confirm returns false on timeout/dismissal. `ctx.signal` is usually present during a turn but can be absent while idle. The gate must handle aborted signals and late answers, and close its own deadline resources. The smoke aborts its nested caller signal while the automated UI returns a late true; no sentinel may appear. In this idle SDK invocation, the event context's `ctx.signal` comes from `agent.signal` and can be undefined even though `createToolContext` supplied a nested caller signal. Thus this case proves cancellation through the nested execution pipeline, not propagation of a live agent-turn signal to the gate. It does not wait a full 60 seconds or test physical Escape input.
- **Load failure:** Pi reports extension load failures and normally continues without the failed extension. A gate that never loaded cannot block execution. The fixture adds a deliberately throwing extension factory alongside the installed gate and asserts a load diagnostic is visible; it does not pretend that failure activates a fallback gate. Verify activation after startup or reload.

## Coverage gaps / limits

This is a narrowly pinned integration check, not a safety calibration or adversarial security proof. It does not exercise an actual terminal renderer, physical human confirmation, full provider/agent loop, top-level model tool batches, RPC wire protocol, session replacement/reload, OS-level network denial, hostile later-hook mutation, remote shell operations, custom spawn hooks, shell startup files, or race-resistant final execution binding. An unsupported installed version is rejected by the coordinator; loading the extension under another actual Pi version is not tested. Throwing-factory diagnostics cover host load-failure behavior, not every syntax/import failure. No automatic approval model, rules engine or permission-corpus evaluation is involved.
