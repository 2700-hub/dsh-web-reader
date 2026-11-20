@echo off
chcp 65001 >nul
cd /d %~dp0

echo == 安装本地语音服务开机自启 ==
echo.

if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call npm install --no-audit --no-fund
)

schtasks /create /tn "DSH-TTS-Server" /tr "wscript.exe \"%~dp0run-hidden.vbs\"" /sc onlogon /rl limited /f
if errorlevel 1 (
  echo.
  echo 创建计划任务失败。可以改用另一种方式：
  echo 把 start.cmd 的快捷方式放进 shell:startup 文件夹。
  pause
  exit /b 1
)

schtasks /run /tn "DSH-TTS-Server" >nul 2>&1

echo.
echo 完成：以后登录 Windows 会自动在后台启动本地语音服务。
echo 现在就已经为你启动了一次。
echo.
echo 取消自启：双击 uninstall-autostart.cmd
pause
