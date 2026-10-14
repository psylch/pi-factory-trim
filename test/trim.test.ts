import test from "node:test";
import assert from "node:assert/strict";
import { trimMessages, IMAGE_PLACEHOLDER } from "../src/trim.ts";
import { readConfig } from "../src/config.ts";
const image = (data = "abcd") => ({ type: "image", data, mimeType: "image/png" });
const text = (value: string) => ({ type: "text", text: value });
const user = (content: unknown) => ({ role: "user", content });
const tool = (content: unknown) => ({ role: "toolResult", toolCallId: "call", toolName: "read", content, isError: false, timestamp: 0 });

test("keeps last N images across users and tool results with exact placeholders", () => {
  const input = [user([image("first"), image("second")]), tool([image("third")]), user([image("fourth")])];
  const result = trimMessages(input, { keepImages: 2 });
  assert.deepEqual(result.messages[0].content, [text(IMAGE_PLACEHOLDER), text(IMAGE_PLACEHOLDER)]);
  assert.deepEqual(result.messages.slice(1), input.slice(1));
  assert.equal(result.stats.imagesRemoved, 2);
  assert.equal(trimMessages(input, { keepImages: 0 }).stats.imagesRemoved, 4);
});

test("tool text keeps 40 percent head and tail and reports removed characters", () => {
  const value = "H".repeat(5000) + "M".repeat(30000) + "T".repeat(5000);
  const { messages, stats } = trimMessages([tool([text(value)])], { maxToolResultChars: 10000 });
  assert.deepEqual(messages[0].content, [text("H".repeat(4000) + "\n[... 32000 chars truncated to fit request size ...]\n" + "T".repeat(4000))]);
  assert.equal(stats.toolResultsTruncated, 1);
});

test("budget loop brings a roughly 6MB conversation below 3.5MB", () => {
  const input = [user([image("a".repeat(2_000_000))]), tool([image("b".repeat(2_000_000))]), user([image("c".repeat(2_000_000)), text("latest prompt")])];
  const result = trimMessages(input);
  assert.ok(result.stats.bytesBefore > 6_000_000);
  assert.ok(result.stats.bytesAfter <= 3_500_000);
  assert.equal(result.stats.imagesRemoved, 2);
  assert.deepEqual(result.messages[2], input[2]);
});

test("budget reduces largest text first, ties oldest, and counts each block once", () => {
  const input = [tool([text("a".repeat(8000))]), tool([text("b".repeat(9000))])];
  const result = trimMessages(input, { maxToolResultChars: 10000, budgetBytes: 11000 });
  assert.deepEqual(result.messages[0], input[0]);
  assert.equal(result.stats.toolResultsTruncated, 1);
  assert.ok(result.stats.bytesAfter <= 11000);
  const twice = trimMessages([tool([text("a".repeat(40000))])], { budgetBytes: 2500 });
  assert.equal(twice.stats.toolResultsTruncated, 1);
  assert.ok(twice.stats.bytesAfter <= 2500);
  const tied = trimMessages([tool([text("a".repeat(8000)), text("b".repeat(8000))])], { budgetBytes: 11000 });
  const blocks = tied.messages[0].content as {text: string}[];
  assert.ok(blocks[0].text.length < 2000);
  assert.equal(blocks[1].text.length, 8000);
});

test("input is deeply unchanged even when images and text are trimmed", () => {
  const input = [tool([image(), text("x".repeat(40000))]), user([text("untouched")])];
  const original = structuredClone(input);
  trimMessages(input, { keepImages: 0, budgetBytes: 1000 });
  assert.deepEqual(input, original);
});

test("small messages are a no-op and UTF-8 byte estimates are exact", () => {
  const input = [user("你好"), tool([text("short")])];
  const { messages, stats } = trimMessages(input);
  assert.deepEqual(messages, input);
  assert.equal(stats.imagesRemoved, 0);
  assert.equal(stats.toolResultsTruncated, 0);
  assert.equal(stats.bytesBefore, Buffer.byteLength(JSON.stringify(input)));
  assert.equal(stats.bytesAfter, stats.bytesBefore);
});

test("assistant messages and all user text survive even an impossible budget", () => {
  const input = [{ role: "assistant", content: [image(), text("x".repeat(40000)), { type: "toolCall", id: "call", arguments: { nested: true } }] }, user([text("y".repeat(40000))]), user("z".repeat(40000)), tool([text("short")])];
  const result = trimMessages(input, { keepImages: 0, budgetBytes: 0 });
  assert.deepEqual(result.messages, input);
  assert.equal(result.messages.length, input.length);
  assert.ok(result.stats.bytesAfter > 0);
});

test("configuration defaults, overrides, matching, disable and invalid numbers", () => {
  assert.deepEqual(readConfig({}), { keepImages: 3, maxToolResultChars: 30000, budgetBytes: 3500000, match: /factory|magpie/, disabled: false });
  const config = readConfig({ PI_FACTORY_TRIM_KEEP_IMAGES: "0", PI_FACTORY_TRIM_MAX_TOOL_CHARS: "4000", PI_FACTORY_TRIM_BUDGET_BYTES: "1234", PI_FACTORY_TRIM_MATCH: ".*", PI_FACTORY_TRIM_DISABLE: "1" });
  assert.equal(config.keepImages, 0);
  assert.equal(config.maxToolResultChars, 4000);
  assert.equal(config.budgetBytes, 1234);
  assert.equal(config.disabled, true);
  assert.ok(config.match.test("any/model"));
  assert.equal(readConfig({ PI_FACTORY_TRIM_KEEP_IMAGES: "-1" }).keepImages, 3);
  assert.equal(readConfig({ PI_FACTORY_TRIM_BUDGET_BYTES: "NaN" }).budgetBytes, 3500000);
  assert.throws(() => readConfig({ PI_FACTORY_TRIM_MATCH: "[" }));
});
