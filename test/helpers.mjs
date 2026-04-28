import contextPrunePlugin from "../index.js";

export const makePlugin = () => {
  const events = {};
  contextPrunePlugin({
    on: (e, cb) => { events[e] = cb; },
    registerTool: () => {}, registerCommand: () => {}
  });
  return events;
};

export const sessionCtx = () => ({
  ui: { notify: () => {} },
  sessionManager: { getBranch: () => [] }
});
