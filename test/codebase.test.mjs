import test from "node:test";
import assert from "node:assert/strict";
import { stripCodebase } from "../index.js";

test("stripCodebase: strips CODEBASE block between markers", () => {
  const text = "You are helpful.\n\n[PROJECT CODEBASE — File structure]\n- app.js\n\n## Subagent Model\n\nDone.";
  const r = stripCodebase(text);
  assert.ok(r);
  assert.ok(!r.stable.includes("PROJECT CODEBASE"));
  assert.ok(r.stable.includes("You are helpful"));
  assert.ok(r.stable.includes("## Subagent Model"));
  assert.ok(r.dynamic.includes("app.js"));
});

test("stripCodebase: returns null when no CODEBASE", () => {
  assert.equal(stripCodebase("Just text."), null);
});

test("stripCodebase: handles missing boundary (partial CODEBASE)", () => {
  const text = "Start.\n\n[PROJECT CODEBASE — File structure]\n- app.js\n\nNo boundary after this.";
  assert.equal(stripCodebase(text), null);
});
