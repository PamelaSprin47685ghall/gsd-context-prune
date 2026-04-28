import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFile } from "./fs.js";

const SETTINGS_PATH = path.join(os.homedir(), ".gsd", "context-prune.json");

export function loadDefaultModelId() {
  try {
    const raw = readFile(SETTINGS_PATH);
    if (!raw) return "default";
    const data = JSON.parse(raw);
    return data.summarizerModelId || "default";
  } catch (err) {
    console.error(`pruner: failed to parse ${SETTINGS_PATH}: ${err.message}`);
    return "default";
  }
}

export function saveModelId(modelId) {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ summarizerModelId: modelId }));
    return true;
  } catch (err) {
    console.error(`pruner: failed to persist model id to ${SETTINGS_PATH}: ${err.message}`);
    return false;
  }
}
