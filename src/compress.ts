import { createHash } from "node:crypto";
import { IMAGE_PLACEHOLDER, validInteger } from "./trim.ts";

export interface ResizeOptions { maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number }
export interface ResizeResult {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}
/** Structural match for pi's `resizeImage`. */
export type Resizer = (bytes: Uint8Array, mimeType: string, options: ResizeOptions) => Promise<ResizeResult | null>;

export interface CompressOptions { keepFull?: number; tier1Count?: number }
export const COMPRESS_DEFAULTS = { keepFull: 2, tier1Count: 3 } as const;
export const TIERS = {
  1: { maxWidth: 1568, maxHeight: 1568, jpegQuality: 75 },
  2: { maxWidth: 768, maxHeight: 768, jpegQuality: 60 },
} as const;
export type Tier = keyof typeof TIERS;
export interface CompressStats { imagesCompressed: number; imagesRemoved: number }
export type Outcome =
  | { kind: "compressed"; data: string; mimeType: string; width: number; height: number }
  | { kind: "kept" }
  | { kind: "failed" };

interface Block { type: string; data?: unknown; mimeType?: unknown; [key: string]: unknown }
interface Message { role: string; content?: unknown }

const CACHE_LIMIT = 200;
const CONCURRENCY = 4;
const KEPT: Outcome = { kind: "kept" };
const FAILED: Outcome = { kind: "failed" };
// Per resizer so injected resizers never see each other's results.
const caches = new WeakMap<Resizer, Map<string, Promise<Outcome>>>();

let defaultResizer: Promise<Resizer> | undefined;
export function loadDefaultResizer(): Promise<Resizer> {
  defaultResizer ??= import("@earendil-works/pi-coding-agent").then(
    (pi) => pi.resizeImage as Resizer,
    (error) => {
      defaultResizer = undefined;
      throw error;
    },
  );
  return defaultResizer;
}

/** Mirrors pi's resizer so a result shrunk below the tier's dimensions can be detected. */
function targetSize(width: number, height: number, maxWidth: number, maxHeight: number) {
  if (width > maxWidth) {
    height = Math.round((height * maxWidth) / width);
    width = maxWidth;
  }
  if (height > maxHeight) {
    width = Math.round((width * maxHeight) / height);
    height = maxHeight;
  }
  return { width, height };
}

async function encode(data: string, mimeType: string, tier: Tier, resizer: Resizer): Promise<Outcome> {
  const settings = TIERS[tier];
  const bytes = Buffer.from(data, "base64");
  const fullTierSize = (result: ResizeResult) => {
    const target = targetSize(result.originalWidth, result.originalHeight, settings.maxWidth, settings.maxHeight);
    return result.width >= target.width && result.height >= target.height;
  };
  const usable = (result: ResizeResult) => fullTierSize(result) && result.data.length < data.length;
  let first: ResizeResult | null;
  try {
    // A maxBytes equal to the original size forces a re-encode even when dimensions already fit.
    first = await resizer(bytes, mimeType, { ...settings, maxBytes: data.length });
  } catch {
    return FAILED;
  }
  if (!first) return FAILED;
  const candidates = [first];
  // pi's resizer returns the first candidate under maxBytes and tries PNG before JPEG, so
  // jpegQuality only takes effect when the PNG is excluded by a tighter limit.
  if (first.mimeType === "image/png" && fullTierSize(first)) {
    try {
      const second = await resizer(bytes, mimeType, { ...settings, maxBytes: Math.min(first.data.length, data.length) });
      if (second) candidates.push(second);
    } catch { /* The first result is still valid. */ }
  }
  const best = candidates.filter(usable).sort((a, b) => a.data.length - b.data.length)[0];
  return best
    ? { kind: "compressed", data: best.data, mimeType: best.mimeType, width: best.width, height: best.height }
    : KEPT;
}

/** Cached by content hash and tier; never rejects. */
export function compressImage(data: string, mimeType: string, tier: Tier, resizer: Resizer): Promise<Outcome> {
  let cache = caches.get(resizer);
  if (!cache) caches.set(resizer, cache = new Map());
  const key = `${tier}:${createHash("sha256").update(data).digest("hex")}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const pending = encode(data, mimeType, tier, resizer);
  cache.set(key, pending);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return pending;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** Request-local: changed messages and content arrays are copied, the input is never mutated. */
export async function compressImages<T extends Message>(
  input: T[],
  opts: CompressOptions = {},
  resizer?: Resizer,
): Promise<{ messages: T[]; stats: CompressStats }> {
  const keepFull = validInteger(opts.keepFull, COMPRESS_DEFAULTS.keepFull);
  const tier1Count = validInteger(opts.tier1Count, COMPRESS_DEFAULTS.tier1Count);
  const stats: CompressStats = { imagesCompressed: 0, imagesRemoved: 0 };
  const images: { message: number; index: number; block: Block }[] = [];
  input.forEach((message, messageIndex) => {
    if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return;
    (message.content as Block[]).forEach((block, index) => {
      if (block.type === "image") images.push({ message: messageIndex, index, block });
    });
  });
  const older = images.slice(0, Math.max(0, images.length - keepFull));
  if (!older.length) return { messages: input.slice(), stats };
  const resize = resizer ?? await loadDefaultResizer();
  const outcomes = await mapLimit(older, CONCURRENCY, ({ block }, index) => {
    const tier: Tier = older.length - 1 - index < tier1Count ? 1 : 2;
    return typeof block.data === "string" && typeof block.mimeType === "string"
      ? compressImage(block.data, block.mimeType, tier, resize)
      : Promise.resolve(FAILED);
  });
  const messages = input.slice();
  const copied = new Set<number>();
  outcomes.forEach((outcome, i) => {
    if (outcome.kind === "kept") return;
    const { message, index, block } = older[i];
    if (!copied.has(message)) {
      messages[message] = { ...messages[message], content: [...(messages[message].content as Block[])] };
      copied.add(message);
    }
    const content = messages[message].content as Block[];
    if (outcome.kind === "compressed") {
      content[index] = { ...block, data: outcome.data, mimeType: outcome.mimeType };
      stats.imagesCompressed++;
    } else {
      content[index] = { type: "text", text: IMAGE_PLACEHOLDER };
      stats.imagesRemoved++;
    }
  });
  return { messages, stats };
}
