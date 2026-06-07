#!/bin/bash

# Lynse Unified CLI - 同时支持 lynse-cli-a 和 lynse-cli-b
# 自动检测并调用合适的客户端版本

# 获取当前脚本所在目录，确保相对路径正确
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# 配置路径（使用相对路径）
CLI_A_PATH="$SCRIPT_DIR/lynse-cli-a/client.sh"
CLI_B_PATH="$SCRIPT_DIR/lynse-cli-b/client.sh"

# 版本检测函数
check_cli_version() {
    if [[ -x "$CLI_B_PATH" ]]; then
        echo "b"
        return 0
    elif [[ -x "$CLI_A_PATH" ]]; then
        echo "a"
        return 0
    else
        echo "error" >&2
        return 1
    fi
}

# 自动路由函数
route_command() {
    local version=$1
    shift
    local command=$1
    shift

    case "$version" in
        "b")
            # 优先使用功能更完整的CLI B
            "$CLI_B_PATH" "$command" "$@"
            ;;
        "a")
            # CLI A 仅处理基础命令
            case "$command" in
                bind|exchangeToken|generateApiKey|isLogin|login|logout|refreshToken|register|render|revokeApiKey|terminate|updatePhone|updatePwd|verifyWechatSignature|getPoolStatus|smsCode)
                    "$CLI_A_PATH" "$command" "$@"
                    ;;
                *)
                    echo "Error: 命令 '$command' 在CLI A中不支持，请升级到CLI B" >&2
                    return 1
                    ;;
            esac
            ;;
    esac
}

# 主程序
main() {
    local version=$(check_cli_version)
    if [[ "$version" == "error" ]]; then
        echo "Error: 未找到可执行的Lynse CLI客户端" >&2
        exit 1
    fi

    if [[ $# -eq 0 ]]; then
        echo "Lynse Unified CLI (v$version)" >&2
        echo "使用方法: $0 <command> [参数...]" >&2
        exit 1
    fi

    local command=$1
    shift
    route_command "$version" "$command" "$@"
}

# 执行主程序
main "$@"