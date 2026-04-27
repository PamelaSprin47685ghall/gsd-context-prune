import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHintSources, buildHintsBlock } from "../index.js";
import { withTmp, withEnv } from "./helpers.mjs";

test("loadHintSources: prefers .gsd/HINTS.md over root", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "global\n");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "project\n");
  writeFileSync(join(pDir, "HINTS.md"), "root\n");
  withEnv("GSD_HOME", gDir, () => {
    const s = loadHintSources(pDir);
    assert.equal(s.length, 2);
    assert.equal(s[0].content, "global");
    assert.equal(s[1].content, "project");
  });
})));

test("loadHintSources: falls back to root HINTS.md", () => withTmp(pDir => withTmp(gDir => {
  writeFileSync(join(pDir, "HINTS.md"), "root");
  withEnv("GSD_HOME", gDir, () => {
    const s = loadHintSources(pDir);
    assert.equal(s.length, 1);
    assert.equal(s[0].content, "root");
  });
})));

test("loadHintSources: returns empty when no hints", () => withTmp(pDir => withTmp(gDir => {
  withEnv("GSD_HOME", gDir, () => assert.equal(loadHintSources(pDir).length, 0));
})));

test("buildHintsBlock: returns empty string when no hints", () => withTmp(pDir => withTmp(gDir => {
  withEnv("GSD_HOME", gDir, () => assert.equal(buildHintsBlock(pDir), ""));
})));

test("buildHintsBlock: formats hints block", () => withTmp(pDir => withTmp(gDir => {
  mkdirSync(join(pDir, ".gsd"));
  writeFileSync(join(gDir, "HINTS.md"), "global-hint");
  writeFileSync(join(pDir, ".gsd", "HINTS.md"), "project-hint");
  withEnv("GSD_HOME", gDir, () => {
    const r = buildHintsBlock(pDir);
    assert.ok(r.includes("[HINTS — Stable Guidance]"));
    assert.ok(r.includes("global-hint"));
    assert.ok(r.includes("project-hint"));
  });
})));
