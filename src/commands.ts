import { Text, Box } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ContextPruneConfig, SummaryMessageDetails } from "./types.js";
import { STATUS_WIDGET_ID } from "./types.js";
import { saveConfig } from "./config.js";

function pruneStatusText(config: ContextPruneConfig): string {
  return config.enabled ? "prune: ON" : "prune: OFF";
}

export function registerCommands(
  pi: ExtensionAPI,
  currentConfig: { value: ContextPruneConfig }
): void {
  // Register the /context-prune command
  pi.registerCommand("context-prune", {
    description: "Manage context pruning. Subcommands: on, off, status, model [value]",
    handler: async (args, ctx) => {
      const parts = (args?.trim() ?? "").split(/\s+/).filter(Boolean);
      const subcommand = parts[0] ?? "";

      switch (subcommand) {
        case "on": {
          currentConfig.value.enabled = true;
          await saveConfig(ctx.cwd, currentConfig.value);
          ctx.ui.setStatus(STATUS_WIDGET_ID, pruneStatusText(currentConfig.value));
          ctx.ui.notify("Context pruning enabled", "info");
          break;
        }

        case "off": {
          currentConfig.value.enabled = false;
          await saveConfig(ctx.cwd, currentConfig.value);
          ctx.ui.setStatus(STATUS_WIDGET_ID, pruneStatusText(currentConfig.value));
          ctx.ui.notify("Context pruning disabled", "info");
          break;
        }

        case "status": {
          const { enabled, summarizerModel } = currentConfig.value;
          ctx.ui.notify(
            `Context pruning: ${enabled ? "ON" : "OFF"} | model: ${summarizerModel}`,
            "info"
          );
          break;
        }

        case "model": {
          const value = parts[1];
          if (!value) {
            ctx.ui.notify(
              `Current summarizer model: ${currentConfig.value.summarizerModel}`,
              "info"
            );
          } else {
            currentConfig.value.summarizerModel = value;
            await saveConfig(ctx.cwd, currentConfig.value);
            ctx.ui.setStatus(STATUS_WIDGET_ID, pruneStatusText(currentConfig.value));
            ctx.ui.notify(`Summarizer model set to: ${value}`, "info");
          }
          break;
        }

        default: {
          ctx.ui.notify(
            "Usage: /context-prune <subcommand>\n  on          Enable context pruning\n  off         Disable context pruning\n  status      Show current status\n  model       Show current summarizer model\n  model <id>  Set summarizer model (e.g. anthropic/claude-haiku-3-5)",
            "warning"
          );
          break;
        }
      }
    },
  });

  // Register custom renderer for context-prune-summary messages
  pi.registerMessageRenderer("context-prune-summary", (message, { expanded }, theme) => {
    const details = message.details as SummaryMessageDetails | undefined;
    const turnIndex = details?.turnIndex ?? "?";
    const toolCount = details?.toolCallIds?.length ?? 0;

    const header = theme.fg(
      "accent",
      `[context-prune] Turn ${turnIndex} summary (${toolCount} tool${toolCount === 1 ? "" : "s"})`
    );

    if (!expanded) {
      const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
      box.addChild(new Text(header, 0, 0));
      return box;
    }

    const body = theme.fg("muted", message.content);
    const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
    box.addChild(new Text(`${header}\n${body}`, 0, 0));
    return box;
  });
}
