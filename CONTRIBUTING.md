# 贡献指南

感谢你对 Lynse 的兴趣！欢迎通过 Issue 和 Pull Request 参与贡献。

## 开发环境

| 依赖 | 版本要求 |
| --- | --- |
| Node.js | ≥ 18（推荐 22） |
| pnpm | ≥ 9（版本以 `package.json` 的 `packageManager` 为准） |
| Rust | stable 工具链（仅桌面端开发需要，通过 `rustup` 安装） |
| macOS | Xcode Command Line Tools |
| Windows | Visual Studio Build Tools（C++ 桌面开发） |

本地转写（可选）：Python 3.10+ 及 FunASR 模型目录。

## 常用命令

```bash
pnpm install        # 安装依赖
pnpm dev:desktop    # 启动桌面端（Tauri + Vite）
pnpm dev:web        # 启动 Web 端（Next.js）
pnpm typecheck      # TypeScript 类型检查
pnpm test           # Vitest 单元测试
pnpm build          # 全量构建
```

> `pnpm lint` 目前尚未接入 ESLint（脚本引用了未安装的 eslint 二进制），CI 暂不运行 lint。

## 提交 PR 前的检查清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过
- [ ] 涉及 UI 的改动使用 shadcn 设计令牌，不硬编码颜色值
- [ ] 共享代码遵守包边界（见下方）

## 包边界（重要）

这是一个 pnpm workspaces + Turborepo 的 monorepo，共享代码有严格的依赖方向：

```
packages/views → packages/core + packages/ui
```

- `packages/core/` — 禁止 react-dom、localStorage（用 StorageAdapter）、process.env
- `packages/ui/` — 纯 UI 组件，禁止 `@lynse/core` 导入
- `packages/views/` — 禁止 `next/*`、`react-router-dom` 导入，路由一律走 `NavigationAdapter`
- 框架专属 API 只允许出现在 `apps/web/platform/` 与 `apps/tauri/src/platform/`

## 提交信息规范

使用 Conventional Commits 风格：`feat: xxx` / `fix: xxx` / `chore: xxx` / `docs: xxx`，中英文均可。

## Issue 与 PR

- Bug 报告请使用 Bug Report 模板，附上复现步骤与系统环境（macOS / Windows、应用版本）。
- 新功能建议先开 Feature Request 讨论再动手实现。
- PR 请保持改动聚焦，一个 PR 解决一件事。

## 行为准则

请保持友善和尊重。技术讨论对事不对人。
