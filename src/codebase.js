const CB_START = "[PROJECT CODEBASE —";
const CB_STOPS = ["## Subagent Model", "## GSD Skill Preferences", "# Tools", "## Tools"];

export function stripCodebase(text) {
  const s = text.indexOf(CB_START);
  if (s === -1) return null;
  let e = -1;
  for (const stop of CB_STOPS) {
    const i = text.indexOf(stop, s + 1);
    if (i !== -1 && (e === -1 || i < e)) e = i;
  }
  return e === -1 ? null : { stable: text.slice(0, s) + text.slice(e), dynamic: text.slice(s, e).trim() };
}

export function stripMessages(messages) {
  let changed = false;
  const out = messages.map(m => {
    if (m.role !== "system" && m.role !== "developer") return m;
    if (typeof m.content === "string") {
      const r = stripCodebase(m.content);
      if (!r) return m;
      changed = true;
      return { ...m, content: r.stable };
    }
    if (Array.isArray(m.content)) {
      let ok = false;
      const c = m.content.map(x => {
        if (x.type !== "text") return x;
        const r = stripCodebase(x.text);
        if (!r) return x;
        ok = true;
        return { ...x, text: r.stable };
      });
      return ok ? (changed = true, { ...m, content: c }) : m;
    }
    return m;
  });
  return changed ? out : messages;
}
