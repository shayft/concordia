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

## 源码 c110272 的三平台回归

2026-11-27，提交 `c110272`。三个托管系统均从冻结锁安装，并通过 `pnpm lint`、`pnpm test` 和含严格类型检查的 `pnpm build`。本阶段涉及模拟连接的用例为「模拟测试通过」。整仓在 Linux 和 macOS 各 201 项通过、2 项跳过，Windows 197 项通过、6 项跳过。个人账号、计费和桌面验收状态沿用上表。[逐系统作业、跳过原因及统一测试步骤](README.md) · [GitHub Actions](https://github.com/shayft/concordia/actions/runs/45996818506)

## 网关响应模式与计划差异

- **模拟测试通过。** `11cd5a9` 的仅 JSON 回环网关在重启后共收到三次非流式请求，分别来自连接验证、计划生成和任务执行。连接验证界面显示实际 HTTP 状态、耗时与上游可提供的用量。对应命令为 `pnpm exec vitest run apps/server/test/application-http.test.ts apps/web/test/workspace-ui.test.tsx`。[协议说明](../providers.md)
- **模拟测试通过。** `4611fb4` 在批准前显示草案移除的预算及岗位变化。切换草案来源后，即使旧的预览返回，页面也不会重新出现旧计划的批准按钮。Linux 执行 `pnpm exec vitest run apps/web/test/workspace-ui.test.tsx packages/store/test/workflow.test.ts`，36 项通过。

### 2026-11-28 调度回归

| 验收场景 | 状态 | 执行的命令和结果 |
|---|---|---|
| 新建会议、并行比较和审查；修订旧计划 | 模拟测试通过 | `pnpm exec vitest run apps/server/test/application-http.test.ts apps/web/test/workspace-ui.test.tsx` 检查相同目标两次创建得到不同实例，旧会议的预算从自身归档读取；错误实例无法批准，正确修订可以应用。 |
| 绑定成员审查、执行编号与主卡版本 | 模拟测试通过 | `pnpm exec vitest run packages/store/test/workflow.test.ts apps/server/test/application-http.test.ts` 检查过期执行和不匹配快照均被拒绝；不兼容上游使基于钉住旧版的必需审查失去验收资格。另以 `pnpm exec vitest run apps/web/test/workspace-ui.test.tsx -t 主卡验收弹窗` 验证打开弹窗后看板刷新仍提交原快照。 |
| 阻塞答复的异常和重启恢复 | 模拟测试通过 | `pnpm exec vitest run packages/store/test/workflow.test.ts` 在收件人失败、取消、被改派、重启中断后分别验证两条同卡问题只有一个待决定答复任务；取消后的待办或全局停止不会重新派发。 |
