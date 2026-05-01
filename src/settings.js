import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

function readFile(p) {
  try {
    return fs.readFileSync(p, "utf-8").trim();
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

const SETTINGS_PATH = path.join(os.homedir(), ".gsd", "context-prune.json");

export function loadDefaultModelId() {
  try {
    const raw = readFile(SETTINGS_PATH);
    if (!raw) return "default";
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return "default";
    return typeof data.summarizerModelId === "string" ? data.summarizerModelId : "default";
  } catch (err) {
    return "default";
  }
}

export function saveModelId(modelId) {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `context-prune.tmp.${crypto.randomBytes(4).toString("hex")}`);
    fs.writeFileSync(tmp, JSON.stringify({ summarizerModelId: modelId }));
    fs.renameSync(tmp, SETTINGS_PATH);
    return true;
  } catch (err) {
    return false;
  }
}
