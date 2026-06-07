#!/bin/bash

# 获取当前脚本所在的绝对目录，保证能在任何地方被 OpenClaw 准确调用
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# 1. 基础配置（从环境变量或配置文件读取，不再硬编码敏感信息）
CONFIG_FILE="${LYNSE_CONFIG_FILE:-$DIR/.env}"

# 加载配置文件（如果存在）
if [ -f "$CONFIG_FILE" ]; then
    # 安全地逐行读取，只处理 KEY=VALUE 格式，忽略注释和空行
    while IFS='=' read -r key value; do
        # 跳过注释和空行
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$key" ]] && continue
        # 去除前后空白
        key=$(echo "$key" | xargs)
        value=$(echo "$value" | xargs)
        # 只允许已知配置项
        case "$key" in
            LYNSE_API_HOST|LYNSE_API_KEY|LYNSE_OWNER_ID) export "$key"="$value" ;;
        esac
    done < "$CONFIG_FILE"
fi

# 从环境变量读取，未设置时给出明确提示
API_HOST="${LYNSE_API_HOST:?错误：未设置 LYNSE_API_HOST 环境变量。请在 .env 文件中配置 API 服务器地址}"
API_KEY="${LYNSE_API_KEY:?错误：未设置 LYNSE_API_KEY 环境变量。请在 .env 文件中配置 API Key}"

# Token 缓存文件路径（使用安全权限）
TOKEN_FILE="${LYNSE_TOKEN_FILE:-$DIR/.token_cache}"

# 2. 自动路由到统一CLI，并传递API_HOST参数
"$DIR/lynse_unified.sh" --host "$API_HOST" "$@"

# 保留原API接口作为备用
# 3. 接收大模型传来的参数
ACTION=$1
shift
# 安全处理参数：防止注入，对参数进行基本转义
PARAMS=""
for param in "$@"; do
    # 移除潜在的命令注入字符
    sanitized=$(echo "$param" | sed 's/[;$`]//g; s/\.\.//g')
    PARAMS="$PARAMS $sanitized"
done
PARAMS=$(echo "$PARAMS" | xargs)

# 安全函数：验证Token格式（JWT基本格式检查）
validate_token() {
    local token="$1"
    # JWT格式：三段base64由.连接
    if [[ "$token" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
        return 0
    fi
    return 1
}

# 尝试从缓存获取Token或刷新
if [ -f "$TOKEN_FILE" ]; then
    # 检查文件权限，确保只有文件所有者可读写
    chmod 600 "$TOKEN_FILE" 2>/dev/null
    API_TOKEN=$(cat "$TOKEN_FILE")
    if validate_token "$API_TOKEN"; then
        # 验证Token是否有效
        VALID_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$API_HOST/api/business/customer/current" -H "Authorization: $API_TOKEN" -H "X-API-Key: $API_KEY")
        if [ "$VALID_RESPONSE" -eq 200 ]; then
            TOKEN="$API_TOKEN"
        else
            # 缓存Token无效，重新获取
            API_TOKEN=$(curl -s -X POST "$API_HOST/api/auth/apikey/token" -H "X-API-Key: $API_KEY" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
            if [ "$API_TOKEN" != "null" ] && [ -n "$API_TOKEN" ] && validate_token "$API_TOKEN"; then
                echo "$API_TOKEN" > "$TOKEN_FILE"
                chmod 600 "$TOKEN_FILE" 2>/dev/null
                TOKEN="$API_TOKEN"
            else
                echo "API Key认证失败，请检查 LYNSE_API_KEY 是否正确" >&2
                exit 1
            fi
        fi
    else
        # 缓存Token格式无效，清除并重新获取
        rm -f "$TOKEN_FILE"
        API_TOKEN=$(curl -s -X POST "$API_HOST/api/auth/apikey/token" -H "X-API-Key: $API_KEY" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
        if [ "$API_TOKEN" != "null" ] && [ -n "$API_TOKEN" ] && validate_token "$API_TOKEN"; then
            echo "$API_TOKEN" > "$TOKEN_FILE"
            chmod 600 "$TOKEN_FILE" 2>/dev/null
            TOKEN="$API_TOKEN"
        else
            echo "API Key认证失败，请检查 LYNSE_API_KEY 是否正确" >&2
            exit 1
        fi
    fi
else
    # 无缓存，首次获取Token
    API_TOKEN=$(curl -s -X POST "$API_HOST/api/auth/apikey/token" -H "X-API-Key: $API_KEY" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
    if [ "$API_TOKEN" != "null" ] && [ -n "$API_TOKEN" ] && validate_token "$API_TOKEN"; then
        # 确保缓存目录存在且权限正确
        mkdir -p "$(dirname "$TOKEN_FILE")" 2>/dev/null
        echo "$API_TOKEN" > "$TOKEN_FILE"
        chmod 600 "$TOKEN_FILE" 2>/dev/null
        TOKEN="$API_TOKEN"
    else
        echo "API Key认证失败，请检查 LYNSE_API_KEY 是否正确" >&2
        exit 1
    fi
fi

# Owner 权限检查：若配置了 LYNSE_OWNER_ID，验证当前用户是否匹配
if [ -n "$LYNSE_OWNER_ID" ]; then
    CURRENT_USER_ID=$(curl -s -X GET "$API_HOST/api/business/customer/current" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$CURRENT_USER_ID" ] && [ "$CURRENT_USER_ID" != "$LYNSE_OWNER_ID" ]; then
        echo "抱歉，这是私密账户，我无法操作" >&2
        exit 1
    fi
fi

# 安全函数：转义参数中的特殊字符，防止HTTP头注入
sanitize_header_value() {
    echo "$1" | tr -d '\r\n' | sed 's/"/\\"/g'
}

# 安全函数：构建JSON body，防止注入
safe_json_string() {
    echo "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr -d '\n\r'
}

# 错误处理函数：检查 HTTP 响应状态码
check_http_error() {
    local http_code="$1"
    local response="$2"
    case "$http_code" in
        200) return 0 ;;
        401) echo "错误：Token 已过期，正在自动刷新..." >&2; return 401 ;;
        403) echo "错误：您的账户权限不足，请联系管理员升级权限" >&2; return 403 ;;
        404) echo "错误：请求的资源不存在" >&2; return 404 ;;
        429) echo "错误：请求过于频繁，请等待 60 秒后重试" >&2; return 429 ;;
        500|502|503) echo "错误：服务器暂时不可用，请稍后重试" >&2; return 503 ;;
        *)
            if [ "$http_code" != "200" ]; then
                echo "错误：API 请求失败 (HTTP $http_code)" >&2
                [ -n "$response" ] && echo "详细信息：$response" >&2
                return "$http_code"
            fi
            ;;
    esac
}

