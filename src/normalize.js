export function normalizeMessages(messages, reasoningEffort) {
  return messages.map(m => {
    if (!m || typeof m !== "object") return m;
    const changed = {};
    if (m.content === null) changed.content = "";
    if (reasoningEffort && m.role === "assistant" && (m.reasoning_content === undefined || m.reasoning_content === null))
      changed.reasoning_content = "";
    return Object.keys(changed).length ? { ...m, ...changed } : m;
  });
}
