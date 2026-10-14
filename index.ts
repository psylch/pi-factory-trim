import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readCompressConfig, readConfig, type TrimConfig } from "./src/config.ts";
import { compressImages, loadDefaultResizer, type Resizer } from "./src/compress.ts";
import { trimMessages } from "./src/trim.ts";

export interface ExtensionOptions {
  loadResizer?: () => Promise<Resizer>;
  env?: NodeJS.ProcessEnv;
}

function notify(ctx: ExtensionContext, message: string) {
  if (!ctx.hasUI) {
    // Print/RPC mode has no UI; opt-in stderr logging keeps stdout clean.
    if (process.env.PI_FACTORY_TRIM_LOG === "1") console.error(message);
    return;
  }
  try {
    ctx.ui.notify(message, "info");
  } catch { /* A UI failure must not discard a successful transformation. */ }
}

function trimOnly<T extends { role: string }>(messages: T[], config: TrimConfig, ctx: ExtensionContext) {
  const { messages: trimmed, stats } = trimMessages(messages, config);
  if (!stats.imagesRemoved && !stats.toolResultsTruncated) return;
  notify(ctx, `Factory trim: removed ${stats.imagesRemoved} images, truncated ${stats.toolResultsTruncated} tool texts; ${stats.bytesBefore} → ${stats.bytesAfter} bytes`);
  return { messages: trimmed };
}

export function createExtension(options: ExtensionOptions = {}) {
  const loadResizer = options.loadResizer ?? loadDefaultResizer;
  return (pi: ExtensionAPI) => {
    pi.on("context", async (event, ctx) => {
      const env = options.env ?? process.env;
      let config: TrimConfig;
      try {
        config = readConfig(env);
        if (config.disabled || !ctx.model || !config.match.test(`${ctx.model.provider}/${ctx.model.id}`)) return;
        const compression = readCompressConfig(env);
        if (compression.enabled) {
          try {
            const compressed = await compressImages(
              event.messages,
              { ...compression, budgetBytes: config.budgetBytes, maxToolResultChars: config.maxToolResultChars },
              await loadResizer(),
            );
            // Compressed images are only dropped under budget pressure, never by count.
            const { messages, stats } = trimMessages(compressed.messages, { ...config, keepImages: Number.MAX_SAFE_INTEGER });
            const removed = compressed.stats.imagesRemoved + stats.imagesRemoved;
            if (!compressed.stats.imagesCompressed && !removed && !stats.toolResultsTruncated) return;
            const before = Buffer.byteLength(JSON.stringify(event.messages));
            notify(ctx, `Factory trim: compressed ${compressed.stats.imagesCompressed}, removed ${removed}, truncated ${stats.toolResultsTruncated}; ${before} → ${stats.bytesAfter} bytes`);
            return { messages };
          } catch { /* Fall back to the synchronous trim below. */ }
        }
        return trimOnly(event.messages, config, ctx);
      } catch {
        return;
      }
    });
  };
}

export default function (pi: ExtensionAPI) {
  createExtension()(pi);
}
