import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

let m;
mock.module("../src/fs.js", {
  exports: {
    readFile: () => "mocked-hint",
    generateFileListing: () => " 123.0M  src/\n   4.0K  package.json\n 456.0K  README.md"
  }
});
m = await import("../src/inject.js");

test("buildStablePrompt: strips CODEBASE and appends HINTS", () => {
  const prompt = "Role.\nCurrent working directory: /tmp/d\n\n## Subagent Model\n\nUse default.\n\n[PROJECT CODEBASE — File structure]\n- app.js\n\n## End";
  const r = m.buildStablePrompt(prompt);
  assert.ok(!r.includes("PROJECT CODEBASE"));
  assert.ok(r.includes("[HINTS — Stable Guidance]"));
  assert.ok(r.includes("mocked-hint"));
  assert.ok(r.includes("Role."));
  assert.ok(r.includes("## End"));
  assert.ok(r.includes("$ du -hxd1"));
  assert.ok(r.includes("src/"));
  assert.ok(r.includes("package.json"));
});

test("buildStablePrompt: extracts cwd from Current working directory line", () => {
  const prompt = "Role.\nCurrent working directory: /real/proj\n\n[PROJECT CODEBASE — File structure]\n- x.js\n\n## Done";
  const r = m.buildStablePrompt(prompt);
  assert.ok(r.includes("/real/proj"));
  assert.ok(r.includes("$ du -hxd1"));
});

test("buildStablePrompt: no CODEBASE, just appends HINTS", () => {
  const prompt = "You are helpful.\nCurrent working directory: /tmp\n\n## Subagent Model\n\nDone.";
  const r = m.buildStablePrompt(prompt);
  assert.ok(r.includes("[HINTS — Stable Guidance]"));
  assert.ok(r.includes("You are helpful"));
});

test("buildStablePrompt: worktree override takes priority", () => {
  const prompt = [
    "Role.",
    "Current working directory: /some/old/path",
    "Some instructions.",
    "",
    "[WORKTREE CONTEXT — OVERRIDES CURRENT WORKING DIRECTORY ABOVE]",
    "The actual current working directory is: /real/worktree/path",
    "---",
    "[PROJECT CODEBASE — File structure]",
    "- old.js",
    "## Subagent Model",
    "Use claude."
  ].join("\n");
  const r = m.buildStablePrompt(prompt);
  assert.ok(r.includes("$ du -hxd1"));
  assert.ok(r.includes("/real/worktree/path"));
});
