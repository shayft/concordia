# Concordia 验收记录

各阶段均区分「模拟测试通过」「真实 Linux／macOS／Windows 测试通过」和「尚未验证」。托管 runner 会真实运行 Node、SQLite、Git 和子进程，模型、CLI 账户和网关由测试替身提供。

| 阶段 | 核对内容 |
| --- | --- |
| [1 · 已有连接](stage-1.md) | 路径、版本、计费环境、凭据、取消、录制和原生账号测试缺口 |
| [2 · 调度核心](stage-2.md) | 依赖图、早期版本发布、点对点提问、连接与模型目录、两种 CLI 的 MCP 会话 |
| [3 · 协作任务板](stage-3.md) | 独立工作树、按 SHA 读文件、混合团队唤醒、联调、分开的测试与合并审批 |
| [4 · 通用分派](stage-4.md) | 从目标生成计划、批准前预览、会议、改派、返工、流式协议及有限 JSON 修复 |
| [5 · 安全与交付](stage-5.md) | 强制重启、进程回收、限额、脱敏导出、访问控制、安装和灾后恢复 |

## 三平台最终回归

2026-11-27，GitHub Actions 对源码提交 `c110272343b78987a61f66980ed4e1a2e04b24b3` 执行冻结锁安装、`pnpm lint`、`pnpm test`、`pnpm build`；构建包含 `pnpm typecheck`。以下为整仓计数，每台机器收集 203 项。[完整运行](https://github.com/shayft/concordia/actions/runs/45996818506)

| 托管系统 | 安装、lint、类型检查与构建 | 模拟回归 | 日志 |
| --- | --- | --- | --- |
| Ubuntu 26.04.1 LTS | 真实 Linux 测试通过 | 模拟测试通过，201 通过、2 跳过 | [Linux 作业](https://github.com/shayft/concordia/actions/runs/45996818506/job/140498166457) |
| macOS 26.7.2 ARM64 | 真实 macOS 测试通过 | 模拟测试通过，201 通过、2 跳过 | [macOS 作业](https://github.com/shayft/concordia/actions/runs/45996818506/job/140498166448) |
| Windows Server 2025 | 真实 Windows 测试通过 | 模拟测试通过，197 通过、6 跳过 | [Windows 作业](https://github.com/shayft/concordia/actions/runs/45996818506/job/140498165908) |

每个平台都跳过了缺少真实 Claude、Codex 录制的两项回放。Windows 另外跳过四项 Unix 文件符号链接用例，Windows 专属的联接、硬链接和进程回收另有回归。云端 Linux 在同一源码提交独立执行 `pnpm lint`、`pnpm test`、`pnpm build`，共 201 项通过、2 项跳过。

首轮 Windows 暴露了 Git 的空配置设备路径不兼容，以及长短路径或大小写不同导致同一目录校验失败的问题。修复使用随应用提供的无任务配置文件隔离全局 Git 设置与 hooks，并按卷号和文件号验证目录身份。最终回归保留了工作树创建、冲突、审批、合并、用户钩子隔离和清理的断言。[早期 Windows 作业](https://github.com/shayft/concordia/actions/runs/45995426830/job/140493512369) · [路径复测](https://github.com/shayft/concordia/actions/runs/45996144139/job/140495903180)

## 个人设备统一测试

以下项目目前为**尚未验证**。在准备好的目标系统上填写实际版本、结果和供应商能确认的计费来源即可。各平台沿用同一套步骤。

1. 在系统桌面正常启动 Concordia，预检 Claude Code 和 Codex CLI，核对两者的路径、版本、登录状态与环境变量名。用精简 PATH 的回归结果与真实桌面观测分别记录。
2. 在各自原生 CLI 完成登录。本机各批准一次只读固定回显，以验证命令的录制选项保存净化样本，再跑回放测试。阶段 1 文档记录了云端 Codex 遇到的沙箱限制。
3. 在系统凭据库保存网关条目。使用自己的 Base URL，在同一网关分别验证一个 Kimi 或 DeepSeek 模型及另一个模型，另验证 Gemini 原生协议。每个测试按钮对应一次验证。记录 HTTP 状态、耗时、可用用量以及实际账单情况。
4. 在专用测试仓库用 Claude CLI 生成计划，批准后让 API 岗位交付版本，并由 Codex CLI 参与执行或审查。核对下游拿到的提交、联调结果与 diff，再决定是否合并。记录受批准的调用次数和供应方用量。
5. 在每台机器上实测自己的凭据库锁定与解锁、关闭服务后重启、备份及恢复。可对一次性安装进行卸载演练，核对自行创建的仓库、工作树和分支。

[启动与模拟演练](../../README.md) · [CLI 参数与会话](../cli.md) · [系统凭据](../credentials.md) · [安装、备份和卸载](../operations.md)
