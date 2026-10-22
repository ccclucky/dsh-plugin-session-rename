# dsh-plugin-session-rename

English | [中文](README.zh.md)

A tiny [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that gives the Agent one native tool:

```
session_rename(title: string)
```

The tool calls the Cordis `sessionTitle` service directly — `sessionTitle.rename(session, title)` — so the current conversation is renamed for real, not just in the model's imagination.

## Why

Out of the box the user can rename a conversation from the UI, but the Agent cannot. That matters when a session's title should carry its state:

- a `[wip]` / `[pending]` / `[done]` prefix that tracks what the session is doing right now;
- a title derived from the finished artifact instead of the first prompt;
- a corrected title when the first prompt was vague.

With this plugin the Agent can keep the title honest on its own, at the moment the state actually changes.

## What happens on a rename

`sessionTitle.rename(session, title)` appends a `session/title` event with `source: user` to the session log. Three consequences follow:

| Property | Effect |
|---|---|
| **Durable** | Replay, fork and resume all rebuild the title from the log. |
| **Pinned** | In-flight automatic title generation is superseded, and later prompts no longer auto-rename the conversation. |
| **Live** | The session list and the Chat header repaint as soon as the event lands — no page refresh. |

## Requirements

- A DSH build that provides the `sessionTitle` service (it ships with the standard Web/Desktop bundles).
- No runtime dependencies. The plugin imports nothing at all.

## Install

> **Not on npm yet.** This package is distributed from GitHub only. There is no
> `npm install` and no `dsh plugin add dsh-plugin-session-rename` — that form
> works only for a name the npm registry can resolve.

### Option A — install straight from GitHub (recommended)

The `dsh plugin` command is a thin forwarder to `pnpm add`, so a git spec works:

```bash
dsh plugin --profile <profile> add git+https://github.com/ccclucky/dsh-plugin-session-rename.git
```

Verified: pnpm records `github:ccclucky/dsh-plugin-session-rename`, and because
the package declares `dsh.bundle.patch`, the installer appends it to
`dsh.profile.bundles` — the row mounts itself, no patch editing:

```yaml
- insert:
    - id: session-rename
      name: 'dsh-plugin-session-rename'
```

Note that a profile named `desktop` is owned by the Electron application and
cannot be managed from the CLI; use the in-app plugin manager there, or Option B.

### Option B — local checkout in your profile

Clone this repository anywhere, then point the profile patch at the file. The
Loader anchors relative paths beside the patch file:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: session-rename
      name: './plugins/session-rename/index.js'
```

Use **one** channel only: both at once produces a duplicate entry id
`session-rename`.

HMR picks up both the module and the patch layer live; no restart is needed.

## Usage

Ask in natural language — "rename this conversation to `[done] 迁移收尾`" — or the Agent calls it directly:

```json
{ "title": "[wip] 迁移进行中" }
```

Result:

```json
{
  "title": "[wip] 迁移进行中",
  "eventSeq": 514,
  "source": "user"
}
```

Errors are explicit, never silent:

- an empty or whitespace-only title is rejected before the service is called;
- a call with no owning agent, or an agent without a live session, is rejected;
- a title the service normalizes to empty propagates the service's own error.

## Design notes

- **Raw JSON Schema, not the authoring dialect.** `ctx.tools.register()` takes raw JSON Schema. `defineTool()`'s authoring dialect (`required: true` inline in each property) is for packaged, TypeScript-authored tools; mixing them makes the loader row fail to activate. The tests pin this.
- **The model cannot target someone else's session.** The session comes from `exec.agent.session`, never from tool arguments.
- **Zero imports.** The registry accepts a plain `ToolDefinition`, so nothing has to resolve from the profile's `node_modules`.
- **Dormant rather than broken.** `inject = ['tools', 'sessionTitle']` keeps the plugin inactive in a profile lacking either service instead of throwing.
- **Disposal is owned.** Registration happens inside `ctx.effect(...)`, so disabling the row removes the tool.

## Test

```bash
node --test
```

14 contract tests, no dependencies, no DSH install needed: they drive the plugin through a stub Cordis context and assert the registration shape, the raw-schema contract, session resolution, cancellation and every error path.

## Compatibility

Written against the DSH 0.2.x plugin API (`ctx.tools.register`, `ctx.effect`, `sessionTitle.rename`). Because the plugin has no peer dependencies, it does not trigger version-compatibility refusals; if a future API change lands, the row reports `failed` in `plugin_manager list_plugins` and the tool simply disappears.

## Distribution status

| Channel | Available |
|---|---|
| GitHub repository | ✅ https://github.com/ccclucky/dsh-plugin-session-rename |
| `dsh plugin add git+https://…` | ✅ verified end to end |
| npm registry | ❌ **not published** |
| `dsh plugin add dsh-plugin-session-rename` (bare name) | ❌ fails while the name is absent from npm |

Publishing to npm would make the bare-name install work. That requires an npm
account and a deliberate `npm publish`; it has not been done, so treat the
bare-name form as unavailable until this table says otherwise.

## License

[MIT](LICENSE) © CCLUCKY