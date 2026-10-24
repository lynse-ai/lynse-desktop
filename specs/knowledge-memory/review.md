# 知识库与共用记忆计划 v0.3 实施状态复核

> 此文件保留为实施前审计快照。当前状态已更新到 [v0.4 计划](./plan-v0.4.md) 和 [实施记录](./implementation.md)。

复核日期：2026-10-24。对照用户提供的 v0.3，以及 Desktop 和 Lynclaw 当前本机源码。本文是实施状态与剩余工作的复核，不变更产品规则。

结论：**已有自动 Wiki、共用云端记忆和 Personal Context 后端基础，应把计划改成基于现有能力的增量交付清单。P0–P3 的完整 MVP 仍未完成，不能用已有基础能力代替新流程验收。**

Desktop 基线为 `31d910e5`，Lynclaw 基线为 `039dcbb`。两边都存在未提交改动：本次将它们计入“当前源码已实现”，不计入“已提交、已部署或已发布”。尤其自动 Wiki 的 `wiki_automation.rs`、`runtime/desktop_wiki.py` 及部分测试仍是未跟踪文件。

| 原阶段 | 修订后的状态 | 已有实现 | 剩余交付与验收 |
| --- | --- | --- | --- |
| P0 契约与基线 | 部分完成 | Memory 已有 OpenAPI、契约测试、迁移、类型化动作、身份与幂等基础 | 冻结本计划新增接口和字段；补能力声明、跨端 fixture、使用资格及迁移规则；核对原 PRD；现有契约测试不覆盖 v0.3 全部要求 |
| P1 入口与共享范围 | 本地知识库体验已实现；云端范围与新管理入口未完成 | 侧栏“知识库”、首页进度、图谱/目录/专题、齿轮设置、返回知识库、高级设置折叠、文件夹多选与未分类、范围保存/暂停、本机范围限制 | 账号级共享范围、排除项和版本同步；独立记忆授权；`/memory/manage`；助手主入口及返回原会话；旧 library 链接迁移；与 Wiki 开关解耦 |
| P2 来源与候选 | 基础服务已实现；新链路未接通 | 来源修订/撤销、证据服务、持久任务、Runtime worker、自动候选、显式记忆写入、确认/拒绝/替代、云端 Markdown 编辑及离线草稿 | 本地文本上传会话/分片/完整提交/别名；Wiki 有效版本事件与提取回执；新范围/授权/场景绑定；冲突及批量确认预览；纠正的人工来源语义；新候选管理 UI |
| P3 召回与遗忘 | 召回及遗忘基础已实现；强化语义与完整验收未完成 | 已有记忆召回、候选隔离、来源版本门槛、证据依赖失效、墓碑/抑制、内容与派生索引清理、删除日志和部分恢复工具 | 可解释的统一资格结果；独立 explain；遗忘预览与清单绑定；证据片段/别名/替代链抑制；自动原文补充约束；大级联消费者；所有本期遗忘类型恢复；新字段下的历史复核 |
| MVP 门槛 | 未完成 | 两端各有局部实现、测试和既往联调记录 | P0–P3 新闭环及单独授权本地转写未贯通；本次未执行真实 PostgreSQL、网关与原生 Desktop 的完整验收、灰度或回滚演练 |
| P4 合成视图 | 新目标视图尚未实现 | 已有只读 `memory_summary.md` 索引、部分派生数据和目标回顾导出 | 每日笔记、`long_term_summary.md`、分类投影及分页接口；完整输入指纹、覆盖截止时间、失败缺口；普通聊天后台提取的独立授权 |
| P5 待办与目标 | 目标能力已有；待办四态未完成 | 业务云端待办/本地待办各自保存；目标确认、跟踪、回顾、完成/重开等既有流程 | 四态类型/接口/历史、能力协商、旧二态写入保护及业务后端交付；新目标来源与验收条件变更回归 |
| P6 人物、校准与简报 | 有可复用基础；本阶段未完成 | 图谱、Context inbox、建议/提醒、时区/免打扰/展示确认；Wiki 的独立 Gmail 配置 | 人物/群组只读投影、关系确认、偏好校准、晨间简报、多渠道交付状态与去重、邮箱长期记忆授权适配 |
| P7 全量验收与发布准备 | 未完成 | 既有迁移、RLS、恢复测试与局部执行记录 | 新闭环容量/恢复/混合版本/灰度验收；分别记录源码、构建、联调、部署和发布证据 |

下面这些内容可从“新建工作”移入“已有能力及保持回归”。

