# 目录库和工作树登记库的恢复验收

2026-11-28。已有默认看板的安装丢失目录库时，继续启动会遗失连接及预算上限。成员工作树的文件也无法重建原有的项目授权、提交登记与审批票据。

**决定**　启动时依据已有看板目录、项目交付绑定、工作树及 SQLite 旁文件检查所需数据库。已有安装缺少相应数据库时停止启动。备份与恢复在发布目标前也检查工作树登记库，即使旧备份的文件摘要完全匹配，只要缺少台账便停止。操作人员应保留原数据目录，核对路径，从同一完整备份恢复。初次启动仅留下锁和空进程目录可以继续。拥有完整旧目录库且尚未启用项目的安装可以初始化工作树登记库。

**模拟测试通过（Linux）**　通过本地 HTTP 创建带预算上限的模拟看板，并在临时 Git 项目内发布一次成员提交。停服后逐个移走临时库。缺失目录库时服务拒绝启动，复原后仍能读到原上限与验收版本。缺失工作树登记库时启动、创建备份和恢复清单正确的旧不完整备份均失败，目标未发布，补回原库后成员发布版本可读。另覆盖单独遗留的代码版本绑定、仅有项目授权的空工作树目录、首次启动中断及旧库迁移。

```sh
pnpm exec vitest run apps/server/test/ledger-recovery.test.ts apps/server/test/backup.test.ts apps/server/test/workspace-storage.test.ts apps/server/test/backup-service.test.ts apps/server/test/worktrees.test.ts apps/server/test/delivery.test.ts apps/server/test/connection-privacy.test.ts packages/store/test/database-identity.test.ts
```

本地结果为 8 个文件、51 项通过。模拟缺库使用正常停服后的临时目录。实际掉电、文件系统损坏及个人设备的数据恢复仍为「尚未验证」。
