# 模型协议连接

服务端用 `createModelProvider` 为一个 Base URL、协议和模型建立连接。一次 `stream` 发送一次 POST。可传 `{stream:false}` 获取完整响应；两种模式都输出文本、用量、工具动作和明确的结束事件。普通文本模型可以接收带 JSON 动作说明的提示词；动作 schema 及修复次数由调度层控制。

## Chat Completions

在 API 根路径下请求 `chat/completions`。任意模型 ID 原样传给配置的网关。工具参数的流式片段按索引拼接，收到结束原因和 SSE 的 `[DONE]` 后才交付工具动作。非流式从 `choices[0].message` 和 `usage` 解析。[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/) · [流事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)

API 根路径由用户指定，端点覆盖须为同一根路径下的相对路径。非回环地址使用 HTTPS。可选的主凭据和附加请求头凭据均从操作系统凭据库读取。响应不跟随重定向；认证、限流、预算和服务错误报告固定诊断，保留 HTTP 状态。模型文本中过去或后续分块可能共同回显的已知凭据也会脱敏。将不依赖凭据的自建端点留空即可。

请求正文至多 128 KiB，响应总量至多 2 MiB。默认最多生成 1024 个 token，可配置为 1 至 65536。默认超时 60 秒，包含等待凭据解锁和读取最后一个流事件。用户取消或达到上限时终止本次请求。调用方收到终止错误后应舍弃已展示的部分文本。真实用量来自上游；缺少的字段留空。
