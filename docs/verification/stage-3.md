# 阶段 3 验收记录 · 协作任务板

验证环境为 Linux 本地工作区。演练使用脚本化成员、Fastify、SQLite、系统 Git 和 Node.js。通过浏览器操作入口选择“代码交付演练”后，平台在自己的数据目录建立演示仓库。用户可以在三个成员各自提交之后查看快照，再分别批准测试与合并。

| 开发计划验收标准 | 状态 | 命令与结果 |
| --- | --- | --- |
| “按负责人筛选”使用手写 spec、固定槽位和依赖 | 模拟测试通过 | A。后端发布接口约定时仍在执行，前端和测试均已领取依赖该版本的卡；前端直接向后端提问并收到答复。 |
| 成员在各自的 worktree 写代码并发布提交 | 模拟测试通过 | A。三个真实 Git worktree 产生不同 SHA，前端交付筛选控件，后端实现列表接口，测试成员编写三个验收用例。目标工作副本保持在基准提交。 |
| 按版本快照联调，运行项目声明的命令 | 模拟测试通过 | A。联调任务核对每个输入版本的 SHA，批准对应票据后在联调树中运行 `node --test filter.test.mjs`，退出码为 0。覆盖按指定成员筛选、仅看未分配、清除筛选。 |
| 对照 diff 后单独批准合并 | 模拟测试通过 | A。测试通过后产生绑定目标 SHA 和联调 SHA 的 diff。使用命令票据批准合并或重复批准会被拒绝；正确批准后目标 HEAD 等于联调 SHA。重开服务可以继续审阅相同快照。 |
| 同一团队经 CLI MCP 发布、HTTP API 审查并验收 | 模拟测试通过 | B。假 CLI 在真正的子进程中发布契约，进程仍运行时，已批准批次自动唤醒本机 HTTP 审查成员。服务记录指定输入版本与审查产物的关联，随后验收两项版本。 |
| 通用 Worker 在用户绑定的项目中交付 Git 版本，只读成员按版本取文件 | 模拟测试通过 | C。通过 HTTP API 配置演练目录以外的 Git 仓库。写入成员发布提交后，手工改动其工作树中的同名文件。只读下游取得发布时的正文，目标分支仍在原 SHA。另一个工作区使用相同计划及任务名时，不能借用旧树或指定旧版本取得文件。 |
| 使用一个真实 CLI 和一个真实 API 完成版本发布、唤醒、提问与自动移卡 | 尚未验证 | 本次演练的 `mode` 为 `simulated-agents`。Linux、macOS、Windows 均待本人用原生 CLI、真实网关和实际计费授权演示。 |

**命令 A** 在仓库根目录执行，3 个测试文件、13 项通过。Web 交互用例通过 DOM 测试驱动操作命令审批及 diff 审批。

```sh
node_modules/.bin/vitest run apps/server/test/delivery.test.ts apps/server/test/worktrees.test.ts apps/web/test/workspace-ui.test.tsx
```

**命令 B** 经服务启动链接交换本地会话，使用正式 HTTP 路由审批两类连接和收件卡。Linux 上 1 项测试通过。通过 Node 启动假 CLI 的脚本，同一夹具可在 Windows 使用原生 Node 可执行文件；本条目前只有 Linux 的实际运行证据。

```sh
node_modules/.bin/vitest run apps/server/test/mixed-team.test.ts
```

**命令 C** 在 Linux 执行，1 项通过；标题过滤未选中 3 项其他用例。使用正式服务路由和两个工作区、真实 Git 仓库与本机模拟 HTTP API。

```sh
node_modules/.bin/vitest run apps/server/test/application-http.test.ts -t '通用 Worker'
```

用户真实混合演示时，应记录平台、CLI 路径／版本／实际参数、批准的连接和模型、任务与交付版本、联调 SHA、批准的测试退出码、diff 及最终合并 SHA。CLI 无法可靠报告的计费来源记“未知”。

## 最终三平台回归

2026-11-27，提交 `c110272`。三个托管系统均从冻结锁安装，并通过 `pnpm lint`、`pnpm test` 和含严格类型检查的 `pnpm build`。本阶段涉及模拟连接的用例为「模拟测试通过」。整仓在 Linux 和 macOS 各 201 项通过、2 项跳过，Windows 197 项通过、6 项跳过。个人账号、计费和桌面验收状态沿用上表。[逐系统作业、跳过原因及统一测试步骤](README.md) · [GitHub Actions](https://github.com/shayft/concordia/actions/runs/45996818506)

## 三平台真实浏览器验收

2026-11-27，提交 `73e2670d7cc8457e3fd47fe019867216a3c06dda`。每台 runner 均实际执行 `pnpm build` 和 `pnpm test:browser`。测试使用独立临时配置和启用原生沙箱的 Chrome，通过一次性启动链接建立会话并连上事件流。在页面点击载入固定模板、预览六项新增任务、批准、运行模拟，核对五张已交付卡和主卡所引用的四个交付版本。切换到活动记录再刷新后仍能查看验收事件。三台机器均通过页面错误、HTTP 状态和提交操作检查。模拟成员未产生供应商调用。[完整运行](https://github.com/shayft/concordia/actions/runs/45998469973)

| 托管系统 | 浏览器验收 | 整仓 Vitest | 已核对的作业日志 |
| --- | --- | --- | --- |
| Ubuntu 26.04.1 LTS | 真实 Linux 测试通过 | 202 通过，2 跳过 | [Ubuntu 作业](https://github.com/shayft/concordia/actions/runs/45998469973/job/140503749463) |
| macOS 26.7.2 | 真实 macOS 测试通过 | 202 通过，2 跳过 | [macOS 作业](https://github.com/shayft/concordia/actions/runs/45998469973/job/140503749765) |
| Windows Server 2025 | 真实 Windows 测试通过 | 198 通过，6 跳过 | [Windows 作业](https://github.com/shayft/concordia/actions/runs/45998469973/job/140503749580) |
