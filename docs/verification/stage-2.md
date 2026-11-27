# 阶段 2 验收记录

2026-11-27 在 Linux 工作区执行。模型调用使用回环 HTTP 服务或脚本化成员，两款 CLI 均由本地测试程序模拟。SQLite 写入临时磁盘文件，进程测试启动实际子进程。测试没有使用个人凭据或消耗真实模型额度。

## 开发计划逐项验收

| 阶段 2 标准 | 状态 | 已观察结果 |
|---|---|---|
| 数据模型、状态机、事件日志用假 Agent 和手写 spec 跑通提案 §4.5 | 模拟测试通过 | 后端发布接口约定后仍在执行，前端和测试已领取任务。前端问题只送给后端，更新普通进度没有增加执行数。五次模拟执行完成必需交付物验收，可选说明仍为已就绪。重复投递只创建一个版本和一组唤醒记录。SQLite 重开后可按原事件序号读取后续事件。 |
| UI 可新增、测试和禁用连接 | 模拟测试通过 | 在 DOM 中点击新增、编辑、禁用及启用，只对选中的连接发出请求。CLI 先预检，批准后仅发送一次测试请求，切换模型时清空批准。连接 API 的 SQLite 测试覆盖新增、修改、禁用、重开和按成员使用；禁用单个连接后其他连接仍可使用。 |
| Chat Completions 覆盖成功、流式和错误响应 | 模拟测试通过 | 回环服务返回普通 JSON 和分块 SSE，文本在流结束前送达，跨数据块的工具参数可重组。对不完整的流、401、429、503 和重定向均检查错误状态及实际请求次数。 |
| 两个 Base URL 可同时使用，同一网关可手填多个模型 ID | 模拟测试通过 | 两个回环端口同时接收请求，分别收到任意模型 ID `any/0`、`any/1`，请求保留配置的 API 根路径和自定义 endpoint。连接目录的复测在网关 A、B 上各验证一个模型，再在 A 上验证另一手填模型。模拟服务实际收到 A、B、A 三个预期路径和对应的三个模型 ID。 |
| Claude Code、Codex CLI 共用事件格式，各自保留会话，并通过本机 MCP 发出动作 | 模拟测试通过 | 两种假 CLI 均经本机 TCP 完成工具调用。同一成员的同一任务恢复已记录的会话，换任务使用独立会话。针对错绑、重发、到期、撤销及动作参数分别做了断言。 |
| 密钥保存在各自系统的凭据存储中 | 模拟测试通过 | 注入凭据库验证写入、读取、拒绝非法引用、取消和拒绝访问。配置 API 拒绝明文凭据字段，持久化连接只保存引用。三种系统凭据库的托管账户存取均已实测，见下文。个人桌面账户解锁仍为**尚未验证**。 |

## 命令与证据

在仓库根目录运行以下命令。9 个测试文件、68 项用例通过，退出码为 0。其中 HTTP 用例打开受启动链接保护的本地服务，并通过实际 HTTP 会话提交连接、预览和批准计划、运行模拟网关、验收指定版本。UI 用例在模拟 DOM 中运行。

```sh
node_modules/.bin/vitest run packages/store/test/workflow.test.ts packages/providers/test/gateway.test.ts packages/providers/test/model-provider.test.ts packages/providers/test/credentials.test.ts packages/runtimes/test/mcp.test.ts packages/runtimes/test/agent-runtime.test.ts apps/server/test/connections.test.ts apps/server/test/application-http.test.ts apps/web/test/workspace-ui.test.tsx
```

在上述联测后独立复跑了以下用例，覆盖随后补充的断言。

| 命令 | 结果 |
|---|---|
| `node_modules/.bin/vitest run apps/web/test` | 6 项通过，包含新建、编辑、禁用、启用连接的实际 DOM 交互 |
| `node_modules/.bin/vitest run apps/server/test/connections.test.ts` | 8 项通过，包含同一连接下两个手填模型的实际 HTTP 请求 |
| `node_modules/.bin/vitest run packages/store/test/workflow.test.ts` | 20 项通过，包含审查绑定执行及上游更新后的验收失效 |

| 验证内容 | 实现提交 | 可复查的用例 |
|---|---|---|
| 工作流 schema、固定流程、状态与 SQLite 恢复 | `26cbda0`、`6de41ae`、`315f729`、`67e5de8` | [工作流回归](../../packages/store/test/workflow.test.ts) |
| 连接、模型和岗位管理 | `5010a90`、`ba55ee3`、`76bd59d` | [连接 API](../../apps/server/test/connections.test.ts) · [页面交互](../../apps/web/test/workspace-ui.test.tsx) |
| Chat Completions 与并行网关 | `c2a84af` | [模型协议](../../packages/providers/test/model-provider.test.ts) · [网关验证](../../packages/providers/test/gateway.test.ts) |
| 统一动作、MCP 和两款 CLI 的会话 | `a238e08`、`b7d37a2`、`4cb24be` | [MCP 验证](../../packages/runtimes/test/mcp.test.ts) · [CLI 运行时](../../packages/runtimes/test/agent-runtime.test.ts) |
| 系统凭据适配 | `4d6002e` | [凭据存取测试](../../packages/providers/test/credentials.test.ts) |

真实模型的 MCP 会话和第三方网关仍需原生 CLI 登录、对应系统凭据与实际调用授权。此前阶段 1 的云端 Codex 尝试及三平台模拟运行结果见[阶段 1 验收记录](./stage-1.md)。

## 最终三平台回归

2026-11-27，提交 `c110272`。三个托管系统均从冻结锁安装，并通过 `pnpm lint`、`pnpm test` 和含严格类型检查的 `pnpm build`。本阶段涉及模拟连接的用例为「模拟测试通过」。整仓在 Linux 和 macOS 各 201 项通过、2 项跳过，Windows 197 项通过、6 项跳过。个人账号、计费和桌面验收状态沿用上表。[逐系统作业、跳过原因及统一测试步骤](README.md) · [GitHub Actions](https://github.com/shayft/concordia/actions/runs/45996818506)

## 三种原生凭据库

2026-11-27，源码 `73e2670`。托管系统在独立账户内运行 `node packages/providers/test-native/vault.ts`，经正式应用接口写入与读回内存生成的一次性值，再通过原生接口删除。原生接口与 Concordia 均确认删除后查无此项。Linux 使用私有 D-Bus 会话的 GNOME Keyring，macOS 使用 Keychain，Windows 使用 Credential Manager。每项操作使用随机条目标识。该用例不发送模型请求。个人账户的锁屏、授权弹窗和登录后解锁仍为「尚未验证」。

| 系统 | 状态与命令结果 |
| --- | --- |
| Ubuntu 26.04 | 真实 Linux 测试通过，原生凭据脚本退出 0。[作业](https://github.com/shayft/concordia/actions/runs/45998469897/job/140503749838) |
| macOS 26 ARM64 | 真实 macOS 测试通过，原生凭据脚本退出 0。[作业](https://github.com/shayft/concordia/actions/runs/45998469897/job/140503749154) |
| Windows Server 2025 | 真实 Windows 测试通过，原生凭据脚本退出 0。[作业](https://github.com/shayft/concordia/actions/runs/45998469897/job/140503749619) |
