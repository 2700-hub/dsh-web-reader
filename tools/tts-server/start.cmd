@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist node_modules (
  echo 首次运行，正在安装依赖（只需一次）...
  call npm install --no-audit --no-fund
)
echo.
echo 启动本地语音服务（关闭本窗口即停止）
node server.mjs
pause
