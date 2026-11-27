# Concordia

个人自用的本地多模型协作平台。当前交付到阶段 1，可分别验证 Claude Code、Codex CLI 和指定的 OpenAI Chat Completions 网关。目标系统为 Linux、macOS 和 Windows。已运行的测试和仍缺的真机证据见[阶段 1 验收记录](docs/verification/stage-1.md)。

## 安装与本地运行

在目标系统上安装 Node.js 24 LTS（24.16 或更新的 24.x）和 pnpm 11.25.0。下载项目后，在包含此 README 的目录执行以下命令。已安装 Node 的机器可用 `npm install --global pnpm@11.25.0` 安装该版本。首次安装项目依赖需要访问 npm 注册表。

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify --help
```

CLI、网关和数据库验证均可从终端执行。要打开 React 页面，在交互式终端运行 `pnpm serve`，用同机浏览器打开当次显示的链接，按 Ctrl+C 关闭服务。Fastify 监听随机回环端口，启动链接只能兑换一次。运行测试无需任何模型账号。Windows 上运行端到端假 CLI 测试需系统 .NET Framework 4.x 的 C# 编译器来生成临时的原生测试程序。

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

## 数据与卸载

阶段 1 的连接探针按次运行。API Key 由系统凭据库保存。需要初始化应用数据库时，先建立个人可写的独立目录，然后运行 `pnpm db:migrate "本地数据库文件的绝对路径"`。可选用 Linux 的 `~/.local/share/concordia`、macOS 的 `~/Library/Application Support/Concordia` 或 Windows 的 `%LOCALAPPDATA%\Concordia`；在命令中填写展开后的路径。

卸载时退出服务，移除本项目目录。若需清除运行数据，可另外删除自己为 Concordia 建立的数据目录，并在系统凭据管理界面删除名为 Concordia 的对应条目。保留原生 CLI 及用户工程。

[项目方案](Multi_Agent_Platform_Proposal.md) · [开发计划](DEVELOPMENT_PLAN.md) · [阶段 1 决策记录](docs/decisions.md)
