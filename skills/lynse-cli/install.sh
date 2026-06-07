#!/bin/bash

# Lynse CLI Auto-Install Script
# 自动检测环境并安装到正确的 skills 目录

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
SKILL_NAME="lynse-cli"

# 检查是否从命令行传入了 API 服务器地址
API_HOST_ARG=""
for arg in "$@"; do
    case "$arg" in
        --api-host=*)
            API_HOST_ARG="${arg#*=}"
            ;;
    esac
done

# 如果没有命令行参数，尝试从环境变量读取
if [ -z "$API_HOST_ARG" ]; then
    API_HOST_ARG="${LYNSE_API_HOST_FROM_PROMPT:-}"
fi

# 如果还没有，尝试从标准输入读取（支持管道传入）
if [ -z "$API_HOST_ARG" ] && [ ! -t 0 ]; then
    # 读取所有输入到变量
    INPUT_CONTENT=$(cat)
    # 匹配包含 API 服务器地址的行（支持中英文多种格式）
    # 支持："API 服务器地址"、"API Server"、"服务器地址"、"api server"等
    API_LINE=$(echo "$INPUT_CONTENT" | grep -iE "(API 服务器地址|API Server|服务器地址|api server)" || true)
    if [ -n "$API_LINE" ]; then
        # 从该行提取 URL（支持 http/https，支持路径）
        API_HOST_ARG=$(echo "$API_LINE" | grep -oE "https?://[^[:space:]\"']+" | head -1 || true)
        if [ -n "$API_HOST_ARG" ]; then
            echo -e "${BLUE}[INFO]${NC} 从输入中提取 API 服务器地址：$API_HOST_ARG" >&2
        fi
    fi
fi

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1" >&2
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" >&2
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

# 检测环境函数
detect_environment() {
    local target_dir=""
    local env_name=""

    # 检测 OpenClaw
    if [ -d "$HOME/.openclaw/workspace" ]; then
        target_dir="$HOME/.openclaw/workspace/skills/$SKILL_NAME"
        env_name="OpenClaw"
        log_info "检测到 OpenClaw 环境"
    fi

    # 检测 Claude Code
    if [ -d "$HOME/.claude" ]; then
        if [ -z "$target_dir" ]; then
            target_dir="$HOME/.claude/skills/$SKILL_NAME"
            env_name="Claude Code"
            log_info "检测到 Claude Code 环境"
        fi
    fi

    # 检测 Cursor
    if [ -d "$HOME/.cursor" ]; then
        if [ -z "$target_dir" ]; then
            target_dir="$HOME/.cursor/skills/$SKILL_NAME"
            env_name="Cursor"
            log_info "检测到 Cursor 环境"
        fi
    fi

    # 检测 Hermes (常见路径)
    if [ -d "$HOME/.hermes" ]; then
        if [ -z "$target_dir" ]; then
            target_dir="$HOME/.hermes/skills/$SKILL_NAME"
            env_name="Hermes"
            log_info "检测到 Hermes 环境"
        fi
    fi

    # 如果没有检测到任何环境，提示用户手动指定
    if [ -z "$target_dir" ]; then
        log_error "未检测到支持的 AI 助手环境"
        echo ""
        echo "支持的环境："
        echo "  - OpenClaw: ~/.openclaw/workspace/skills/"
        echo "  - Claude Code: ~/.claude/skills/"
        echo "  - Cursor: ~/.cursor/skills/"
        echo "  - Hermes: ~/.hermes/skills/"
        echo ""
        read -p "请输入目标 skills 目录路径：" target_dir
        if [ -z "$target_dir" ]; then
            log_error "未提供路径，安装取消"
            exit 1
        fi
        env_name="Manual"
    fi

    echo "$target_dir"
}

# 安装函数
install_skill() {
    local target_dir="$1"

    log_info "开始安装到：$target_dir"

    # 创建目录
    mkdir -p "$target_dir"

    # 复制技能文件
    log_info "复制技能文件..."
    cp -r "$SCRIPT_DIR"/* "$target_dir/" 2>/dev/null || true

    # 创建 .env 配置文件（如果不存在）
    if [ ! -f "$target_dir/.env" ]; then
        log_info "创建 .env 配置文件..."
        if [ -f "$target_dir/.env.example" ]; then
            cp "$target_dir/.env.example" "$target_dir/.env"
            # 如果传入了 API 服务器地址，写入 .env
            if [ -n "$API_HOST_ARG" ]; then
                echo "LYNSE_API_HOST=$API_HOST_ARG" >> "$target_dir/.env"
                log_info "已设置 API 服务器地址：$API_HOST_ARG"
            fi
        else
            # 使用传入的 API 服务器地址，否则使用占位符
            local api_host_value="${API_HOST_ARG:-https://your-api-host/api}"
            cat > "$target_dir/.env" << EOF
# Lynse CLI Configuration

# API 服务器地址
LYNSE_API_HOST=$api_host_value

# API Key（从系统控制台获取）
LYNSE_API_KEY=dk_your_api_key_here

# [可选] 限定只有此用户 ID 可操作
# LYNSE_OWNER_ID=2008741550857883650
EOF
        fi
        log_warn "请编辑 .env 文件并填入你的 LYNSE_API_KEY"
    fi

    # 设置执行权限
    log_info "设置执行权限..."
    chmod +x "$target_dir"/*.sh 2>/dev/null || true
    chmod 600 "$target_dir/.env" 2>/dev/null || true

    log_success "安装完成！"
    echo ""
    echo "==================================="
    echo "  Lynse CLI 安装成功"
    echo "==================================="
    echo ""
    echo "下一步："
    echo "  1. 编辑 $target_dir/.env"
    echo "  2. 填入你的 LYNSE_API_KEY"
    echo "  3. 在 AI 助手中使用 lynse-cli 技能"
    echo ""
    echo "使用方法："
    echo "  - 查询用户信息：getCurrentCustomer"
    echo "  - 查询文件列表：listFiles"
    echo "  - 获取文件总结：getConclusion <fileId>"
    echo ""
    echo "文档：$target_dir/README.md"
    echo "==================================="
}

# 主程序
main() {
    echo "==================================="
    echo "  Lynse CLI 自动安装脚本"
    echo "==================================="
    echo ""

    local target_dir=$(detect_environment)
    install_skill "$target_dir"
}

main "$@"
