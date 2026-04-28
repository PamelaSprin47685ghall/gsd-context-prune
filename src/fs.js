import fs from "node:fs";

let _listingCache = { dir: null, mtime: 0, listing: "" };

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

function dirSize(dir, depth = 0) {
  if (depth > 5) return 0;
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .reduce((sum, item) => {
        const fp = dir + "/" + item.name;
        try { return sum + (fs.statSync(fp).isDirectory() ? dirSize(fp, depth + 1) : fs.statSync(fp).size); } catch { return sum; }
      }, 0);
  } catch { return 0; }
}

export function generateFileListing(dir) {
  try {
    const dirStat = fs.statSync(dir);
    if (_listingCache.dir === dir && dirStat.mtimeMs <= _listingCache.mtime)
      return _listingCache.listing;

    const listing = fs.readdirSync(dir, { withFileTypes: true }).map(item => {
      const fp = dir + "/" + item.name;
      try {
        const st = fs.statSync(fp);
        const sz = st.isDirectory() ? dirSize(fp) : st.size;
        return `${sizeStr(sz).padStart(8)}  ${item.name}${st.isDirectory() ? "/" : ""}`;
      } catch { return ""; }
    }).filter(Boolean).join("\n");

    _listingCache = { dir, mtime: dirStat.mtimeMs, listing };
    return listing;
  } catch { return ""; }
}
