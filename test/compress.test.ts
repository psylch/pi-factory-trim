import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtension } from "../index.ts";
import { compressImages, TIERS, type ResizeOptions, type Resizer } from "../src/compress.ts";
import { readCompressConfig, readConfig } from "../src/config.ts";
import { IMAGE_PLACEHOLDER, trimMessages } from "../src/trim.ts";
import { FIXTURES, fixture, imageSize, loadRealResizer } from "./support/real-resizer.ts";

const image = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });
const text = (value: string) => ({ type: "text", text: value });
const user = (content: unknown) => ({ role: "user", content });
const tool = (content: unknown) => ({ role: "toolResult", toolCallId: "call", toolName: "read", content, isError: false, timestamp: 0 });
const placeholder = text(IMAGE_PLACEHOLDER);

/** Returns a JPEG at the tier's dimensions whose payload records which image and tier produced it. */
function fakeResizer(calls: { data: string; options: ResizeOptions }[] = [], size = (bytes: Uint8Array) => bytes.length): Resizer {
  return async (bytes, _mimeType, options) => {
    const data = Buffer.from(bytes).toString("base64");
    calls.push({ data, options });
    return {
      data: `${options.maxWidth}:${data}`.slice(0, size(bytes)),
      mimeType: "image/jpeg",
      width: options.maxWidth,
      height: options.maxHeight,
      originalWidth: options.maxWidth * 2,
      originalHeight: options.maxHeight * 2,
    };
  };
}
const payload = (id: string) => Buffer.from(id.repeat(64)).toString("base64");

async function runHandler(messages: unknown[], env: NodeJS.ProcessEnv, loadResizer: () => Promise<Resizer>) {
  let handler: ((event: unknown, ctx: unknown) => Promise<{ messages: unknown[] } | void>) | undefined;
  const pi = { on: (_event: string, h: typeof handler) => { handler = h; } } as unknown as ExtensionAPI;
  createExtension({ env, loadResizer })(pi);
  const notes: string[] = [];
  const ctx = { model: { provider: "factory", id: "claude" }, hasUI: true, ui: { notify: (message: string) => notes.push(message) } };
  const result = await handler!({ type: "context", messages }, ctx);
  return { result, notes };
}

test("real resizeImage compresses older images and keeps the latest N byte-identical", async () => {
  const resizer = await loadRealResizer();
  const [small, large] = FIXTURES.map(fixture);
  // Kept-full images stay under the default per-image cap so they are not compressed.
  const input = [user([image(large), text("first")]), tool([image(small)]), tool([image(small)]), user([image(small), text("latest")])];
  const original = structuredClone(input);
  const { messages, stats } = await compressImages(input, { keepFull: 2 }, resizer);
  assert.deepEqual(stats, { imagesCompressed: 2, imagesRemoved: 0 });
  assert.deepEqual(messages.slice(2), original.slice(2));
  assert.deepEqual(input, original);
  const blocks = messages.map((m) => m.content as { type: string; data?: string; mimeType?: string }[]);
  const older = [blocks[0][0], blocks[1][0]] as { data: string; mimeType: string }[];
  for (const [i, block] of older.entries()) {
    const source = [large, small][i];
    assert.equal(block.mimeType, "image/jpeg");
    assert.ok(block.data.length < source.length / 1.5, `compressed ${block.data.length} vs ${source.length}`);
    assert.equal(Math.max(...Object.values(imageSize(block.data))), TIERS[1].maxWidth);
  }
  assert.deepEqual(blocks[0][1], text("first"));
});

test("real resizeImage tiers: next older images get 1568px, the rest 768px and fewer bytes", async () => {
  const resizer = await loadRealResizer();
  const large = fixture(FIXTURES[1]);
  // Same bytes at different ages: the cache key includes the tier, so both tiers are encoded.
  const { messages, stats } = await compressImages([user([image(large)]), user([image(large)])], { keepFull: 0, tier1Count: 1 }, resizer);
  assert.equal(stats.imagesCompressed, 2);
  const [tier2, tier1] = messages.map((m) => (m.content as { data: string }[])[0].data);
  assert.deepEqual(imageSize(tier1), { width: 1568, height: 980 });
  assert.deepEqual(imageSize(tier2), { width: 768, height: 480 });
  assert.ok(tier2.length < tier1.length);
});

