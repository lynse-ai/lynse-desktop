@echo off
REM =============================================================================
REM Lynse CLI Windows Wrapper (Python-based)
REM =============================================================================
REM 跨平台支持：无需 Git Bash，使用 Python 直接运行
REM
REM 前置要求:
REM   Python 3.8+ (https://www.python.org/downloads/)
REM
REM 使用方法:
REM   lynse getCurrentCustomer
REM   lynse listFiles
REM   lynse getConclusion <fileId>
REM =============================================================================

REM 获取脚本所在目录
set "SCRIPT_DIR=%~dp0"

REM 使用 Python 运行 lynse.py
python "%SCRIPT_DIR%lynse.py" %*
