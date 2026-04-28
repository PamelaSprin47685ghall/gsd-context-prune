import fs from "node:fs";

export function readFile(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : ""; } catch { return ""; }
}

function sizeStr(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + "G";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + "M";
  return bytes >= 1024 ? (bytes / 1024).toFixed(1) + "K" : bytes + "B";
}

function dirSize(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .reduce((sum, item) => {
        const fp = dir + "/" + item.name;
        try { return sum + (fs.statSync(fp).isDirectory() ? dirSize(fp) : fs.statSync(fp).size); } catch { return sum; }
      }, 0);
  } catch { return 0; }
}

export function generateFileListing(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map(item => {
      const fp = dir + "/" + item.name;
      try {
        const st = fs.statSync(fp);
        const sz = st.isDirectory() ? dirSize(fp) : st.size;
        return `${sizeStr(sz).padStart(8)}  ${item.name}${st.isDirectory() ? "/" : ""}`;
      } catch { return ""; }
    }).filter(Boolean).join("\n");
  } catch { return ""; }
}
