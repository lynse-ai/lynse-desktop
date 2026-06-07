---
name: lynse-cli
description: Lynse CLI 工具，调用 lynse.ai 后端服务的 API。当用户需要查询 lynse 账户信息、管理文件/转写/总结、操作设备、管理 AI 模型、团队协作、发送消息时使用此技能。即使只是简单查个积分或看个文件列表，也应使用此技能。
version: 1.2.8
metadata:
  openclaw:
    requires:
      env:
        - LYNSE_API_HOST
        - LYNSE_API_KEY
      bins:
        - python
    platforms:
      - macOS
      - Linux
      - Windows
    primaryEnv: LYNSE_API_KEY
    homepage: https://www.lynse.ai
    emoji: "\U0001F4CB"
---

# Lynse CLI Skill

## ✅ 跨平台支持 (v1.3.0)

**当前版本基于 Python 3.8+，原生支持 Windows/macOS/Linux，无需 Git Bash 或 WSL。**

### Windows 用户安装指南

Windows 用户无需安装 Git for Windows 或 WSL。只需：

1. **安装 Python 3.8+**: https://www.python.org/downloads/ （安装时勾选 "Add Python to PATH"）
2. **运行安装脚本**: 打开 PowerShell 执行 `.\install.ps1`
3. **配置 API Key**: 编辑 `.env` 文件填入 `LYNSE_API_KEY`
4. **开始使用**: `python lynse.py getCurrentCustomer`

### 快速开始

```bash
# 自动安装（推荐）
./install.sh           # macOS/Linux
.\install.ps1          # Windows PowerShell

# 使用命令（所有平台通用）
python lynse.py getCurrentCustomer
python lynse_cli.py listFiles
```

**Windows 环境变量配置:**
```powershell
# PowerShell 中设置环境变量
$env:LYNSE_API_HOST="https://your-api-host/api"
$env:LYNSE_API_KEY="dk_your_api_key_here"

# CMD 中设置环境变量
set LYNSE_API_HOST=https://your-api-host/api
set LYNSE_API_KEY=dk_your_api_key_here
```

---

## ⚠️ Agent 必读约束

### 🌐 Base URL
```
$LYNSE_API_HOST
```
Base URL 通过环境变量配置，不硬编码。所有 API 请求必须使用此变量，不要猜测或自行构造地址。

### 🔑 认证
Lynse 使用 **API Key + 临时 Token** 双层认证：

```
第一步：用 API Key 换取 Token
POST $LYNSE_API_HOST/api/auth/apikey/token
Header: X-API-Key: $LYNSE_API_KEY

第二步：用 Token 调用业务接口
Header: Authorization: <accessToken>    （不带 Bearer 前缀）
Header: X-API-Key: $LYNSE_API_KEY
```

- **API Key 格式**：`dk_xxx`（从系统控制台获取）
- **Token 有效期**：2 小时，过期自动刷新
- **Token 缓存**：本地文件，权限 600（仅所有者可读写）

**每次调用前检查 `$LYNSE_API_KEY` 和 `$LYNSE_API_HOST` 是否存在**。若不存在，提示用户完成配置：
```bash
# macOS/Linux 环境变量
export LYNSE_API_HOST="https://your-api-host/api"
export LYNSE_API_KEY="dk_your_api_key_here"

# Windows PowerShell 环境变量
$env:LYNSE_API_HOST="https://your-api-host/api"
$env:LYNSE_API_KEY="dk_your_api_key_here"

# 方式二：配置文件（所有平台通用）
# 复制模板后填入（Windows 用 copy，macOS/Linux 用 cp）
cp .env.example .env    # macOS/Linux
copy .env.example .env  # Windows CMD
```

配置完成后再继续执行用户原本的请求。

### 🔐 Scope 权限
不同操作需要对应权限，权限由 API Key 绑定的角色决定：

| Scope | 说明 | 典型操作 |
|-------|------|----------|
| `customer.read` | 读取用户信息 | getCurrentCustomer, getUserInfo |
| `customer.write` | 编辑用户 | addUser, editUser, removeUser |
| `file.read` | 读取文件/转写/总结 | listFiles, getFileInfo, getConclusion, getOutline |
| `file.write` | 编辑文件内容 | editConclusion, editOutline, editTransRecord |
| `device.read` | 读取设备信息 | getDeviceInfo, getDevicePage |
| `device.manage` | 管理设备 | unbindDevice |
| `ai.read` | 查看 AI 模型 | getAiModels |
| `ai.manage` | 管理 AI 模型 | addModel, editModel, deleteModel, enableModel |
| `message.send` | 发送消息 | sendSms, sendEmail |
| `team.read` | 查看团队 | listMyTeam |
| `team.manage` | 管理团队 | createTeam, editTeam, removeTeamMember |

权限不足时 API 返回 HTTP 403，引导用户联系管理员升级权限。

### 🔒 安全规则