test("tier assignment uses keepFull and tier1Count counted from the newest image", async () => {
  const calls: { data: string; options: ResizeOptions }[] = [];
  const ids = ["a", "b", "c", "d", "e", "f", "g"].map(payload);
  const input = [user(ids.slice(0, 3).map((id) => image(id))), tool(ids.slice(3, 5).map((id) => image(id))), user(ids.slice(5).map((id) => image(id)))];
  const { messages, stats } = await compressImages(input, {}, fakeResizer(calls));
  assert.deepEqual(stats, { imagesCompressed: 5, imagesRemoved: 0 });
  const tiers = new Map(calls.map(({ data, options }) => [data, options]));
  assert.equal(tiers.size, 5);
  for (const id of ids.slice(0, 2)) assert.deepEqual(tiers.get(id), { ...TIERS[2], maxBytes: id.length });
  for (const id of ids.slice(2, 5)) assert.deepEqual(tiers.get(id), { ...TIERS[1], maxBytes: id.length });
  assert.deepEqual(messages[2], input[2]);
  const env = readCompressConfig({ PI_FACTORY_TRIM_KEEP_FULL: "0", PI_FACTORY_TRIM_TIER1_COUNT: "1" });
  const again: typeof calls = [];
  await compressImages(input, env, fakeResizer(again));
  assert.equal(again.filter(({ options }) => options.maxWidth === 1568).length, 1);
  assert.equal(again.filter(({ options }) => options.maxWidth === 768).length, 6);
});

test("results are cached by content and tier across calls", async () => {
  const calls: { data: string; options: ResizeOptions }[] = [];
  const resizer = fakeResizer(calls);
  const input = [user([image(payload("x"))]), user([image(payload("x"))]), user([image(payload("latest"))])];
  const first = await compressImages(input, { keepFull: 1 }, resizer);
  const second = await compressImages(input, { keepFull: 1 }, resizer);
  assert.equal(calls.length, 1);
  assert.deepEqual(first, second);
  assert.equal(second.stats.imagesCompressed, 2);

  let realCalls = 0;
  const real = await loadRealResizer();
  const counting: Resizer = (...args) => { realCalls++; return real(...args); };
  const screenshot = [user([image(fixture(FIXTURES[0]))]), user([text("latest")])];
  const a = await compressImages(screenshot, { keepFull: 0 }, counting);
  const afterFirst = realCalls;
  const b = await compressImages(screenshot, { keepFull: 0 }, counting);
  assert.ok(afterFirst >= 1);
  assert.equal(realCalls, afterFirst);
  assert.deepEqual(a, b);
});

test("null or throwing resizers fall back to the placeholder and count as removed", async () => {
  const input = [user([image(payload("old")), text("keep")]), tool([image(payload("older"))]), user([image(payload("new"))])];
  const original = structuredClone(input);
  for (const resizer of [async () => null, async () => { throw new Error("photon unavailable"); }] as Resizer[]) {
    const { messages, stats } = await compressImages(input, { keepFull: 1 }, resizer);
    assert.deepEqual(stats, { imagesCompressed: 0, imagesRemoved: 2 });
    assert.deepEqual(messages, [user([placeholder, text("keep")]), tool([placeholder]), input[2]]);
  }
  const malformed = await compressImages([user([{ type: "image" }]), user([text("latest")])], { keepFull: 0 }, fakeResizer());
  assert.deepEqual(malformed.messages[0].content, [placeholder]);
  assert.deepEqual(input, original);
});

test("results that are not smaller or were shrunk below the tier size keep the original", async () => {
  const input = [user([image(payload("big"))]), user([text("latest")])];
  const larger = await compressImages(input, { keepFull: 0 }, fakeResizer([], (bytes) => bytes.length * 10));
  assert.deepEqual(larger, { messages: input, stats: { imagesCompressed: 0, imagesRemoved: 0 } });
  const shrunk: Resizer = async (_bytes, _mime, options) => ({ data: "x", mimeType: "image/jpeg", width: 10, height: 10, originalWidth: options.maxWidth, originalHeight: options.maxHeight });
  assert.deepEqual((await compressImages(input, { keepFull: 0 }, shrunk)).messages, input);
});