- **图谱优先的知识库和自动 Wiki。** 已有范围筛选、总结优先/转写兜底、敏感文本遮盖、原始引文校验、专题归类、自动发布、历史和人工补充保留、相同正文不重复发布、单专题失败隔离。自动发布标记为 `auto_validated`，与 `approved` 分开。入口和设置往返保留专题/来源/目录参数，图谱状态按账号保存。
- **云端为共用记忆权威。** Desktop 经 Lynclaw 文件接口操作同一批 L1 记录；`MEMORY.md`、独立笔记和记录 Markdown 视图不构成第二套主存储。已有版本冲突、稳定操作 ID、账号隔离、离线缓存和待同步草稿。候选不能靠编辑变成已确认记忆，云端失败也有独立状态。
- **候选、确认和召回的服务基础。** `MemoryService` 已有 add/replace/confirm/reject/forget、来源版本与证据失效处理。`ContextService` 可从已同步且获授权的会议等来源生成 candidate；任务提交不自动确认，也不创建业务待办。
- **持久后台执行。** PostgreSQL 任务队列已有租约、SKIP LOCKED claim、五分钟租约、每分钟续租、四次尝试和 1/5/30 分钟退避。模型调用在 Runtime；Memory 在事务内重新检查授权、来源、输入和租约并提交候选/建议/完成状态。任务保存来源指针，不保存用户业务凭据。
- **遗忘和恢复基础。** 已有先写删除意图、墓碑与使用门槛，再清理内容/索引/依赖的机制，并有来源撤销及证据恢复相关测试。新计划应扩展这些机制。
- **目标与提醒基础。** Personal Context 已有用户确认目标、带来源回顾、建议拒绝抑制、展示回执、时区与展示窗口；它们可以供 P5/P6 复用。

几处已确认的差异需要写进新任务，不能归入“已有能力直接复用”。

| 差异 | 当前源码证据 | 对计划的影响 |
| --- | --- | --- |
| 本机文件夹范围尚未成为云端共享范围 | `WikiAutomation` 只有 `folder_ids/include_unfiled`；`workbench_configure` 写本机 Manifest。现有 Context preferences 是 `global/project` scopes 与 `grant_version` | 需要扩展账号级范围模型及同步协议；不能用已有 Context scopes 替代文件夹范围，也不能让两端长期维护不同选择 |
| 记忆管理仍挂在 Wiki 页面与开关下 | `MemoryPage` 在 `wikiEnabled=false` 时跳转 `/home`；设置入口也受 `wikiEnabled` 限制；当前是 `/memory?tab=library`，未发现 `/memory/manage` | P1 仍需独立管理页和路由。当前“返回 AI 助手”打开设置对话框，不是返回原聊天 |
| 同一来源多个证据片段尚不支持 | `EvidenceService.validate` 按 `(parent_type,parent_id)` 去重；迁移 005 的主键同样不含片段标识 | 原始证据能力需要增量迁移，不能只增加前端字段 |
| 人工纠正沿用原来源和证据 | `MarkdownMemoryService.save` 调用 replace；`_apply_replace` 从旧记录展开，并在未提供新依赖时继承旧证据 | 要保留敏感性和作用域约束，同时明确新文本为人工陈述；原始引文不能自动证明改写后的内容 |
| 当前暂停和授权资格耦合 | Context `stop` 关闭 `enabled` 并推进 grant；`_context_grant_available` 要求 enabled 和相同 grant，适用于带 `context-origin` 的记录 | v0.3 的“暂停仅停止新提取”和“撤销授权停止使用”必须分开实现；沿用旧开关会改变已确认内容的可用性 |
| 大级联只有升级任务，未发现对应消费者 | `EvidenceService.invalidate_parent` 超过 500 个后创建 `evidence_cleanup` 并报错；当前源码对该任务名的命中只有生产点与测试 | 已有读取门槛有价值，但还需可恢复、可推进的大级联 worker，不能把“已入队”当作清理完成 |
| 恢复工具覆盖不完整 | `replay_memory_source_deletions.py` 明确仅重放 source_delete/source_refresh，并报告其他类型尚未重放 | 不得将该工具视为覆盖本期全部遗忘类型的恢复方案；已有单元测试也不能代替真实备份恢复验收 |
| 后台队列参数只覆盖部分要求 | 当前 worker 有租约/重试；任务指纹主要绑定来源、目标、授权和 coverage。未发现本计划的每日 200 次模型调用配额、全局四并发控制和 02:00/08:00 合成/简报调度 | 租约和退避作为基线复用；补配额、并发、模型/提示词/schema 指纹、发布及外部副作用事件机制 |

此外，当前 recall 可以追加会议片段作为证据视图。v0.3 要求的片段级遗忘抑制、普通自动补充与用户主动查原文的区分，仍需为这条路径建立专门验收；仅验证记忆记录消失不足以证明整个遗忘契约完成。现有 `source is None` 的兼容分支、旧记录和迁移资格，也需要纳入新的统一使用资格审计。

本次在本机 Memory OpenAPI、Runtime 路由和 Desktop 调用中，**未发现**以下计划新增接口：`memory-capabilities`、`desktop-sources/*`、`wiki-memory/events`、`memories/{id}/explain`、`memories/forget-plans*`、`memory-projections/*`。现有 `memory-files*`、`sources/events`、`memories/actions`、`memories/recall`、Context preferences/task/inbox/goals 接口应保留并扩展。这里不对未取得源码的同源业务网关和业务待办后端作完成判断。

建议 v0.4 按以下增量顺序组织，保留原 P0–P7 编号方便追踪：

