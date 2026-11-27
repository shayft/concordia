# 阶段 1 CLI 校验

Concordia 在同一连接上发起一次固定回显，只有模型返回 `CONCORDIA_OK` 才通过。认证状态、CLI 输出和账单分别判断。Claude 的 `auth status` 输出为 JSON，Codex 的 `login status` 可能写入标准错误。平台只提取已识别的登录状态和认证方式。Claude 明确报告 API Key 时标为 API；Claude.ai 和 ChatGPT 登录的实际扣费仍需用量页核对。Codex 可以通过自己的配置选择提供商，也可能在 `exec` 时采用单次认证覆盖，所以它的实际计费一律记为「未知」。[Claude CLI 参考](https://code.claude.com/docs/en/cli-reference) · [Claude 使用条款说明](https://code.claude.com/docs/en/legal-and-compliance) · [Codex 非交互模式](https://developers.openai.com/codex/noninteractive/)

## 核实的版本和参数

本开发环境的 `/opt/codex/bin/codex --version` 返回 `codex-cli 0.172.0-alpha.2`。已查看 `codex --help`、`codex exec --help`、`codex login --help`、`codex mcp list --help`、`codex features list --help` 和实际 feature 列表。CLI 提示沙箱内不能创建 PATH 别名，上述查询仍成功。Claude 未安装，其参数依据官方参考核对。两者运行预检时均按实际可执行文件重新检查版本和参数，版本或能力不足会停止。[Claude CLI 参考](https://code.claude.com/docs/en/cli-reference) · [Codex 配置参考](https://developers.openai.com/codex/config-reference/)

CLI 子进程以参数数组启动。以下代码块用终端写法表示其中的单个参数；实际参数数组可通过 `inspect` 查看。最后一个参数是固定的英文回显提示。

```text
claude --print --output-format json --safe-mode --permission-mode default --tools "" --disallowedTools "*" --strict-mcp-config --max-turns 1 --no-session-persistence --settings '{"disableAllHooks":true,"fallbackModel":[],"switchModelsOnFlag":false}' "Reply with exactly CONCORDIA_OK. Do not use tools or access files."

codex --no-daemon --disable shell_tool --disable shell_snapshot --disable apps --disable hooks --disable plugins --disable multi_agent --disable computer_use --disable browser_use --disable code_mode --disable image_generation -c 'notify=[]' -c 'web_search="disabled"' -c 'mcp_servers={}' --ask-for-approval on-request exec --sandbox read-only --ephemeral --skip-git-repo-check --json "Reply with exactly CONCORDIA_OK. Do not use tools or access files."
```

Claude 同时关闭内置工具、MCP 工具、用户自定义扩展和模型回退。管理员策略的优先级高于会话设置，safe mode 仍可能执行受管 hooks。首次在原生 Claude Code 的 `/status` 查看 **Setting sources**。只有确认其中没有 **Managed settings** 才能给 Claude 的 `inspect` 和 `run` 同时传 `--confirm-unmanaged`。受管或未知的机器可执行预检，不能运行该探针。这个确认不会改变原生配置。[设置来源及优先级](https://code.claude.com/docs/en/settings) · [Claude 模型回退](https://code.claude.com/docs/en/model-config)

Codex 保留本机认证与模型提供商配置，在一次性参数中启用只读沙箱并保留原生审批。每次预检都用相同覆盖参数调用 `features list` 核对上述列出的功能均确实为 `false`，调用 `mcp list --json` 确认有效列表为空，遇到不认识的输出会停止。默认工作目录是新建的空临时目录，因此需允许在 Git 仓库外运行。CLI 即使报告执行成功，校验也会拒绝含工具活动或不完整终止事件的结果。Windows 指定原生 `.exe`，POSIX 指定有执行权限的程序。[Codex 非交互模式](https://developers.openai.com/codex/noninteractive/) · [Codex 配置参考](https://developers.openai.com/codex/config-reference/)

## 预检与录制

`pnpm verify env` 只列当前进程环境里已知的认证、服务商、网关或模型选择变量和常见自定义凭据名。GUI 进程无法识别登录 Shell 独有的变量。工具不启动登录 Shell，默认按白名单只传主目录、PATH、语言、临时目录和系统会话定位变量。需传某个受支持的计费变量时，用 `--pass-env 变量名` 逐个选择，预检和运行使用相同的选项。[Claude 环境变量](https://code.claude.com/docs/en/env-vars) · [Codex 非交互模式](https://developers.openai.com/codex/noninteractive/)

预检显示可执行路径、版本、工作目录、登录方式、计费来源、变量名及传递状态和实际运行参数。运行前复查，并对照所批准的 `inspectionId`。这个标识是脱敏预检结果的摘要；变量值、受管状态的后台变更和套餐余量都不在摘要里。

`--record` 仅适用于已经批准的真实调用。程序仅保留解析所需事件、成功标志与固定回显，清除会话、组织、账号、思考文本、未识别的元数据和标准错误。回放测试自动扫描 `packages/runtimes/fixtures/recorded/claude/*.json` 和 `packages/runtimes/fixtures/recorded/codex/*.jsonl`，没有录制时显示跳过。假 CLI 的输出独立存于测试代码中。[Claude 结构化输出](https://code.claude.com/docs/en/headless) · [Codex JSONL 事件](https://developers.openai.com/codex/noninteractive/)

## 协作执行与 MCP

`CliAgentRuntime` 把提示通过标准输入交给 CLI。执行中的动作通过 Streamable HTTP 送到 `POST /mcp/:executionId`。端点只在本机回环上工作，每个执行单独完成协议协商、列工具和调用工具。访问令牌只通过子进程环境传入，180 秒内到期，取消和结束时立即撤销。相同请求编号的重复调用共享原先的结果。动作名、JSON Schema 和参数校验均来自 `packages/protocol/src/actions.ts`，应用侧每次核对当前有效执行、角色、槽位和工作树授权。[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) · [MCP 工具协议](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

Claude 使用单次 `--strict-mcp-config --mcp-config` 设置本机 HTTP 地址，认证头引用临时环境变量。`--tools ""` 关闭内置工具，`--allowedTools` 仅列本次获准的 Concordia 工具。授权代码任务可以经 `read_file`、`write_file` 和 `commit_artifact` 交付，路径由平台工作树服务校验。Claude 的 restricted 模式会略过用户和项目设置，可能影响所选提供商，因此使用同一套受控文件工具实现写入。[Claude MCP](https://code.claude.com/docs/en/mcp) · [Claude CLI 权限与 restricted 模式](https://code.claude.com/docs/en/cli-reference)

Codex 使用单次 `-c mcp_servers=...` 注入唯一的本机服务器，`bearer_token_env_var` 指定环境变量名。执行前用同一覆盖运行 `mcp list --json` 核对实际服务器和地址。只读任务传 `--sandbox read-only`；明确授权的工作树才使用 `workspace-write`，额外写入根为空，同时排除临时目录并关闭沙箱网络。Shell、hooks、外部插件和网页搜索继续被禁用。若当前 CLI 无法确认这些约束，运行停止。[Codex MCP](https://developers.openai.com/codex/mcp/) · [Codex 沙箱配置](https://developers.openai.com/codex/config-reference/)

独立会话按 CLI、连接、模型、成员、任务、工作目录和权限绑定，禁止同一会话并行运行。Claude 首次指定新 `--session-id`，随后指定 `--resume <UUID>`；Codex 首次从 `thread.started` 得到 UUID，之后用 `exec resume <UUID> -`。后端登记正反向绑定，发现返回 UUID 变更或属于另一任务即停止。用量保留 CLI 公开字段，动作发生时即可交给调度器，最终文本和用量在子进程结束后交付。CLI 对版本、原生登录、组织策略和计费的真实兼容性仍按真实验收记录判断。[Claude CLI 会话](https://code.claude.com/docs/en/cli-reference) · [Codex 非交互会话](https://developers.openai.com/codex/noninteractive/)

连接可显式选 JSON 动作通道。对于帮助中缺少单次 MCP 注入参数、但可验证只读与禁用外部工具的 Claude 版本，预检后直接选择 JSON；运行时的 MCP 故障不会触发第二次模型请求。JSON 模式使用同一动作 schema 生成说明，先校验完整动作列表，再逐项检查当前执行和权限。该模式只在 CLI 结束后交付动作，不向子进程提供执行令牌。负责人生成计划时只取文本并关闭动作。平台拒绝在动作参数、请求编号或回复中携带当前执行的 MCP 凭证。

CLI 协作运行时在收到 Codex `thread.started` 或 Claude `system/init` 后即向本地会话存储登记 UUID。Claude 在支持的版本中使用 `--output-format stream-json --verbose`。若版本只能在最终 JSON 中报告 UUID，在该报告前被中断的初次执行无法恢复；即使如此也不会按“最近会话”恢复其他任务。取消会撤销动作令牌并终止进程树，重新执行必须领取新的执行编号。[Claude 流式输出](https://code.claude.com/docs/en/headless) · [Claude 会话初始化事件](https://code.claude.com/docs/en/agent-sdk/typescript#sdksystemmessage) · [Codex 非交互事件](https://developers.openai.com/codex/noninteractive/)
