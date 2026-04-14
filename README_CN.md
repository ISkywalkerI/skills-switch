# Skills Switch

方便快捷的全局 Skills 一键开关！

![alt text](assets\skillswitch.png)

安装和管理技能，无需额外的思考和操作。

让你能够没有心理负担，随心所欲地安装 skills。
![alt text](assets\image.png)
[English README](./README.md)

`Skills Switch` 专注于一件事：全局统一控制 skills。
相比 cc-switch 这类按单个 Host 细粒度控制的方案，本项目做了更直接的取舍。由于 cc-switch 的控制在 Claude Code 之外的宿主中并不总是稳定有效，例如 OpenCode、Codex 等会在类似 .agents/skills 的公用路径中扫描，因此这里移除了逐 Host 控制，只保留简单一致的全局开关。
开启后，所有受支持的 Agent 都可以使用该 skill；Vice versa.

`Skills Switch` 是一个基于 Electron、React 和 TypeScript 的桌面 GUI 工具，用于统一管理多个 AI Agent 宿主环境中的技能目录。

它以中央仓库作为唯一权威来源，再通过受控的 Windows junction 将启用的技能同步到各个宿主目录，减少重复拷贝、宿主之间的状态漂移以及手工维护成本。

## 快速开始

### 方式 1：下载 release 压缩包后直接运行

1. 进入项目的 GitHub `Releases` 页面
2. 下载最新的 `Skills Switch` zip 压缩包
3. 将 zip 解压到本地目录
4. 打开解压后的文件夹
5. 运行 `Skills Switch.exe`

说明：

- 不要直接在 zip 压缩包内运行程序
- 请保持解压后的目录结构完整
- 如果出现 Windows SmartScreen，请在确认来源可信后手动允许运行

### 方式 2：从源码运行

```bash
npm install
npm run dev
```

### 本地构建发布包

```bash
npm run build
npm run dist
```

然后：

1. 打开应用
2. 点击 `Rescan`
3. 点击 `Run Migration`
4. 启用或禁用你想要全局同步的技能

## 推荐的 skills 存储和安装方法

