# 本机验证记录 · 2026-10-24

## 交付行为

- 记忆管理默认显示专题 Markdown 文件，移除主导航上的记忆状态分类。
- 从已有证据归类传递稳定专题身份与可读名称；项目、课程、客户、投资对象等共用通用机制。
- 文件标题统一英文，明确采用正式名称 lynse，保留“灵光记”等原名和别名用于搜索。
- 正文和内部章节根据实际内容选择语言，不强制英文；支持中文、英文、混合和人工原文。
- 多次会议的信息进入同一文件；候选更新在文件内审阅，确认后才能被 AI 使用。
- 支持新建、编辑、命名、移动、合并/按信息段拆分；较长专题按现有编辑上限生成补充文件。
- 同一来源中的同一事实可关联多个文件，底层只保存一份；不同对象的同文事实不做全账号内容去重。
- 保留版本冲突、来源版本校验、人工修正、账号隔离、冻结删除预览和无正文操作回执。
- 知识库浏览不再在后台挂载旧记忆编辑器，避免无用的旧文件读取。

## 自动检查

所有模型和业务资料均为合成数据，不调用真实模型或外部业务服务。

| 命令 | 结果 |
| --- | --- |
| `.venv/bin/python tools/run_agent_regression.py </dev/null` | 120/120 场景通过，含新增通用课程记忆场景 |
| `.venv/bin/python -m unittest tests/test_agent_runtime.py -v </dev/null` | 210 项通过；最终完整套件再次覆盖这些用例 |
| `.venv/bin/python -m unittest discover -s tests -v </dev/null` | 2825 项，0 失败，80 跳过 |
| `.venv/bin/python -m unittest tests.test_topic_memory_files tests.test_knowledge_gateway_integration -q </dev/null` | 在最终正式命名调整后补验，16 项通过 |
| `pnpm --filter @lynse/views typecheck` | 通过 |
| `pnpm --filter @lynse/views exec vitest run workbench/topic-memory-library.test.tsx workbench/wiki-automation-settings.test.tsx workbench/page.test.tsx` | 16 项通过 |
| `pnpm --filter @lynse/core exec vitest run api/memory.test.ts` | 5 项通过 |
| `pnpm --filter @lynse/views exec eslint workbench/topic-memory-library.tsx workbench/topic-memory-library.test.tsx workbench/topic-memory-locales.ts workbench/memory-management.tsx workbench/memory-management-locales.ts workbench/wiki-automation-settings.tsx workbench/wiki-automation-settings.test.tsx workbench/locales.ts workbench/page.tsx workbench/page.test.tsx` | 通过 |
| `pnpm --filter @lynse/core exec eslint api/memory.ts api/memory.test.ts` | 通过 |
| `pnpm --filter @lynse/tauri exec vite build` | 通过；已有大包与静态/动态重复导入提示仍存在 |
| `cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml --lib` | 349 项通过，4 忽略 |
| 两个仓库的 `git diff --check` | 通过 |

完整套件先发现新增 organize 路由没有同步 OpenAPI，修复契约后通过。沙箱内不能监听测试端口的用例在允许本机端口的环境补跑通过。

## 浏览器与真实本机入口

URL：`http://127.0.0.1:5192/`。使用实际共享页面组件和 memoryApi，经本机 Runtime HTTP 路由访问实际 Memory HTTP 服务；仅在身份边界使用固定合成账号，存储为 InMemoryStores，不是线上 PostgreSQL。资料覆盖硬件、课程、客户和基金，预览已注明“本机合成数据”。

已验证：

1. 直接进入文件列表，不出现“已记住/待确认/不可用/已拒绝”分类导航。
2. 用中文原名与原始引文搜索英文标题文件。
3. 文件内预览并确认更新，正文在同一文件中增加，候选入口随之消失。
4. 新建文件、保存 Markdown、保留人工中文、重命名、移入文件夹。
5. 展开原始来源，显示未经翻译的中文引文。
6. 删除预览显示冻结版本和受影响的文件；取消预览后数据保留。实际删除、清理和回执重放由离线回归覆盖。
7. 640×800 窄窗口下列表与正文顺序展示，操作和正文可访问；已恢复默认视口。
8. 相邻整理设置页正常，主记忆授权之外的自动更新、本机文字上传和回顾选项维持独立选择。
9. 最终预览浏览器未记录新的 error/warn。

视觉文件位于 `/Users/lynse/.codex/visualizations/2026/10/24/01a16ced-fc20-7271-9205-5b8db68c6936/memory-topics/`：final.png、narrow.png、settings.png。预览服务和合成资料脚本位于 `/private/tmp`，不是产品测试后门或发布内容。

## 实现边界

- 编辑会保留来源信息段之间的 Markdown 分隔线。跨段重组使用文件菜单，删除使用冻结预览；单段内容可以正常编辑。
- 新主页面需要服务连接；本轮没有新增主页面离线缓存。既有原生缓存接口保留。
- 本轮未部署云托管、修改线上权限、应用数据库迁移、调用真实模型、执行真实 PostgreSQL 联调或发布/安装桌面包。
- 上线顺序应为 Memory 服务、Runtime 网关，再发布桌面端。新桌面依赖 topic_files 能力与 organize 网关路由；不能只发布桌面。
- 用户原有未提交文件和此前云端修复/审计改动均保留。本轮未提交、推送或创建 PR。
