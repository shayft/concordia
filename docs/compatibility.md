# 连接兼容范围

适用于本地单用户源码发行。以下状态对应 2026-11-28 的验收记录。机主在计划使用的系统上，用同一份验收清单补齐真实账户、真实模型和实际账单的证据。[个人设备统一验收](verification/README.md#个人设备统一验收)

## 官方 CLI

| 工具与版本 | Ubuntu x64、macOS ARM64、Windows x64 的已验能力 | 可用账户和策略 | 真实账户验收 |
| --- | --- | --- | --- |
| Claude Code 2.1.332 | 三系统的官方原版程序均完成无任务版本、帮助、权限及未登录检查。固定回显使用 `--print --output-format json --safe-mode --permission-mode default --tools "" --disallowedTools "*" --strict-mcp-config --max-turns 1`。 | 账户由原生 Claude Code 管理。运行前需在 `/status` 确认没有 Managed settings。受管策略或状态未知时仅可预检，管理员设置保持生效。 | 三系统均尚未验证登录后的固定回显、MCP 工具续调及原生会话恢复。 |
| Codex CLI 0.172.0 | 三系统原版均通过版本、帮助、原生登录状态、`features list` 和 `mcp list --json` 的无任务预检。固定回显使用 `--ask-for-approval on-request exec --sandbox read-only --ephemeral --skip-git-repo-check --json`。 | 原生登录、模型提供方与组织策略须允许本次只读调用和禁用不需要的工具。无法确认有效配置时停止。实际计费来源为未知。 | 三系统均尚未验证登录后的固定回显与端到端交付。Linux 云端的 0.172.0-alpha.2 仅有帮助和失败记录。 |

表中列出关键参数。完整固定回显参数、受限功能列表及工作树 MCP 差异见 CLI 文档。运行验收时保存当前安装程序返回的实际参数数组。可执行路径、程序版本或权限策略发生变化后重新预检。其他版本及系统架构须另附证据才能列入支持矩阵。[完整参数与原生帮助](cli.md) · [官方程序与三平台作业记录](verification/stage-1.md)

## API 与凭据

| 连接 | 已实现并经本地模拟验证的能力 | 账户、平台及验收门槛 |
| --- | --- | --- |
| OpenAI Chat Completions 及兼容网关 | JSON、SSE、原生工具及 JSON 动作；显式选择 `max_completion_tokens` 或 `max_tokens`。同一配置用于固定回显、任务和工具续调。 | 从本人配置的端点选两个模型，其中一个为 Kimi 或 DeepSeek，批准固定回显。对拟使用的工具通道验证完整的两轮调用和用量。真实端点结果尚未验证。 |
| OpenAI Responses | JSON、SSE、无状态工具续调及加密推理项。 | 需有权使用目标端点及模型。若将此连接列入实际交付，先验证固定回显及工具续调。真实服务尚未验证。 |
| Gemini Native | 生成、流式生成、函数调用及签名回传。 | 需能在该组织和地区使用目标模型。本人批准固定回显及所需工具调用。真实服务尚未验证。 |
| Anthropic Messages | 文本及工具使用块，JSON 或 SSE，协议版本 `2023-06-01`。 | 使用对应 API 凭据。其他内容块须单独核实。真实服务尚未验证。 |
| 系统凭据库 | Linux Secret Service、macOS Keychain 和 Windows Credential Manager 通过托管 runner 随机条目的写入、读回、删除。 | 个人桌面的解锁、组织策略、授权/拒绝界面须在目标账户核对。数据库只存 `keychain:` 引用。 |

自定义端点当前支持 HTTPS 基地址、同源相对路径、协议规定的认证方式和受限的 `x-` 请求头引用。需要固定路径查询参数、其他专有认证或自定义协议字段的服务须逐项核对。官方原生预检 CI 使用隔离的临时用户目录，凭据测试 CI 使用临时随机条目。第三方真实模型和个人账单留给机主验收。[协议字段](providers.md) · [原生凭据验证](verification/stage-2.md)

## 账户和产品分发

自行使用时，机主在原生应用登录，分别核对套餐、授权模型和供应方账单。组织内推广或将 CLI 集成到对外产品前，由负责人记录适用日期、发行方式、账户类别、认证及直接计费主体，以及审查结论。Anthropic 对原版二进制、内建认证、由每位用户自行认证并付费和第三方代路由订阅有独立条件。OpenAI 的账户授权、工作区策略与 API 计费也取决于所选账户及服务。无法确认某一组合时，将该组合保留为尚未验证。平台不会代办登录、读取 CLI 认证文件或在失败后改用其他计费方式。[Anthropic 官方条款说明](https://code.claude.com/docs/en/legal-and-compliance) · [Codex 原生认证](https://developers.openai.com/codex/auth/) · [OpenAI 使用条款](https://openai.com/policies/terms-of-use/) · [OpenAI 商业条款](https://openai.com/policies/business-terms/)
