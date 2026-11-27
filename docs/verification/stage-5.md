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

安装与卸载演练的源码记录为 `d16eedb`。在临时源码目录运行以下三个项目命令。安装从 pnpm 本地存储复用了 208 个包；构建生成了静态首页、CSS 和 JS。首次用普通输出管道启动时，程序按设计提示需要交互式终端；在伪终端重新启动后完成整套演练。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm serve
```

启动会话后依次请求 `GET /api/health`、`GET /api/export/audit`、`POST /api/worktrees/projects`、`POST /api/worktrees/member` 和 `POST /api/worktrees/remove`。停服后使用 `git rev-parse main`、`git rev-parse <平台分支>`、`git status --porcelain` 及普通文件检查核实保留项。启动令牌和 Cookie 仅在测试进程内传递。

## 待验证环境

用户个人设备的 Finder、Windows 桌面及 Linux 图形启动器、三平台已有订阅的计费来源、系统凭据解锁和三位真实成员的协作仍为「尚未验证」。安装和卸载演练使用专用临时目录；未操作使用中的个人安装、系统凭据项或现有 CLI 认证目录。源项目与目标分支的人工合并审批仍是正式验收的一步。[安装、备份与卸载说明](../operations.md)
