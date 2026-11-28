# Concordia 验收记录

最近一次整体审查覆盖审批、调度、工作树、预算、恢复以及长期运行时的历史查询。[2026-11-28 审查整改记录](audit-2026-11-28.md)

各阶段均区分「模拟测试通过」「真实 Linux／macOS／Windows 测试通过」和「尚未验证」。托管 runner 会真实运行 Node、SQLite、Git 和子进程，模型、CLI 账户和网关由测试替身提供。

| 阶段 | 核对内容 |
| --- | --- |
| [1 · 已有连接](stage-1.md) | 路径、版本、计费环境、凭据、取消、录制和原生账号测试缺口 |
| [2 · 调度核心](stage-2.md) | 依赖图、早期版本发布、点对点提问、连接与模型目录、两种 CLI 的 MCP 会话 |
| [3 · 协作任务板](stage-3.md) | 独立工作树、按 SHA 读文件、混合团队唤醒、联调、分开的测试与合并审批 |
| [4 · 通用分派](stage-4.md) | 从目标生成计划、批准前预览、会议、改派、返工、流式协议及有限 JSON 修复 |
| [5 · 安全与交付](stage-5.md) | 强制重启、进程回收、限额、脱敏导出、访问控制、安装和灾后恢复 |

## 当前交付版本

