@echo off
chcp 65001 >nul
title 图片工作流工作室 v2 (优化版)

echo ========================================
echo      图片工作流工作室 v2 (优化版)
echo ========================================
echo.
echo 优化内容：
echo - 图片存储为路径方式，项目文件更小
echo - 图片压缩到85%质量，平衡大小和清晰度
echo - 后端自动压缩上传的图片
echo.

cd /d "%~dp0"

echo [1/2] 检查 Python 环境...
python --version >nul 2>&1
if errorlevel 1 (
    echo 错误: 未找到 Python，请先安装 Python 3.10+
    echo 下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)
echo ✓ Python 已安装

echo.
echo [2/2] 启动服务...
echo.
echo 服务启动后，请在浏览器访问:
echo    http://localhost:5688
echo.
echo 按 Ctrl+C 停止服务
echo ========================================

echo [0/2] 正在后台启动本地 Gemini 代理服务 (gcli2api)...
start /min "" "D:\gcli2api\.venv\Scripts\python.exe" "D:\gcli2api\web.py"

python backend\app.py

pause