**敏感信息保护：**
- 用户数据属于隐私，不在群聊/公开场合主动展示用户手机号、积分等敏感字段
- 查询用户信息时，默认只展示非敏感字段（如昵称、ID），除非用户明确要求查看积分或手机号
- 在群聊中展示用户信息时，自动隐藏敏感字段（手机号显示为 `138****1234`，积分不展示）
- 若配置了 `LYNSE_OWNER_ID`，检查当前操作用户 ID 是否匹配；不匹配时回复「抱歉，这是私密账户，我无法操作」

**认证安全：**
- Token 失效时自动刷新，刷新失败则提示用户检查 API Key 配置
- Token 缓存文件权限必须为 600（仅所有者可读写）

**输入安全：**
- 所有用户输入参数经过转义处理，防止注入
- 创建/编辑操作建议间隔 1 分钟以上，避免触发服务端限流

### ⚠️ 错误处理规则

| 状态码 / 场景 | HTTP 代码 | 处理方式 |
|---------------|-----------|----------|
| Token 过期 | 401 | 自动用 API Key 刷新 Token 后重试 |
| 权限不足 | 403 | 提示「您的账户权限不足，请联系管理员升级权限」 |
| 请求限流 | 429 | 等待 60 秒后重试，提示「请求过于频繁，请稍后再试」 |
| 资源不存在 | 404 | 提示「请求的资源不存在」 |
| 服务器错误 | 500/502/503 | 提示「服务器暂时不可用，请稍后重试」 |
| Token 刷新失败 | - | 提示检查 `LYNSE_API_KEY` 是否正确或已过期 |
| 接口返回 `code != 200` | - | 展示错误信息，不静默忽略，给出可能的解决建议 |

**错误响应示例：**
```json
{"code": 403, "message": "权限不足", "data": null}
```

遇到错误时，回复格式：
1. 说明发生了什么错误
2. 给出可能的原因
3. 提供解决建议或下一步操作

### 📦 CLI 版本路由
技能同时支持两个 CLI 版本：
- **lynse-cli-a**（基础版）：核心认证功能（login, register, token 管理等）
- **lynse-cli-b**（增强版）：完整业务功能（文件、团队、AI、设备等）

`lynse_cli.py` 自动检测并路由到可用版本。详细命令对照见 [compatibility.md](compatibility.md)。

---

## 调用方式

### 跨平台与多环境规则

**所有命令必须使用 `python`（不是 `python3`）。** Windows 环境下 `python3` 可能不存在，而 `python` 在所有平台都能工作。

**环境检测：** 根据用户上下文识别运行环境，使用对应的技能路径：

| 环境 | 技能路径 | 环境变量来源 |
|------|----------|-------------|
| Claude Code | `~/.claude/skills/lynse-cli/lynse.py` | 用户手动配置 `.env` 或环境变量 |
| Cursor | `~/.cursor/skills/lynse-cli/lynse.py` | 用户手动配置 `.env` 或环境变量 |
| Hermes | `~/.hermes/skills/lynse-cli/lynse.py` | 用户手动配置 `.env` 或环境变量 |
| OpenClaw | `~/.openclaw/workspace/skills/lynse-cli/lynse.py` | 平台自动注入，无需手动配置 |

**跨平台规则：**
1. 使用 `python`（不是 `python3`）调用 lynse.py
2. 根据运行环境使用上表中对应的技能路径
3. OpenClaw 环境下 `LYNSE_API_HOST` 和 `LYNSE_API_KEY` 由平台自动注入，无需手动配置；其他环境需检查环境变量是否已设置
4. 不要使用 Shell 脚本（`./lynse_unified.sh`、`./api_wrapper.sh`）—— 它们不兼容 Windows

### 跨平台命令 (推荐)

```bash
# 所有平台通用 (macOS/Linux/Windows/OpenClaw)
python lynse.py <command> [参数...]
python lynse_cli.py <command> [参数...]
```

### Windows 额外支持

```powershell
# PowerShell
python lynse.py getCurrentCustomer

# 或使用 .bat 包装器 (CMD)
lynse getCurrentCustomer
```

### macOS/Linux 额外支持

```bash
# Shell 脚本（保留向后兼容，仅限 macOS/Linux）
./lynse_unified.sh getCurrentCustomer
./api_wrapper.sh listFiles
```

---

## 常用操作

### 🔹 用户信息
```bash
python lynse.py getCurrentCustomer          # 当前用户完整信息
python lynse.py getUserPhone                # 当前用户手机号
python lynse.py getUserPoints               # 当前用户积分（含已用）
python lynse.py getUserInfo <用户 ID>        # 指定用户信息
python lynse.py getCurrentUser              # 当前系统用户
```

### 🔹 文件管理
```bash
python lynse.py listFiles                         # 所有文件列表
python lynse.py getFileInfo <fileId>              # 文件详情
python lynse.py getConclusion <fileId>            # 文件总结
python lynse.py getOutline <fileId>               # 文件大纲
python lynse.py exportOutline <fileId>            # 导出大纲
python lynse.py getTranscriptionRecord <fileId>   # 转写记录
python lynse.py listFilesByTimeRange [天数]        # 按时间范围（默认 7 天）
```

