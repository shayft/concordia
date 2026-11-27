# Concordia

Concordia 是运行在 Linux、macOS 和 Windows 本机上的个人 AI 协作工作区。可以为不同岗位绑定 CLI 或 API 连接，在浏览器中预览计划、按交付物版本并行派工、处理返工和审查代码差异。第一次体验可以只用模拟成员，不需要模型账号。

## 安装与启动

准备 Git、Node.js 24 LTS（24.16 或更新的 24.x）和 pnpm 11.25.0。已有 Node 时可通过 `npm install --global pnpm@11.25.0` 安装 pnpm。三个系统均可从仓库根目录执行以下命令，首次安装会访问 npm 注册表。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm serve
```

在启动服务的交互式终端复制本次完整链接，在同机浏览器打开。Fastify 监听 `127.0.0.1` 的随机端口；浏览器用链接片段中的一次性令牌建立会话。页面提示重新启动时，可停止服务后再运行 `pnpm serve`。当前数据目录、CLI 和 Git 仓库均在运行服务的计算机上。

## 跑通模拟交付

1. 在页头选择 **新工作区**，填写本次演练名称。点 **计划与审批**，选择 **固定示范 · 按负责人筛选**，依次点 **载入模板**、**校验并预览差异** 和 **批准并应用此版本**。审批前可以检查成员、任务、输入槽位、验收条件和调用上限。
2. 在 **协作任务板** 点 **运行固定模拟** 并确认。这个入口只接受空工作区或尚未执行的标准模拟计划。它用假 Agent 发布接口样例、唤醒下游、处理技术提问并完成版本快照验收。
3. 按负责人筛选卡片，选择“未分配”，再清除筛选。打开任务的执行记录，展开交付版本；在 **活动记录** 按事件顺序核对前端、测试何时取得输入，以及完成主卡验收时绑定的版本。
4. 打开 **代码与联调**，在 **代码交付演练** 中批准创建平台专用演示仓库。成员由程序模拟，仓库、工作树及 Git 提交会真实写入应用数据目录。先检查并批准联调测试命令，再查看测试结果、候选提交和 diff，最后决定是否批准合并。如果目标分支不满足合并条件，页面会显示交付分支。
5. 在另一新工作区载入并批准同一模板，**逐卡**点击“模拟执行”。可在待审查卡片上验收或返工，暂停后恢复，改派或取消未结束的任务。全局停止会取消未结束的工作，适合在单独的演练工作区验证。

## 接入自己的连接与团队

在 **连接与成员** 中按下列顺序配置。工作区之间共享连接目录；每份工作流各自保存任务、投递记录和交付版本。

1. 如同一订阅或网关账号有多个连接，可先新建 **额度池** 并设置并发上限。
2. **添加连接**。CLI 可选 Claude Code 或 Codex，保留自动探测或填写可执行文件绝对路径。API 可选 Chat Completions、Responses、Gemini Native 或 Anthropic Messages，填写网关实际 API 根路径。需鉴权时在本机系统凭据库存入密钥，页面只填 `keychain:` 引用。高级字段支持端点、请求头引用、超时、输出上限和采样参数。[凭据操作](docs/credentials.md) · [协议适配](docs/providers.md)
3. 在 **模型** 下绑定连接，填写真实的供应方模型 ID；用 API 的原生工具或受限 JSON 文本动作模式。然后在 **岗位** 下设置职责、系统提示词、连接和模型。CLI 岗位可沿用原生默认模型。编辑或禁用单个条目只作用于所选条目；正在使用的绑定可能需要先结束当前执行。
4. 从连接或岗位点 **验证**。CLI 先预检，核对实际路径、版本、登录、计费和权限，再批准真实调用。CLI 的登录由用户在原生工具中完成。API 连接选中已启用模型后可单独批准一次测试。失败时显示诊断，由用户处理当前连接。
5. 在新工作区的 **计划与审批** 使用会议、并行比较、成员审查、负责人生成或手工 spec。真实成员的 `id` 对应岗位标识，`connection` 对应该岗位绑定的连接标识。模板会带入所选岗位；修改手工草案后需重新预览并批准。负责人生成计划也会发生真实调用，页面单独请求批准。
6. 在就绪任务上选择单项授权或从看板授权批量派发。单个 API 执行按请求上限授权；CLI 按程序启动计次，内部可能有多轮模型调用，计费来源不明时按“未知”处理。需要写代码时先在 **代码与联调** 注册独立测试仓库、目标分支和项目命令，在明确开启写入后为对应任务创建 worktree，再在任务执行授权里选择它。项目命令使用可执行文件绝对路径和参数数组。联调时勾选提交版本，查看测试与差异，再决定是否合并。

## 检查已有 CLI

先在相应原生程序中登录，再执行预检。下面的命令只查询现有 CLI，输出路径、版本、认证状态、计费环境变量的名称和来源，以及实际权限参数。

```sh
pnpm verify env
pnpm verify inspect codex
pnpm verify inspect claude
```

找不到程序时给 `inspect` 和后续 `run` 传相同的 `--executable "可执行文件绝对路径"`。Linux/macOS 需要可执行权限。Windows 选择官方原生 `.exe`；如果 PowerShell 找到的只是 npm 的 `.cmd` 启动脚本，请选对应安装目录里的原生程序。默认在新建的空目录执行；需要指定目录时使用 `--cwd "工作目录绝对路径"`。涉及计费的环境变量只有按名称逐项选择后才会传入。见 [CLI 参数及计费说明](docs/cli.md)。

每条 `run` 命令会启动一次可能消耗额度的任务。核对预检结果后，将引号内的预检 ID 占位符替换为本次输出的 `inspectionId`。Claude 的受管 hooks 可覆盖用户权限设置，须先在原生 Claude Code 的 `/status` 中核对 Setting sources。确认没有 Managed settings 后，再按下例预检和运行。

```sh
pnpm verify run codex --inspection "Codex预检ID" --approve-call --record
pnpm verify inspect claude --confirm-unmanaged
pnpm verify run claude --confirm-unmanaged --inspection "Claude预检ID" --approve-call --record
```

成功后只保留固定回显及必要的协议字段。同一 CLI 版本的回放保存在 `packages/runtimes/fixtures/recorded` 下，运行 `pnpm test` 会自动重放。预检或运行失败可查诊断；实际账单需在供应商用量页核对。

## 验证一个网关

先在自己的终端录入密钥，按隐藏提示输入。Linux 需要当前桌面会话有已解锁的 Secret Service，macOS 和 Windows 分别使用当前用户的钥匙串和凭据管理器。[凭据操作说明](docs/credentials.md)

```sh
pnpm credential:set keychain:my_openai_gateway
```

将以下地址和模型名替换为实际配置，确认花费后运行。程序向该 API 根路径下的 `chat/completions` 发一次 POST，报告 HTTP 状态、耗时、返回文本和可用的用量。阶段 1 的探针要求只回复固定短句 `CONCORDIA_OK`。详见[网关验证](docs/gateway.md)。

```sh
pnpm verify run gateway --base-url "https://gateway.example.com/v1" --model "自定义模型ID" --credential keychain:my_openai_gateway --approve-call
```

## 验证与人工验收

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Vitest 回归使用临时数据、假 CLI 与回环模拟服务。Windows 的进程测试使用系统 .NET Framework 4.x 的 C# 编译器生成临时测试程序。按阶段核对每项已经运行的命令、真实平台和待验证项；CI 的系统矩阵只计入该系统上实际执行的测试。[验收记录目录](docs/verification/) · [阶段 1 连接验收](docs/verification/stage-1.md)

人工验收请使用自己的测试仓库和独立工作区。分别验证真实桌面启动下的 CLI 路径与登录、授权后的两个 CLI 与自定义网关、平台凭据库、取消及重启恢复，最后由真实成员完成“计划 → 分派 → 阶段交付 → 联调测试 → diff 审查 → 合并”并核对账单。在本机记录系统、CLI 版本及参数、模型、状态和经净化的回显，凭据始终留在系统凭据库。未配备账号或目标系统的项目保留“尚未验证”。

## 数据、停止与升级

| 平台 | 默认应用数据目录 |
| --- | --- |
| Linux | `$XDG_DATA_HOME/concordia`，未设置时为 `~/.local/share/concordia` |
| macOS | `~/Library/Application Support/Concordia` |
| Windows | `%LOCALAPPDATA%\Concordia` |

首次启动会创建目录及 SQLite 数据库并执行迁移。可在启动前设置 `CONCORDIA_DATA_DIR` 为当前用户专用的本地绝对路径。停止前先等待执行结束或从看板取消，再在服务终端按 Ctrl+C 并等待退出。重启后在任务板和活动记录核对中断项与进程恢复结果，选择是否重试。

升级前先停服，另行保存用户项目的 Git 对象及需要保留的分支，用备份工具创建应用数据快照。备份目标须为尚不存在的目录，父目录须已存在。恢复演练使用新的目标目录。命令中的路径请换成本机绝对路径。

```sh
pnpm exec tsx apps/server/src/backup.ts create "/absolute/concordia-data" "/absolute/backups/concordia-01"
pnpm exec tsx apps/server/src/backup.ts restore "/absolute/backups/concordia-01" "/absolute/restored"
```

换到已选定的新发行版本后，重新运行锁文件安装、构建和启动命令，打开原工作区核对任务与版本。系统凭据、CLI 会话及外部 Git 仓库需要分别保管；工作树恢复还依赖原仓库与位置登记。[备份和恢复说明](docs/operations.md)

卸载前先审查未提交的工作，再通过 **代码与联调** 逐一清理平台创建的工作树，确认需要保留的分支，停止服务。核对路径后可移除 Concordia 的应用副本和专用数据目录。网关凭据按服务名 `Concordia` 在系统凭据界面逐项处理。保留原始项目及原生 CLI 的配置和认证。[完整卸载流程](docs/operations.md)

[项目方案](Multi_Agent_Platform_Proposal.md) · [开发计划](DEVELOPMENT_PLAN.md) · [工程决策](docs/decisions.md)
