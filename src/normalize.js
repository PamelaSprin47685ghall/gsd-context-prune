// Convert top-level reasoning_content into a thinking block inside content.
// gsd-2's convertMessages drops top-level reasoning_content from raw pi messages
// but correctly propagates thinking blocks with thinkingSignature. This function
// bridges that gap so reasoning survives conversion to the API format.
export function embedReasoningContent(messages) {
  let changed = false;
  const out = messages.map(m => {
    if (m.role !== "assistant") return m;
    const rc = m.reasoning_content;
    if (rc === undefined || rc === null) return m;
    changed = true;
    const { reasoning_content, ...rest } = m;
    const content = Array.isArray(rest.content) ? rest.content : [];
    // Already has a thinking block → the top-level field is redundant (e.g. from a
    // previous context-prune injection).  Just drop the duplicate top-level field.
    if (content.some(b => b.type === "thinking")) return rest;
    // Promote top-level reasoning_content into a thinking block so convertMessages
    // sets (assistantMsg as any)["reasoning_content"] correctly.
    return {
      ...rest,
      content: [
        { type: "thinking", thinking: rc, thinkingSignature: "reasoning_content" },
        ...content,
      ],
    };
  });
  return changed ? out : messages;
}

export function normalizeMessages(messages, reasoningEffort) {
  return messages.map(m => {
    if (!m || typeof m !== "object") return m;
    const changed = {};
    if (m.content === null) changed.content = "";
    // Last-resort fallback: ensure every assistant message has the field for providers
    // that require reasoning_content on all assistant messages in reasoning mode.
    if (reasoningEffort && m.role === "assistant" && (m.reasoning_content === undefined || m.reasoning_content === null))
      changed.reasoning_content = "";
    return Object.keys(changed).length ? { ...m, ...changed } : m;
  });
}
