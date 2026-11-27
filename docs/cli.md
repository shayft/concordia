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
