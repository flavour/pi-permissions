import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import install from "./extension.js";

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Only these host capabilities are exercised. Assertions are confined to the
// host boundary, rather than pretending to construct a real session or TUI.
function host() {
  type Callback = (event: unknown, context: unknown) => unknown;
  const callbacks = new Map<string, Callback>();
  const prompts: string[] = [];
  const statuses: string[] = [];
  const notices: string[] = [];
  let confirm = async () => false;
  let prefix = "";
  let source = "builtin";
  let path = "builtin:bash";
  let sessionId = "session-one";
  const api = {
    on: (name: string, callback: Callback) => {
      callbacks.set(name, callback);
      return () => {};
    },
    getAllTools: () => [{ name: "bash", sourceInfo: { source, path } }],
    getSettings: () => ({ shellCommandPrefix: prefix }),
  };
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/work",
    signal: undefined,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setStatus: (_key: string, message: string) => {
        statuses.push(message);
      },
      notify: (message: string) => {
        notices.push(message);
      },
      confirm: async (_title: string, message: string) => {
        prompts.push(message);
        return confirm();
      },
    },
  };
  install(api as unknown as ExtensionAPI);
  const emit = async (name: string, event: unknown = { type: name }) => {
    const callback = callbacks.get(name);
    if (!callback) throw new Error(`Missing registration: ${name}`);
    return (await callback(event, context as unknown as ExtensionContext)) as
      | ToolCallEventResult
      | undefined;
  };
  return {
    callbacks,
    context,
    prompts,
    statuses,
    notices,
    emit,
    approve: (callback: () => Promise<boolean>) => {
      confirm = callback;
    },
    prefix: (value: string) => {
      prefix = value;
    },
    tool: (value: string, location: string) => {
      source = value;
      path = location;
    },
    session: (value: string) => {
      sessionId = value;
    },
  };
}

