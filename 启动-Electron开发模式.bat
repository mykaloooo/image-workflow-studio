@echo off
chcp 65001 >nul
echo ====================================
echo   图片工作流工作室 - Electron 开发模式
echo ====================================
echo.

cd /d "%~dp0"

echo [1/3] 启动后端服务...
start "Backend Server" cmd /k "cd backend && (py -3 app.py || python app.py)"
timeout /t 3 /nobreak >nul

echo [2/3] 启动前端开发服务器...
start "Frontend Dev Server" cmd /k "cd frontend && npm run dev"
timeout /t 5 /nobreak >nul

echo [3/3] 启动 Electron...
cd frontend
call npm run electron:dev

echo.
echo 应用已关闭
pause
