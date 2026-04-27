import test from "node:test";
import assert from "node:assert/strict";
import { stabilizeIds } from "../index.js";

test("stabilizeIds: strips assistant message id and function_call id/call_id", () => {
  const input = [
    { type: "message", role: "assistant", id: "msg_rnd", content: [] },
    { type: "function_call", id: "fc_rnd", call_id: "call_rnd" },
    { type: "function_call_output", call_id: "call_rnd", output: "ok" },
    { type: "message", role: "assistant", id: "msg_other", content: [] }
  ];
  const out = stabilizeIds(input);
  assert.equal(out[0].id, undefined);
  assert.equal(out[1].id, undefined);
  assert.equal(out[1].call_id, undefined);
  assert.equal(out[2].call_id, undefined);
  assert.equal(out[3].id, undefined);
  assert.ok(out !== input);
});

test("stabilizeIds: preserves reasoning items and strips function_call_output call_id", () => {
  const input = [
    { type: "reasoning", id: "rs_id" },
    { type: "function_call_output", call_id: "late" }
  ];
  const out = stabilizeIds(input);
  assert.equal(out[0].id, "rs_id");
  assert.equal(out[1].call_id, undefined);
});

test("stabilizeIds: strips already-stable IDs too", () => {
  const input = [
    { type: "message", role: "assistant", id: "msg_0", content: [] }
  ];
  const out = stabilizeIds(input);
  assert.equal(out[0].id, undefined);
  assert.ok(out !== input);
});
