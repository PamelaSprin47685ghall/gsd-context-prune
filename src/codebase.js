const CB_START = "[PROJECT CODEBASE —";

export function stripCodebase(text) {
  const s = text.indexOf(CB_START);
  if (s === -1) return null;
  const e = text.indexOf("\n#", s + 1);
  if (e === -1) return null;
  return { stable: text.slice(0, s) + text.slice(e), dynamic: text.slice(s, e).trim() };
}

export function stripMessages(messages) {
  const m = messages[0];
  if (!m) return messages;
  if (m.role !== "system" && m.role !== "developer") return messages;
  if (typeof m.content !== "string") return messages;
  const r = stripCodebase(m.content);
  if (!r) return messages;
  const out = messages.slice();
  out[0] = { ...m, content: r.stable };
  return out;
}
