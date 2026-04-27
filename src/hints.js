import path from "node:path";
import os from "node:os";
import { readFile } from "./util.js";

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

export function injectHints(messages, cwd) {
  const block = buildHintsBlock(cwd);
  if (!block) return messages;
  let changed = false;
  const out = messages.map(m => {
    if (m.role !== "system" && m.role !== "developer") return m;
    if (typeof m.content === "string") {
      if (m.content.includes("[HINTS — Stable Guidance]")) return m;
      changed = true;
      return { ...m, content: block + "\n\n" + m.content };
    }
    if (Array.isArray(m.content)) {
      if (m.content.some(c => c.text?.includes("[HINTS — Stable Guidance]"))) return m;
      changed = true;
      return { ...m, content: [{ type: "text", text: block + "\n\n" }, ...m.content] };
    }
    return m;
  });
  return changed ? out : messages;
}
