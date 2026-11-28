# 0.1.0-rc.1 验收边界

发布候选的单元回归使用模拟服务和假 CLI。系统凭据测试使用隔离条目，原生 CLI 兼容测试在未登录环境检查版本、参数与发现逻辑。每次合并与发布应核对相应提交的实际工作流，记录通过、跳过和失败的系统。过往提交的通过数单列。[候选包和恢复](../release-artifacts.md) · [CLI 和系统组合](../compatibility.md)

| 验收项 | 可重复命令或入口 | 可核对的结果 |
| --- | --- | --- |
| 数据库、演练、工作树和备份 | `pnpm exec vitest run apps/server/test/ledger-recovery.test.ts apps/server/test/backup.test.ts` | 模拟测试通过的恢复标准包括保留原数据、拒绝发布无效目标、补回原库可见原限额与验收。[恢复记录](ledger-recovery.md) |
| 审批、撤销和可追溯性 | `pnpm exec vitest run apps/server/test/approval-route.test.ts apps/server/test/governance.test.ts apps/server/test/planning-requests.test.ts` | 模拟测试通过。两窗口改路由、成员或上限会令旧批准失效；独立取消、重复请求及记录隔离有回归。 |
| 分工提案、对照与规模 | `pnpm benchmark:delivery`、`pnpm benchmark:load` | 模拟测试通过的时间口径和完整样本见[提案与负载记录](proposals-and-load.md)。 |
| 离线清理 | `pnpm exec vitest run apps/server/test/retention.test.ts` | 在临时数据根核对保留期、预览、确认、跨工作区隔离和备份边界。[清理操作](../retention.md) |
| 个人登录、私有网关、账单、受管环境和真实三成员交付 | 按机主清单在自选设备操作 | **尚未验证**。需要实际账户、供应方账单、组织策略和用户验收；每类调用须在对应界面获批。[个人验收记录](README.md#个人设备统一验收) |

## 可用性实测记录

请让首次使用者从候选归档启动，在没有指导的情况下找到免费演练，运行一张卡并查到它的交付正文。再由熟悉 CLI 的使用者给空 API 连接补齐模型，核对某次规划将发送的岗位，撤销该规划并找到历史状态。仅用键盘完成导航、打开与关闭对话框以及返回原操作。记录系统、浏览器、源提交、是否完成、耗时、需要帮助的步骤和匿名反馈。遇到需要额度的操作，可先完成免费流程，待本人批准后继续。实际使用者的独立观察目前为 **尚未验证**。

## 本轮实跑

工作区使用 Node 24.19.0 和 pnpm 11.25.0 执行 `pnpm lint`、`pnpm build`（包含 strict 类型检查）和 `pnpm test`。Linux 全量回归为 **模拟测试通过**，56 个文件，350 项通过、5 项跳过。主机相关分支和个人登录回放按各自条件选择，付费服务由模拟端替代。

提交 `4d28747` 的同一份源码包在三种托管系统完成冻结安装、模拟交付、候选直接导入旧备份、旧数据原位升级、新备份恢复和旧程序回退。各系统均从 SQLite 版本 7/3/7 迁移至 10/4/10，并从升级前备份回到 7/3/7。三项状态分别为 **真实 Linux 测试通过**、**真实 macOS 测试通过**、**真实 Windows 测试通过**，模型部分为模拟测试。第一轮发现的 Windows tar 盘符问题与 macOS 临时路径下的旧版启动器问题均经第二轮复测。[同一制品的三平台演练](https://github.com/shayft/concordia/actions/runs/46149038763)

同一提交的三个原生凭据库作业和三项未登录 CLI 预检通过。CLI 为 Claude Code 2.1.332 和 Codex CLI 0.172.0。此记录涵盖锁定版本的发现、版本、已安装能力和离线认证状态。[原生凭据库](https://github.com/shayft/concordia/actions/runs/46149038831) · [未登录 CLI](https://github.com/shayft/concordia/actions/runs/46149038771)
