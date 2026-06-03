@echo off
chcp 65001 >nul
title 图片工作流工作室 v2 (带日志)

cd /d "%~dp0"

if not exist "logs" mkdir logs

set LOG_FILE=logs\studio-%date:~0,4%%date:~5,2%%date:~8,2%.log

echo ========================================
echo      图片工作流工作室 v2 (带日志版)
echo ========================================
echo.
echo 日志文件: %LOG_FILE%
echo 屏幕和日志文件同步输出，Ctrl+C 停止
echo ========================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo 错误: 未找到 Python 3.10+
    pause
    exit /b 1
)

echo [0/2] 正在后台启动本地 Gemini 代理服务 (gcli2api)...
start /min "" "D:\gcli2api\.venv\Scripts\python.exe" "D:\gcli2api\web.py"

python backend\app.py 2>&1 | powershell -Command "$input | Tee-Object -FilePath '%LOG_FILE%' -Append"

pause
