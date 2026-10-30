# dsh-sync

通过 Git 在多个设备之间同步 DeepSeek Harness（DSH）的会话。

- npm：`@code_tin/dsh-sync`；安装：`plugin_manager install_bundle { "target": "@code_tin/dsh-sync@0.1.0" }`
- 设置页：**设置 → 会话 Git 同步**，填写 Git 仓库地址与分支，查看本地/镜像状态，直接拉取或推送。
- 命令：`/sync`、`/sync pull`、`/sync push`、`/sync test`。
- 数据：本机会话仍在 `~/.dsh/sessions`；插件在 `~/.dsh/dsh-sync/repo` 维护一个专用 Git 镜像仓库，不往会话目录里写 `.git`。

## 工作原理

```
本机 ~/.dsh/sessions ──复制──> ~/.dsh/dsh-sync/repo/sessions ──git push──> 远程仓库
本机 ~/.dsh/sessions <──复制── ~/.dsh/dsh-sync/repo/sessions <──git pull── 远程仓库
```

- **push**：先 flush 活跃会话，把本地 `session.*.jsonl.zstd` 复制进镜像，提交并推送。推送被拒绝（其他设备刚推过）时会自动 fetch 重试一次；同一会话冲突时本地文件优先。
- **pull**：把镜像快进到远程分支，只复制本地**不存在**的会话文件。本地已有的会话一律保留，并计入“跳过”数量。
- 只同步会话日志文件；`session.lock`、`.DS_Store` 等不会进入仓库。

## 使用

1. 在设置页填写仓库地址，例如 `https://github.com/me/dsh-sessions.git` 或 `git@github.com:me/dsh-sessions.git`，保存。
2. 在设备 A 执行 `/sync push`（或点“推送到远程”）。
3. 在设备 B 保存同一地址后执行 `/sync pull`，刷新侧边栏（或重新打开窗口）即可看到新会话。

`/sync` 显示状态；`/sync test` 测试连接。Git 认证沿用本机的 SSH agent / credential helper，插件不会保存凭据。若 HTTPS 需要账号密码，请先配置好 credential helper，否则命令会快速失败而不是弹出交互提示。

## 安装（开发目录）

在 DSH 中把本目录作为本地 bundle 安装：

```
plugin_manager install_bundle { "target": "/path/to/dsh-sync" }
```

`package.json` 里 `dsh.bundle.patch` 插入 `dsh-sync` 行，`dsh.client` 声明 Web 设置页。

## 已知限制

- 同一个会话如果在两台设备上继续写入，pull 不会合并日志：保留本地版本并跳过该文件。需要时请在镜像仓库里手动取出远端版本。
- 首次 pull 之前远程必须至少有一次 push（远程分支不存在时 pull 会明确报错）。
- 镜像仓库会保留历史上推送过的会话；本机删除会话不会删除镜像中的副本。
- Git 地址保存在 `~/.dsh/dsh-sync/settings.json`（权限 0600）。不要把带 token 的 URL 提交到任何地方。

## 分发给其他设备

插件是纯 JavaScript，没有构建步骤；`npm pack` 生成的内容就是完整插件。

### 本地安装包（离线分发）

```bash
npm pack
# 生成 code_tin-dsh-sync-0.1.0.tgz
```

把 tgz 拷到目标机器，在 DSH 里安装：

```
plugin_manager install_bundle { "target": "/绝对路径/code_tin-dsh-sync-0.1.0.tgz" }
```

Plugin Manager 支持目录、tarball、git 地址和 npm 包名这几类安装 spec。

### 发布到 npm

包名：**`@code_tin/dsh-sync`**（public）。发布：

```bash
npm login
npm publish --access public
```

发布后其他机器直接安装：

```
plugin_manager install_bundle { "target": "@code_tin/dsh-sync@0.1.0" }
```

注意：发布到 npm 只解决“可安装”，不会自动让插件出现在 DSH 插件市场的 Discover 列表；市场收录通常还需要公开仓库和索引源。

## 测试

```
node --test test/*.test.mjs
```

测试使用本地 bare 仓库，不需要网络。