const bash = (command = "printf text", toolCallId = "call-one") => ({
  type: "tool_call",
  toolName: "bash",
  toolCallId,
  input: { command },
});
let agentDir: string;
let previousAgentDir: string | undefined;
beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = mkdtempSync(join(tmpdir(), "permissions-extension-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});
function config(value: unknown) {
  const directory = join(agentDir, "extensions", "pi-permissions");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.json"), JSON.stringify(value));
}
const allow = {
  version: 1,
  whitelist: [{ id: "allow", exact: "printf text" }],
  blacklist: [],
};

describe("extension registration and text-only host dispatch", () => {
  it("reads the agent directory dynamically and announces missing config activation", async () => {
    expect(getAgentDir()).toBe(agentDir);
    const h = host();
    await h.emit("session_start");
    expect(h.statuses[0]).toContain("ACTIVE built-in bash gate");
    expect(h.statuses[0]).toContain("config missing");
    expect(h.notices[0]).toContain("Model off.");
    expect((await h.emit("tool_call", bash()))?.block).toBe(true);
    expect(h.prompts).toHaveLength(1);
  });

  it("announces invalid config without leaking contents and still requires review", async () => {
    config({ secret: "DO-NOT-DISPLAY" });
    const h = host();
    await h.emit("session_start");
    expect(h.statuses[0]).toContain("config invalid");
    expect((await h.emit("tool_call", bash()))?.block).toBe(true);
    expect(h.notices.join(" ")).not.toContain("DO-NOT-DISPLAY");
    expect(h.prompts[0]).toContain("invalid");
  });

  it("leaves non-bash calls entirely untouched", async () => {
    const h = host();
    expect(
      await h.emit("tool_call", { ...bash(), toolName: "write" }),
    ).toBeUndefined();
    expect(h.prompts).toHaveLength(0);
    expect(existsSync(join(agentDir, "pi-permissions-records"))).toBe(false);
  });

  for (const mode of ["print", "json", "rpc"]) {
    it(`blocks ${mode} even with an exact allow and no dialog`, async () => {
      config(allow);
      const h = host();
      h.context.mode = mode;
      h.context.hasUI = mode === "rpc";
      expect((await h.emit("tool_call", bash()))?.reason).toContain(
        "no_review_ui",
      );
      expect(h.prompts).toHaveLength(0);
    });
  }

  for (const [source, path] of [
    ["extension", "/custom/bash.ts"],
    ["builtin", "builtin:other"],
  ]) {
    it(`rejects unsupported bash identity ${source}:${path}`, async () => {
      const h = host();
      h.tool(source ?? "", path ?? "");
      expect((await h.emit("tool_call", bash()))?.reason).toContain(
        "supported built-in",
      );
      expect(h.prompts).toHaveLength(0);
    });
  }

  for (const event of ["session_before_switch", "session_shutdown", "input"]) {
    it(`${event} invalidates a waiting approval and ignores a late yes`, async () => {
      const h = host();
      const shown = deferred<void>();
      const answer = deferred<boolean>();
      h.approve(() => {
        shown.resolve();
        return answer.promise;
      });
      const pending = h.emit("tool_call", bash());
      await shown.promise;
      await h.emit(event, {
        type: event,
        text: "new intent",
        source: "interactive",
      });
      answer.resolve(true);
      expect((await pending)?.block).toBe(true);
      h.approve(async () => true);
      expect(
        await h.emit("tool_call", bash("printf fresh", "fresh")),
      ).toBeUndefined();
    });
  }

  it("keeps parallel approvals independent and reviews each whole command", async () => {
    const h = host();
    const shown = deferred<void>();
    const answer = deferred<boolean>();
    h.approve(() => {
      shown.resolve();
      return answer.promise;
    });
    const first = h.emit("tool_call", bash("first\nwhole payload", "one"));
    await shown.promise;
    const second = h.emit("tool_call", bash("second payload", "two"));
    expect(h.prompts).toHaveLength(1);
    h.approve(async () => false);
    answer.resolve(true);
    expect(await first).toBeUndefined();
    expect((await second)?.block).toBe(true);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[0]).toContain("first\nwhole payload");
    expect(h.prompts[1]).toContain("second payload");
  });

  for (const field of ["command", "cwd", "prefix", "session", "toolCallId"]) {
    it(`invalidates approval after live ${field} mutation`, async () => {
      const h = host();
      const event = bash("printf original\ncomplete payload");
      h.approve(async () => {
        if (field === "command") event.input.command = "changed";
        else if (field === "cwd") h.context.cwd = "/changed";
        else if (field === "prefix") h.prefix("new effective invocation; ");
        else if (field === "session") h.session("another-session");
        else event.toolCallId = "another-call";
        return true;
      });
      expect((await h.emit("tool_call", event))?.reason).toContain(
        "approval is invalid",
      );
      expect(h.prompts[0]).toContain("printf original\ncomplete payload");
      expect(h.prompts[0]).toContain("/work");
    });
  }

  it("requires prefix review despite a whitelist and displays the full prefix", async () => {
    config(allow);
    const h = host();
    h.prefix("source private-init; ");
    h.approve(async () => true);
    expect(await h.emit("tool_call", bash())).toBeUndefined();
    expect(h.prompts[0]).toContain("source private-init; ");
    expect(h.prompts[0]).toContain("unverified");
  });

  it("explains a policy denial, discourages evasion and never prompts", async () => {
    config({
      ...allow,
      blacklist: [
        {
          id: "deny",
          exact: "printf text",
          reason: "Local publication freeze.",
        },
      ],
    });
    const h = host();
    const result = await h.emit("tool_call", bash());
    expect(result?.reason).toContain("blacklist_match");
    expect(result?.reason).toContain("Local publication freeze.");
    expect(result?.reason).toContain("Do not evade");
    expect(result?.reason).toContain("explicit policy change");
    expect(h.prompts).toHaveLength(0);
  });

  it("shows only conditionally associated input and rejects expanded/queued provenance", async () => {
    const h = host();
    await h.emit("input", { text: "inspect", source: "interactive" });
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "inspect",
    });
    await h.emit("agent_start");
    await h.emit("tool_call", bash());
    expect(h.prompts.at(-1)).toContain("authority): inspect");
    await h.emit("agent_end");
    await h.emit("input", { text: "/template", source: "interactive" });
    await h.emit("before_agent_start", {
      messageType: "user",
      prompt: "expanded",
    });
    await h.emit("tool_call", bash());
    expect(h.prompts.at(-1)).toContain("UNKNOWN");
    await h.emit("input", {
      text: "queued",
      source: "interactive",
      streamingBehavior: "steer",
    });
    await h.emit("tool_call", bash());
    expect(h.prompts.at(-1)).toContain("UNKNOWN");
  });

  it("keeps the config snapshot fixed while review waits, then reloads for the next request", async () => {
    const h = host();
    h.approve(async () => {
      config(allow);
      return false;
    });
    expect((await h.emit("tool_call", bash()))?.block).toBe(true);
    expect(await h.emit("tool_call", bash())).toBeUndefined();
    expect(h.prompts).toHaveLength(1);
    config({ version: 99 });
    expect((await h.emit("tool_call", bash()))?.block).toBe(true);
    expect(h.prompts.at(-1)).toContain("invalid");
  });

  it("honors records:false at the adapter without disabling decisions", async () => {
    config({ ...allow, records: false });
    expect(await host().emit("tool_call", bash())).toBeUndefined();
    expect(existsSync(join(agentDir, "pi-permissions-records"))).toBe(false);
  });
});
