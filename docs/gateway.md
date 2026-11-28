# 阶段 1 网关验证

验证器使用 Node 的 HTTP 客户端向用户指定的 API 根路径追加 `/chat/completions`。例如配置的根路径以 `/bridge/v1/` 结尾，最终请求路径为 `/bridge/v1/chat/completions`。URL 可使用 HTTPS，HTTP 限本机回环。地址中的身份信息、查询和片段会导致配置校验失败。

每次批准触发一次 POST。请求包含用户指定的 `model`、要求回复 `CONCORDIA_OK` 的 `messages`、`stream:false` 和配置的输出上限。命令行通过 `--output-token-field`、`--max-output-tokens` 选择字段及数值，默认 `max_completion_tokens=1024`，按网关文档也可使用 `max_tokens`。验证器与正式任务共用字段校验和请求映射。验证器从系统凭据存储取出授权头所需的值。调用结束后，报告记录 HTTP 状态、经过的毫秒数、实际回显，以及网关提供的输入、输出和总 token 数。用量缺失时对应字段省略。供应商未提供的计量或计费金额无法从固定提示词推算。[OpenAI Chat Completions 协议](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/) · [认证头](https://developers.openai.com/api/reference/overview/#authentication)

为防止错误页回显请求头，报告只接收约定的公开短句和已知错误代码。网关返回其他非空文本时，工具保留 HTTP 状态并报告回显验证失败。诊断会区分本地凭据失败、网络失败、重定向、认证失败、限流或额度不足，以及服务端错误。原始响应体在内存中最多读取 64 KiB。响应或异常中夹带的自由文本、堆栈、请求头和重定向地址均不写入报告。

回归测试使用本机回环上的模拟 HTTP 服务、临时生成的无效凭据和自定义模型 ID。真实网关验收需要用户提供 API 根路径和模型 ID、在目标系统中存入凭据，并确认调用次数。
