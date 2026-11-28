# 源码候选包和升级演练

Concordia 分发带 MIT 许可证的源码。运行需要 Git、Node.js 24 LTS 和 pnpm 11.25.0。源码包从一个完整 Git 提交生成，前端和当前操作系统所需的原生依赖在安装时构建。应用内的 Claude Code 和 Codex 连接仍使用机器上独立安装的官方程序。

## 下载并验证

进入对应提交的 **Source release candidate** 工作流，查看 **Package one immutable source candidate** 的作业摘要。摘要给出完整提交、`SHA256SUMS` 的 SHA-256 和 **Download candidate** 链接。GitHub Actions 制品保留 30 天，下载可能需要登录 GitHub。PR 上的作业用于合并前演练。main 的三个安装作业完成后，**Attest verified main candidate** 会用 GitHub 的工作流身份为各文件生成来源证明。[候选工作流](../.github/workflows/source-candidate.yml)

解压 Actions 下载的 ZIP，将以下文件保存在同一目录，例如 `bundle`。

| 文件 | 内容 |
| --- | --- |
| `concordia-source.tar` | 该提交的源码，顶层目录为 `concordia`，包含根 `LICENSE` |
| `source.json` | Git commit、tree、项目版本、包管理器、许可证和锁文件摘要，以及包数量 |
| `sbom.cdx.json` | CycloneDX 1.6 JSON，列出冻结锁中各系统的注册表包、版本、PURL、SHA-512，列出工作区组件及依赖关系，包含开发和可选依赖 |
| `SHA256SUMS` | 上述三个文件各自的 SHA-256 |

从已经信任的项目检出中运行以下命令，将占位符替换为 GitHub **作业摘要**中的值。最后一个参数是尚不存在的目录。程序从可信清单摘要开始核验三个文件，再检查解出的许可证与依赖锁。单独收到的本地摘要文件不能证明其发布方。

```sh
node scripts/release/unpack.mjs <完整提交SHA> bundle <可信清单SHA256> installed
cd installed/concordia
pnpm install --frozen-lockfile
pnpm build
pnpm serve
```

针对已完成 main 证明的制品，可用支持 `gh attestation verify` 和 `--source-digest` 的 GitHub CLI 验证签发仓库、工作流和源提交。对 `bundle/SHA256SUMS` 执行验证，再从该清单校验其他文件。下载 ZIP 的摘要属于 GitHub 传输封装，可在作业摘要中另行核对。[GitHub CLI 命令参考](https://cli.github.com/manual/gh_attestation_verify)

```sh
gh attestation verify bundle/SHA256SUMS --repo shayft/concordia --signer-workflow shayft/concordia/.github/workflows/source-candidate.yml --source-digest <完整提交SHA>
```

## 从提交复建

在包含指定提交的 Git 检出中安装冻结依赖，然后使用与目标版本一致的构建脚本。目标目录必须是新目录。下面两个命令可在 PowerShell 或 POSIX 终端使用。完整 SHA 可用 `git rev-parse HEAD` 查看。

```sh
pnpm install --frozen-lockfile
pnpm release:candidate <完整提交SHA> bundle-a
pnpm release:candidate <完整提交SHA> bundle-b
```

用上述验证器分别核对两个目录和同一个可信清单摘要，或比较两个 `SHA256SUMS` 的内容。源码 tar 使用 Git 中的提交时间及固定权限掩码。SBOM 不加入当前时间，根据 pnpm 锁整理注册表发布包的依赖边；同一包在不同工作区的 peer 组合合并到同一发布包节点。未知格式或无法解析的依赖会阻止构建。第三方包的许可证以对应发布包为准。源码候选不内嵌模型 CLI、npm 包缓存或系统组件。

## 安装、升级、恢复和回退的验收

同一运行中的 Linux、macOS 和 Windows 作业按同一个 artifact ID 下载候选，用生产作业给出的清单摘要验证，分别在新的目录安装。测试经本地 HTTP 服务加载已构建首页、模拟交付并核对交付正文。旧应用固定在 `c110272343b78987a61f66980ed4e1a2e04b24b3`，包含版本 7 的目录库与看板库，以及版本 3 的工作树库。两代应用分别从各自的冻结锁安装。

演练先用旧应用建立验收成果，停服后用旧版命令备份。候选先直接恢复该旧备份到新目录，启动核对旧验收、交付正文及迁移版本。随后候选打开原始数据、独立验证原位迁移及既有成果，另建一个工作区完成模拟交付。候选备份恢复后两个工作区均须能读回原验收版本和正文。回退时使用**升级前备份**恢复到新目录，并启动对应旧程序核对旧版本号、工作区数量及正文。个人数据的操作步骤见[备份与恢复](operations.md)。

本地重演时，准备两个已分别完成 `pnpm install --frozen-lockfile` 和 `pnpm build` 的源码目录，再在候选目录执行以下命令。旧目录可从上述固定提交另行检出。测试创建临时的私有数据目录，使用模拟成员，结束时清除该次演练的数据。

```sh
node scripts/release/lifecycle.mjs /absolute/pinned-old-install /absolute/candidate-install
```
