# dsh-plugin-session-rename

[English](README.md) | 中文

一个极小的 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件，给 Agent 增加一个原生工具：

```
session_rename(title: string)
```

工具内部直接调用 Cordis 的 `sessionTitle` 服务 —— `sessionTitle.rename(session, title)` —— 所以会话标题是真的被改了，不是模型自说自话。

## 为什么需要

默认情况下用户能在界面上改会话名，但 Agent 不能。当标题要承载任务状态时，这就是个缺口：

- 用 `[wip]` / `[pending]` / `[done]` 前缀表示会话当前进展；
- 用交付物命名，而不是用第一句提问命名；
- 第一句提问太模糊时，把标题改准确。

装上这个插件后，Agent 可以在状态真正变化的那一刻自己把标题改对。

## 改名时发生了什么

`sessionTitle.rename(session, title)` 会向会话日志追加一条 `session/title` 事件，`source` 为 `user`。由此得到三个特性：

| 特性 | 效果 |
|---|---|
| **持久** | 重放、分叉、恢复都从日志重建标题。 |
| **锁定** | 进行中的自动标题生成被取代，后续提问不会再自动改名。 |
| **实时** | 事件落地即刷新会话列表与聊天头部，无需刷新页面。 |

## 前置条件

- 提供 `sessionTitle` 服务的 DSH 版本（标准 Web / Desktop bundle 已内置）。
- 无运行时依赖，插件本身不 import 任何包。

## 安装

### 从 npm 安装（一条命令）

```bash
dsh plugin --profile <profile> add dsh-plugin-session-rename
```

这是应用内 Plugin Hub 与社区索引所依赖的形式。本包声明了 `dsh.bundle.patch`，安装器会把它
追加进 `dsh.profile.bundles`，该行自行挂载：

```yaml
- insert:
    - id: session-rename
      name: 'dsh-plugin-session-rename'
```

注意：名为 `desktop` 的 profile 由 Electron 应用独占，CLI 无法管理；请改用应用内插件管理页，
或用下面的源码安装方式。

### 从源码安装（npm 发布前可用）

`dsh plugin` 命令本身只是转发给 `pnpm add`，所以 git 源可用：

```bash
dsh plugin --profile <profile> add git+https://github.com/ccclucky/dsh-plugin-session-rename.git
```

### profile 内本地副本

把本仓库 clone 到任意位置，再让 profile 补丁指向文件（Loader 以补丁文件所在目录为基准解析相对路径）：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: session-rename
      name: './plugins/session-rename/index.js'
```

**只能选一种**：npm、git、本地行三者同时存在会产生重复 entry id `session-rename`。

模块与补丁层都由 HMR 热加载，无需重启。

## 使用

自然语言即可——「把会话改名为 `[done] 迁移收尾`」——Agent 也可以直接调用：

```json
{ "title": "[wip] 迁移进行中" }
```

返回：

```json
{
  "title": "[wip] 迁移进行中",
  "eventSeq": 514,
  "source": "user"
}
```

错误都是显式的，不会静默成功：

- 空标题或全空白标题，在调用服务前就被拒绝；
- 没有调用方 agent、或 agent 没有 live session，直接报错；
- 服务端把标题归一化为空时，原样抛出服务自己的错误。

## 设计要点

- **用原始 JSON Schema，不用作者方言。** `ctx.tools.register()` 接收的是原始 JSON Schema。`defineTool()` 那套作者方言（属性内写 `required: true`）只适用于打包的 TypeScript 工具，混用会让 loader 行激活失败。测试里专门钉住了这一点。
- **模型改不了别人的会话。** 会话取自 `exec.agent.session`，不接受工具参数指定。
- **零 import。** registry 接受普通 `ToolDefinition` 对象，不需要从 profile 的 `node_modules` 解析任何东西。
- **缺依赖时休眠而非报错。** `inject = ['tools', 'sessionTitle']`，缺任一服务的 profile 里插件保持 inactive。
- **注销由 effect 拥有。** 注册放在 `ctx.effect(...)` 内，禁用该行即卸载工具。

## 测试

```bash
node --test
```

14 条契约测试，零依赖、无需安装 DSH：通过桩 Cordis 上下文驱动插件，覆盖注册形态、原始 schema 契约、会话解析、取消以及全部错误路径。

## 兼容性

基于 DSH 0.2.x 插件 API 编写（`ctx.tools.register`、`ctx.effect`、`sessionTitle.rename`）。

本包声明 `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`。DSH 在安装前会校验该范围，不兼容的运行时会被
直接拒绝，而不是加载一个可能崩的插件——DSH 处于开发者预览期，0.3.x 的破坏性变更应当显式失败。
由于存在 `engines.dsh`，它单独决定兼容性：本包**刻意不声明**任何 `@deepseek-ai/*` peerDependencies，
因为它不 import 任何包，不该被 peer 解析卡住。

若未来运行时能跑但不在范围内，请用官方的精确版本豁免（`dsh plugin allow-version`），而不是改范围。

## 发布状态

| 渠道 | 是否可用 |
|---|---|
| GitHub 仓库 | ✅ https://github.com/ccclucky/dsh-plugin-session-rename |
| GitHub 话题 `dsh-plugin` | ✅ 已添加 —— 社区站 dsh-plugin.org 依此话题发现仓库 |
| `dsh plugin add git+https://…` | ✅ 已端到端实测 |
| npm registry | ⏳ 已备好，**首次发布待执行** |
| `dsh plugin add dsh-plugin-session-rename` | ❌ 首次 npm 发布完成前不可用 |

npm 发布已备成可复现流程：`.github/workflows/publish.yml` 在推送 `v*` 标签时跑测试、校验 tarball、
带 provenance 发布，使用仓库密钥 `NPM_TOKEN`。在该流程成功之前，请用上面的 git 或本地方式。

## 许可

[MIT](LICENSE) © CCLUCKY