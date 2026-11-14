/**
 * Floor tests: never-allow and not-wholly-visible refusals.
 */

import { expect, test } from "bun:test";
import { floorRefusal, opaqueRefusal } from "../decisions/floor.js";

test("floorRefusal returns undefined for ordinary commands", () => {
  expect(floorRefusal("pwd")).toBeUndefined();
  expect(floorRefusal("git status")).toBeUndefined();
  expect(floorRefusal("ls -la")).toBeUndefined();
});

test("floorRefusal catches privilege escalation", () => {
  const refusal = floorRefusal("sudo rm -rf /tmp/x");
  expect(refusal?.reason).toBe("never_allow");
  expect(refusal?.rule).toBe("privilege escalation");
});

test("floorRefusal catches recursive delete of home", () => {
  expect(floorRefusal("rm -rf /home")).toMatchObject({
    reason: "never_allow",
    rule: "recursive delete of a home or root path",
  });
  expect(floorRefusal("rm -rf ~/project")).toMatchObject({
    reason: "never_allow",
    rule: "recursive delete of a home or root path",
  });
});

test("floorRefusal catches format wipe", () => {
  expect(floorRefusal("mkfs.ext4 /dev/sdb1")).toMatchObject({
    reason: "never_allow",
    rule: "filesystem format or signature wipe",
  });
});

test("floorRefusal catches force push", () => {
  expect(floorRefusal("git push --force")).toMatchObject({
    reason: "never_allow",
    rule: "force push",
  });
  expect(floorRefusal("git push -f")).toMatchObject({
    reason: "never_allow",
    rule: "force push",
  });
});

test("floorRefusal catches secret in command line", () => {
  expect(floorRefusal("curl --token ABC123")).toMatchObject({
    reason: "never_allow",
    rule: "secret in the command line",
  });
});

test("floorRefusal catches cloud mutation", () => {
  expect(floorRefusal("aws s3 rm bucket")).toMatchObject({
    reason: "never_allow",
    rule: "cloud or infrastructure mutation",
  });
});

test("floorRefusal returns undefined for safe publish", () => {
  expect(floorRefusal("npm run build")).toBeUndefined();
});

test("opaqueRefusal catches eval", () => {
  const refusal = opaqueRefusal("eval 'whoami'");
  expect(refusal?.reason).toBe("not_wholly_visible");
  expect(refusal?.rule).toBe("eval");
});

test("opaqueRefusal catches command substitution", () => {
  expect(opaqueRefusal("echo $(whoami)")).toMatchObject({
    reason: "not_wholly_visible",
    rule: "command substitution",
  });
  expect(opaqueRefusal("echo `whoami`")).toMatchObject({
    reason: "not_wholly_visible",
    rule: "command substitution",
  });
});

test("opaqueRefusal returns undefined for plain commands", () => {
  expect(opaqueRefusal("git diff")).toBeUndefined();
  expect(opaqueRefusal("cat file.txt")).toBeUndefined();
});
