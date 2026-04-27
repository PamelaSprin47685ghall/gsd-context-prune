export function stabilizeIds(input) {
  let changed = false;
  const out = input.map(x => {
    if (!x || typeof x !== "object") return x;
    if (x.type === "message" && x.role === "assistant" && typeof x.id === "string") {
      const { id, ...rest } = x;
      changed = true;
      return rest;
    }
    if (x.type === "function_call" && (typeof x.id === "string" || typeof x.call_id === "string")) {
      const { id, call_id, ...rest } = x;
      changed = true;
      return rest;
    }
    if (x.type === "function_call_output" && typeof x.call_id === "string") {
      const { call_id, ...rest } = x;
      changed = true;
      return rest;
    }
    return x;
  });
  return changed ? out : input;
}
