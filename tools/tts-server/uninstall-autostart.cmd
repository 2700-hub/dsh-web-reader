@echo off
chcp 65001 >nul
echo == 取消本地语音服务开机自启 ==
schtasks /delete /tn "DSH-TTS-Server" /f
if errorlevel 1 (
  echo 没有找到该计划任务，可能本来就没安装。
) else (
  echo 已取消。当前正在运行的服务不受影响，重启后不再自动启动。
)
pause
