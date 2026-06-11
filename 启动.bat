@echo off
chcp 65001 >nul
title 图片工作流 - 启动器

cd /d "%~dp0"

echo ========================================
echo   🎨 图片工作流工作室 - 一键启动
echo ========================================
echo.

REM ========== 1. Python 检测 ==========
py -3 --version >nul 2>&1
if errorlevel 1 (
    python --version >nul 2>&1
    if errorlevel 1 (
        echo ❌ 未找到 Python 3
        echo    下载地址: https://www.python.org/downloads/
        echo.
        pause
        exit /b 1
    )
    set "PYEXE=python"
) else (
    set "PYEXE=py -3"
)
echo ✓ Python 已安装

REM ========== 2. 检测后端是否已经在跑 ==========
echo.
echo [1/3] 检查后端状态...
curl -s -o nul -w "%%{http_code}" http://localhost:5688 2>nul | findstr "200" >nul
if %errorlevel% equ 0 (
    echo     ✓ 后端已在运行
    goto OPEN_BROWSER
)

REM ========== 3. 后端没跑，新窗口最小化启动 ==========
echo     → 后端未运行，启动中...
echo.
echo [2/3] 启动后端 (新窗口最小化)...
start "图片工作流-后端" /min cmd /k "%PYEXE% backend\app.py"
echo     ✓ 启动指令已发出

REM ========== 4. 等 Flask 监听端口 ==========
echo.
echo [3/3] 等待 Flask 就绪 (最多 25 秒)...
set /a count=0
:WAIT
timeout /t 1 /nobreak >nul
set /a count+=1
curl -s -o nul -w "%%{http_code}" http://localhost:5688 2>nul | findstr "200" >nul
if %errorlevel% equ 0 goto OPEN_BROWSER
if %count% geq 25 (
    echo.
    echo ❌ 后端 25 秒未就绪，请打开任务栏上"图片工作流-后端"窗口查看报错。
    echo    （它可能被最小化了，点 Windows 任务栏图标找一下）
    echo.
    pause
    exit /b 1
)
goto WAIT

:OPEN_BROWSER
echo.
echo 🌐 启动浏览器: http://localhost:5688
start "" "http://localhost:5688"
echo.
echo ========================================
echo   ✅ 一切就绪！
echo ========================================
echo.
echo • 后端运行在最小化的"图片工作流-后端"窗口
echo • 关闭那个窗口可停止后端服务
echo • 本启动器 5 秒后自动关闭
echo.
timeout /t 5 >nul
exit /b 0
