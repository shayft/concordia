# 阶段 5 验收记录

2026-11-27，云端 Linux，Node.js v24.19.0、pnpm 11.25.0、Git 2.52.0。回归使用临时仓库、真实 SQLite、回环 HTTP 模拟网关和假 CLI。实际操作系统进程负责执行启动、停止和崩溃场景。本轮真实模型调用数为 0。

| 开发计划验收项 | 状态 | 操作与观测结果 |
| --- | --- | --- |
| 任务运行中重启，由用户决定重试 | 模拟测试通过 | 在独立进程内启动正式 HTTP 服务，收到模拟网关请求并确认执行处于运行中后强制终止服务。用原数据目录重启，旧 Cookie 返回 401，执行变为 interrupted，任务转为 decision，没有生成版本。按 Last-Event-ID 收到缺失事件。模拟网关一共只收到一次请求。审查中的任务重开数据库后保留待验收快照。 |
| CLI 遗留进程与取消后的迟到结果 | 模拟测试通过 | 假 CLI 启动三代进程。杀死调用方后，新实例读取含组长 PID、启动时间和本次运行标识的登记，核实整组退出并清除登记。将旧记录指向另一个活进程组时，恢复返回 unresolved，原进程继续运行。HTTP 流取消后的迟到动作没有发布版本或覆盖执行状态。 |
| 超限停止、额度池与重启核算 | 模拟测试通过 | 对全局、工作区、岗位、连接及共享池执行次数、Token 和并发限制。超预算的下一次调用被拒绝。池限流只影响同池新任务，用户调整预算后可手动继续。重启释放在途并发并保留无法核实的用量预留。 |
| 日志、前端响应和导出脱敏 | 模拟测试通过 | Fastify 访问日志关闭。进度正文入内容存储，事件只记引用。历史和 SSE 逐字段筛选旧记录。审计下载使用工作区内的任务及执行序号，仅导出状态、耗时、次数与可用用量。将合成私有标记放入正文、标识、未知字段和引用后，导出没有该标记；未知 Token 显示为 null。另用临时合成凭据标记驱动本机回环对端将错误正文回显，浏览器、目录/预算接口、SQLite 和离线快照均不含该标记。连接配置拒绝明文凭据。离线备份保留私人项目数据，须按私人资料保管。 |
| 本地服务访问控制 | 模拟测试通过 | 真实回环端口只接受绑定端口对应的 127.0.0.1 或 localhost。错误 Host、跨站或缺失 Origin 的写请求、缺凭据的接口请求被拒绝；一次性启动链接兑换 HttpOnly、SameSite=Strict 会话。MCP 调用中的错绑、期限和撤销另有独立回归。 |
| 只读、成员写入范围、命令与合并审批 | 模拟测试通过 | 临时 Git 仓库未授权写入时拒绝建树。成员树按工作区、计划和任务隔离，已发布 SHA 可供下游只读。拒绝父目录、元数据路径、目录链接及硬链接。联调只选择已发布快照；冲突记录投递对象。只有登记的命令可请求批准，批准票一次有效，目标有未提交修改时只交付分支。Linux 文件访问用逐目录描述符打开，Windows 的同一回归包含 junction 和硬链接用例。 |
| 安装、启动和卸载边界 | 真实 Linux 测试通过 | 将 Git 源码快照安装在独立临时目录，使用冻结锁安装 208 个依赖包，严格类型检查和 Vite 构建成功。通过伪终端启动本地服务，用启动会话请求 health 和审计导出。通过工作区管理 API 创建并清理一棵成员树，停服后仅移除本次临时安装及专用数据目录。复核原仓库 main 的 SHA、原文件、用户另建的 worktree 及保留的 concordia 分支。 |
| 离线备份和恢复 | 模拟测试通过 | 使用临时目录执行真实 SQLite 备份。备份含已提交 WAL 事务、事件、内容对象、未提交的工作区文件及演练数据库；恢复验证清单和内容散列。占用中、重叠路径、已有目标及篡改备份都被拒绝。原仓库 Git 对象另行保留。系统凭据库及 CLI 账号未参加此测试。 |
| 三个真实 Agent 端到端交付 | 尚未验证 | 混合连接需要本人环境中可用的 Claude Code、Codex CLI 和已配置的 API 连接、系统凭据与相应调用批准，随后还需对测试仓库的联调差异和目标分支合并逐项批准。目前没有这次三方真实调用或供应商账单证据。 |

## 已执行命令

下列命令在 Linux 的 Bash 中运行，花括号由 Bash 展开。第一组在运行时的工作副本上共 16 个测试文件、98 项通过。第二组另有 2 个测试文件、8 项通过。均以退出码 0 完成。

```sh
./node_modules/.bin/vitest run apps/server/test/{application-http,audit,backup,connections,data-directory,delivery,local-server,worktrees}.test.ts packages/store/test/{content,reassignment,workflow}.test.ts packages/runtimes/test/{agent-runtime,mcp,process}.test.ts packages/providers/test/{credentials,gateway}.test.ts
./node_modules/.bin/vitest run apps/server/test/budget-ledger.test.ts packages/store/test/store.test.ts
```

集成期间又单独运行 `./node_modules/.bin/vitest run apps/server/test/application-http.test.ts`，4 项通过，包含正式 Worker 从绑定树发布提交、下游按版本只读交接、同名跨工作区任务拒绝复用其他成员树。另运行 `./node_modules/.bin/vitest run apps/server/test/connection-privacy.test.ts`，回环错误回显用例 1 项通过。

