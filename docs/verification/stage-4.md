# 阶段 4 验收记录 · 通用分派与验收

Linux 工作区使用回环 HTTP 网关、脚本化 Agent、临时 SQLite 和 DOM 测试。真实供应商账户、模型质量、计费和三平台原生客户端的组合留待用户统一测试。

| 开发计划验收标准 | 状态 | 命令与结果 |
| --- | --- | --- |
| 从用户目标生成同一格式的 spec，经校验与批准后应用 | 模拟测试通过 | B。模拟网关通过正常 HTTP 入口返回 spec。生成前和应用前分别要求批准，生成后当前看板仍为空。A 同时覆盖循环、越权及过期修订的拒绝。 |
| Claude 根据真实用户目标生成可执行 spec | 尚未验证 | 未使用 Claude 账户调用模型。待三平台有相应授权的真实环境记录原生 CLI 版本、参数、模型、审批、计费和生成计划结果。 |
| 成员并行接单，按卡答复，支持改派及返工 | 模拟测试通过 | A。后端尚在执行时前端和 QA 领取任务；多个问题按卡与收件人合并；改派使旧执行提交失效，新成员两次提交分属不同版本，返工后进入审查并验收。 |
| 使用同一套消息与执行记录支持会议 | 模拟测试通过 | A。会议模板通过同一个 Scheduler 登记发言任务、交付版本和后续依赖，切换工作区后原计划及验收快照仍可回读。 |
| Responses 与 Gemini 原生协议的流式、成功和错误响应 | 模拟测试通过 | A。两个协议都验证完整响应、SSE、文本、工具参数和回传、用量、认证错误及取消。流式函数续调分别保留 Responses 的加密推理项和 Gemini 的工具签名。 |
| 纯文本 JSON 调度动作和有限修复 | 模拟测试通过 | A。未给文本模型声明原生工具。一次无效 JSON 后能修复并只派发一次；连续坏格式或越权动作两次调用后停止，派发次数为 0。 |
| 真实 Responses、Gemini 的协议兼容性与真实用量 | 尚未验证 | 本次没有对真实供应商发起协议测试。须用用户指定的 URL、模型和系统凭据分别批准后验证。 |

**命令 A** 在仓库根目录执行，5 个测试文件、42 项通过。

```sh
node_modules/.bin/vitest run packages/providers/test/native.test.ts packages/runtimes/test/builtin-json.test.ts packages/store/test/workflow.test.ts packages/store/test/reassignment.test.ts apps/web/test/workspace-ui.test.tsx
```

**命令 B** 执行了 1 项真实本地 HTTP 会话测试；标题过滤未选中同文件的 2 项阶段 5 用例。

```sh
node_modules/.bin/vitest run apps/server/test/application-http.test.ts -t '阶段 2/4'
```
