import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const read = p => { try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : ""; } catch { return ""; }};
const SETTINGS_PATH = path.join(os.homedir(), ".gsd", "context-prune.json");

export function loadDefaultModelId() {
  try {
    const data = JSON.parse(read(SETTINGS_PATH) || "{}");
    return data.summarizerModelId || "default";
  } catch { return "default"; }
}

export function saveModelId(modelId) {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ summarizerModelId: modelId }));
  } catch {}
}
