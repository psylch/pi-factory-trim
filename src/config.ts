import { DEFAULTS, validInteger, type TrimOptions } from "./trim.ts";
import { COMPRESS_DEFAULTS, type CompressOptions } from "./compress.ts";

export interface TrimConfig extends TrimOptions { disabled: boolean; match: RegExp }
export interface CompressConfig extends CompressOptions { enabled: boolean }

function readNumber(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const raw = env[key];
  return validInteger(raw?.trim() ? Number(raw) : undefined, fallback);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): TrimConfig {
  return {
    keepImages: readNumber(env, "PI_FACTORY_TRIM_KEEP_IMAGES", DEFAULTS.keepImages),
    maxToolResultChars: readNumber(env, "PI_FACTORY_TRIM_MAX_TOOL_CHARS", DEFAULTS.maxToolResultChars),
    budgetBytes: readNumber(env, "PI_FACTORY_TRIM_BUDGET_BYTES", DEFAULTS.budgetBytes),
    match: new RegExp(env.PI_FACTORY_TRIM_MATCH ?? "factory|magpie"),
    disabled: env.PI_FACTORY_TRIM_DISABLE === "1",
  };
}

export function readCompressConfig(env: NodeJS.ProcessEnv = process.env): CompressConfig {
  return {
    enabled: env.PI_FACTORY_TRIM_COMPRESS !== "0",
    keepFull: readNumber(env, "PI_FACTORY_TRIM_KEEP_FULL", COMPRESS_DEFAULTS.keepFull),
    tier1Count: readNumber(env, "PI_FACTORY_TRIM_TIER1_COUNT", COMPRESS_DEFAULTS.tier1Count),
    maxImageBytes: readNumber(env, "PI_FACTORY_TRIM_MAX_IMAGE_BYTES", COMPRESS_DEFAULTS.maxImageBytes),
  };
}
