import fs from "node:fs";

export function readFile(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : ""; } catch { return ""; }
}
