import fs from "node:fs";
import path from "node:path";

let listingDir = process.cwd();

export function setCodebaseDir(d) { listingDir = d; }
export function getCodebaseDir() { return listingDir; }

function sizeStr(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + "G";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + "M";
  return bytes >= 1024 ? (bytes / 1024).toFixed(1) + "K" : bytes + "B";
}

function dirSize(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .reduce((sum, item) => {
        const fp = path.join(dir, item.name);
        try { return sum + (fs.statSync(fp).isDirectory() ? dirSize(fp) : fs.statSync(fp).size); } catch { return sum; }
      }, 0);
  } catch { return 0; }
}

export function generateFileListing(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map(item => {
      const fp = path.join(dir, item.name);
      try {
        const st = fs.statSync(fp);
        const sz = st.isDirectory() ? dirSize(fp) : st.size;
        return `${sizeStr(sz).padStart(8)}  ${item.name}${st.isDirectory() ? "/" : ""}`;
      } catch { return ""; }
    }).filter(Boolean).join("\n");
  } catch { return ""; }
}

export function injectListing(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const t = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content) ? m.content.map(c => c.text || "").join("") : "";
    if (t.includes("<system-notification>")) return messages;
    const list = generateFileListing(listingDir);
    if (!list) return messages;
    const notif = `\n\n<system-notification>\n$ du -hxd1\n${list}\n</system-notification>`;
    const out = messages.map(x => ({ ...x }));
    const u = out[i];
    if (typeof u.content === "string") u.content += notif;
    else if (Array.isArray(u.content)) u.content = [...u.content, { type: "text", text: notif }];
    return out;
  }
  return messages;
}