test("a PNG first result is retried with a tighter limit so JPEG quality applies", async () => {
  const calls: number[] = [];
  const data = payload("png");
  const resizer: Resizer = async (_bytes, _mime, options) => {
    calls.push(options.maxBytes);
    const png = calls.length === 1;
    return { data: png ? "p".repeat(data.length - 1) : "j".repeat(10), mimeType: png ? "image/png" : "image/jpeg", width: 8, height: 8, originalWidth: 8, originalHeight: 8 };
  };
  const { messages } = await compressImages([user([image(data)])], { keepFull: 0 }, resizer);
  assert.deepEqual(calls, [data.length, data.length - 1]);
  assert.deepEqual(messages[0].content, [image("j".repeat(10), "image/jpeg")]);
  const failing: Resizer = async (_bytes, _mime, options) => {
    if (options.maxBytes < data.length) throw new Error("second pass failed");
    return { data: "p", mimeType: "image/png", width: 8, height: 8, originalWidth: 8, originalHeight: 8 };
  };
  assert.deepEqual((await compressImages([user([image(data)])], { keepFull: 0 }, failing)).messages[0].content, [image("p")]);
});

test("extension compresses, keeps compressed images past the old count limit, and notifies", async () => {
  const messages = [1, 2, 3, 4, 5, 6].map((n) => user([image(payload(String(n)))]));
  const original = structuredClone(messages);
  const { result, notes } = await runHandler(messages, {}, async () => fakeResizer([], (bytes) => 20));
  const content = result!.messages.map((m) => (m as { content: { type: string; data?: string }[] }).content[0]);
  assert.deepEqual(content.map((b) => b.type), ["image", "image", "image", "image", "image", "image"]);
  assert.deepEqual(content.map((b) => b.data!.split(":")[0]), ["768", "1568", "1568", "1568", payload("5"), payload("6")]);
  const after = Buffer.byteLength(JSON.stringify(result!.messages));
  assert.deepEqual(notes, [`Factory trim: compressed 4, removed 0, truncated 0; ${Buffer.byteLength(JSON.stringify(original))} → ${after} bytes`]);
  assert.deepEqual(messages, original);
  const unchanged = await runHandler([user([image(payload("only"))])], {}, async () => fakeResizer());
  assert.equal(unchanged.result, undefined);
  assert.deepEqual(unchanged.notes, []);
});

test("budget fallback removes oldest images only after every image reached tier 2", async () => {
  const resizer = await loadRealResizer();
  const large = fixture(FIXTURES[1]);
  const input = [user([image(large)]), tool([image(large), text("x".repeat(40000))]), user([image(large)]), user([image(large), text("latest")])];
  // About 254KB with all four at tier 2 (~57KB each) plus 30K of tool text; one removal fits.
  const budget = 210_000;
  const { result, notes } = await runHandler(input, { PI_FACTORY_TRIM_BUDGET_BYTES: String(budget) }, async () => resizer);
  const out = result!.messages as { content: { type: string; data?: string; text?: string }[] }[];
  const bytes = Buffer.byteLength(JSON.stringify(out));
  assert.ok(bytes <= budget, `${bytes} > ${budget}`);
  assert.deepEqual(out[0].content, [placeholder]);
  for (const block of [out[1].content[0], out[2].content[0], out[3].content[0]]) {
    assert.deepEqual(imageSize(block.data!), { width: 768, height: 480 });
  }
  assert.ok(out[1].content[1].text!.length < 40000);
  assert.deepEqual(out[3].content[1], text("latest"));
  // The removed image was compressed first, so it is counted in both numbers.
  assert.deepEqual(notes, [`Factory trim: compressed 4, removed 1, truncated 1; ${Buffer.byteLength(JSON.stringify(input))} → ${bytes} bytes`]);
});

