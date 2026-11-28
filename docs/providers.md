# 模型协议连接

在「连接」中为 API 连接选择「任务与规划响应模式」。流式使用 SSE，非流式读取完整 JSON。已有连接省略设置时默认流式。健康检查固定发送一次非流式请求，页面显示实际 HTTP 状态、耗时和上游提供的 Token 用量，缺失项标为「未知」。

服务端用 `createModelProvider` 为指定的 Base URL、协议和模型建立连接。每次 `stream` 发送一次 POST，调用方的 `options.stream` 优先于连接设置。两种响应模式都产生文本、用量、工具动作和结束事件。普通文本模型可以接收带 JSON 动作说明的提示词，动作 schema 和修复次数由调度层控制。

## Chat Completions

在 API 根路径下请求 `chat/completions`。任意模型 ID 原样传给配置的网关。工具参数的流式片段按索引拼接，收到结束原因和 SSE 的 `[DONE]` 后才交付工具动作。非流式从 `choices[0].message` 和 `usage` 解析。[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/) · [流事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)

在连接的「高级调用参数 → 输出上限字段」选择网关文档列出的字段。新建和旧连接默认使用 `max_completion_tokens`。只接受 `max_tokens` 的网关可选该项。每次请求只会出现选定的一个字段，独立验证命令、连接健康检查和正式任务使用相同的上限映射。更改连接后需要重新核对审批，运行中的同一次会话继续使用已批准配置。[OpenAI 输出限制](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/) · [DeepSeek Chat 请求字段](https://api-docs.deepseek.com/api/create-chat-completion/)

API 根路径由用户指定，端点覆盖须为同一根路径下的相对路径。非回环地址使用 HTTPS。可选的主凭据和附加请求头凭据均从操作系统凭据库读取。响应不跟随重定向；认证、限流、预算和服务错误报告固定诊断，保留 HTTP 状态。模型文本中过去或后续分块可能共同回显的已知凭据也会脱敏。将不依赖凭据的自建端点留空即可。

请求正文至多 128 KiB，响应总量至多 2 MiB。默认最多生成 1024 个 token，可配置为 1 至 65536。默认超时 60 秒，包含等待凭据解锁和读取最后一个流事件。用户取消或达到上限时终止本次请求。调用方收到终止错误后应舍弃已展示的部分文本。真实用量来自上游；缺少的字段留空。

## 其他原生协议

| 协议 | API 根路径下的默认端点 | 认证头 | 流的结束条件 |
| --- | --- | --- | --- |
| OpenAI Responses | `responses` | Bearer | `response.completed` 且响应状态为 `completed` |
| Gemini Native | `models/{模型}:generateContent` 或 `:streamGenerateContent?alt=sse` | `x-goog-api-key` | 候选的 `finishReason` 为 `STOP` 且传输完整结束 |
| Anthropic Messages | `messages` | `x-api-key` | 收到可接受的停止原因及 `message_stop` |

Responses 发送 `store:false`，将函数调用结果通过 `function_call_output` 发回。工具续调所需的加密推理项随当前任务的调用传递。流中已显示的文本不会在最终响应里重复显示。[OpenAI 函数调用](https://developers.openai.com/api/docs/guides/function-calling) · [无状态推理项](https://developers.openai.com/api/docs/guides/reasoning)

Gemini 的工具声明使用 `functionDeclarations`，工具结果按原名称和可用的原始 ID 放入 `functionResponse`。模型给工具调用附上 `thoughtSignature` 时，下一轮按原样传回。自由模型 ID 编码为路径中的单个模型标识。[Gemini generateContent / streamGenerateContent](https://ai.google.dev/api/generate-content) · [Gemini API 认证](https://ai.google.dev/gemini-api/docs/api-key)

Anthropic 使用已发布的 Messages API 版本 `2023-06-01`。工具请求解析为统一动作，结果按 `tool_use_id` 回复。流式的 `input_json_delta` 在一个工具块内累积并校验。当前支持文本与工具使用块，遇到未支持的块类型会停止。[Messages API](https://platform.claude.com/docs/en/api/messages/create) · [流事件](https://platform.claude.com/docs/en/build-with-claude/streaming) · [协议版本](https://platform.claude.com/docs/en/api/versioning)

两种 OpenAI 协议与 Anthropic、Gemini 均可用于 JSON 文本动作通道。运行时不给这类模型声明原生工具，动作说明随上下文传入，平台仍应按同一份 schema 验证和执行。每次健康检查只要求返回固定的公开短句。

回归命令为 `pnpm exec vitest run packages/providers/test`。覆盖四种协议各自的正常和错误响应、真实 HTTP 分块与工具结果回传、两条请求的配置隔离，以及认证失败无重试。以上测试所用端点均为本机模拟服务。
