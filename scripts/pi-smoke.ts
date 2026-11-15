import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Opt-in only: executes harmless sentinel shell commands in disposable directories.
if (
  process.env.PI_PERMISSIONS_SMOKE !== "1" &&
  !process.argv.includes("--consent")
) {
  console.error(
    "Opt-in required: PI_PERMISSIONS_SMOKE=1 bun scripts/pi-smoke.ts (or --consent)",
  );
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host =
  process.env.PI_SMOKE_HOST ??
  join(
    homedir(),
    ".pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent",
  );
const manifest = JSON.parse(await readFile(join(host, "package.json"), "utf8"));
if (manifest.version !== "1.5.2")
  throw new Error(`Expected Pi 1.5.2, got ${manifest.version}`);
const temp = await mkdtemp(join(tmpdir(), "pi-permissions-smoke-"));
const home = join(temp, "home");
const agentDir = join(home, ".pi/agent");
const cwd = join(temp, "workspace");
const snapshot = join(temp, "snapshot");
for (const dir of [home, agentDir, cwd, snapshot])
  await mkdir(dir, { recursive: true });
// Allowlist, not process.env spread: no API credentials, inherited Node hooks, shell startup,
// user git configs, or user Pi settings. npm cannot access registries (offline).
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  PI_CODING_AGENT_DIR: agentDir,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  TMPDIR: temp,
  CI: "1",
  TERM: "dumb",
  NO_COLOR: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
  GIT_TERMINAL_PROMPT: "0",
  npm_config_offline: "true",
  npm_config_ignore_scripts: "true",
  npm_config_cache: join(temp, "npm-cache"),
};
async function command(
  args: string[],
  dir = cwd,
  timeout = 60_000,
  quiet = false,
) {
  const proc = Bun.spawn(args, {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
  try {
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (out && !quiet) console.log(out.trimEnd());
    if (code !== 0) throw new Error(`${args[0]} exited ${code}:\n${err}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}
try {
  // Wait for parallel implementation to publish its package; snapshot working tree, not HEAD.
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      await readFile(join(root, "package.json"));
      await readFile(join(root, "src/extension.ts"));
      break;
    } catch {
      if (Date.now() > deadline)
        throw new Error("package.json/src/extension.ts not ready");
      await Bun.sleep(500);
    }
  }
  const paths = (
    await command(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      root,
      60_000,
      true,
    )
  )
    .split("\0")
    .filter(Boolean);
  for (const path of paths) {
    if (path.startsWith("node_modules/") || path.startsWith(".git/")) continue;
    await mkdir(dirname(join(snapshot, path)), { recursive: true });
    try {
      await copyFile(join(root, path), join(snapshot, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const pkg = JSON.parse(
    await readFile(join(snapshot, "package.json"), "utf8"),
  );
  if (Object.keys(pkg.dependencies ?? {}).length)
    throw new Error("Offline smoke expects no runtime npm dependencies");
  await command(["git", "init", "-q"], snapshot);
  await command(["git", "add", "."], snapshot);
  await command(
    [
      "git",
      "-c",
      "user.name=Automated smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "commit",
      "-qm",
      "Disposable working-tree snapshot",
    ],
    snapshot,
  );
  // Pi 1.5.2 rejects git:file://. A private Git URL rewrite retains the real Pi Git
  // installation path while every Git transfer is local and no server is contacted.
  await writeFile(
    join(home, "gitconfig"),
    `[url "file://${snapshot}"]\n\tinsteadOf = https://smoke.invalid/owner/package\n[protocol "file"]\n\tallow = always\n`,
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      npmCommand: ["bun"],
      packages: [],
      defaultProjectTrust: "no",
    }),
  );
  const cli = join(host, "dist/bundle/cli.js");
  await command([
    "node",
    cli,
    "install",
    "git:https://smoke.invalid/owner/package",
  ]);
  async function checkModules(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      if (entry.name === "node_modules") {
        const modules = (await readdir(join(dir, entry.name))).filter(
          (n) => n !== ".package-lock.json" && n !== ".bin",
        );
        if (modules.length)
          throw new Error(
            `Unexpected installed dependencies: ${modules.join(", ")}`,
          );
      } else await checkModules(join(dir, entry.name));
    }
  }
  await checkModules(agentDir);
  await command(
    ["node", join(root, "scripts/fixtures/pi-host.mjs"), host, cwd, agentDir],
    cwd,
    90_000,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
