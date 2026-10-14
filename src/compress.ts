import { createHash } from "node:crypto";
import { DEFAULTS, IMAGE_PLACEHOLDER, trimMessages, validInteger } from "./trim.ts";

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

export interface CompressOptions {
  keepFull?: number;
  tier1Count?: number;
  /** Kept-full images whose base64 is longer than this are compressed at tier 1 anyway. */
  maxImageBytes?: number;
  /** Escalation target; defaults to the trim budget. */
  budgetBytes?: number;
  /** Lets the size estimate match the tool text truncation `trimMessages` will apply. */
  maxToolResultChars?: number;
}
export const COMPRESS_DEFAULTS = { keepFull: 2, tier1Count: 3, maxImageBytes: 1_000_000 } as const;
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

interface Slot {
  message: number;
  index: number;
  /** The original block; every tier is encoded from it, never from an earlier result. */
  block: Block;
  keepFull: boolean;
  /** Highest tier attempted so far. */
  tier?: Tier;
  compressed: boolean;
  removed: boolean;
}

/**
 * Request-local: changed messages and content arrays are copied, the input is never mutated.
 *
 * Older images are compressed by age. Kept-full images over `maxImageBytes` get tier 1. If the
 * request is then still over `budgetBytes`, kept-full images are compressed at tier 1 and then
 * tier-1 images at tier 2, oldest first, until it fits. Dropping is left to `trimMessages`.
 */
export async function compressImages<T extends Message>(
  input: T[],
  opts: CompressOptions = {},
  resizer?: Resizer,
): Promise<{ messages: T[]; stats: CompressStats }> {
  const keepFull = validInteger(opts.keepFull, COMPRESS_DEFAULTS.keepFull);
  const tier1Count = validInteger(opts.tier1Count, COMPRESS_DEFAULTS.tier1Count);
  const maxImageBytes = validInteger(opts.maxImageBytes, COMPRESS_DEFAULTS.maxImageBytes);
  const budget = validInteger(opts.budgetBytes, DEFAULTS.budgetBytes);
  const slots: Slot[] = [];
  input.forEach((message, messageIndex) => {
    if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return;
    (message.content as Block[]).forEach((block, index) => {
      if (block.type === "image") slots.push({ message: messageIndex, index, block, keepFull: false, compressed: false, removed: false });
    });
  });
  const olderCount = Math.max(0, slots.length - keepFull);
  slots.forEach((slot, i) => { slot.keepFull = i >= olderCount; });

  let resize: Resizer | undefined;
  const run = async (slot: Slot, tier: Tier): Promise<Outcome> => {
    slot.tier = tier;
    const { data, mimeType } = slot.block;
    if (typeof data !== "string" || typeof mimeType !== "string") return FAILED;
    resize ??= resizer ?? await loadDefaultResizer();
    return compressImage(data, mimeType, tier, resize);
  };

  const messages = input.slice();
  const copied = new Set<number>();
  let bytes = 0;
  const blockBytes = (block: Block) => Buffer.byteLength(JSON.stringify(block));
  const replace = (slot: Slot, block: Block) => {
    if (!copied.has(slot.message)) {
      messages[slot.message] = { ...messages[slot.message], content: [...(messages[slot.message].content as Block[])] };
      copied.add(slot.message);
    }
    const content = messages[slot.message].content as Block[];
    // Swapping one array element changes the serialized request by exactly the element's difference.
    bytes += blockBytes(block) - blockBytes(content[slot.index]);
    content[slot.index] = block;
  };
  // Only older images fall back to the placeholder. Kept-full images and escalations keep what
  // they had (the original or a tier-1 result); the budget loop still drops them if needed.
  const apply = (slot: Slot, outcome: Outcome, placeholderOnFailure = false) => {
    if (outcome.kind === "compressed") {
      replace(slot, { ...slot.block, data: outcome.data, mimeType: outcome.mimeType });
      slot.compressed = true;
    } else if (outcome.kind === "failed" && placeholderOnFailure) {
      replace(slot, { type: "text", text: IMAGE_PLACEHOLDER });
      slot.removed = true;
    }
  };

  const initial = slots.flatMap((slot, i): [Slot, Tier][] => {
    if (!slot.keepFull) return [[slot, olderCount - 1 - i < tier1Count ? 1 : 2]];
    return typeof slot.block.data === "string" && slot.block.data.length > maxImageBytes ? [[slot, 1]] : [];
  });
  const outcomes = await mapLimit(initial, CONCURRENCY, ([slot, tier]) => run(slot, tier));
  outcomes.forEach((outcome, i) => apply(initial[i][0], outcome, !initial[i][0].keepFull));

  if (slots.length) {
    // Measured the way trimMessages will see it, after the initial tool text truncation.
    bytes = trimMessages(messages, {
      keepImages: Number.MAX_SAFE_INTEGER,
      maxToolResultChars: opts.maxToolResultChars,
      budgetBytes: Number.MAX_SAFE_INTEGER,
    }).stats.bytesAfter;
    for (const slot of slots) {
      if (bytes <= budget) break;
      if (slot.keepFull && !slot.tier) apply(slot, await run(slot, 1));
    }
    for (const slot of slots) {
      if (bytes <= budget) break;
      if (slot.tier === 1 && !slot.removed) apply(slot, await run(slot, 2));
    }
  }
  // Each image counts once, whichever tiers it went through.
  const stats: CompressStats = {
    imagesCompressed: slots.filter((slot) => slot.compressed).length,
    imagesRemoved: slots.filter((slot) => slot.removed).length,
  };
  return { messages, stats };
}
