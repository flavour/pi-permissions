import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DecisionRecord } from "./handler.js";

/** Local raw decisions only, never an assertion that the shell executed. Two bounded files. */
export function writeRecord(agentDir: string, record: DecisionRecord): void {
  const dir = join(agentDir, "pi-permissions-records");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let ancestor = realpathSync(dir);
  while (true) {
    if (existsSync(join(ancestor, ".git")))
      throw new Error("Raw decision records must remain outside Git");
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("Records directory must be private and not a symlink");
  const path = join(dir, "decisions.jsonl");
  const bytes = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(bytes) > 1_048_576)
    throw new Error("Decision exceeds local record limit");
  let fd = openSync(
    path,
    constants.O_CREAT |
      constants.O_APPEND |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile())
      throw new Error("Records target is not a file");
    fchmodSync(fd, 0o600);
    if (fstatSync(fd).size + Buffer.byteLength(bytes) > 1_048_576) {
      closeSync(fd);
      fd = -1;
      renameSync(path, join(dir, "decisions.previous.jsonl"));
      fd = openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
    }
    writeSync(fd, bytes);
  } finally {
    if (fd !== -1) closeSync(fd);
  }
}
