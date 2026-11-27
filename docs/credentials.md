# 本机网关凭据

在目标机器上登录自己的桌面账户，从项目根目录的交互式终端执行下面的命令。出现输入提示时再输入网关密钥，按 Enter 保存。Linux、macOS 和 Windows PowerShell 使用同一条命令。同一引用再次写入将更新已有条目。

```sh
pnpm credential:set keychain:my_openai_gateway
```

连接配置中的 `credential` 填 `keychain:my_openai_gateway`。冒号后的标识最长 128 个字符，以英文字母或数字开头，其余字符可用英文字母、数字、句点、下划线和连字符。应用只打开服务名为 `Concordia`、条目名为该标识的凭据。验证网关时才需要读取条目。不同机器或桌面账户需要分别存入。

| 系统 | 条目保存位置 | 运行条件 |
| --- | --- | --- |
| Linux | 桌面会话中的 Secret Service 集合 | 当前用户的 D-Bus 会话中有可解锁的 Secret Service，例如 GNOME Keyring |
| macOS | 当前用户的 Keychain | 运行命令的账户能访问对应钥匙串，按系统提示批准 |
| Windows | 当前用户的 Windows Credential Manager | 在目标账户的交互式登录会话中运行 |

Linux 无图形会话、系统后端缺失或用户取消解锁时，命令会报错停止。可以在系统凭据管理界面中按服务名和条目标识定位、删除自己的条目。卸载应用会保留该条目。

## 实现依据

2026-11-27 核对了 npm 发布包的类型声明和维护者文档。应用使用 `@napi-rs/keyring@2.1.2` 的 `AsyncEntry(service, username, options)`、`setPassword(value)` 和 `getPassword(signal)`。Linux 固定传入 `{ linux: { store: 'secret-service' } }`。系统已开始的解锁操作可能晚于取消返回，调用方丢弃迟到结果。终端输入由 `@inquirer/password@5.3.1` 处理，禁用回显和显示明文的快捷键。[keyring-node 文档](https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/README.md) · [各平台后端依赖](https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/Cargo.toml) · [Inquirer 隐藏输入](https://github.com/SBoudrias/Inquirer.js/blob/6570b8e4d5e33a00dad2b55fa5f5fa5d148a245b/packages/password/README.md)

## 托管系统验证

在 GitHub Actions 里选择 **Native credential stores → Run workflow**。三个作业在各自的临时用户会话中执行 `node packages/providers/test-native/vault.ts`。Linux 作业启动独立的 D-Bus 会话和 GNOME Keyring，其数据、配置和运行目录均位于本次创建的临时目录。macOS 和 Windows 作业使用托管账户的原生后端。

工具在内存中生成随机值，通过应用的凭据接口写入唯一测试条目并读回比对。删除后，工具分别向原生后端和应用确认该条目不存在。日志只记录平台、成功结果或失败阶段。缺少系统后端、解锁失败或超时都会使对应作业失败。该验证覆盖托管账户的凭据读写，个人桌面的授权弹窗和账户策略需在目标机器上另行验证。[托管运行器环境](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) · [GNOME Keyring 命令说明](https://github.com/GNOME/gnome-keyring/blob/master/docs/gnome-keyring-daemon.xml) · [绑定维护者的原生测试](https://github.com/Brooooooklyn/keyring-node/blob/52184fbebffeef8a061234f60f313c479b954f9f/.github/workflows/CI.yml)