2026-11-27，提交 `702939bdef021599dd0660568763709966f2826b`。三台托管机均完成 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm test`、`pnpm build`（含严格类型检查）和 `pnpm test:browser`。每个系统收集 225 项 Vitest 用例。另在云端 Linux 工作区独立运行冻结锁安装、lint、构建和全套 Vitest，223 项通过、2 项跳过。[完整运行](https://github.com/shayft/concordia/actions/runs/46000757825)

| 托管系统 | Vitest 回归 | 安装、构建及启用沙箱的真实 Chrome |
| --- | --- | --- |
| Ubuntu 26.04.1 LTS x64 | 模拟测试通过，223 通过、2 跳过 | 真实 Linux 测试通过。[作业日志](https://github.com/shayft/concordia/actions/runs/46000757825/job/140511488269) |
| macOS 26.7.2 ARM64 | 模拟测试通过，223 通过、2 跳过 | 真实 macOS 测试通过。[作业日志](https://github.com/shayft/concordia/actions/runs/46000757825/job/140511488664) |
| Windows Server 2025 x64 | 模拟测试通过，219 通过、6 跳过 | 真实 Windows 测试通过。[作业日志](https://github.com/shayft/concordia/actions/runs/46000757825/job/140511488671) |

三台机器均实际完成一次性会话、模板预览、批准、六卡模拟交付、验收快照与刷新回读。两款 CLI 尚缺个人账号真实回放，各系统均跳过这两项。Windows 另跳过四项 Unix 文件链接场景，使用 Windows 的目录联接、硬链接及原生进程回归验证平台边界。

Windows 上一轮在临时测试程序的清理阶段出现一次 `EPERM`。本版验证根进程退出码 23、两代后代收到 CTRL_BREAK、所有 PID 和管理器退出后，才清理临时文件。对 Windows 短暂占用作有界重试，超出次数仍报错。Windows 作业在全量回归后另行连续三次执行 `pnpm exec vitest run packages/runtimes/test/process.test.ts -t early`，三次均通过。[上一轮 Windows 日志](https://github.com/shayft/concordia/actions/runs/46000066364/job/140509127943)

## 官方 CLI 与系统凭据

在 Ubuntu x64、macOS ARM64 和 Windows x64 上，Claude Code `2.1.332` 和 Codex CLI `0.172.0` 的六次无账号预检均取得 PASS，模型请求数为 0。每次检查都使用独立临时用户目录，核对官方平台发行物、版本和权限参数，并取得原生未登录状态。[三平台 CLI 作业](https://github.com/shayft/concordia/actions/runs/46000066348) · [实际命令与版本记录](stage-1.md)

同三个托管系统已经使用正式应用接口写入及读回一次性随机凭据，并通过 Linux Secret Service、macOS Keychain、Windows Credential Manager 核对删除结果。个人登录、系统解锁、真实任务回显、网关与账单列在下方的统一验收菜单。[三平台凭据作业](https://github.com/shayft/concordia/actions/runs/45999064361) · [逐系统说明](stage-2.md#三种原生凭据库)

## 较早版本的三平台回归

2026-11-27，GitHub Actions 对源码提交 `c110272343b78987a61f66980ed4e1a2e04b24b3` 执行冻结锁安装、`pnpm lint`、`pnpm test`、`pnpm build`；构建包含 `pnpm typecheck`。以下为整仓计数，每台机器收集 203 项。[完整运行](https://github.com/shayft/concordia/actions/runs/45996818506)

| 托管系统 | 安装、lint、类型检查与构建 | 模拟回归 | 日志 |
| --- | --- | --- | --- |
| Ubuntu 26.04.1 LTS | 真实 Linux 测试通过 | 模拟测试通过，201 通过、2 跳过 | [Linux 作业](https://github.com/shayft/concordia/actions/runs/45996818506/job/140498166457) |
| macOS 26.7.2 ARM64 | 真实 macOS 测试通过 | 模拟测试通过，201 通过、2 跳过 | [macOS 作业](https://github.com/shayft/concordia/actions/runs/45996818506/job/140498166448) |
| Windows Server 2025 | 真实 Windows 测试通过 | 模拟测试通过，197 通过、6 跳过 | [Windows 作业](https://github.com/shayft/concordia/actions/runs/45996818506/job/140498165908) |

每个平台都跳过了缺少真实 Claude、Codex 录制的两项回放。Windows 另外跳过四项 Unix 文件符号链接用例，Windows 专属的联接、硬链接和进程回收另有回归。云端 Linux 在同一源码提交独立执行 `pnpm lint`、`pnpm test`、`pnpm build`，共 201 项通过、2 项跳过。

首轮 Windows 暴露了 Git 的空配置设备路径不兼容，以及长短路径或大小写不同导致同一目录校验失败的问题。修复使用随应用提供的无任务配置文件隔离全局 Git 设置与 hooks，并按卷号和文件号验证目录身份。最终回归保留了工作树创建、冲突、审批、合并、用户钩子隔离和清理的断言。[早期 Windows 作业](https://github.com/shayft/concordia/actions/runs/45995426830/job/140493512369) · [路径复测](https://github.com/shayft/concordia/actions/runs/45996144139/job/140495903180)

## 个人设备统一验收

Linux、macOS、Windows 各填一份记录。以下是待执行菜单，初始状态为 **尚未验证**。在项目根目录执行命令，准备 Git、Node.js 24.16 或更新的 24.x、pnpm 11.25.0。托管浏览器使用临时浏览器配置，托管凭据库使用 runner 的测试账户。这两类结果与个人桌面会话分别登记。使用独立测试仓库和工作区，可将 `CONCORDIA_DATA_DIR` 设为个人账户专用的测试目录绝对路径。

### 无模型费用的操作

| 操作 | 如何核对 |
| --- | --- |
| 安装和回归 | 依次运行 `pnpm install --frozen-lockfile`、`pnpm lint`、`pnpm test`、`pnpm build`。记录通过数、跳过数及原因。需要测试实际浏览器时再运行 `pnpm test:browser`，它用本机 Chrome/Chromium 的原生沙箱，打开内置模拟工作流。 |
| 从个人桌面打开 Web UI | 从 macOS Finder、Windows 开始菜单或 Linux 应用菜单打开终端，进入仓库运行 `pnpm serve`，在同机浏览器打开本次完整链接。新建工作区，在 **协作任务板 → 运行固定模拟 → 运行模拟** 完成固定需求，在 **活动记录** 核对 `plan.accepted`，刷新后仍应可见。此项记录「桌面终端启动／浏览器操作」。 |
| 原生 CLI 预检及启动环境 | 在各自的原生程序中登录。在终端运行 `pnpm verify env`、`pnpm verify inspect codex` 和 `pnpm verify inspect claude`，记录脱敏路径、版本、实际参数、登录方式及计费相关变量名与来源。再从个人实际使用的桌面快捷方式或启动器启动服务，在 **连接与成员 → 验证 → 预检路径、版本和登录状态** 核对该进程看到的环境。找不到程序时指定绝对路径，Windows 选原生 `.exe`。分别记录启动器、终端及模拟精简 PATH 的结果。当前发布入口需要交互式终端。缺少独立启动器时，其启动环境保留「尚未验证」。 |
| 存入网关凭据 | 在本人交互式终端运行 `pnpm credential:set keychain:my_openai_gateway` 并按隐藏提示输入。Linux 使用已解锁的 Secret Service，macOS 使用 Keychain，Windows 使用 Credential Manager。在系统界面只按服务名 `Concordia` 和条目标识核对；个人账户的解锁或拒绝结果单独记录。 |
| 取消、停服与恢复 | `pnpm exec vitest run packages/runtimes/test/process.test.ts apps/server/test/backup-service.test.ts` 用假进程验证整树退出，并用两个服务进程实测停服和异地恢复。个人恢复演练先按 Ctrl+C 等服务退出，按操作文档执行 `create` 和 `restore`，指向新数据目录后运行 `pnpm serve`，用新链接核对原看板、版本和事件。异地副本保留未提交文件，发布工作树需要原路径和 Git 登记。[安装、备份与卸载命令](../operations.md) |
| 一次性安装的卸载演练 | 核对未提交内容并完成备份，在 **代码与联调** 清理选定的演练工作树，停服后仅移除专用测试安装及其数据副本。用 `git worktree list --porcelain`、`git branch --list` 核对原仓库、用户工作树和保留分支。[卸载步骤](../operations.md) |

### 需要本人逐项批准的真实调用

**两款 CLI 各启动一次只读固定回显。** 先在原生 Claude Code 的 `/status` 核对 Setting sources，确认没有 Managed settings 才使用下列 Claude 参数。将引号内的预检 ID 替换为本机本次输出；如使用 `--executable`，在对应的 `inspect` 和 `run` 传相同路径。每条 `run` 都可能消耗订阅额度或产生 API 费用。CLI 启动次数可查，内部请求次数和实际扣费以供应方记录为准。

```sh
pnpm verify inspect claude --confirm-unmanaged
pnpm verify run claude --confirm-unmanaged --inspection "Claude预检ID" --approve-call --record
pnpm verify run codex --inspection "Codex预检ID" --approve-call --record
pnpm exec vitest run packages/runtimes/test/recorded.test.ts
```

两款 CLI 都应返回 `CONCORDIA_OK`，在 `packages/runtimes/fixtures/recorded/` 下各留下按版本命名的净化样本。最后一条仅本地回放，核对两款 CLI 都有通过项。缺样本导致的跳过记为「尚未验证」。遇到登录、受管策略或沙箱阻塞时记诊断与退出码，保留原权限。[CLI 参数与录制](../cli.md)

**API 每次健康验证发送一次请求。** 第一项用自己的 API 根路径、模型 ID 和系统凭据引用替换示例，验证 Chat Completions 固定回显，记录 HTTP 状态、耗时及返回的 token 用量。

```sh
pnpm verify run gateway --base-url "https://gateway.example.com/v1" --model "供应方模型ID" --credential keychain:my_openai_gateway --approve-call
```

完整配置验收包括同一网关的两个手填模型（其中一个为 Kimi 或 DeepSeek），以及单独配置的 Gemini Native 连接。在 **连接与成员 → 模型** 逐个绑定，再从对应连接点击 **验证**，选择模型并点 **批准一次真实调用**。如果首个探针已经覆盖其中一个模型，剩余两项各批准一次即可。缺少供应方用量或账单时填「未知」。[协议与模型配置](../providers.md)

**三位真实成员交付。** 先在 **调用预算** 设置本次可接受的调用上限。在 **计划与审批** 选择 Claude 负责人，预检后点 **批准模型调用并生成草案**，校验差异并单独批准计划。在 **代码与联调** 登记专用测试仓库、目标分支和允许的命令，为需要写入的任务创建成员工作树。让 API 岗位交付版本、由 Codex CLI 执行或审查，逐卡核对 API 请求上限或单次 CLI 启动后批准。记录下游收到的版本、提问与验收快照，在联调树核对测试命令并单次批准，审查 diff 后另行决定是否合并。实际用量、费用或未知项填入记录。[团队与工作树操作](../../README.md)

### 单项验收记录模板

每个系统、每项操作各复制一行。状态使用「模拟测试通过」「真实 Linux 测试通过」「真实 macOS 测试通过」「真实 Windows 测试通过」或「尚未验证」，写明失败或跳过原因。CLI 只记脱敏后的路径、参数和样本位置；启动链接、Cookie、凭据值、原始认证输出和个人账号信息均留在本机。

| 日期、系统版本、启动方式、Git 提交 | 验收项、命令或 UI 操作 | CLI 版本及实际参数／协议与模型 | 授权和实耗次数、HTTP／耗时／用量、计费来源 | 结果、状态、脱敏证据或阻塞原因 |
| --- | --- | --- | --- | --- |
| 待填 | 待填 | 待填 | 未知 | 尚未验证 |
