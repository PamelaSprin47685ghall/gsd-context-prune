import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

let m;
let hintValues;
mock.module("../src/fs.js", {
  exports: {
    readFile: (p) => {
      // First call: global path (home/.gsd/HINTS.md) → "global"
      // Second call: project .gsd path (cwd/.gsd/HINTS.md) → "project" or fallback
      // Third call: project root path (cwd/HINTS.md) → fallback
      if (typeof hintValues !== "undefined") return hintValues.shift() ?? "";
      return "";
    },
    generateFileListing: () => ""
  }
});
m = await import("../index.js");

test("loadHintSources: loads global and project hints", () => {
  hintValues = ["global", "project"];
  const s = m.loadHintSources("/tmp/proj");
  assert.equal(s.length, 2);
  assert.equal(s[0].content, "global");
  assert.equal(s[1].content, "project");
});

test("loadHintSources: falls back to root HINTS.md", () => {
  hintValues = [null, null, "root"];
  const s = m.loadHintSources("/tmp/proj");
  assert.equal(s.length, 1);
  assert.equal(s[0].content, "root");
});

test("loadHintSources: returns empty when no hints", () => {
  hintValues = [null, null];
  assert.equal(m.loadHintSources("/tmp/proj").length, 0);
});

test("buildHintsBlock: returns context_prune hint when no user hints", () => {
  hintValues = [null, null];
  const r = m.buildHintsBlock("/tmp/proj");
  assert.ok(r.includes("[HINTS — Stable Guidance]"));
  assert.ok(r.includes("Context Prune Discipline"));
  assert.ok(r.includes("context_prune"));
});

test("buildHintsBlock: formats hints block", () => {
  hintValues = ["global-hint", "project-hint"];
  const r = m.buildHintsBlock("/tmp/proj");
  assert.ok(r.includes("[HINTS — Stable Guidance]"));
  assert.ok(r.includes("global-hint"));
  assert.ok(r.includes("project-hint"));
});