在云端 Linux 运行 `./node_modules/.bin/vitest run apps/server/test/backup-service.test.ts`，1 项模拟测试通过。独立服务进程创建第二个工作区、完成模拟验收并正常停服。测试用正式备份命令 `tsx apps/server/src/backup.ts create` 和 `restore` 把数据复制到新路径，移走临时源目录，再启动新的服务进程。恢复后的目录库、工作树库和两个看板的 SQLite 版本与源库相同。旧会话返回 401，新会话可以切换两个工作区，读取原验收快照、执行状态、事件和交付正文。未提交的工作树文件随备份保留，异地副本发布返回 409，外部临时仓库的目标分支和成员分支仍指向原提交。

安装与卸载演练的源码记录为 `d16eedb`。在临时源码目录运行以下三个项目命令。安装从 pnpm 本地存储复用了 208 个包；构建生成了静态首页、CSS 和 JS。首次用普通输出管道启动时，程序按设计提示需要交互式终端；在伪终端重新启动后完成整套演练。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm serve
```

启动会话后依次请求 `GET /api/health`、`GET /api/export/audit`、`POST /api/worktrees/projects`、`POST /api/worktrees/member` 和 `POST /api/worktrees/remove`。停服后使用 `git rev-parse main`、`git rev-parse <平台分支>`、`git status --porcelain` 及普通文件检查核实保留项。启动令牌和 Cookie 仅在测试进程内传递。

## 待验证环境

用户个人设备的 Finder、Windows 桌面及 Linux 图形启动器、三平台已有订阅的计费来源、系统凭据解锁和三位真实成员的协作仍为「尚未验证」。安装和卸载演练使用专用临时目录；未操作使用中的个人安装、系统凭据项或现有 CLI 认证目录。源项目与目标分支的人工合并审批仍是正式验收的一步。[安装、备份与卸载说明](../operations.md)

## 源码 c110272 的三平台回归

2026-11-27，提交 `c110272`。三个托管系统均从冻结锁安装，并通过 `pnpm lint`、`pnpm test` 和含严格类型检查的 `pnpm build`。本阶段涉及模拟连接的用例为「模拟测试通过」。整仓在 Linux 和 macOS 各 201 项通过、2 项跳过，Windows 197 项通过、6 项跳过。个人账号、计费和桌面验收状态沿用上表。[逐系统作业、跳过原因及统一测试步骤](README.md) · [GitHub Actions](https://github.com/shayft/concordia/actions/runs/45996818506)

## CLI 与 API 同时运行时强退

2026-11-27，`821cf64`，模拟测试通过。在云端 Linux 执行 `pnpm exec vitest run apps/server/test/crash-recovery-mixed.test.ts`，1 项通过。测试在同一个正式服务实例中同时运行三代假 Codex 进程和回环 HTTP 请求，在两个任务执行中强制终止服务，再用同一数据目录重启。恢复后 CLI 三个进程均已退出，两个 execution 均为 `interrupted`，对应卡均为 `decision`，此前交付的版本仍可取用。HTTP 对端只收到原来的一次请求，等待用户决定重试。

Windows Server 2025 补验了假 CLI 根进程早退。全量回归通过后连跑三次 `pnpm exec vitest run packages/runtimes/test/process.test.ts -t early`，每次选中的用例均通过。根进程保留退出码 23，后代收到 CTRL_BREAK，校验全部 PID 与管理器退出后才删除临时目录。上一次作业失败于删除测试程序时的短暂文件占用。[最终 Windows 作业](https://github.com/shayft/concordia/actions/runs/46000757825/job/140511488671)

## 2026-11-28 普通项目的合并、撤权与恢复

**模拟测试通过（云端 Linux）。** 在临时仓库和独立服务上运行下列命令，6 个文件共 40 项通过。模型连接由本机模拟服务和假 CLI 提供。

```sh
pnpm exec vitest run apps/server/test/worktrees.test.ts apps/server/test/worktree-revocation.test.ts apps/server/test/application-http.test.ts apps/server/test/delivery.test.ts apps/server/test/backup-service.test.ts packages/runtimes/test/process.test.ts
```

- 通过正式 API 生成项目提交、联调版本并运行已声明的命令。主卡未验收时申请合并返回 409。相同成员后来发布的另一 SHA 虽通过命令检查，申请合并仍返回 409；切换到其他工作区也不能消费原票据。计划修订后，即使重新验收同一 SHA，原票据也返回 409。新的合并票显示验收版本、来源树与命令记录，批准后目标分支指向该票据的提交。先申请的命令若最后执行失败，也会使已有成功记录失效。
- 在两个项目中各启动一个可写的假 Codex。第一个项目的撤权请求完成时，原 PID 已退出，再无新的工作树写入。第二个项目的进程仍运行并能继续修改自己的测试文件。
- 分别准备 Git 已更新、仍在原基线和由用户更新到第三个提交的中断审批记录。重新打开服务后，目标分支没有被改写，结果分别显示当前已在获批提交、仍在基线和需要人工核对。
- 旧进程退出后重新核对，服务清除其遗留登记。并发复核得到相同的结果，复核期间新增的登记保持原状。成员差异检查可在项目只读状态读取暂存、未暂存和已发布的版本，完成后索引和 HEAD 保持原值。

本组新增用例的托管 macOS、Windows 结果由该提交对应的作业登记。个人账号、真实模型和个人原生桌面仍需在目标机器验收。
