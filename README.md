# Skills Switch

`Skills Switch` 是一个基于 Electron + React + TypeScript 的桌面工具，用来统一管理多个 AI Agent 宿主中的技能目录。

它的目标是把技能集中收敛到一个中央仓库，再通过受控的 Windows junction 链接，把启用的技能同步到各个宿主目录，避免重复拷贝、状态漂移和手工维护。

## 功能特性

- 统一扫描多个技能目录，发现已有技能和冲突状态
- 使用中央仓库 `~/.skills-repo/skills` 作为唯一权威来源
- 一键全局启用/禁用技能，同步 managed outputs
- 检测 legacy skill 目录并执行迁移
- 支持在迁移前预览 `Detected in`、`Managed Outputs`、阻塞问题和强制清理项
- 支持对扫描路径中的冲突目录/链接执行确认后强制清理，再同步到中央仓库
- 提供独立的 `Filesystem Surfaces` 视图查看扫描面和输出面

## 当前支持的路径

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

- `~/.agents/skills` 和 `~/.claude/skills` 同时既是扫描路径，也是 managed outputs
- `~/.codex/skills` 下的 `.system` 会被保留，不参与普通技能扫描

## 适用场景

- 你同时在 OpenCode、Claude Code、Codex 等环境里使用 skills
- 你已经有多个历史技能目录，想统一迁移到一个中央仓库
- 你希望全局开关一个 skill，而不是在每个宿主目录下分别维护
- 你需要一个可视化工具来发现目录冲突、坏链接和状态不一致问题

## 技术栈

- Electron
- React
- TypeScript
- Vite

## 项目结构

- `src/electron/main.ts`: Electron 主进程入口
- `src/electron/config.ts`: 默认路径、宿主定义、配置加载
- `src/electron/skill-service.ts`: 扫描、状态判定、迁移、启停逻辑
- `src/electron/preload.cts`: 向前端暴露安全 IPC API
- `src/renderer/App.tsx`: 主界面和交互逻辑
- `src/shared/models.ts`: 主进程和渲染进程共享类型

## 安装与开发

### 环境要求

- Node.js 18+
- Windows

