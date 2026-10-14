# Spec: pi-factory-trim (pi extension)

Goal: keep pi's outgoing request body under an (undisclosed) Factory byte limit when pi is routed to Factory via magpie, emulating Droid CLI's client-side behaviour ("Older images and PDFs are dropped so a turn with large attachments still goes through", Factory CLI v0.239.0, 2026-10-12).

## Hook (verified in pi-mono main, @earendil-works/pi-coding-agent 1.2.0)
- `pi.on("context", (event, ctx) => ...)` in `src/core/extensions/types.ts` (ContextEvent { type:"context"; messages: AgentMessage[] }, result `{ messages?: AgentMessage[] }`).
- runner.ts `emitContext` does `structuredClone(messages)` first, so edits are request-local and do NOT change the saved session.
- `ctx.model` is `Model<any> | undefined` with `.provider` and `.id`.
- Message types (packages/ai/src/types.ts): ImageContent {type:"image"; data: base64; mimeType}; TextContent {type:"text"; text}; user messages `{role:"user", content: string | (TextContent|ImageContent)[]}`; ToolResultMessage `{role:"toolResult", toolCallId, toolName, content:(TextContent|ImageContent)[], isError, timestamp}`; assistant messages contain toolCall blocks — never touch assistant messages, never drop messages (keep tool call/result pairing).
- Extension format: default export `function (pi: ExtensionAPI)`; import type from "@earendil-works/pi-coding-agent". Package.json may have `"pi": {"extensions": ["./index.ts"]}`.

## Files to create in /workspace/pi-factory-trim
- `src/trim.ts`: pure function `trimMessages(messages, opts) => { messages, stats }`, no pi runtime import (types only allowed, or local minimal types).
  Options (all with defaults):
  - keepImages (default 3): keep only the last N images inline across all user + toolResult messages; replace older image blocks with `{type:"text", text:"[image removed to fit request size]"}`.
  - maxToolResultChars (default 30000): any text block in a toolResult longer than this → keep head 40% and tail 40% of the limit with marker `\n[... N chars truncated to fit request size ...]\n`.
  - budgetBytes (default 3_500_000; a GUESS, Factory limit is undisclosed): estimate `Buffer.byteLength(JSON.stringify(messages))`; while over budget, remove the oldest remaining inline image (placeholder), then if no images left, truncate the oldest largest toolResult text further (down to 2000 chars head/tail), until under budget or nothing left. Never touch the last user message's text.
  - Must not mutate input (deep clone or careful copy). Return stats: imagesRemoved, toolResultsTruncated, bytesBefore, bytesAfter.
- `src/config.ts`: read options from env vars PI_FACTORY_TRIM_KEEP_IMAGES, PI_FACTORY_TRIM_MAX_TOOL_CHARS, PI_FACTORY_TRIM_BUDGET_BYTES, PI_FACTORY_TRIM_MATCH (regex tested against `${provider}/${id}`, default `factory|magpie`; `.*` means all models), PI_FACTORY_TRIM_DISABLE=1.
- `index.ts`: extension. On "context": if model doesn't match → return; else run trimMessages; if anything changed return {messages}; if ctx.hasUI and changed, optionally ctx.ui.notify (only if that API exists in types; otherwise console.error a one-line note). Wrap in try/catch: on error return nothing.
- `test/trim.test.ts`: node:test unit tests (run with `npx tsx --test test/*.test.ts`): keeps last N images; placeholder text; tool result head/tail truncation; budget loop brings a synthetic ~6MB conversation under 3.5MB; input not mutated; no-op when already small; assistant messages untouched.
- `package.json` (type module, devDependencies: typescript, tsx, @types/node, @earendil-works/pi-coding-agent@1.2.0 as devDependency for types; scripts: test, typecheck=`tsc --noEmit`), `tsconfig.json` (strict, module NodeNext/ESNext, moduleResolution bundler ok, allowImportingTsExtensions if needed, noEmit).
- `README.md` (English + short Chinese): what it does, install (`pi install /path` or copy to `~/.pi/agent/extensions/pi-factory-trim/` — check pi docs in /workspace/pi-mono/packages/coding-agent/docs/extensions.md and packages.md for the correct install method and cite it), config env vars, limitations (budget is a guess; base64 size dominates; magpie may re-serialize/translate so wire size differs; not tested against Factory).

Run `npm install`, `npm run typecheck`, `npm test` and fix until green. Do not touch anything outside /workspace/pi-factory-trim except reading /workspace/pi-mono.
