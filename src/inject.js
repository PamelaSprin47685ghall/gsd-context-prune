import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { readFile } from "./fs.js";

export function loadHintSources(cwd) {
  const home = process.env.GSD_HOME || path.join(os.homedir(), ".gsd");
  const sources = [];
  const errors = [];

  try {
    const g = readFile(path.join(home, "HINTS.md"));
    if (g) sources.push({ label: "Global", path: path.join(home, "HINTS.md"), content: g });
  } catch (err) {
    errors.push(`Global HINTS: ${err.message}`);
  }

  if (cwd) {
    try {
      const found = [path.join(cwd, ".gsd", "HINTS.md"), path.join(cwd, "HINTS.md")]
        .find(p => fs.existsSync(p));
      if (found) {
        const content = readFile(found);
        if (content) sources.push({ label: "Project", path: "", content });
      }
    } catch (err) {
      errors.push(`Project HINTS: ${err.message}`);
    }
  }

  return { sources, errors };
}

function contextPruneHint() {
  return "## Context Prune Discipline\n\n"
    + "Tool call outputs are automatically compressed into summaries when you submit a new prompt. "
    + "This prevents large outputs from silently filling your context window and pushing out earlier "
    + "instructions and constraints. No manual action is needed — the compression happens before each "
    + "new turn so your context stays manageable.";
}

export function buildHintsBlock(cwd) {
  const { sources, errors } = loadHintSources(cwd);
  const parts = [contextPruneHint(), ...sources.map(x => `## ${x.label} HINTS (${x.path})\n\n${x.content}`)];
  const block = `[HINTS — Stable Guidance]\n\nThese instructions come from HINTS.md files and are intentionally injected into the stable system prompt.\n\n${
    parts.join("\n\n")}`;
  return { block, errors };
}

export function buildStablePrompt(systemPrompt, generateFileListing) {
  let cwd = null;
  let skipCodebase = false;
  const out = [];

  for (const line of systemPrompt.split("\n")) {
    if (line.startsWith("[PROJECT CODEBASE —")) {
      skipCodebase = true;
      continue;
    }
    if (skipCodebase) {
      if (line.startsWith("[") || line.startsWith("## ")) {
        skipCodebase = false;
        out.push(line);
      }
      continue;
    }
    const wt = /The actual current working directory is: (.+)/.exec(line);
    if (wt) cwd = wt[1].trim();
    const cd = /Current working directory: (.+)/.exec(line);
    if (!cwd && cd) cwd = cd[1].trim();
    out.push(line);
  }

  const { block, errors } = buildHintsBlock(cwd);
  const listing = cwd && generateFileListing ? generateFileListing(cwd) : "";
  const listingBlock = listing ? `\n$ du -hxd1\n${listing}\n` : "";
  return { systemPrompt: out.join("\n") + "\n\n" + block + listingBlock, errors };
}
