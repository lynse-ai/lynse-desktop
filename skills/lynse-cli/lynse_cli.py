#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Lynse Unified CLI - 统一命令入口
同时支持 lynse-cli-a 和 lynse-cli-b 功能

用法：
    python lynse_cli.py <command> [参数...]

示例：
    python lynse_cli.py getCurrentCustomer
    python lynse_cli.py login username password
"""

import os
import sys
import json
from pathlib import Path

# 导入核心 API 模块
from lynse import LynseAPI, LynseAPIError


class LynseUnifiedCLI:
    """Lynse 统一 CLI - 路由到合适的处理逻辑"""

    def __init__(self):
        self.script_dir = Path(__file__).parent.resolve()
        self.api: LynseAPI = None

        # CLI 版本检测
        self.cli_a_path = self.script_dir / 'lynse-cli-a' / 'client.sh'
        self.cli_b_path = self.script_dir / 'lynse-cli-b' / 'client.sh'

    def _check_cli_version(self) -> str:
        """检测可用的 CLI 版本"""
        if self.cli_b_path.exists() and os.access(self.cli_b_path, os.X_OK):
            return 'b'
        elif self.cli_a_path.exists() and os.access(self.cli_a_path, os.X_OK):
            return 'a'
        else:
            return 'none'

    def _init_api(self):
        """初始化 API 客户端"""
        if self.api is None:
            self.api = LynseAPI()

    def _run_cli_a(self, command: str, args: list) -> int:
        """运行 CLI A（基础版）"""
        # CLI A 仅支持基础认证命令
        supported_commands = {
            'bind', 'exchangeToken', 'generateApiKey', 'isLogin',
            'login', 'logout', 'refreshToken', 'register', 'render',
            'revokeApiKey', 'terminate', 'updatePhone', 'updatePwd',
            'verifyWechatSignature', 'getPoolStatus', 'smsCode'
        }

        if command not in supported_commands:
            print(f"错误：命令 '{command}' 在 CLI A 中不支持，请升级到 CLI B", file=sys.stderr)
            return 1

        # 调用 shell 脚本
        import subprocess
        cmd_args = [str(self.cli_a_path), command] + args
        try:
            result = subprocess.run(cmd_args, cwd=str(self.script_dir))
            return result.returncode
        except Exception as e:
            print(f"错误：执行 CLI A 失败 - {e}", file=sys.stderr)
            return 1

    def _run_cli_b(self, command: str, args: list) -> int:
        """运行 CLI B（完整版）"""
        import subprocess
        cmd_args = [str(self.cli_b_path), command] + args
        try:
            result = subprocess.run(cmd_args, cwd=str(self.script_dir))
            return result.returncode
        except Exception as e:
            print(f"错误：执行 CLI B 失败 - {e}", file=sys.stderr)
            return 1

    def _handle_python_command(self, command: str, args: list) -> int:
        """使用 Python API 处理命令"""
        try:
            self._init_api()

            if command == 'getCurrentCustomer':
                result = self.api.get_current_customer()
            elif command == 'getUserInfo':
                if len(args) < 1:
                    print("错误：getUserInfo 需要用户 ID 参数", file=sys.stderr)
                    return 1
                result = self.api.get_user_info(args[0])
            elif command == 'getUserPoints':
                points = self.api.get_user_points()
                print(f"当前积分：{points['pointsAmount']}")
                print(f"已使用积分：{points['usedPointsAmount']}")
                return 0
            elif command == 'getUserPhone':
                phone = self.api.get_user_phone()
                print(phone)
                return 0
            elif command == 'listFiles':
                result = self.api.list_files()
            elif command == 'getFileInfo':
                if len(args) < 1:
                    print("错误：getFileInfo 需要文件 ID 参数", file=sys.stderr)
                    return 1
                result = self.api.get_file_info(args[0])
            elif command == 'getConclusion' or command == 'getConclusionList':
                if len(args) < 1:
                    print("错误：getConclusion 需要文件 ID 参数", file=sys.stderr)
                    return 1
                result = self.api.get_conclusion(args[0])
            elif command == 'getOutline':
                if len(args) < 1:
                    print("错误：getOutline 需要文件 ID 参数", file=sys.stderr)
                    return 1
                result = self.api.get_outline(args[0])
            elif command == 'exportOutline':
                if len(args) < 1:
                    print("错误：exportOutline 需要文件 ID 参数", file=sys.stderr)
                    return 1
                result = self.api.export_outline(args[0])
            elif command == 'listFilesByTimeRange':
                days = int(args[0]) if args else 7
                result = self.api.list_files_by_time_range(days)
            elif command == 'getTranscriptionRecord':
                if len(args) < 1:
                    print("错误：getTranscriptionRecord 需要文件 ID 参数", file=sys.stderr)
                    return 1
                result = self.api.get_transcription_record(args[0])
            elif command == 'getAiModels':
                result = self.api.get_ai_models()
            elif command == 'addModel':
                if len(args) < 1:
                    print("错误：addModel 需要 JSON 数据参数", file=sys.stderr)
                    return 1
                model_data = json.loads(args[0])
                result = self.api.add_model(model_data)
            elif command == 'deleteModel':
                if len(args) < 1:
                    print("错误：deleteModel 需要模型 ID 参数", file=sys.stderr)
                    return 1
                result = self.api.delete_model(args[0])
            elif command == 'editModel':
                if len(args) < 1:
                    print("错误：editModel 需要 JSON 数据参数", file=sys.stderr)
                    return 1
                model_data = json.loads(args[0])
                result = self.api.edit_model(model_data)
            elif command == 'enableModel':
                if len(args) < 2:
                    print("错误：enableModel 需要模型 ID 和 enabled 参数", file=sys.stderr)
                    return 1
                enabled = args[1].lower() in ('true', '1', 'yes')
                result = self.api.enable_model(args[0], enabled)
            elif command == 'getDevicePage':
                page = int(args[0]) if args else 1
                result = self.api.get_device_page(page)
            elif command == 'getDeviceInfo':
                if len(args) < 1:
                    print("错误：getDeviceInfo 需要设备 ID 参数", file=sys.stderr)
                    return 1
                result = self.api.get_device_info(args[0])
            elif command == 'unbindDevice':
                if len(args) < 1:
                    print("错误：unbindDevice 需要设备 ID 参数", file=sys.stderr)
                    return 1
                result = self.api.unbind_device(args[0])
            elif command == 'getCurrentUser':
                result = self.api.get_current_user()
            elif command == 'addUser':
                if len(args) < 1:
                    print("错误：addUser 需要 JSON 数据参数", file=sys.stderr)
                    return 1
                user_data = json.loads(args[0])
                result = self.api.add_user(user_data)
            elif command == 'editUser':
                if len(args) < 1:
                    print("错误：editUser 需要 JSON 数据参数", file=sys.stderr)
                    return 1
                user_data = json.loads(args[0])
                result = self.api.edit_user(user_data)
            elif command == 'removeUser':
                if len(args) < 1:
                    print("错误：removeUser 需要用户 ID 参数", file=sys.stderr)
                    return 1
                result = self.api.remove_user(args[0])
            elif command == 'login':
                if len(args) < 2:
                    print("错误：login 需要用户名和密码参数", file=sys.stderr)
                    return 1
                result = self.api.login(args[0], args[1])
            elif command == 'loginWithPhone':
                if len(args) < 2:
                    print("错误：loginWithPhone 需要手机号和验证码参数", file=sys.stderr)
                    return 1
                result = self.api.login_with_phone(args[0], args[1])
            elif command == 'logout':
                result = self.api.logout()
            elif command == 'sendSms':
                if len(args) < 1:
                    print("错误：sendSms 需要 JSON 数据参数", file=sys.stderr)
                    return 1
                msg_data = json.loads(args[0])
                result = self.api.send_sms(msg_data)
            elif command == 'sendEmail':
                if len(args) < 1:
                    print("错误：sendEmail 需要 JSON 数据参数", file=sys.stderr)
                    return 1
                email_data = json.loads(args[0])
                result = self.api.send_email(email_data)
            elif command == 'getRoleList':
                result = self.api.get_role_list()
            elif command == 'getMenuTree':
                result = self.api.get_menu_tree()
            else:
                print(f"错误：不支持的命令 '{command}'", file=sys.stderr)
                return 1

            # 输出结果
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0

        except LynseAPIError as e:
            print(f"错误：{e.message}", file=sys.stderr)
            return e.http_code or e.code or 1
        except json.JSONDecodeError as e:
            print(f"错误：JSON 格式错误 - {e}", file=sys.stderr)
            return 1
        except Exception as e:
            print(f"错误：{e}", file=sys.stderr)
            return 1

    def run(self, args: list) -> int:
        """
        运行 CLI

        Args:
            args: 命令行参数（不包含脚本名）

        Returns:
            退出码
        """
        if len(args) < 1:
            version = self._check_cli_version()
            print(f"Lynse Unified CLI (v{version})")
            print("用法：python lynse_cli.py <command> [参数...]")
            print("\n常用命令:")
            print("  getCurrentCustomer          - 当前用户信息")
            print("  getUserPoints               - 当前用户积分")
            print("  listFiles                   - 文件列表")
            print("  getAiModels                 - AI 模型列表")
            print("  getDevicePage [页码]        - 设备列表")
            return 1

        command = args[0]
        cmd_args = args[1:]

        # 检测 CLI 版本
        version = self._check_cli_version()

        if version == 'none':
            # 没有 shell CLI，使用 Python 实现
            return self._handle_python_command(command, cmd_args)

        # 优先使用 Python API 处理业务命令（跨平台）
        python_commands = {
            'getCurrentCustomer', 'getUserInfo', 'getUserPoints', 'getUserPhone',
            'listFiles', 'getFileInfo', 'getConclusion', 'getConclusionList',
            'getOutline', 'exportOutline', 'listFilesByTimeRange', 'getTranscriptionRecord',
            'getAiModels', 'addModel', 'deleteModel', 'editModel', 'enableModel',
            'getDevicePage', 'getDeviceInfo', 'unbindDevice',
            'getCurrentUser', 'addUser', 'editUser', 'removeUser',
            'login', 'loginWithPhone', 'logout', 'sendSms', 'sendEmail',
            'getRoleList', 'getMenuTree'
        }

        if command in python_commands:
            return self._handle_python_command(command, cmd_args)

        # 其他命令路由到 shell CLI
        if version == 'b':
            return self._run_cli_b(command, cmd_args)
        else:
            return self._run_cli_a(command, cmd_args)


def main():
    """CLI 入口"""
    cli = LynseUnifiedCLI()
    sys.exit(cli.run(sys.argv[1:]))


if __name__ == '__main__':
    main()
