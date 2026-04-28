import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

let m;
let hintValues;
let existsPaths;
mock.module("../src/fs.js", {
  exports: {
    readFile: (p) => {
      if (typeof hintValues !== "undefined") return hintValues.shift() ?? "";
      return "";
    },
    generateFileListing: () => ""
  }
});
// Mock existsSync to control which project path "exists"
mock.module("node:fs", {
  exports: {
    existsSync: (p) => Array.isArray(existsPaths) ? existsPaths.includes(p) : false,
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => ""
  }
});
m = await import("../index.js");

test("loadHintSources: loads global and project hints", () => {
  hintValues = ["global", "project"];
  existsPaths = ["/tmp/proj/.gsd/HINTS.md"];
  const { sources } = m.loadHintSources("/tmp/proj");
  assert.equal(sources.length, 2);
  assert.equal(sources[0].content, "global");
  assert.equal(sources[1].content, "project");
});

test("loadHintSources: falls back to root HINTS.md", () => {
  hintValues = ["root"];
  existsPaths = ["/tmp/proj/HINTS.md"];
  const { sources } = m.loadHintSources("/tmp/proj");
  assert.equal(sources.length, 1);
  assert.equal(sources[0].content, "root");
});

test("loadHintSources: returns empty when no hints", () => {
  hintValues = [];
  existsPaths = [];
  const { sources } = m.loadHintSources("/tmp/proj");
  assert.equal(sources.length, 0);
});

test("buildHintsBlock: returns context_prune hint when no user hints", () => {
  hintValues = [];
  existsPaths = [];
  const { block } = m.buildHintsBlock("/tmp/proj");
  assert.ok(block.includes("[HINTS — Stable Guidance]"));
  assert.ok(block.includes("Context Prune Discipline"));
  assert.ok(block.includes("context_prune"));
});

test("buildHintsBlock: formats hints block", () => {
  hintValues = ["global-hint", "project-hint"];
  existsPaths = ["/tmp/proj/.gsd/HINTS.md"];
  const { block } = m.buildHintsBlock("/tmp/proj");
  assert.ok(block.includes("[HINTS — Stable Guidance]"));
  assert.ok(block.includes("global-hint"));
  assert.ok(block.includes("project-hint"));
});
