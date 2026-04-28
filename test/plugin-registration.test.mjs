import test from "node:test";
import assert from "node:assert/strict";
import contextPrunePlugin from "../index.js";

test("registers hooks and command", () => {
  const events = {}, commands = [];
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {},
    registerCommand: (n, o) => commands.push({ name: n, options: o })
  });
  assert.equal(typeof events.before_provider_request, "function");
  assert.equal(typeof events.before_agent_start, "function");
  assert.equal(typeof events.session_start, "function");
  assert.equal(typeof events.context, "function");
  assert.equal(typeof events.turn_end, "function");
  assert.equal(typeof events.input, "function");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "pruner");
});
