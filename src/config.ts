import { DEFAULTS, validInteger, type TrimOptions } from "./trim.ts";

export interface TrimConfig extends TrimOptions { disabled: boolean; match: RegExp }
export function readConfig(env: NodeJS.ProcessEnv = process.env): TrimConfig {
  const number = (key: string, fallback: number) => {
    const raw = env[key];
    return validInteger(raw?.trim() ? Number(raw) : undefined, fallback);
  };
  return {
    keepImages: number("PI_FACTORY_TRIM_KEEP_IMAGES", DEFAULTS.keepImages),
    maxToolResultChars: number("PI_FACTORY_TRIM_MAX_TOOL_CHARS", DEFAULTS.maxToolResultChars),
    budgetBytes: number("PI_FACTORY_TRIM_BUDGET_BYTES", DEFAULTS.budgetBytes),
    match: new RegExp(env.PI_FACTORY_TRIM_MATCH ?? "factory|magpie"),
    disabled: env.PI_FACTORY_TRIM_DISABLE === "1",
  };
}