[skills.sh](https://skills.sh/)

推荐使用此网站来搜索skills, 并通过推荐的npx skills add 命令来安装 skills。

## 支持的Agent Hosts
- OpenCode
- Claude Code
- Codex
- Trae

## 功能特性

- 扫描多个技能路径，识别已有技能、冲突和 legacy 布局
- 使用 `~/.skills-repo/skills` 作为中央权威仓库
- 全局启用或禁用技能，并同步到 managed outputs
- 将 legacy skill 目录迁移到中央仓库
- 在迁移前预览 `Managed Outputs`、`Detected In`、阻塞问题和强制清理警告
- 在确认后强制清理扫描路径中的冲突目录或坏链接，并同步回中央仓库
- 提供独立的 `Filesystem Surfaces` 二级界面，查看扫描面与输出面

## 支持的路径

### Central Repository

- `~/.skills-repo/skills`

### Managed Outputs

- `~/.agents/skills`
- `~/.claude/skills`

### Scanned Paths

- `~/.opencode/skills`
- `~/.config/opencode/skills`
- `~/.codex/skills`
- `~/.agents/skills`
- `~/.claude/skills`

说明：

- `~/.agents/skills` 和 `~/.claude/skills` 既是扫描路径，也是 managed outputs
- `~/.codex/skills` 下的 `.system` 是保留目录，不参与普通技能扫描

## 适用场景

- 你在 OpenCode、Claude Code、Codex 等多个宿主环境中共用 skills
- 你希望把历史技能目录统一收敛到一个中央仓库
- 你希望通过单一开关管理 skill，而不是手工维护每个宿主目录
- 你需要一个 GUI 来检查冲突、坏链接和迁移状态

## 技术栈

- Electron
- React
- TypeScript
- Vite

## 项目结构

- `src/electron/main.ts`: Electron 主进程入口
- `src/electron/config.ts`: 默认路径、宿主定义、配置加载
- `src/electron/skill-service.ts`: 扫描、状态判定、迁移、启停逻辑
- `src/electron/preload.cts`: 暴露给前端的安全 IPC 桥
- `src/renderer/App.tsx`: UI 和交互逻辑
- `src/shared/models.ts`: 共享 IPC 与视图模型

## 环境要求

- Node.js 18+
- Windows

当前项目主要面向 Windows，因为 managed 同步依赖 Windows junction。

## 安装

```bash
npm install
```

## 开发运行

```bash
npm run dev
```

该命令会同时启动：

- Vite renderer 开发服务
- Electron TypeScript 监听编译
- Electron 桌面应用

## 构建

```bash
npm run build
```

该命令用于验证：

- TypeScript 能否正常编译
- renderer 能否正常构建
- Electron main 和 preload 能否正常构建

## 发布打包

```bash
npm run dist
```

输出路径：

- `release/win-unpacked/`

说明：

- 当前项目发布的是 unpacked Windows 应用目录，而不是安装包
- 发布到 GitHub Release 时，建议将 `release/win-unpacked/` 压缩后作为附件上传

## 使用方法

### 1. 启动应用

可通过 `npm run dev` 启动开发环境，或直接运行打包后的 `Skills Switch.exe`。

### 2. 查看主界面

主界面包含：

- 中央仓库路径
- 已启用技能数量
- 需要迁移数量
- 问题数量
- `Global Skill Switches`

### 3. 查看文件系统面

点击 `Filesystem Surfaces`，进入二级视图查看：

- `Managed Outputs`
- `Scanned Paths`

### 4. 全局启用或禁用技能

在 `Global Skill Switches` 中：

- 每一行只显示技能名、状态和开关
- 打开开关会把中央仓库中的技能同步到 managed outputs
- 关闭开关会移除 managed outputs 中对应的受控链接

### 5. 查看技能详情

点击 `Managed Outputs View`，可查看每个 skill 的：

- `Managed Outputs`
- `Detected In`

该视图只读，不包含路径跳转按钮，尽量保持简洁。

### 6. 执行迁移

当检测到 legacy skills 时，界面会显示 `Migration Assistant`。

典型流程：

1. 扫描当前技能路径
2. 识别需要迁移到中央仓库的技能
3. 查看迁移项、强制清理警告和阻塞问题
4. 点击 `Run Migration`
5. 由应用完成迁移或清理，并重新同步 managed outputs

## 迁移行为

### 普通迁移

如果某个 skill 只存在于一个 legacy 路径中，且中央仓库中还没有它：

- 该目录会被移动到 `~/.skills-repo/skills/<skill-name>`
- 然后 managed outputs 会链接到中央仓库副本

### 强制清理后同步

如果中央仓库中已经存在某个 skill，但扫描路径中仍残留冲突目录、旧链接或坏 junction：

- 界面会显示 `Force cleanup before sync`
- 点击 `Run Migration` 后会弹出确认框
- 确认后，应用会清理这些冲突扫描项
- 然后重新将 managed outputs 同步到中央仓库

这套强制清理逻辑适用于所有扫描路径。

## 异常处理

### Blocking issues

如果界面显示 `Blocking issues`，表示当前状态不适合自动迁移。

常见原因：

- skill 路径里是普通文件而不是目录
- 某个路径状态异常，无法被安全清理
- managed outputs 中存在仍需人工处理的冲突

建议处理步骤：

1. 根据提示定位路径
2. 必要时先备份冲突文件或目录
3. 手工清理冲突
4. 点击 `Rescan`
5. 再次尝试迁移或同步

### Force cleanup warnings

如果界面显示 `Force cleanup before sync`，表示应用可以继续，但会在确认后删除扫描路径中的冲突目录或链接。

建议处理步骤：

1. 确认中央仓库中的 skill 是正确版本
2. 仔细查看 warning 列表
3. 点击 `Run Migration`
4. 确认清理操作

### 开关不可用

如果某个 skill 无法切换，通常说明：

- 该 skill 还未进入中央仓库
- 该 skill 仍需要迁移
- 该 skill 处于冲突或部分损坏状态

建议处理步骤：

1. 点击 `Rescan`
2. 查看 `Migration Assistant` 和详情视图
3. 先完成迁移或解决冲突

### 打开路径失败

如果 `Open Repository` 打开失败：

- 目标目录可能尚未创建
- 操作系统 shell 可能无法打开该路径

建议处理步骤：

1. 先确认路径存在
2. 先迁移或启用至少一个 skill 以创建目录
3. 重新尝试

### 构建成功但应用异常

请优先检查以下项目约束：

1. `vite.config.ts` 是否保持 `base: './'`
2. preload 是否仍为 CommonJS，即 `preload.cts -> preload.cjs`
3. 在部分 Windows 环境中，`npm run dist` 可能仍需要管理员权限，因为 `electron-builder` 在解压 `winCodeSign` 符号链接时可能失败

## 验证建议

### 改动后的最小安全验证

```bash
npm run build
```

然后手动验证：

- 主界面是否正常渲染
- `Filesystem Surfaces` 是否通过二级视图打开
- `Global Skill Switches` 是否只显示名称、状态和开关
- 迁移 warning 和 blocking issue 是否展示正确

### 发布前验证

```bash
npm run dist
```

然后检查：

1. `release/win-unpacked/Skills Switch.exe` 能否正常启动
2. 扫描面是否正常加载
3. 启用和禁用流程是否正常
4. 迁移和强制清理流程是否正常

## GitHub Release 清单

1. 视需要更新版本号
2. 执行 `npm run build`
3. 执行 `npm run dist`
4. 手动 smoke test `Skills Switch.exe`
5. 压缩 `release/win-unpacked/`
6. 创建 GitHub Release 并上传 zip 文件

## 注意事项

- 不要把 managed outputs 当作长期存储目录
- 中央仓库才是唯一权威来源
- 强制清理会删除扫描路径中的冲突目录或链接，执行前请先确认中央仓库内容正确
- 普通文件不会被自动删除，必须手工处理

## License

MIT