### 🔹 AI 模型管理
```bash
python lynse.py getAiModels                        # 所有模型列表
python lynse.py addModel '<JSON>'                  # 添加模型
python lynse.py editModel '<JSON>'                 # 编辑模型
python lynse.py deleteModel <模型 ID>               # 删除模型
python lynse.py enableModel <模型 ID> <true/false>  # 启用/禁用
```

### 🔹 设备管理
```bash
python lynse.py getDevicePage <页码>      # 分页设备列表
python lynse.py getDeviceInfo <设备 ID>    # 设备详情
python lynse.py unbindDevice <设备 ID>     # 解绑设备
```

### 🔹 用户管理（需要 customer.write 权限）
```bash
python lynse.py addUser '<JSON>'          # 添加用户
python lynse.py editUser '<JSON>'         # 编辑用户
python lynse.py removeUser <用户 ID>       # 删除用户
```

### 🔹 认证（推荐使用 API Key 自动认证，无需手动调用）
```bash
python lynse.py login <用户名> <密码>              # 用户名密码登录
python lynse.py loginWithPhone <手机号> <验证码>   # 手机号登录
python lynse.py logout                              # 登出
```

### 🔹 消息
```bash
python lynse.py sendSms '<JSON>'         # 发送短信
python lynse.py sendEmail '<JSON>'       # 发送邮件
```

### 🔹 系统
```bash
python lynse.py getRoleList              # 角色列表
python lynse.py getMenuTree              # 菜单树
```

---

## 认证流程

```
用户调用 → lynse.py
  → 检查 LYNSE_API_HOST / LYNSE_API_KEY
    → 不存在 → 提示配置
    → 存在 → 检查缓存 Token
      → Token 有效 → 直接使用
      → Token 无效/过期 → POST /api/auth/apikey/token 换取新 Token
        → 成功 → 缓存（权限 600）→ 调用业务接口
        → 失败 → 提示检查 API Key
```

---

## 快速部署

### 自动安装（推荐）

运行以下命令自动检测环境并安装：

```bash
# macOS/Linux
./install.sh

# Windows PowerShell
.\install.ps1
```

安装脚本会：
1. 检测当前运行的 AI 助手环境
2. 复制技能文件到对应的 skills 目录
3. 创建 `.env` 配置文件（自动填入 API 服务器地址）
4. 安装 Python 依赖 (requests)
5. 设置脚本执行权限
6. 显示安装完成后的使用说明

### 手动安装

1. 复制整个 `lynse-cli` 目录到目标实例的 `skills` 目录
2. 复制 `.env.example` 为 `.env`，填入 `LYNSE_API_HOST` 和 `LYNSE_API_KEY`
   - macOS/Linux: `cp .env.example .env`
   - Windows CMD: `copy .env.example .env`
   - Windows PowerShell: `Copy-Item .env.example .env`
3. 运行 `pip install -r requirements.txt` 安装依赖
4. 直接使用，无需其他配置

### Windows 常见问题

**Q: Windows 上 `python` 命令找不到？**
A: 安装 Python 时确保勾选了 "Add Python to PATH"。或使用 `py` 启动器：`py lynse.py getCurrentCustomer`

**Q: 没有 PowerShell 怎么安装？**
A: 直接手动复制文件到 `~/.claude/skills/lynse-cli/` 目录，创建 `.env` 配置文件，运行 `pip install requests` 即可。

**Q: 可以用 Git Bash 吗？**
A: 可以但不需要。Python 版本不需要 bash。`python lynse.py` 在 CMD、PowerShell、Git Bash 中都能工作。

### 各环境安装路径

| 环境 | Skills 目录 |
|------|------------|
| OpenClaw | `~/.openclaw/workspace/skills/` |
| Claude Code | `~/.claude/skills/` |
| Cursor | `~/.cursor/skills/` |
| Hermes | `~/.hermes/skills/` |

---

## 文件结构

```
lynse-cli/
├── SKILL.md              # 本文档
├── lynse.py              # 核心 API 封装模块
├── lynse_cli.py          # CLI 命令入口
├── requirements.txt      # Python 依赖
├── install.sh            # macOS/Linux 安装脚本
├── install.ps1           # Windows 安装脚本
├── .env                  # 配置文件
├── lynse_unified.sh      # Shell CLI（向后兼容）
├── api_wrapper.sh        # Shell API 包装器（向后兼容）
├── lynse.bat             # Windows .bat 包装器（向后兼容）
└── customer/
├── file/
└── admin/
```

## 更新日志

### v1.3.0 (2026-04-17)
- ✅ 新增 Python 跨平台支持（Windows/macOS/Linux）
- ✅ 新增 `lynse.py` 核心 API 封装模块
- ✅ 新增 `lynse_cli.py` 统一命令入口
- ✅ 新增 `install.ps1` Windows 安装脚本
- ✅ 保留原有 Bash 脚本向后兼容
- ✅ 改进错误处理和 Token 管理

### v1.2.1
- 支持 API 服务器地址自动提取
