# 实施决策

| 日期 | 问题 | 选择 | 理由 |
|---|---|---|---|
| 2026-11-27 | 原稿只面向 macOS，当前执行环境是云端 Linux | 按用户修订将两份文档升级为三平台目标，在云端独立仓库开发。按系统和证据记录验收 | 云端 CLI 的账号、权限和环境与用户电脑各自独立。沿用原预算时保留单平台基线 |
| 2026-11-27 | 三平台如何运行同步 SQLite 迁移 | 使用 Node 24 LTS 内置的 node:sqlite、WAL 和 BEGIN IMMEDIATE；显式指定应用数据库路径 | 同步驱动满足 §8，同一锁文件可供三个系统安装，避免单独构建数据库驱动 |
| 2026-11-27 | 如何在阶段 1 提供 UI 和验证入口 | React 只展示验证入口。本地 CLI 负责探针。浏览器通过每次启动的一次性片段兑换 HttpOnly 会话，在同一 Fastify 服务读取构建产物 | 可以独立测试连接。生产资源和 API 共用 Host、Origin 和会话检查 |
| 2026-11-27 | 如何恢复用户已有登录并检查可能的计费覆盖 | 让原生 CLI 自行读取配置；只传运行必需的环境，报告当前进程可见的计费变量名。按名称显式确认可选项。预检摘要绑定同一次授权能看到的路径、参数、登录和环境变量名 | 图形启动器的 PATH 可以与终端不同。通过绝对路径可避免运行登录 Shell；认证模式与实际账单需分开判断 |
| 2026-11-27 | Claude 受管策略是否允许无人值守执行 | 使用原生只读文本探针参数，要求用户先在原生 /status 确认没有 Managed settings。Codex 用原生命令核对收紧后的功能列表和空 MCP 列表，再启动只读 exec | Claude safe mode 仍可保留优先级更高的受管 hooks。外部工具或扩展会扩大固定回显的执行权限，见 [CLI 参数依据](cli.md) |
| 2026-11-27 | 处理只在桌面中找不到的命令 | 支持绝对路径，Windows 使用原生 .exe，省略相对 PATH 项；Unix 使用可执行文件。在精简环境中从绝对 Node 路径启动整个验证命令 | 保持参数数组贯穿调用链，并能单独定位程序发现问题 |
| 2026-11-27 | 父进程先退出后如何收回后代 | 每次 CLI 预检或运行都先建立专用管理进程。在 POSIX 进程组内发送 SIGTERM 和 SIGKILL；Windows 在启动 CLI 前加入 kill-on-close Job Object，独立控制台先发送 CTRL_BREAK。默认宽限 300 毫秒 | 组长持续拥有身份，避免向已经回收的 PID 发信。运行中登记 PID 和启动时间，IPC 断开触发清理。组长意外丢失时报告无法确认清理结果 |
| 2026-11-27 | 如何跨平台存放密钥 | 保留 keychain: 逻辑引用，通过 @napi-rs/keyring 访问 macOS Keychain、Windows Credential Manager、Linux Secret Service。终端隐藏输入，Linux 后端显式固定 | 业务层能复用引用，凭据服务缺失或锁定时可停止并给出诊断。凭据只在原生系统存储和当前请求内存中使用 |
| 2026-11-27 | 如何同时验证与脱敏 | 固定回显 CONCORDIA_OK；CLI 录制仅重建必要字段，错误按有限类别显示。网关远程仅 HTTPS，可用本机回环 HTTP 测试；拒绝跳转，限制正文大小，不补 /v1 | 防止把账号、任意输出、请求头或网关错误中的秘密带进样本与日志，同时保留 HTTP 状态、耗时和用量 |
| 2026-11-27 | 哪些能力留到下一阶段 | 阶段 1 的运行时和提供方仅实现连接探针。工作流、MCP 动作、连接编辑、流式响应和持久化执行恢复按开发计划推进 | 本次交付独立可验证，保留核心层的时钟、ID、存储注入边界 |

进程管理依据为 [Node child_process](https://nodejs.org/api/child_process.html)、[Windows Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[控制台事件](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent) 和[控制处理函数](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler)。系统凭据接口与网关协议依据分别见[凭据说明](credentials.md)及[网关说明](gateway.md)。
