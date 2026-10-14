import { readFileSync } from "node:fs";
import { loadDefaultResizer, type Resizer } from "../../src/compress.ts";

/**
 * The package root needs Node >= 22.19 (it uses fs.globSync). On older Node the
 * resize module itself still works, so load it directly by path.
 */
export async function loadRealResizer(): Promise<Resizer> {
  try {
    return await loadDefaultResizer();
  } catch {
    const module = await import("../../node_modules/@earendil-works/pi-coding-agent/dist/utils/image-resize.js");
    return module.resizeImage as Resizer;
  }
}

export const FIXTURES = ["screenshot-1920x1080.png", "screenshot-2880x1800.png"] as const;
export function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url)).toString("base64");
}

/** Width and height from a base64 JPEG's SOF marker, or a PNG's IHDR. */
export function imageSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  let offset = 2;
  while (offset < bytes.length) {
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    offset += 2 + length;
  }
  throw new Error("unknown image format");
}
