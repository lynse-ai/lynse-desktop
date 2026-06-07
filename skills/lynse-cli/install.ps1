# Lynse CLI Auto-Install Script (Windows PowerShell)
# 自动检测环境并安装到正确的 skills 目录

param(
    [string]$ApiHost = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillName = "lynse-cli"

# 颜色输出函数
function Write-Info { Write-Host "[INFO] $args" -ForegroundColor Blue }
function Write-Success { Write-Host "[SUCCESS] $args" -ForegroundColor Green }
function Write-Warn { Write-Host "[WARN] $args" -ForegroundColor Yellow }
function Write-Error { Write-Host "[ERROR] $args" -ForegroundColor Red }

# 检测 Python 环境
function Check-Python {
    # 尝试 python 命令
    try {
        $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
        if ($pythonCmd) {
            $version = python --version 2>&1
            if ($version -match "Python 3\.(\d+)") {
                $minor = [int]$matches[1]
                if ($minor -ge 8) {
                    $script:PythonCmd = "python"
                    Write-Info "检测到 Python: $version"
                    return
                }
            }
        }
    } catch {}

    # 尝试 python3 命令
    try {
        $pythonCmd = Get-Command python3 -ErrorAction SilentlyContinue
        if ($pythonCmd) {
            $version = python3 --version 2>&1
            if ($version -match "Python 3\.(\d+)") {
                $minor = [int]$matches[1]
                if ($minor -ge 8) {
                    $script:PythonCmd = "python3"
                    Write-Info "检测到 Python: $version"
                    return
                }
            }
        }
    } catch {}

    # 检查 py launcher
    try {
        $pyCmd = Get-Command py -ErrorAction SilentlyContinue
        if ($pyCmd) {
            $version = py -3 --version 2>&1
            if ($version -match "Python 3\.(\d+)") {
                $minor = [int]$matches[1]
                if ($minor -ge 8) {
                    $script:PythonCmd = "py -3"
                    Write-Info "检测到 Python: $version"
                    return
                }
            }
        }
    } catch {}

    Write-Error "未找到 Python 或版本过低 (需要 Python 3.8+)"
    Write-Host ""
    Write-Host "请安装 Python 3.8+: https://www.python.org/downloads/"
    Write-Host "安装时请勾选 'Add Python to PATH'"
    exit 1
}

# 安装 Python 依赖
function Install-Dependencies {
    Write-Info "安装 Python 依赖..."

    $requirementsPath = Join-Path $ScriptDir "requirements.txt"
    if (Test-Path $requirementsPath) {
        & $script:PythonCmd -m pip install -q -r $requirementsPath
        Write-Success "依赖安装完成"
    }
}

# 检测环境
function Detect-Environment {
    $targetDir = ""
    $envName = ""

    # 检测 OpenClaw
    $openClawPath = Join-Path $HOME ".openclaw\workspace\skills\$SkillName"
    if (Test-Path (Join-Path $HOME ".openclaw\workspace")) {
        $targetDir = $openClawPath
        $envName = "OpenClaw"
        Write-Info "检测到 OpenClaw 环境"
    }

    # 检测 Claude Code
    $claudePath = Join-Path $HOME ".claude\skills\$SkillName"
    if (Test-Path (Join-Path $HOME ".claude")) {
        if (-not $targetDir) {
            $targetDir = $claudePath
            $envName = "Claude Code"
            Write-Info "检测到 Claude Code 环境"
        }
    }

    # 检测 Cursor
    $cursorPath = Join-Path $HOME ".cursor\skills\$SkillName"
    if (Test-Path (Join-Path $HOME ".cursor")) {
        if (-not $targetDir) {
            $targetDir = $cursorPath
            $envName = "Cursor"
            Write-Info "检测到 Cursor 环境"
        }
    }

    # 检测 Hermes
    $hermesPath = Join-Path $HOME ".hermes\skills\$SkillName"
    if (Test-Path (Join-Path $HOME ".hermes")) {
        if (-not $targetDir) {
            $targetDir = $hermesPath
            $envName = "Hermes"
            Write-Info "检测到 Hermes 环境"
        }
    }

    # 如果没有检测到任何环境，提示用户手动指定
    if (-not $targetDir) {
        Write-Error "未检测到支持的 AI 助手环境"
        Write-Host ""
        Write-Host "支持的环境："
        Write-Host "  - OpenClaw: $HOME\.openclaw\workspace\skills\"
        Write-Host "  - Claude Code: $HOME\.claude\skills\"
        Write-Host "  - Cursor: $HOME\.cursor\skills\"
        Write-Host "  - Hermes: $HOME\.hermes\skills\""
        Write-Host ""

        $targetDir = Read-Host "请输入目标 skills 目录路径 (或按回车取消)"
        if (-not $targetDir) {
            Write-Error "未提供路径，安装取消"
            exit 1
        }
        $envName = "Manual"
    }

    return $targetDir
}

# 安装技能
function Install-Skill {
    param($targetDir)

    Write-Info "开始安装到：$targetDir"

    # 创建目录
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

    # 复制技能文件
    Write-Info "复制技能文件..."
    Get-ChildItem -Path $ScriptDir -Exclude "*.ps1" | Copy-Item -Destination $targetDir -Recurse -Force

    # 创建 .env 配置文件
    $envPath = Join-Path $targetDir ".env"
    if (-not (Test-Path $envPath)) {
        Write-Info "创建 .env 配置文件..."

        $apiHostValue = if ($ApiHost) { $ApiHost } else { "https://your-api-host/api" }

        $envContent = @"
# Lynse CLI Configuration

# API 服务器地址
LYNSE_API_HOST=$apiHostValue

# API Key（从系统控制台获取）
LYNSE_API_KEY=dk_your_api_key_here

# [可选] 限定只有此用户 ID 可操作
# LYNSE_OWNER_ID=2008741550857883650
"@
        Set-Content -Path $envPath -Value $envContent -Encoding UTF8

        if ($ApiHost) {
            Write-Info "已设置 API 服务器地址：$ApiHost"
        }
        Write-Warn "请编辑 .env 文件并填入你的 LYNSE_API_KEY"
    }

    Write-Success "安装完成！"
    Write-Host ""
    Write-Host "==================================="
    Write-Host "  Lynse CLI 安装成功 (Python 版)"
    Write-Host "==================================="
    Write-Host ""
    Write-Host "下一步："
    Write-Host "  1. 编辑 $targetDir\.env"
    Write-Host "  2. 填入你的 LYNSE_API_KEY"
    Write-Host "  3. 在 AI 助手中使用 lynse-cli 技能"
    Write-Host ""
    Write-Host "使用方法 (PowerShell):"
    Write-Host "  python lynse.py getCurrentCustomer    - 当前用户信息"
    Write-Host "  python lynse.py listFiles             - 文件列表"
    Write-Host "  python lynse.py getConclusion <id>    - 文件总结"
    Write-Host ""
    Write-Host "或使用 .bat 包装器 (CMD):"
    Write-Host "  lynse getCurrentCustomer"
    Write-Host ""
    Write-Host "==================================="
}

# 主程序
function Main {
    Write-Host "==================================="
    Write-Host "  Lynse CLI 自动安装脚本 (Windows)"
    Write-Host "==================================="
    Write-Host ""

    Check-Python
    Install-Dependencies

    $targetDir = Detect-Environment
    Install-Skill $targetDir
}

Main