# 敏感信息脱敏函数：手机号脱敏
mask_phone() {
    local phone="$1"
    if [ ${#phone} -ge 11 ]; then
        echo "${phone:0:3}****${phone:7:4}"
    else
        echo "$phone"
    fi
}

# 3. 语义化路由
case $ACTION in
    # 常用接口
    "getCurrentCustomer")
        curl -s -X GET "$API_HOST/api/business/customer/current" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;
    "getUserInfo")
        SAFE_ID=$(sanitize_header_value "$1")
        curl -s -X GET "$API_HOST/api/business/sysUser/info" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "id:$SAFE_ID"
        ;;
    "getDevicePage")
        SAFE_PAGE=$(echo "$1" | tr -cd '0-9')
        curl -s -X GET "$API_HOST/api/business/deviceMgt/page9" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "pageNum:$SAFE_PAGE" -H "pageSize:10"
        ;;
    "getAiModels")
        curl -s -X GET "$API_HOST/api/business/ai/getAllAIModelList" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;
    "getUserPoints")
        RESPONSE=$(curl -s -X GET "$API_HOST/api/business/customer/current" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY")
        POINTS=$(echo "$RESPONSE" | grep -o '"pointsAmount":[0-9]*' | cut -d: -f2)
        USED_POINTS=$(echo "$RESPONSE" | grep -o '"usedPointsAmount":[0-9]*' | cut -d: -f2)
        POINTS="${POINTS:-0}"
        USED_POINTS="${USED_POINTS:-0}"
        echo "当前积分: $POINTS"
        echo "已使用积分: $USED_POINTS"
        ;;
    "getUserPhone")
        RESPONSE=$(curl -s -X GET "$API_HOST/api/business/customer/current" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY")
        echo "$RESPONSE" | grep -o '"phone":"[0-9*]*"' | cut -d: -f2 | tr -d '"'
        ;;

    # 文件管理接口
    "listFiles")
        curl -s -X GET "$API_HOST/api/business/file/list" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;
    "getFileInfo")
        SAFE_ID=$(echo "$1" | tr -cd '0-9')
        curl -s -X GET "$API_HOST/api/business/file/info?fileId=$SAFE_ID" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;
    "getConclusion")
        SAFE_ID=$(echo "$1" | tr -cd '0-9')
        curl -s -X GET "$API_HOST/api/business/file/conclusion/list?fileId=$SAFE_ID" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;
    "getConclusionList")
        SAFE_ID=$(echo "$1" | tr -cd '0-9')
        curl -s -X GET "$API_HOST/api/business/file/conclusion/list?fileId=$SAFE_ID" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;
    "getOutline")
        SAFE_ID=$(echo "$1" | tr -cd '0-9')
        curl -s -X GET "$API_HOST/api/business/file/outline/get?fileId=$SAFE_ID" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;
    "exportOutline")
        SAFE_ID=$(echo "$1" | tr -cd '0-9')
        curl -s -X GET "$API_HOST/api/business/file/outline/export?fileId=$SAFE_ID" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;
    "listFilesByTimeRange")
        if [ -n "$1" ]; then
            SAFE_DAYS=$(echo "$1" | tr -cd '0-9')
            startTime=$(date -d "$SAFE_DAYS ago" +'%Y-%m-%dT%H:%M:%S')
        else
            startTime=$(date -d '7 days ago' +'%Y-%m-%dT%H:%M:%S')
        fi
        endTime=$(date +'%Y-%m-%dT%H:%M:%S')
        curl -s -X GET "$API_HOST/api/business/file/timeRange/list?startTime=$startTime&endTime=$endTime" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;
    "getTranscriptionRecord")
        SAFE_ID=$(echo "$1" | tr -cd '0-9')
        curl -s -X GET "$API_HOST/api/business/file/trans/get?fileId=$SAFE_ID" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;

    # AI模型管理（接受JSON body的接口，使用文件传递而非命令行拼接）
    "addModel")
        echo "$PARAMS" | curl -s -X POST "$API_HOST/api/business/ai/addModel" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d @-
        ;;
    "deleteModel")
        SAFE_ID=$(sanitize_header_value "$1")
        curl -s -X DELETE "$API_HOST/api/business/ai/deleteModel" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "id:$SAFE_ID"
        ;;
    "editModel")
        echo "$PARAMS" | curl -s -X POST "$API_HOST/api/business/ai/editModel" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d @-
        ;;
    "enableModel")
        SAFE_ID=$(sanitize_header_value "$1")
        SAFE_ENABLED=$(echo "$2" | tr -cd 'a-zA-Z')
        curl -s -X POST "$API_HOST/api/business/ai/enableModel" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "id:$SAFE_ID" -H "enabled:$SAFE_ENABLED"
        ;;

    # 设备管理
    "getDeviceInfo")
        SAFE_ID=$(sanitize_header_value "$1")
        curl -s -X GET "$API_HOST/api/business/deviceMgt/info5" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "id:$SAFE_ID"
        ;;
    "unbindDevice")
        SAFE_ID=$(sanitize_header_value "$1")
        curl -s -X POST "$API_HOST/api/business/deviceMgt/unbind" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "id:$SAFE_ID"
        ;;

    # 用户管理（使用stdin传递JSON body）
    "getCurrentUser")
        curl -s -X GET "$API_HOST/api/business/sysUser/current" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;
    "addUser")
        echo "$PARAMS" | curl -s -X POST "$API_HOST/api/business/sysUser/add2" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d @-
        ;;
    "editUser")
        echo "$PARAMS" | curl -s -X POST "$API_HOST/api/business/sysUser/edit1" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d @-
        ;;
    "removeUser")
        SAFE_ID=$(sanitize_header_value "$1")
        curl -s -X POST "$API_HOST/api/business/sysUser/remove" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "id:$SAFE_ID"
        ;;

    # 登录相关
    "login")
        SAFE_USER=$(safe_json_string "$1")
        SAFE_PASS=$(safe_json_string "$2")
        curl -s -X POST "$API_HOST/api/business/sysLogin/login" -H "Content-Type: application/json" -d "{\"username\":\"$SAFE_USER\",\"password\":\"$SAFE_PASS\"}"
        ;;
    "loginWithPhone")
        SAFE_PHONE=$(safe_json_string "$1")
        SAFE_CODE=$(safe_json_string "$2")
        curl -s -X POST "$API_HOST/api/business/sysLogin/login" -H "Content-Type: application/json" -d "{\"phone\":\"$SAFE_PHONE\",\"captcha\":\"$SAFE_CODE\"}"
        ;;
    "logout")
        curl -s -X POST "$API_HOST/api/business/sysLogin/logout" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;

    # 消息管理（使用stdin传递JSON body）
    "sendSms")
        echo "$PARAMS" | curl -s -X POST "$API_HOST/api/business/message/sendSmsMessage" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d @-
        ;;
    "sendEmail")
        echo "$PARAMS" | curl -s -X POST "$API_HOST/api/business/message/sendEmailMessage" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d @-
        ;;

    # 系统管理
    "getRoleList")
        curl -s -X GET "$API_HOST/api/business/sysRole/list1" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;
    "getMenuTree")
        curl -s -X GET "$API_HOST/api/business/sysMenu/tree" -H "Authorization: $TOKEN" -H "X-API-Key: $API_KEY"
        ;;

    # 默认情况
    *)
        echo "Error: 不支持的 Action $ACTION。" >&2
        echo "支持的操作包括: getCurrentCustomer, getUserInfo, getDevicePage, getAiModels, getUserPoints, getUserPhone, listFiles, getFileInfo, getConclusion, getConclusionList, getOutline, exportOutline, getTranscriptionRecord, addModel, deleteModel, editModel, enableModel, getDeviceInfo, unbindDevice, getCurrentUser, addUser, editUser, removeUser, login, loginWithPhone, logout, sendSms, sendEmail, getRoleList, getMenuTree" >&2
        exit 1
        ;;
esac
