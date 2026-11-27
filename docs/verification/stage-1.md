# 阶段 1 验收记录

2026-11-27。验收范围为三平台 monorepo 和已有连接验证。GitHub 托管作业使用 Node.js v24.19.0、pnpm 11.25.0，连接测试使用假 CLI 和回环模拟网关。原生 Codex 的账号预检及回显尝试发生在 Codex 云端 Linux 工作区。

## 官方 Codex 稳定版 0.172.0 的 Linux 补验

2026-11-27，在 Linux x86_64 核对 npm 发布包 `@openai/codex@0.172.0` 的平台依赖。Linux x64 条目指向 `@openai/codex@0.172.0-linux-x64`。校验 tarball 与该包发布元数据的 SHA-512 完整性后，将其中 `vendor/x86_64-unknown-linux-musl/bin/codex` 解包到临时目录。进程使用独立的空 HOME、CODEX_HOME 和临时工作目录。表中 `<临时目录>` 代表本次创建的随机目录。[官方 npm 发布包](https://www.npmjs.com/package/@openai/codex/v/0.172.0) · [Codex 非交互模式](https://developers.openai.com/codex/noninteractive/)

| 验收项 | 状态 | 命令和结果 |
| --- | --- | --- |
| 官方版本及公开参数 | **真实 Linux 测试通过** | `codex --version` 返回 `codex-cli 0.172.0`。`codex --help`、`codex exec --help`、`codex exec resume --help`、`codex login status --help`、`codex mcp list --help`、`codex features list --help` 均退出 0。根和 exec 帮助包含探针使用的七种长选项 |
| 平台预检与原生登录状态 | **真实 Linux 测试通过** | `node --import tsx apps/server/src/verify.ts inspect codex --executable <临时目录>/codex --pass-env CODEX_HOME` 退出 0。平台用既有参数执行 `features list`，确认十项功能全部关闭，并以 `mcp list --json` 确认有效列表为空。`login status` 在临时用户环境中报告未登录。平台输出版本 0.172.0，认证方式和计费来源均未知 |
| 真实登录后的文本回显和录制 | **尚未验证** | 本轮模型调用为 0，没有个人账号、用量或输出样本。首轮云端 0.172.0-alpha.2 的两次失败回显另见下文 |

## 官方 Claude Code 2.1.332 的 Linux 补验

2026-11-27，在 Linux x86_64 从官方 npm 包的 `optionalDependencies` 确认 `@anthropic-ai/claude-code-linux-x64@2.1.332`，下载平台包并对照发布元数据验证 tarball 的 SHA-512 完整性。只把独立程序解包到临时目录，用空的临时 HOME、CLI 配置目录和工作目录执行。以下命令用 `<临时目录>` 代表本次随机创建的目录。[官方 npm 包](https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.332) · [Claude CLI 参考](https://code.claude.com/docs/en/cli-reference)

| 验收项 | 状态 | 命令和结果 |
| --- | --- | --- |
| 官方版本与参数解析 | **真实 Linux 测试通过** | `claude --version` 返回 `2.1.332 (Claude Code)`。`claude --help` 和 `claude auth status --help` 退出 0。根帮助省略 `--max-turns`。`claude --help --max-turns` 退出 1，对该选项报告缺少值。对照命令 `claude --help --concordia-probe-unknown` 退出 0 并打印普通帮助 |
| 平台正式预检入口 | **真实 Linux 测试通过** | `node --import tsx apps/server/src/verify.ts inspect claude --executable <临时目录>/claude --pass-env CLAUDE_CONFIG_DIR` 退出 0。程序检查版本、帮助、隐藏选项与原生登录状态。结果为 2.1.332、未登录、认证方式和计费来源均未知。未确认受管策略 |
| 隐藏选项与不支持版本的边界 | **模拟测试通过** | `pnpm exec vitest run packages/runtimes/test/claude-flags.test.ts packages/runtimes/test/capabilities.test.ts`，共 29 项通过。覆盖无效的退出码、附加内容、未知选项和缺少其他权限参数 |
| 真实登录回显、计费及解析回放 | **尚未验证** | 本次没有个人账号，模型调用为 0，没有生成真实输出样本。macOS、Windows 的原生 CLI，以及三平台桌面启动、真实 MCP 交互和会话恢复，仍需个人环境实测 |

## GitHub 三平台复验

2026-11-27 在公开仓库 `shayft/concordia` 的提交 `3e73f4998dc9618572bd94f304d383b50ad30e1f` 上完成复验。三个系统均从冻结锁文件安装依赖，依次运行 `pnpm lint`、`pnpm test`、`pnpm build`。构建命令包含严格类型检查。三个作业均成功退出。[GitHub Actions 运行记录](https://github.com/shayft/concordia/actions/runs/45991637358)

| 托管系统 | 安装、lint、类型检查与构建 | 假 CLI、模拟网关及本地回归 |
|---|---|---|
| Ubuntu 26.04 | **真实 Linux 测试通过** | **模拟测试通过**，62 项通过，2 项跳过。[作业日志](https://github.com/shayft/concordia/actions/runs/45991637358/job/140480633046) |
| macOS 26 ARM64 | **真实 macOS 测试通过** | **模拟测试通过**，62 项通过，2 项跳过。[作业日志](https://github.com/shayft/concordia/actions/runs/45991637358/job/140480633432) |
| Windows Server 2025 | **真实 Windows 测试通过** | **模拟测试通过**，62 项通过，2 项跳过。[作业日志](https://github.com/shayft/concordia/actions/runs/45991637358/job/140480633499) |

- **程序发现与诊断、假 CLI 文本回显、登录和计费变量过滤、批准与环境变化、网关异常和取消、凭据库模拟接口、Fastify 本地访问校验、SQLite 迁移：模拟测试通过。** 三个平台都从精简环境启动了验证命令。Windows 使用临时编译的 .exe。
- **整树取消：模拟测试通过。** 各平台实际启动三代测试进程，并核实取消信号送达及后代最终退出。Windows 初次复验发现 Node 父进程先退出时，libuv 会先清理它自己的子进程。修订后的 Windows 早退夹具使用同一控制台中的 .NET 进程，使两代后代在根进程返回 23 后仍可接收 CTRL_BREAK，再由 Job 回收；保留了所有信号和退出断言。首轮 Windows 的一个失败可在[首轮日志](https://github.com/shayft/concordia/actions/runs/45990966042/job/140478399048)中核对。
- **三种真实连接、两份真实录制回放、真实桌面启动和个人凭据存取：尚未验证。** 每个平台的两个跳过项都是缺少正式 CLI 输出文件的回放。GitHub 测试使用内置夹具，不读取个人账号，未启动任何可能计费的任务。下文记录早先云端 Codex 的两次只读尝试及其结果。

## 首轮云端 Linux 验收（GitHub 三平台复验前）

| 开发计划及本次交付项 | 已执行的验证 | 仍需取得的证据 |
|---|---|---|
| §8.2 七个包、strict、lint、测试、构建 | **真实 Linux 测试通过**。冻结锁文件安装、类型检查、ESLint 和 Vite 构建成功。SQLite 实际临时文件启用 WAL，迁移可重复执行 | macOS、Windows 安装和运行均为 **尚未验证** |
| 已登录 Claude Code 返回文本，记录版本、路径、参数、计费 | **模拟测试通过**。假 CLI 完成预检、批准和 JSON 回显；版本、参数与变量过滤有断言 | 三平台真实回显均为 **尚未验证**。云端 `pnpm verify inspect claude` 退出 1，PATH 内找不到 claude。用户电脑尚无测试证据 |
| 已登录 Codex 返回文本，记录版本、路径、参数、计费 | **真实 Linux 测试通过** 仅限路径、版本及原生登录状态查询。**模拟测试通过** 覆盖 JSONL 回显、有效功能检查及预检匹配 | 真实回显为 **尚未验证**。云端同一连接的两次实跑均失败，第二次报告「本机沙箱或权限限制」。macOS 和 Windows 未实跑；云端实际计费未知 |
| 自定义 Chat Completions 网关返回文本；状态、耗时、用量和脱敏错误 | **模拟测试通过**。17 项本机 HTTP 用例覆盖不同 API 根路径和模型、成功和错误、取消和超时、重定向、未知用量、过大响应、迟到的凭据读取 | 各平台真实网关均为 **尚未验证**。缺实际 Base URL、模型、系统凭据和该网关的调用授权 |
| 只列可能影响认证或计费的变量名称与来源，失败不切换连接 | **模拟测试通过**。假 CLI 检查白名单；两次预检不一致会停止；网关检查失败时不重试或跳转。**真实 Linux 测试通过** 仅限环境诊断，`pnpm verify env` 列出当前进程环境中的 `CODEX_HOME`，Codex 预检显示未传入 | macOS、Windows 的现有账号、计费覆盖和供应商账单为 **尚未验证** |
| 图形启动路径、绝对路径与找不到程序时的诊断 | **模拟测试通过**。从绝对 Node 路径启动验证工具，POSIX PATH 设为 `/usr/bin:/bin:/usr/sbin:/sbin`，绝对假 CLI 成功；另用已知空 PATH 目录，两款 CLI 均明确提示配置绝对路径 | 三平台从真实桌面启动器启动、访问原生账号和解锁系统存储均为 **尚未验证** |
| 取消时 CLI 及其后代退出 | **模拟测试通过**。在 Linux 启动实际的三代假进程，验证正常退出请求送达、拒绝退出的后代被强制回收、父进程早退，以及调用方意外终止后的清理 | macOS 进程组和 Windows Job Object 在各自系统的运行情况为 **尚未验证**。持久化任务重启与用户决定重试按计划阶段 5 验收 |
| 两种 CLI 各一份脱敏真实输出，基于真实输出的回放 | **模拟测试通过** 仅指合成输出的解析和净化。真实样本测试会发现按 CLI 与版本保存的录制文件 | 两份实际录制均为 **尚未验证**。本轮产生 0 份真实样本，Vitest 明确跳过 2 项 |
| 系统凭据存储、本地服务访问控制 | **模拟测试通过**。凭据库读写、缺失、失败和取消 4 项；本地服务 Host、Origin、单次启动链接、Cookie 及静态资源访问 4 项。**真实 Linux 测试通过** 仅限本机 HTTP 启动和构建产物读取 | Linux/macOS/Windows 真实凭据存取以及桌面账号环境为 **尚未验证** |

Linux 精简 PATH 用例在实际 Linux 内核上运行，所调用的 CLI 和模型输出均为测试夹具。该用例能查出程序发现、空参数、进程环境和工作目录问题。Finder、桌面启动器或资源管理器还涉及实际用户会话、原生安装路径和凭据解锁。Windows 的回归会从 System32 精简 PATH 启动并使用临时编译的原生假 .exe，首轮云端 Linux 测试没有运行该分支。

## 首轮云端 Linux 命令和结果

| 命令 | 结果 |
|---|---|
| `pnpm install --offline --frozen-lockfile` | 使用本机已有依赖缓存成功安装／校验，8 个 workspace projects（含根） |
| `pnpm lint`、`pnpm typecheck`、`pnpm build` | 均退出 0。TypeScript 6.0.3 strict，ESLint 10.15.0 无警告。Vite 8.4.0 生成 HTML、JS、CSS |
| `pnpm test` | Vitest 5.1.2，62 项通过、2 项跳过；跳过项均是尚缺真实录制的回放 |
| `pnpm exec vitest run apps/server/test/verification-command.test.ts` | 4 项通过。两个 CLI 各测试一次绝对路径正常流程和一次缺失诊断 |
| `pnpm exec vitest run packages/runtimes/test/process.test.ts` | 9 项通过。覆盖 TERM 到达和强制退出、父提前退出、调用方崩溃等；组长被外力结束时会报告清理结果未知 |
| `pnpm exec vitest run packages/providers/test/gateway.test.ts` | 17 项通过，全部在回环地址请求模拟服务 |
| `pnpm exec vitest run packages/providers/test/credentials.test.ts` | 4 项通过，注入模拟凭据库 |
| `pnpm exec vitest run apps/server/test/local-server.test.ts` | 4 项通过；另在 Linux 交互终端运行 `pnpm serve`，引导页 200、单次会话兑换 204、受保护的首页和 JS/CSS 200。非交互运行按设计退出 1 |
| `pnpm db:migrate /tmp/concordia-stage1-bootstrap.sqlite` | WAL，版本 1。存储专题两项通过 |
| `pnpm verify run gateway` | 缺少批准，退出 1，未访问网关 |
| `pnpm verify inspect codex`、`pnpm verify env`、`pnpm verify inspect claude` | Codex 和环境诊断成功。Claude 路径缺失，退出 1 |
| `pnpm verify run codex --approve-call --inspection <本次预检ID> --record` | 获得对云端 Codex 的明确授权后，启动两次单独的只读任务。首次退出 1，原始错误已丢弃，无法判定原因。补上固定类别诊断后同参数复核，退出 1，类别为「本机沙箱或权限限制」。未改动沙箱，无成功文本、样本或可核实用量 |

## 实际使用的版本与参数

首轮云端执行文件为 `/opt/codex/bin/codex`，版本 `codex-cli 0.172.0-alpha.2`。通过原生 `login status` 获取 ChatGPT 登录状态，无法从该结果确定实际支出。以当前版本 `--help`、`exec --help`、`features list` 和 `mcp list --json` 核对参数及有效工具状态。两次实跑均使用下列同一参数数组，在新建空目录启动。argv 不包含任何密钥。

```json
["--no-daemon","--disable","shell_tool","--disable","shell_snapshot","--disable","apps","--disable","hooks","--disable","plugins","--disable","multi_agent","--disable","computer_use","--disable","browser_use","--disable","code_mode","--disable","image_generation","-c","notify=[]","-c","web_search=\"disabled\"","-c","mcp_servers={}","--ask-for-approval","on-request","exec","--sandbox","read-only","--ephemeral","--skip-git-repo-check","--json","Reply with exactly CONCORDIA_OK. Do not use tools or access files."]
```

首轮云端运行时未安装 Claude。后续在隔离目录中完成官方原生二进制预检，见上表。计划参数与安全前提见 [CLI 说明](../cli.md)。两个假 CLI 报告的 1.2.3 仅为测试数据。真实 Claude 任务和真实网关请求次数均为 0。云端 Codex 的 CLI 启动次数不能用于推算上游 HTTP 次数或扣费。

## 下一次验收

在选定的目标系统上依 [README](../../README.md) 安装、预检和验证，保留每个系统对应的结果。真实网关先通过隐藏输入命令存入系统凭据，取得对所选模型的一次调用授权。对两个原生 CLI 的成功回显使用 `--record`，再用 `pnpm test` 回放。真实 GUI 验收应从桌面启动同一验证工具，在该会话中核对绝对路径和登录结果。将目标平台、CLI 版本、实际参数、未知或已核实的计费来源及命令结果补入本记录。
