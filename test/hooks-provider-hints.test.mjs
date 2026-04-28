import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

let m;
mock.module("../src/fs.js", {
  namedExports: {
    readFile: () => "mocked-hint"
  }
});
m = await import("../src/inject.js");

test("buildStablePrompt: strips CODEBASE and appends HINTS", () => {
  const prompt = "Role.\nCurrent working directory: /tmp/d\n\n## Subagent Model\n\nUse default.\n\n[PROJECT CODEBASE — File structure]\n- app.js\n\n## End";
  const { systemPrompt } = m.buildStablePrompt(prompt, () => " 123.0M  src/\n   4.0K  package.json\n 456.0K  README.md");
  assert.ok(!systemPrompt.includes("PROJECT CODEBASE"));
  assert.ok(systemPrompt.includes("[HINTS — Stable Guidance]"));
  assert.ok(systemPrompt.includes("mocked-hint"));
  assert.ok(systemPrompt.includes("Role."));
  assert.ok(systemPrompt.includes("## End"));
  assert.ok(systemPrompt.includes("$ du -hxd1"));
  assert.ok(systemPrompt.includes("src/"));
  assert.ok(systemPrompt.includes("package.json"));
});

test("buildStablePrompt: extracts cwd from Current working directory line", () => {
  const prompt = "Role.\nCurrent working directory: /real/proj\n\n[PROJECT CODEBASE — File structure]\n- x.js\n\n## Done";
  const { systemPrompt } = m.buildStablePrompt(prompt, () => "listing");
  assert.ok(systemPrompt.includes("$ du -hxd1"));
});

test("buildStablePrompt: no CODEBASE, just appends HINTS", () => {
  const prompt = "You are helpful.\nCurrent working directory: /tmp\n\n## Subagent Model\n\nDone.";
  const { systemPrompt } = m.buildStablePrompt(prompt, () => "");
  assert.ok(systemPrompt.includes("[HINTS — Stable Guidance]"));
  assert.ok(systemPrompt.includes("You are helpful"));
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
  const { systemPrompt } = m.buildStablePrompt(prompt, () => "worktree-listing");
  assert.ok(systemPrompt.includes("$ du -hxd1"));
  assert.ok(systemPrompt.includes("worktree-listing"));
});
