# pi-factory-trim

A pi extension that reduces outgoing conversation size when the active model's
`provider/id` matches `factory|magpie`. It replaces older inline images with
`[image removed to fit request size]` and shortens large tool result text while
preserving the beginning and end. Changes are request-local: saved sessions,
assistant messages, tool call/result pairing, and user text remain intact.

## Why

When pi talks to Claude models through [magpie](https://github.com/yetone/magpie)'s Factory provider, long sessions or sessions with pasted images can fail with
`413 Factory: Request Entity Too Large`. pi resends the whole conversation each turn with base64 images inlined, so the body eventually exceeds Factory's (undisclosed) byte limit. See [yetone/magpie#2082](https://github.com/yetone/magpie/issues/2082). Factory's own Droid CLI handles this by dropping older images/PDFs from large requests (changelog v0.239.0).

This extension trims **before** sending, on pi's `context` hook, so the request stays under budget instead of failing and retrying.

## Install

```sh
git clone https://github.com/psylch/pi-factory-trim
cd pi-factory-trim && npm install
```


From this directory, run `npm install`, then:

```sh
pi install /absolute/path/to/pi-factory-trim
```

Alternatively, copy `index.ts`, `src/`, and `package.json` into
`~/.pi/agent/extensions/pi-factory-trim/` and restart pi.
For a single invocation: `pi --extension /absolute/path/to/pi-factory-trim/index.ts`.


## Configuration

Set environment variables before starting pi:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_FACTORY_TRIM_KEEP_IMAGES` | `3` | Keep the last N inline images across user and tool results. Budget pressure can remove these too. |
| `PI_FACTORY_TRIM_MAX_TOOL_CHARS` | `30000` | Initial per-block tool text limit. Keep 40% head and 40% tail plus a truncation marker. |
| `PI_FACTORY_TRIM_BUDGET_BYTES` | `3500000` | Target UTF-8 bytes of `JSON.stringify(messages)`. |
| `PI_FACTORY_TRIM_MATCH` | `factory\|magpie` | Case-sensitive JavaScript regex against `provider/id`; `.*` enables every model. |
| `PI_FACTORY_TRIM_DISABLE` | unset | Set exactly `1` to disable. |

Numeric values must be nonnegative safe integers; invalid or empty values use
defaults. An invalid regex causes the context hook to return without changes.
Configuration is read on each context event. Interactive clients receive a short
notification when anything changes; headless use works without UI.

After initial trimming, the budget loop removes remaining images oldest first,
then reduces the largest remaining tool text blocks using a 2000-character limit
(800 characters at either end plus the marker); ties choose the older block.
Stats count distinct shortened text blocks. If protected content still exceeds
the budget, trimming stops when no eligible content remains.

## Limitations

The 3.5MB budget is a guess: Factory's actual limit is undisclosed. Base64 image
size usually dominates. This handles pi's inline image blocks; it cannot identify
PDFs or attachments embedded in arbitrary text or other message types. Magpie may
translate or re-serialize requests, so actual wire size differs from this estimate;
system prompts, tool definitions, and transport overhead are not included.  Removing images and shortening tool
output can lose useful context; it cannot guarantee that every request fits.

## Test result

Manual test on macOS, pi v1.1.0, model `factory/claude-opus-5-5` via magpie, with a session containing several large images:
with the extension the request succeeded (7 older images replaced by placeholders, 1 kept); without it the same request did not complete (timed out). One machine, one scenario: not a guarantee.

Note: magpie's Factory plugin `@magpie-community/opencode-factory-auth` 0.1.26 now retries once on 413 with older images replaced. This extension is complementary: it trims proactively before the first request and also shortens oversized tool output.

## Development

```sh
npm install
npm run typecheck
npm test
```

## 中文说明

此 pi 扩展在模型的 `provider/id` 匹配 `factory|magpie` 时，替换较旧的内联图片，
并保留工具输出的头尾以缩小请求。只修改本次请求，不修改已保存的会话、助手消息或用户文字。
可通过 `pi install /绝对路径/pi-factory-trim` 安装。环境变量见上表；
`PI_FACTORY_TRIM_MATCH='.*'` 对所有模型启用，`PI_FACTORY_TRIM_DISABLE=1` 禁用。
默认 350 万字节只是估计，magpie 转换后的实际请求大小可能不同。