说明：当前项目的链接策略基于 Windows junction，主要面向 Windows 环境。

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
npm run dev
```

该命令会同时启动：

- Vite renderer 开发服务
- Electron TypeScript 编译监听
- Electron 桌面应用

### 生产构建检查

```bash
npm run build
```

用途：

- 校验 TypeScript 和前端构建是否正常
- 作为功能开发后的最小安全验证

### 打包发布产物

```bash
npm run dist
```

用途：

- 生成可发布的 Windows 应用目录
- 输出路径为 `release/win-unpacked/`

说明：

- 当前项目发布方式是压缩 `release/win-unpacked/` 目录后发布
- 不是生成单独安装包再分发

## 使用方法

### 1. 启动应用

运行开发环境或打开打包后的 `Skills Switch.exe`。

### 2. 查看主界面

主界面会显示：

- 中央仓库路径
- 已启用技能数量
- 需要迁移数量
- 问题数量
- `Global Skill Switches`

### 3. 查看扫描路径与输出路径

点击主界面的 `Filesystem Surfaces` 按钮，可以进入二级界面查看：

- Managed Outputs
- Scanned Paths

### 4. 全局启用/禁用技能

在 `Global Skill Switches` 中：

- 每个 skill 只显示技能名、状态和开关
- 打开开关会把中央仓库中的该技能同步到 managed outputs
- 关闭开关会移除 managed outputs 中对应的链接

### 5. 查看技能详情

点击 `Managed Outputs View` 可以进入详情视图，查看每个 skill 的：

- `Managed Outputs`
- `Detected In`

该界面仅展示信息，不提供路径跳转按钮，避免干扰。

### 6. 执行迁移

当系统检测到 legacy skills 时，会出现 `Migration Assistant`。

常见流程：

1. 应用扫描现有技能目录
2. 判断哪些技能需要迁移到中央仓库
3. 展示迁移项、警告项、阻塞问题
4. 点击 `Run Migration`
5. 迁移完成后自动同步 managed outputs

## 迁移行为说明

迁移逻辑分两类：

### 正常迁移

当某个 skill 只在一个 legacy 目录里存在，且中央仓库中还没有它时：

- 应用会把该目录移动到 `~/.skills-repo/skills/<skill-name>`
- 然后在 managed outputs 中建立受控链接

### 强制清理后同步

当中央仓库中已经存在某个 skill，但扫描路径里仍残留旧目录、旧链接或坏链接时：

- 应用会显示 `Force cleanup before sync`
- 点击 `Run Migration` 时会弹出确认框
- 确认后，应用会移除这些冲突扫描项
- 然后把 managed outputs 重新同步到中央仓库

该能力适用于所有扫描路径，而不只是某一个宿主目录。

## 异常处理

### 1. Blocking issues

当界面显示 `Blocking issues` 时，表示当前存在不能自动修复的问题，迁移会被阻止。

典型情况：

- 某个扫描路径下对应 skill 是普通文件而不是目录
- 某个路径状态异常，无法识别为可安全清理对象
- managed outputs 中存在无法自动处理的冲突

处理建议：

1. 根据提示定位具体路径
2. 手动备份异常文件或目录
3. 清理冲突后点击 `Rescan`
4. 再次执行迁移或同步

### 2. Force cleanup warnings

当界面显示 `Force cleanup before sync` 时，表示：

- 这些项目不是致命阻塞
- 但执行迁移时会删除扫描路径中的冲突目录或链接

处理建议：

1. 先确认中央仓库中的 skill 是正确版本
2. 阅读 warning 列表，确认待清理路径
3. 点击 `Run Migration`
4. 在确认框中确认执行

### 3. 开关不可点击

如果某个 skill 的开关不可点击，通常说明：

- 该 skill 还未进入中央仓库
- 当前处于冲突、部分损坏或需要先迁移的状态

处理建议：

1. 先执行 `Rescan`
2. 查看 `Migration Assistant` 或详情页中的状态说明
3. 优先完成迁移或清理冲突

### 4. 路径打开失败

如果点击 `Open Repository` 或 `Open Directory` 失败：

- 目标目录可能尚未创建
- 系统 shell 打开路径失败

处理建议：

1. 先确认路径是否真实存在
2. 先执行迁移或启用一个 skill 以创建目录
3. 再次尝试打开

### 5. 构建成功但运行异常

建议依次检查：

1. 是否在 Windows 环境下运行
2. `vite.config.ts` 是否保持 `base: './'`
3. 预加载脚本是否仍为 CommonJS 输出，即 `preload.cts -> preload.cjs`
4. 是否错误修改了 Electron 打包配置

## 验证建议

### 开发后最小验证

```bash
npm run build
```

然后启动应用，手动检查：

- 主界面是否正常显示
- `Filesystem Surfaces` 是否通过按钮进入二级页
- `Global Skill Switches` 是否只显示名称、状态、开关
- 迁移面板是否能正确显示 warning 和 blocking issue

### 发布前验证

```bash
npm run dist
```

然后检查：

1. `release/win-unpacked/Skills Switch.exe` 能否启动
2. 能否正常扫描路径
3. 能否执行启用/禁用
4. 能否执行迁移和强制清理

## 发布到 GitHub 的建议

建议仓库包含以下内容：

- `README.md`
- 项目截图
- 发布说明
- `release/win-unpacked/` 对应的压缩包作为 GitHub Release 附件

建议的发布步骤：

1. 更新版本号
2. 执行 `npm run build`
3. 执行 `npm run dist`
4. 手动验证 `Skills Switch.exe`
5. 压缩 `release/win-unpacked/`
6. 在 GitHub 创建 Release 并上传压缩包

## 注意事项

- 不要手动把 managed outputs 当作长期存储目录使用
- 中央仓库才是唯一权威来源
- 强制清理会删除扫描路径中的冲突目录或链接，执行前应确认中央仓库内容正确
- 普通文件不会被自动删除，必须人工处理

## License

MIT