1. **P0 收口。** 把上述已有能力写成基线；明确新增字段/接口、错误、能力位、迁移和 fixture。优先定清暂停/撤销、人工纠正、来源片段与遗忘抑制语义。
2. **P1 补齐。** 先完成账号范围版本、排除项和独立授权，再让 Native 镜像执行；同时收尾 `/memory/manage`、聊天往返、旧链接和 Wiki 解耦。保留现有图谱与自动 Wiki。
3. **P2 接通。** 复用来源服务、证据服务、任务队列和 Memory actions，补本地文本授权上传与 Wiki 有效版本事件，使新流程真正产出可追溯候选；增加预览绑定的确认/拒绝/纠正管理。
4. **P3 强化。** 补统一资格与解释、片段和替代链抑制、遗忘预览、大级联及全类型恢复。覆盖所有自动上下文路径，不能只测 recall 接口。
5. **MVP 联调。** 原生 Desktop、真实非超级用户 PostgreSQL、Runtime、测试业务网关贯通；再做账号开关、故障回滚和迁移复核。未执行前保持未完成。
6. **P4–P6 后续增量。** 合成视图和普通聊天提取仍是新增工作；目标/inbox/提醒/Gmail 适配列为基础；待办四态单独标明业务后端依赖，不能拖住 MVP。
7. **P7 单列发布证据。** 未提交、已提交、构建通过、联调通过、已部署、已灰度、桌面发布分别记录。当前工作区自动 Wiki 不能直接标成已发布。

本次验证如下，均使用合成数据、离线测试或固定模型结果，没有进行线上写入、付费模型调用、生产迁移或发布。

| 验证 | 本次结果 | 限制 |
| --- | --- | --- |
| `pnpm --filter @lynse/views exec vitest run workbench/page.test.tsx workbench/wiki-browse.test.ts workbench/knowledge-graph-scene.test.tsx` | 3 文件、20 项通过 | 组件/状态测试，不代表原生完整路径验收 |
| `cargo test --offline --lib workbench::wiki::automation::tests`（在 `apps/tauri/src-tauri`） | 16 项通过、1 项忽略 | loopback-only 自动 Wiki 联调用例本次未执行 |
| Lynclaw：`python -m unittest tests.test_memory_markdown tests.test_memory_evidence_dependencies tests.test_memory_source_lifecycle tests.test_context_service tests.test_lynse_memory_contract tests.test_context_runtime_api -q` | 83 项通过 | 使用 `.venv/bin/python`、临时日志目录及内存/合成服务；不是真实 PostgreSQL 验收 |
| Lynclaw：`python -m unittest tests.test_wiki_synthesis -q` | 8 项通过 | 固定输出校验，不代表真实模型质量 |
| 当前 views 全量测试 | 629 项通过、9 项失败、1 项跳过 | 9 项失败均来自登录测试 mock 缺少 `showWindowControls`；本次未修改应用代码，也未修复该问题 |

已有 `docs/local-wiki.md` 记录了 2026-10-23 的 Rust、renderer 和本机 HTTP 联调结果；Lynclaw 的 `docs/superpowers/reports/2026-10-06-personal-context-v1.md` 记录了旧 Context 的真实 PostgreSQL/租约/RLS 验证。两份是既往执行记录，本次未复跑，不等同于 v0.3 新闭环通过。

主要源码依据：

- [知识库入口与开关](../packages/views/workbench/page.tsx)、[设置范围与暂停](../packages/views/workbench/wiki-automation-settings.tsx)、[高级设置](../packages/views/workbench/components.tsx)、[全局设置入口](../packages/views/settings/settings-dialog.tsx)。
- [Wiki 自动流程](../apps/tauri/src-tauri/src/workbench/wiki_automation.rs)、[自动流程回归](../apps/tauri/src-tauri/src/workbench/wiki_automation_tests.rs)、[本机范围结构](../apps/tauri/src-tauri/src/workbench/store.rs)、[Native 配置与持久化](../apps/tauri/src-tauri/src/workbench/mod.rs)。
- [云端记忆缓存与传输](../apps/tauri/src-tauri/src/workbench/memory_cloud.rs)、[记忆编辑 UI](../packages/views/workbench/memory-library.tsx)、[待办二态数据层](../packages/views/todo/todo-api.ts)。
- Lynclaw 路径均相对 `/Users/lynse/Documents/lynclaw`：`services/lynse-memory/openapi/v1.yaml`；`runtime/context_api.py:47`；`runtime/context_worker.py:229`；`services/lynse-memory/lynse_memory/core/context_service.py:40`、`:164`、`:290`、`:431`；`core/memory_service.py:72`、`:324`、`:436`、`:587`、`:827`（`core/` 同属 `services/lynse-memory/lynse_memory/`）。
- 差异依据：同目录 `core/evidence_service.py:21`、`:152`，`core/markdown_service.py:72`、`core/memory_service.py:879`；`services/lynse-memory/migrations/005_memory_evidence.sql:7`；`tools/replay_memory_source_deletions.py:1`。
