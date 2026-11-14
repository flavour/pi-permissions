import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  configSchema,
  EMPTY_CONFIG,
  loadConfig,
  type PolicyConfig,
} from "./config.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-permissions-config-"));
  directories.push(path);
  return path;
}
function put(agentDir: string, value: unknown, raw = false): void {
  const path = join(agentDir, "extensions/pi-permissions/config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw ? String(value) : JSON.stringify(value));
}
const empty: PolicyConfig = { version: 1, whitelist: [], blacklist: [] };

describe("global policy configuration", () => {
  it("missing is an active empty policy, not undefined", () => {
    const loaded = loadConfig(directory());
    expect(loaded.status).toBe("missing");
    expect(loaded.config).toEqual(empty);
    expect(loaded.revision).toMatch(/^missing:[a-f0-9]{64}$/);
  });
  it("reads only the exact supplied agentDir location", () => {
    const agent = directory();
    const other = directory();
    put(other, { ...empty, whitelist: [{ id: "other", exact: "anything" }] });
    writeFileSync(
      join(agent, "config.json"),
      JSON.stringify({
        ...empty,
        whitelist: [{ id: "root", exact: "anything" }],
      }),
    );
    mkdirSync(join(agent, ".pi/extensions/pi-permissions"), {
      recursive: true,
    });
    writeFileSync(
      join(agent, ".pi/extensions/pi-permissions/config.json"),
      JSON.stringify({ version: 999 }),
    );
    expect(loadConfig(agent).status).toBe("missing");
    put(agent, empty);
    expect(loadConfig(agent).config.whitelist).toEqual([]);
    expect(loadConfig(other).config.whitelist[0]?.id).toBe("other");
    // Supplying a filename is NOT an alternate loader interface.
    expect(
      loadConfig(join(other, "extensions/pi-permissions/config.json")).status,
    ).toBe("invalid");
  });
  it("retains exact strings, reasons, absolute cwd and optional records", () => {
    const agent = directory();
    const value = {
      ...empty,
      records: false,
      whitelist: [
        {
          id: "rule-1",
          exact: "  :\n",
          cwd: "/tmp/../tmp/",
          reason: "Explicit operator authority",
        },
      ],
    };
    put(agent, value);
    const loaded = loadConfig(agent);
    expect(loaded.status).toBe("valid");
    expect(loaded.config).toEqual(value);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.config)).toBe(true);
    expect(Object.isFrozen(loaded.config.whitelist)).toBe(true);
    expect(Object.isFrozen(loaded.config.whitelist[0])).toBe(true);
  });
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...empty, version: 2 },
    { ...empty, version: "1" },
    { ...empty, records: "false" },
    { ...empty, failOpen: true },
    { ...empty, decisionsEndpoint: "https://example.invalid" },
    { version: 1, whitelist: [] },
    { ...empty, blacklist: null },
    { ...empty, whitelist: [{ id: "prefix", argvPrefix: ["git", "status"] }] },
    { ...empty, whitelist: [{ id: "both", exact: ":", argvPrefix: [":"] }] },
    { ...empty, whitelist: [{ exact: ":" }] },
    { ...empty, whitelist: [{ id: "", exact: ":" }] },
    { ...empty, whitelist: [{ id: "space id", exact: ":" }] },
    { ...empty, whitelist: [{ id: "newline\n", exact: ":" }] },
    { ...empty, whitelist: [{ id: "x", exact: 1 }] },
    { ...empty, whitelist: [{ id: "x", exact: ":", reason: "" }] },
    { ...empty, whitelist: [{ id: "x", exact: ":", cwd: "relative" }] },
    { ...empty, whitelist: [{ id: "x", exact: ":", cwd: "~/project" }] },
    { ...empty, whitelist: [{ id: "x", exact: ":", cwd: "/tmp\0x" }] },
    { ...empty, whitelist: [{ id: "x", exact: ":", extra: true }] },
    {
      ...empty,
      whitelist: [
        { id: "same", exact: "a" },
        { id: "same", exact: "b" },
      ],
    },
    {
      ...empty,
      whitelist: [{ id: "same", exact: "a" }],
      blacklist: [{ id: "same", exact: "b" }],
    },
  ];
  for (const [index, value] of invalid.entries()) {
    it(`rejects invalid schema case ${index} atomically`, () => {
      const agent = directory();
      put(agent, value);
      const loaded = loadConfig(agent);
      expect(loaded.status).toBe("invalid");
      expect(loaded.config).toBe(EMPTY_CONFIG);
      expect(loaded.diagnostic).toContain("automatic approval is disabled");
    });
  }
  it("rejects malformed JSON and unreadable files without exposing contents", () => {
    const agent = directory();
    put(agent, '{"secret":"private-value",', true);
    expect(loadConfig(agent).status).toBe("invalid");
    expect(loadConfig(agent).diagnostic).not.toContain("private-value");
    const path = join(agent, "extensions/pi-permissions/config.json");
    rmSync(path);
    mkdirSync(path);
    expect(loadConfig(agent).status).toBe("invalid");
  });
  it("revisions are stable content identities, including failed reloads", () => {
    const agent = directory();
    put(agent, empty);
    const first = loadConfig(agent);
    expect(loadConfig(agent).revision).toBe(first.revision);
    put(agent, { ...empty, records: true });
    expect(loadConfig(agent).revision).not.toBe(first.revision);
    put(agent, "{", true);
    expect(loadConfig(agent).status).toBe("invalid");
    expect(loadConfig(agent).revision).not.toBe(first.revision);
    expect(first.config).toEqual(empty);
  });
  it("committed schema is generated from runtime source and examples validate", () => {
    expect(
      JSON.parse(
        readFileSync(
          new URL("../docs/config.schema.json", import.meta.url),
          "utf8",
        ),
      ),
    ).toEqual(configSchema);
    const agent = directory();
    put(
      agent,
      JSON.parse(
        readFileSync(
          new URL("../docs/config.example.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    expect(loadConfig(agent).status).toBe("valid");
  });
});
