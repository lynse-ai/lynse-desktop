# 录音上传-转写-总结完整流程集成

## Context
用户需要一个完整的录音处理流程：选择录音文件 → 选择模板 → 上传到 OSS → 触发转写+总结 → 轮询进度 → 展示结果。后端已集成 50+ 种模板和完整的 API 链路。前端需要补齐触发、轮询和模板管理功能。

## API 流程（已确认）
| 步骤 | 接口 | 方法 | 说明 |
|---|---|---|---|
| 列出模板 | `/api/business/translate/prompt/categories` | GET | 返回分类模板列表 |
| 获取预签名 URL | `/api/business/file/presign/upload` | POST | 返回 `{url, headers, fileId}` |
| 上传文件到 OSS | 预签名 `url` | PUT | 直传 OSS，不走后端代理 |
| 通知上传完成 | `/api/business/file/upload/notify?fileId=` | GET | 触发后端处理 |
| 转写+总结 | `/api/business/file/trans` | POST | `{fileId, templateId}` → `{taskId}` |
| 轮询状态 | `/api/business/file/trans/status` | POST | `{fileIds[]}` → 状态映射 |
| 读取总结 | `/api/business/file/conclusion/list` | GET | 已接入 |

## 实现任务

### Task 1: 新增 TypeScript 类型
**文件**: `packages/views/workspace/types.ts`
```ts
// 模板相关
interface PromptTemplate { id, name, alias, category, tags, isDefault, status, sortOrder, iconUrl, contentFormat }
interface PromptTemplateCategory { category, templates: PromptTemplate[], count, sortOrder, isDefault }

// 上传相关
interface PreSignedUrlVO { url, headers: Record<string,string>, fileId }
interface TransferFileReq { fileId, templateId, modelId?, languageId? }
interface TransferFileResult { taskId, requiredPoints? }
interface TransStatusResult { [fileId: string]: { status, taskId? } }
```

### Task 2: 新增 API hooks
**文件**: `packages/views/workspace/hooks/use-files.ts`
- `useTemplateCategories()` — `useQuery` 获取分类模板列表
- `usePresignUpload()` — `useMutation` 获取预签名 URL
- `useNotifyUploadComplete()` — `useMutation` 通知上传完成
- `useTransferFile()` — `useMutation` 触发转写+总结
- `useTranscriptionStatus(fileIds)` — `useQuery` 轮询状态（refetchInterval: 3s）
- `uploadFileToOSS(file)` — 工具函数：presign → PUT → notify → 返回 fileId

### Task 3: 上传 + 模板选择对话框
**新文件**: `packages/views/workspace/upload-dialog.tsx`

UI 流程：
1. **选择文件** — 拖拽或点击选择音频文件（支持 mp3/wav/m4a 等）
2. **选择模板** — 按分类展示 50+ 模板（RadioGroup + ScrollArea），默认选中 isDefault 模板
3. **确认上传** — 点击"开始生成"按钮
4. **进度展示** — 上传进度条 + 转写/总结状态（"上传中" → "转写中" → "总结中" → "完成"）
5. **完成** — 自动关闭对话框，刷新文件列表，切换到新文件的总结 tab

使用 shadcn 组件：`Dialog`, `Tabs`, `RadioGroup`, `Progress`, `ScrollArea`, `Button`

### Task 4: 模板管理器对话框
**新文件**: `packages/views/workspace/template-manager.tsx`

- 独立对话框，展示所有 50+ 模板
- 按 `category` 分组显示（Tabs 或 Accordion）
- 每个模板卡片显示：名称、别名、标签、contentFormat、是否默认
- 仅查看模式（不支持编辑）
- 入口：在上传对话框中添加"管理模板"链接 + 侧边栏设置区域

### Task 5: 侧边栏入口绑定
**文件**: `packages/views/workspace/left-panel/app-sidebar.tsx`
- 给"新建录音"按钮绑定 `onClick` → 打开上传对话框
- 添加模板管理器入口（在设置或更多菜单中）

### Task 6: 国际化
**文件**: `packages/views/locales/zh.ts`, `en.ts`, `ja.ts`
- 上传对话框相关文案
- 模板管理器文案
- 进度状态文案

### Task 7: 文件列表刷新集成
上传完成后：
- `invalidateQueries(['files'])` 刷新文件列表
- 自动选中新上传的文件
- 切换到总结 tab 显示生成中的进度

## 关键文件
- `packages/views/workspace/types.ts` — 类型定义
- `packages/views/workspace/hooks/use-files.ts` — API hooks
- `packages/views/workspace/upload-dialog.tsx` — 上传对话框（新建）
- `packages/views/workspace/template-manager.tsx` — 模板管理器（新建）
- `packages/views/workspace/left-panel/app-sidebar.tsx` — 侧边栏入口
- `packages/views/workspace/content-panel.tsx` — 内容面板（轮询状态集成）
- `packages/views/locales/zh.ts` — 中文文案
- `packages/core/api/client.ts` — API 客户端（已有，可能需小改）

## 验证方式
1. 启动桌面应用 `pnpm run dev:desktop`
2. 点击侧边栏"新建录音" → 上传对话框出现
3. 选择音频文件 + 选择模板 → 点击"开始生成"
4. 观察进度条：上传 → 转写 → 总结
5. 完成后文件列表刷新，自动显示总结 tab
6. 打开模板管理器 → 查看所有 50+ 模板分类