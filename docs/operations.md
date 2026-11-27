# 安装、停服、备份与卸载

## 本地安装与启动

需要 Node.js 24 LTS（24.16 或以上的 24.x）、pnpm 11.25.0 和 Git。三个系统都从仓库根目录执行以下命令。Windows 可用 PowerShell。需要网关时，按凭据文档在本机交互式终端存入条目。各 CLI 的安装、登录和退出仍在其官方程序中处理。[凭据设置](credentials.md) · [CLI 预检](cli.md)

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm serve
```

在启动服务的交互式终端复制本次完整链接到本机浏览器。停止服务时先取消或等待正在运行的任务，再在终端按 Ctrl+C，等进程退出。服务强制退出后使用原数据目录重新启动，查看中断执行、需用户决定的任务和任何待核对的进程组，再决定是否重试。

| 系统 | 默认数据目录 |
| --- | --- |
| Linux | `$XDG_DATA_HOME/concordia`，未指定时为 `~/.local/share/concordia` |
| macOS | `~/Library/Application Support/Concordia` |
| Windows | `%LOCALAPPDATA%\Concordia` |

启动前可用 `CONCORDIA_DATA_DIR` 选择一个单独的、本地账户私有的绝对目录。应用目录包含连接和岗位配置、任务状态、消息、工作区记录及项目内容。原始项目仓库、系统凭据和 CLI 账号各自独立。新账户或新机器使用同一网关时，需要在该机的系统存储中按原引用重新录入。CLI 会话恢复还依赖原生 CLI 的当前本地登录和会话。

## 备份与恢复

1. 停止服务，结束对工作树的外部编辑。若涉及代码交付，另行备份项目原仓库的 Git 对象、`concordia/` 分支及仓库管理目录。工作树中的 `.git` 文件指向原仓库，复制该文件不能重建 Git 对象。
2. 在项目根目录执行下述 `create`。用本机绝对路径替换示例中的源和目标，Windows 使用盘符路径。目标的父目录必须存在。每次备份选一个新的目录，保存到仅当前账户可访问的位置。
3. 恢复或演练时执行 `restore`，指定尚不存在的目标。先保留原始数据目录，恢复成功后再用 `CONCORDIA_DATA_DIR` 指向副本，启动浏览器核对成员、任务、事件和交付物。运行真实模型仍需要相应授权。
4. 有 Git 工作树时，最终恢复到原数据路径并保留原始项目路径及 Git 工作树登记。先将需要保留的旧数据目录移至安全位置，再恢复到腾出的原路径。应在目标仓库用 `git worktree list --porcelain` 核对路径和分支，再开启写入或批准合并。演练副本若使用另一路径，可阅读看板；工作树身份检查会拒绝不匹配的绑定。

```sh
pnpm exec tsx apps/server/src/backup.ts create "/absolute/data" "/absolute/backups/concordia-01"
pnpm exec tsx apps/server/src/backup.ts restore "/absolute/backups/concordia-01" "/absolute/restored"
```

备份命令取得服务独占锁，对 `catalog.sqlite`、`worktrees.sqlite` 和各看板的 `workspace.sqlite` 进行完整性及外键检查，再通过 SQLite 备份 API 导出包含已提交 WAL 事务的快照。它复制 `boards`、`objects` 和 `worktrees` 中的应用数据，包括工作树中尚未提交的文件。工作树内的符号链接只复制链接本身。发布备份前核对内容寻址对象文件名与 SHA-256；恢复时校验整个目录的路径、类型、文件内容和链接目标。只有校验完成才发布目标目录。备份中包含原有的私人讨论和项目源码，应按本地账户的数据保管；SHA-256 用于发现损坏，更换备份介质时请从可信位置取得副本。[Node.js SQLite 备份接口](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsource-path-options)

锁、PID 登记和临时 CLI 工作目录属于运行现场，恢复时由应用重新建立。若源机器刚发生崩溃，应先在该机正常启动并核对遗留进程，停服后再备份。命令不操作系统凭据存储，备份中的连接凭据字段保留原来的 `keychain:` 引用。

## 卸载

1. 在看板和变更页检查未完成任务、待审查差异及未提交的工作树内容。先备份需要保留的数据，再通过工作树管理界面逐个清理已登记且可以移除的工作树。
2. 运行 `git worktree list --porcelain` 核对原仓库。清理工作树后，平台创建的分支仍属于原仓库。用户自行决定是否保留或删除每个分支。
3. 停止 Concordia。在系统文件管理器中分别选择要移除的 Concordia 应用检出目录和专用数据目录，仔细核对路径。若应用检出目录中包含自己尚未备份的源码，请先保留该目录。
4. 用户若要撤销该网关的本机访问，在系统凭据界面按服务名 `Concordia` 和条目标识定位、删除选定条目。原始项目、CLI 和其用户配置目录无需任何卸载操作。
