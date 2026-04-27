import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateFileListing } from "../index.js";
import { withTmp } from "./helpers.mjs";

test("generateFileListing: du -hxd1 style", () => withTmp(dir => {
  writeFileSync(join(dir, "small.txt"), "hi");
  writeFileSync(join(dir, ".hidden"), "secret");
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib", "util.js"), "export const x = 1;");
  const lines = generateFileListing(dir).split("\n").filter(Boolean);
  assert.ok(lines.find(l => l.endsWith("  small.txt")).match(/^\s+\d+B\s+small\.txt$/));
  assert.ok(lines.find(l => l.endsWith("  .hidden")));
  assert.ok(lines.find(l => l.endsWith("  lib/")).match(/^\s+\d+B\s+lib\//));
  assert.ok(!lines.find(l => l.includes("util.js")));
}));

test("generateFileListing: returns empty for invalid dir", () => {
  assert.equal(generateFileListing("/nonexistent"), "");
});
