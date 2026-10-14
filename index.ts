import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./src/config.ts";
import { trimMessages } from "./src/trim.ts";

export default function (pi: ExtensionAPI) {
  pi.on("context", (event, ctx) => {
    try {
      const config = readConfig();
      if (config.disabled || !ctx.model || !config.match.test(`${ctx.model.provider}/${ctx.model.id}`)) return;
      const { messages, stats } = trimMessages(event.messages, config);
      if (!stats.imagesRemoved && !stats.toolResultsTruncated) return;
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(`Factory trim: removed ${stats.imagesRemoved} images, truncated ${stats.toolResultsTruncated} tool texts; ${stats.bytesBefore} → ${stats.bytesAfter} bytes`, "info");
        } catch { /* A UI failure must not discard a successful transformation. */ }
      }
      return { messages };
    } catch {
      return;
    }
  });
}
