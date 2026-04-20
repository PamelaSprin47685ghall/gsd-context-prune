import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ContextPruneConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

/** Reads .pi/settings.json and returns the contextPrune block (or defaults). */
export async function loadConfig(cwd: string): Promise<ContextPruneConfig> {
  const path = join(cwd, ".pi", "settings.json");
  try {
    const raw = await readFile(path, "utf-8");
    const settings = JSON.parse(raw);
    const existing = settings.contextPrune ?? {};
    return { ...DEFAULT_CONFIG, ...existing };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Merges only the contextPrune key into .pi/settings.json, preserving all other keys. */
export async function saveConfig(cwd: string, config: ContextPruneConfig): Promise<void> {
  const path = join(cwd, ".pi", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, "utf-8");
    settings = JSON.parse(raw);
  } catch {
    // start with empty object if missing or unparseable
  }
  settings.contextPrune = config;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2));
}
