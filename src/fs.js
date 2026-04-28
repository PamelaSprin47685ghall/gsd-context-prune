import fs from "node:fs";
import path from "node:path";

let _listingCache = { dir: null, mtime: 0, count: 0, listing: "" };

const MAX_DEPTH = 10;
const MAX_FILES = 10000;

export function readFile(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

function sizeStr(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + "G";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + "M";
  return bytes >= 1024 ? (bytes / 1024).toFixed(1) + "K" : bytes + "B";
}

function dirSize(dir, depth = 0, state = { count: 0 }) {
  if (depth > MAX_DEPTH || state.count > MAX_FILES) return 0;
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .reduce((sum, item) => {
        if (state.count > MAX_FILES) return sum;
        const fp = path.join(dir, item.name);
        try {
          state.count++;
          return sum + (fs.statSync(fp).isDirectory() ? dirSize(fp, depth + 1, state) : fs.statSync(fp).size);
        } catch { return sum; }
      }, 0);
  } catch { return 0; }
}

export function generateFileListing(dir) {
  try {
    const dirStat = fs.statSync(dir);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const count = entries.length;
    
    if (_listingCache.dir === dir && 
        dirStat.mtimeMs <= _listingCache.mtime && 
        count === _listingCache.count)
      return _listingCache.listing;

    const listing = entries.map(item => {
      const fp = path.join(dir, item.name);
      try {
        const st = fs.statSync(fp);
        const sz = st.isDirectory() ? dirSize(fp) : st.size;
        return `${sizeStr(sz).padStart(8)}  ${item.name}${st.isDirectory() ? "/" : ""}`;
      } catch { return ""; }
    }).filter(Boolean).join("\n");

    _listingCache = { dir, mtime: dirStat.mtimeMs, count, listing };
    return listing;
  } catch { return ""; }
}