test("a single latest huge image is compressed under budget pressure instead of dropped", async () => {
  const resizer = await loadRealResizer();
  const large = fixture(FIXTURES[1]);
  const input = [user([text("what is on screen?")]), tool([image(large)])];
  const before = Buffer.byteLength(JSON.stringify(input));
  // The cap is lifted so only the budget can trigger compression of the kept-full image.
  const env = { PI_FACTORY_TRIM_MAX_IMAGE_BYTES: String(Number.MAX_SAFE_INTEGER) };
  const cases = [{ budget: 1_000_000, size: { width: 1568, height: 980 } }, { budget: 100_000, size: { width: 768, height: 480 } }];
  for (const { budget, size } of cases) {
    const { result, notes } = await runHandler(input, { ...env, PI_FACTORY_TRIM_BUDGET_BYTES: String(budget) }, async () => resizer);
    const out = result!.messages as { content: { type: string; data: string; mimeType: string }[] }[];
    const bytes = Buffer.byteLength(JSON.stringify(out));
    assert.ok(bytes <= budget, `${bytes} > ${budget}`);
    assert.equal(out[1].content[0].type, "image");
    assert.equal(out[1].content[0].mimeType, "image/jpeg");
    assert.deepEqual(imageSize(out[1].content[0].data), size);
    assert.deepEqual(notes, [`Factory trim: compressed 1, removed 0, truncated 0; ${before} → ${bytes} bytes`]);
  }
  const roomy = await runHandler(input, env, async () => resizer);
  assert.equal(roomy.result, undefined);
});

/** Tier 1 results are 1000 chars, tier 2 results 100; calls are recorded as image letter + tier. */
function tieredResizer(calls: string[], fail: (id: string, tier: number) => boolean = () => false): Resizer {
  return async (bytes, _mimeType, options) => {
    const id = Buffer.from(bytes).toString("base64")[0];
    const tier = options.maxWidth === TIERS[1].maxWidth ? 1 : 2;
    calls.push(`${id}${tier}`);
    if (fail(id, tier)) return null;
    return {
      data: `${id}${tier}:`.padEnd(tier === 1 ? 1000 : 100, "x"),
      mimeType: "image/jpeg",
      width: options.maxWidth,
      height: options.maxHeight,
      originalWidth: options.maxWidth * 2,
      originalHeight: options.maxHeight * 2,
    };
  };
}

test("escalation compresses kept-full images, then tier 1 to tier 2, oldest first, until under budget", async () => {
  // A is tier 2 and B tier 1 by age; C and D are kept full. Originals are 10000 chars each.
  const input = ["A", "B", "C", "D"].map((id) => user([image(id.repeat(10000))]));
  const original = structuredClone(input);
  const run = async (budgetBytes: number, fail?: (id: string, tier: number) => boolean) => {
    const calls: string[] = [];
    const { messages, stats } = await compressImages(input, { keepFull: 2, tier1Count: 1, budgetBytes }, tieredResizer(calls, fail));
    const data = messages.map((m) => (m.content as { data?: string; text?: string }[])[0]);
    return { calls, stats, prefixes: data.map((b) => b.data?.slice(0, 2) ?? b.text), bytes: Buffer.byteLength(JSON.stringify(messages)) };
  };

  const roomy = await run(100_000);
  assert.deepEqual(roomy.calls, ["A2", "B1"]);
  assert.deepEqual(roomy.prefixes, ["A2", "B1", "CC", "DD"]);

  const one = await run(15_000);
  assert.deepEqual(one.calls, ["A2", "B1", "C1"]);
  assert.deepEqual(one.prefixes, ["A2", "B1", "C1", "DD"]);
  assert.ok(one.bytes <= 15_000);

  const tier2 = await run(3_000);
  assert.deepEqual(tier2.calls, ["A2", "B1", "C1", "D1", "B2"]);
  assert.deepEqual(tier2.prefixes, ["A2", "B2", "C1", "D1"]);
  assert.ok(tier2.bytes <= 3_000);
  // B went through two tiers but counts once.
  assert.deepEqual(tier2.stats, { imagesCompressed: 4, imagesRemoved: 0 });

  const exhausted = await run(0);
  assert.deepEqual(exhausted.calls, ["A2", "B1", "C1", "D1", "B2", "C2", "D2"]);
  assert.deepEqual(exhausted.prefixes, ["A2", "B2", "C2", "D2"]);
  assert.deepEqual(exhausted.stats, { imagesCompressed: 4, imagesRemoved: 0 });

  // Escalation failures keep the current image: a tier-1 result, or the kept-full original.
  const failing = await run(0, (id, tier) => tier === 2 || id === "D");
  assert.deepEqual(failing.prefixes, [IMAGE_PLACEHOLDER, "B1", "C1", "DD"]);
  assert.deepEqual(failing.stats, { imagesCompressed: 2, imagesRemoved: 1 });
  assert.deepEqual(input, original);
});

