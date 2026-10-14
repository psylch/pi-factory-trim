import { compressImage, TIERS, type Tier } from "../src/compress.ts";
import { FIXTURES, fixture, imageSize, loadRealResizer } from "./support/real-resizer.ts";

const resizer = await loadRealResizer();
console.log("| Fixture | Original (base64 bytes) | Tier | Result | Base64 bytes | Of original | Time |");
console.log("| --- | ---: | --- | --- | ---: | ---: | ---: |");
for (const name of FIXTURES) {
  const data = fixture(name);
  for (const tier of [1, 2] as Tier[]) {
    const started = performance.now();
    const outcome = await compressImage(data, "image/png", tier, resizer);
    const ms = Math.round(performance.now() - started);
    const { maxWidth, jpegQuality } = TIERS[tier];
    const label = `${tier} (≤${maxWidth}px, q${jpegQuality})`;
    if (outcome.kind !== "compressed") {
      console.log(`| ${name} | ${data.length} | ${label} | ${outcome.kind} | - | - | ${ms} ms |`);
      continue;
    }
    const { width, height } = imageSize(outcome.data);
    const percent = ((outcome.data.length / data.length) * 100).toFixed(1);
    console.log(`| ${name} | ${data.length} | ${label} | ${outcome.mimeType} ${width}x${height} | ${outcome.data.length} | ${percent}% | ${ms} ms |`);
  }
}
