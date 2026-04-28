import path from "node:path";
import os from "node:os";
import { readFile, generateFileListing } from "./fs.js";

// ─── HINTS loading ───────────────────────────────────────────────────

export function loadHintSources(cwd) {
  const home = process.env.GSD_HOME || path.join(os.homedir(), ".gsd");
  const g = readFile(path.join(home, "HINTS.md"));
  const out = g ? [{ label: "Global", path: path.join(home, "HINTS.md"), content: g }] : [];
  if (cwd) {
    const p = readFile(path.join(cwd, ".gsd", "HINTS.md")) || readFile(path.join(cwd, "HINTS.md"));
    if (p) out.push({ label: "Project", path: "", content: p });
  }
  return out;
}

function contextPruneHint() {
  return "## Context Prune Discipline\n\n"
    + "Call `context_prune` aggressively. Every batch of tool calls (reads, searches, commands) produces large results "
    + "that silently fill your context window. If you don't prune regularly, earlier instructions and constraints will "
    + "be pushed out of context, leading to degraded reasoning and task failure. There is no penalty for calling it "
    + "too often — call it after every meaningful batch of tool work.";
}

export function buildHintsBlock(cwd) {
  const s = loadHintSources(cwd);
  const parts = [contextPruneHint(), ...s.map(x => `## ${x.label} HINTS (${x.path})\n\n${x.content}`)];
  return `[HINTS — Stable Guidance]\n\nThese instructions come from HINTS.md files and are intentionally injected into the stable system prompt.\n\n${
    parts.join("\n\n")}`;
}

// ─── System prompt injection ─────────────────────────────────────────

export function buildStablePrompt(systemPrompt) {
  let cwd = null;
  let skipCodebase = false;
  const out = [];

  for (const line of systemPrompt.split("\n")) {
    if (line.startsWith("[PROJECT CODEBASE —")) {
      skipCodebase = true;
      continue;
    }
    if (skipCodebase) {
      // End of CODEBASE: next section marker restores normal flow
      if (line.startsWith("[") || line.startsWith("## ")) {
        skipCodebase = false;
        out.push(line);
      }
      continue;
    }
    // Extract cwd while we pass through
    const wt = /The actual current working directory is: (.+)/.exec(line);
    if (wt) cwd = wt[1].trim();
    const cd = /Current working directory: (.+)/.exec(line);
    if (!cwd && cd) cwd = cd[1].trim();
    out.push(line);
  }

  const hints = buildHintsBlock(cwd);
  const listing = cwd ? generateFileListing(cwd) : "";
  const listingBlock = listing ? `\n$ du -hxd1\n${listing}\n` : "";
  return out.join("\n") + "\n\n" + hints + listingBlock;
}