test("kept-full images over the per-image cap are compressed at tier 1 regardless of budget", async () => {
  const calls: string[] = [];
  const input = [user([image("A".repeat(10000))]), user([image("B".repeat(2000)), image("C".repeat(1000))])];
  // All three are kept full; only those strictly over the cap are compressed.
  const { messages, stats } = await compressImages(input, { keepFull: 3, maxImageBytes: 1000 }, tieredResizer(calls));
  assert.deepEqual(calls, ["A1", "B1"]);
  assert.deepEqual(stats, { imagesCompressed: 2, imagesRemoved: 0 });
  assert.equal((messages[1].content as { data: string }[])[0].data.slice(0, 2), "B1");
  assert.deepEqual((messages[1].content as unknown[])[1], (input[1].content as unknown[])[1]);

  // A failed capped image is still sent rather than replaced by the placeholder.
  const failed = await compressImages(input, { keepFull: 3, maxImageBytes: 1000 }, async () => null);
  assert.deepEqual(failed, { messages: input, stats: { imagesCompressed: 0, imagesRemoved: 0 } });

  // Default 1MB cap with the real resizer: the 1.34MB fixture is compressed, the 484KB one is not.
  const resizer = await loadRealResizer();
  const [small, large] = FIXTURES.map(fixture);
  const real = [tool([image(small)]), user([image(large), text("latest")])];
  const { result, notes } = await runHandler(real, {}, async () => resizer);
  const out = result!.messages as { content: { type: string; data?: string }[] }[];
  assert.deepEqual(out[0], real[0]);
  assert.deepEqual(imageSize(out[1].content[0].data!), { width: 1568, height: 980 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^Factory trim: compressed 1, removed 0, truncated 0;/);
});

test("PI_FACTORY_TRIM_COMPRESS=0 and resizer load failures use the old trim exactly", async () => {
  const messages = [user([image("a"), image("b")]), tool([image("c"), text("x".repeat(40000))]), user([image("d"), image("e")])];
  const original = structuredClone(messages);
  const expected = trimMessages(messages, readConfig({}));
  const oldNote = `Factory trim: removed 2 images, truncated 1 tool texts; ${expected.stats.bytesBefore} → ${expected.stats.bytesAfter} bytes`;
  let loads = 0;
  const disabled = await runHandler(messages, { PI_FACTORY_TRIM_COMPRESS: "0" }, async () => { loads++; return fakeResizer(); });
  assert.equal(loads, 0);
  assert.deepEqual(disabled.result, { messages: expected.messages });
  assert.deepEqual(disabled.notes, [oldNote]);
  const failed = await runHandler(messages, {}, async () => { throw new Error("cannot load pi"); });
  assert.deepEqual(failed.result, { messages: expected.messages });
  assert.deepEqual(failed.notes, [oldNote]);
  assert.deepEqual(messages, original);
});

test("compression configuration defaults, overrides and invalid numbers", () => {
  assert.deepEqual(readCompressConfig({}), { enabled: true, keepFull: 2, tier1Count: 3, maxImageBytes: 1_000_000 });
  assert.deepEqual(
    readCompressConfig({ PI_FACTORY_TRIM_COMPRESS: "0", PI_FACTORY_TRIM_KEEP_FULL: "5", PI_FACTORY_TRIM_TIER1_COUNT: "0", PI_FACTORY_TRIM_MAX_IMAGE_BYTES: "250000" }),
    { enabled: false, keepFull: 5, tier1Count: 0, maxImageBytes: 250_000 },
  );
  assert.deepEqual(
    readCompressConfig({ PI_FACTORY_TRIM_COMPRESS: "1", PI_FACTORY_TRIM_KEEP_FULL: "-1", PI_FACTORY_TRIM_TIER1_COUNT: "x", PI_FACTORY_TRIM_MAX_IMAGE_BYTES: "1e" }),
    { enabled: true, keepFull: 2, tier1Count: 3, maxImageBytes: 1_000_000 },
  );
});
