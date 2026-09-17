# FeedLog 集成资料

[FeedLog](https://github.com/linkcraftstudio/feedlog) 是开源（MIT）的反馈看板 / 路线图工具
（Canny 替代品）。我们使用其**托管版**工作区：<https://lynse.feedlog.ai>

- 用户在看板中提交功能建议、投票、跟踪进展（看板 / 路线图 / Changelog）
- 官方文档入口：工作区后台「安装」页 + [feedlog-widget 仓库](https://github.com/linkcraftstudio/feedlog-widget)
- 注意：GitHub 开源自托管版 README **没有** SDK / SSO 章节，`@feedlog/widget` 与
  Product SSO 为托管版独有能力

## 1. Widget SDK（前端嵌入）

```bash
pnpm add @feedlog/widget
```

```ts
import { createWidget } from '@feedlog/widget'

createWidget({
  baseUrl: 'https://lynse.feedlog.ai',   // 必填，工作区地址
  theme: 'light',                        // 'light' | 'dark' | 'auto'（默认 auto 跟随系统）
  auth: {
    // 返回后端签发的 JWT；null = 未登录；throw = 临时故障（面板显示可重试）
    getToken: async () => { /* ... */ return token ?? null },
    // 可选：打开自己的登录 UI（弹窗或跳转）
    login: () => openLoginModal(),
  },
})
```

| 选项 | 必填 | 说明 |
| --- | --- | --- |
| `baseUrl` | 是 | 工作区地址 |
| `auth` | 否 | 省略 = 游客模式（需工作区开启 Guest posting） |
| `auth.getToken` | 随 auth | `() => Promise<string \| null>`；null=未登录，throw=可重试故障 |
| `auth.login` | 否 | 打开宿主产品自己的登录界面 |
| `theme` | 否 | 仅在 iframe 创建时生效，运行期切换主题需重建面板 |
| `embedPath` | 否 | 默认 `/widget/embed`，调试用 |

行为要点：

- `createWidget` 全页只允许一次，重复调用被忽略（React 重复挂载安全）
- 无返回值、无实例、无事件——面板的开关由 SDK 自管；宿主无法程序化打开
- 看板 UI 在 FeedLog 托管的跨域 iframe 内渲染，宿主无法注入 CSS，
  定制上限 = **品牌主色 + 明暗主题**
- 令牌交换：SDK 用 JWT 向 FeedLog 换会话，按 email 缓存于 localStorage，
  令牌仅经 URL fragment 传递，不进日志/Referer

## 2. Product SSO（实名身份）

后端用工作区 SSO 密钥签发 **HS256 JWT**，前端经 `auth.getToken` 透传。

### JWT 载荷

| claim | 必填 | 说明 |
| --- | --- | --- |
| `email` | 是 | 身份主键，全局唯一 + 通知收件箱 |
| `name` | 是 | 显示名称 |
| `picture` | 否 | 头像 URL |
| `exp` | 是 | Unix 秒，**最长 24h**，建议 1h |

### 密钥与签名

- 密钥来源：工作台 **Developer → SSO**（可启用多个，任一有效）
- **只存服务端环境变量**（约定：`FEEDLOG_SSO_SECRET`），绝不能进客户端代码/打包产物
- 签名示例（Node.js）：

```js
import jwt from 'jsonwebtoken'

const token = jwt.sign(
  {
    email: user.email,      // 手机号注册无邮箱时可用「手机号@固定域名」合成稳定标识
    name:  user.nickname,
    picture: user.avatar,   // 可选
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  },
  process.env.FEEDLOG_SSO_SECRET,
  { algorithm: 'HS256' },
)
```

### 签发接口约定（后端实现）

```
GET /api/auth/feedlog/token        （带宿主产品登录态）
→ 200: { "code": ..., "data": { "token": "<JWT>" } }
→ 未登录 / 未配置密钥 / 异常：非成功响应 → 前端自动回落游客模式
```

- 接口必须放在宿主登录校验之后——**widget 完全信任该接口返回的身份**
- 签发接口实现于 dting-server：`dting-auth/.../controller/FeedLogController.java`
  （Sa-Token 取当前用户 → Feign 查 CustomerInfoVO → hutool `JWTUtil.createToken`，
  TTL 1h，零新增依赖）
- 身份映射：真实邮箱优先；手机号注册无邮箱 → `手机号@sms.lynse.cn`（稳定唯一，
  收不到邮件通知）；再兜底 `客户id@users.lynse.cn`

## 3. 工作台配置

| 配置 | 位置 | 作用 / 缺失后果 |
| --- | --- | --- |
| **品牌主色** | Settings → Branding | 悬浮球、按钮、链接颜色。填 Lynse 品牌色 `#5f67d8`；未配置为默认灰黑 |
| **Guest actions（游客投稿）** | Settings | 开启后未登录访客可直接发帖（首次发言自动生成游客身份，后续注册会合并到其账户）；关闭则未登录只见登录提示 |
| **SSO 密钥** | Developer → SSO | 生成/管理密钥，只放服务端环境变量 |

## 4. Agent / 程序化接入（Bot 发帖、读看板）

无公开文档化 API，但 widget 与看板 UI 消费的接口**天然支持程序化调用**
（better-auth 已启用 Bearer 认证），已从源码确认可用：

### 第一步：JWT 换会话令牌

```
POST https://lynse.feedlog.ai/api/widget/auth/exchange
Content-Type: application/json

{ "jwt": "<用 FEEDLOG_SSO_SECRET 签的 HS256 JWT，见上节载荷>" }

→ { "token": "<会话令牌>", "expiresAt": "...", "user": { id, email, name, image } }
```

- 限流 30 次/分钟/IP —— **缓存令牌至 expiresAt**（TTL 1h），不要每次调用都换
- 身份自选：为 Bot 签一个固定身份（如 `feedback-bot@lynse.cn`，名字「Lynse 反馈助手」），
  帖子以助手名义出现；也可按最终用户身份签发，帖子归属用户本人并订阅通知

### 第二步：Bearer 调用看板接口

```
Authorization: Bearer <会话令牌>
```

| 接口 | 说明 |
| --- | --- |
| `GET /api/boards` | 看板列表（id / name / postCount），取 `boardId` 用 |
| `POST /api/posts` | 发帖 `{ title ≤200, content ≤10000, boardId? }` → 201 返回完整帖子 |
| `GET /api/posts`、`GET /api/posts/:id` | 列表 / 详情（含搜索 `?` 参数见 `search.get.ts`） |
| `POST` / `DELETE /api/posts/:id/vote` | 投票 / 取消（幂等；merged 帖不可投） |
| `POST` / `DELETE /api/posts/:id/subscription` | 订阅 / 退订该帖通知 |
| `posts/[postId]/comments/*` | 评论及点赞 |

典型用法（飞书机器人 / Lynse 助手代用户提交反馈）：

```js
// 1. 后端按用户身份签 JWT（email = 用户身份 email，1h）
// 2. exchange 换 token（缓存）
// 3. fetch('https://lynse.feedlog.ai/api/posts', {
//      method: 'POST',
//      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
//      body: JSON.stringify({ title, content, boardId }),
//    })
```

### 注意事项

- 以上为 widget / 看板 UI 同源的**内部接口，非版本化公开 API**——托管版尚在
  0.x，端点可能随版本演进调整；生产依赖前建议到 FeedLog 官方看板
  （feedback.feedlog.ai）与团队确认，或申请正式 API
- `FEEDLOG_SSO_SECRET` 签发 JWT 必须在服务端完成，密钥不下发
- 发帖频率自控：发送方是你自己的服务，FeedLog 侧对发帖无限流，避免刷屏

## 5. 降级行为

| 场景 | 表现 |
| --- | --- |
| 宿主未登录（getToken 返回 null） | 游客模式（需工作区开 Guest posting） |
| 签发接口缺失 / 404 / 5xx / 未配密钥 | 游客模式 |
| getToken throw | 面板显示可重试错误态（不算未登录） |
| 一切正常 | 实名身份，看板发帖投票直达，通知可达（真实邮箱） |

## 6. 限制

- 面板为 FeedLog 托管页：无法注入 CSS，定制止步于品牌色 + 明暗主题
- 合成身份（手机号@域名）收不到 FeedLog 邮件通知
- 面板主题仅创建时生效，宿主切主题后需重开面板
- 开源自托管版无 SDK / SSO；迁移自托管等于放弃应用内集成形态
