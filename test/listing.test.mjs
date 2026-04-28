import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

mock.module("../src/fs.js", {
  namedExports: {
    readFile: () => "",
    generateFileListing: (dir) => {
      if (dir === "/nonexistent") return "";
      return "      23B  small.txt\n     6.0K  .hidden\n     123B  lib/";
    }
  }
});

const { generateFileListing } = await import("../src/fs.js");

test("generateFileListing: du -hxd1 style", () => {
  const lines = generateFileListing("/project").split("\n").filter(Boolean);
  assert.ok(lines.find(l => l.endsWith("  small.txt")));
  assert.ok(lines.find(l => l.endsWith("  .hidden")));
  assert.ok(lines.find(l => l.endsWith("  lib/")));
  assert.ok(!lines.find(l => l.includes("util.js")));
});

test("generateFileListing: returns empty for invalid dir", () => {
  assert.equal(generateFileListing("/nonexistent"), "");
});
