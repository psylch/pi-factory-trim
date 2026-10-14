export interface TrimOptions {
  keepImages?: number;
  maxToolResultChars?: number;
  budgetBytes?: number;
}
export const DEFAULTS = {
  keepImages: 3,
  maxToolResultChars: 30_000,
  budgetBytes: 3_500_000,
} as const;
export const IMAGE_PLACEHOLDER = "[image removed to fit request size]";
interface Block { type: string; text?: string; [key: string]: unknown }
interface Message { role: string; content?: unknown }
export interface TrimStats {
  imagesRemoved: number;
  toolResultsTruncated: number;
  bytesBefore: number;
  bytesAfter: number;
}

export function validInteger(value: number | undefined, fallback: number, minimum = 0): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const edge = Math.floor(limit * 0.4);
  const removed = text.length - edge * 2;
  const result = text.slice(0, edge) + `\n[... ${removed} chars truncated to fit request size ...]\n` +
    (edge ? text.slice(-edge) : "");
  // Tiny configured limits must never make the request larger.
  return result.length < text.length ? result : text;
}

/** Request-local transformation. Unknown roles and assistant blocks are preserved. */
export function trimMessages<T extends Message>(input: T[], opts: TrimOptions = {}): { messages: T[]; stats: TrimStats } {
  const messages = structuredClone(input);
  const size = () => Buffer.byteLength(JSON.stringify(messages));
  const stats: TrimStats = { imagesRemoved: 0, toolResultsTruncated: 0, bytesBefore: size(), bytesAfter: 0 };
  const keepImages = validInteger(opts.keepImages, DEFAULTS.keepImages);
  const maxChars = validInteger(opts.maxToolResultChars, DEFAULTS.maxToolResultChars);
  const budget = validInteger(opts.budgetBytes, DEFAULTS.budgetBytes);
  const images: { content: Block[]; index: number }[] = [];
  const texts: Block[] = [];
  const truncated = new Set<Block>();
  for (const message of messages) {
    if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) continue;
    const content = message.content as Block[];
    content.forEach((block, index) => {
      if (block.type === "image") images.push({ content, index });
      if (message.role === "toolResult" && block.type === "text" && typeof block.text === "string") texts.push(block);
    });
  }
  const removeImage = (image: typeof images[number]) => {
    image.content[image.index] = { type: "text", text: IMAGE_PLACEHOLDER };
    stats.imagesRemoved++;
  };
  const shorten = (block: Block, limit: number) => {
    const original = block.text!;
    const replacement = truncate(original, limit);
    if (replacement === original) return false;
    block.text = replacement;
    truncated.add(block);
    return true;
  };
  const olderCount = Math.max(0, images.length - keepImages);
  images.slice(0, olderCount).forEach(removeImage);
  texts.forEach((block) => shorten(block, maxChars));
  let remainingImage = olderCount;
  let bytes = size();
  while (bytes > budget) {
    if (remainingImage < images.length) {
      removeImage(images[remainingImage++]);
    } else {
      // Largest reducible block first; encounter order breaks ties in favor of older results.
      const candidate = texts.filter((block) => block.text!.length > 2000)
        .reduce<Block | undefined>((best, block) => !best || block.text!.length > best.text!.length ? block : best, undefined);
      if (!candidate || !shorten(candidate, 2000)) break;
    }
    bytes = size();
  }
  stats.toolResultsTruncated = truncated.size;
  stats.bytesAfter = bytes;
  return { messages, stats };
}
