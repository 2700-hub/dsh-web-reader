@echo off
chcp 65001 >nul
cd /d %~dp0

echo == 注册 dsh-tts:// 协议 ==
echo.
echo 注册后，朗读面板里的「启动本地服务」按钮就能唤起本服务。
echo.

reg add "HKCU\Software\Classes\dsh-tts" /ve /d "URL:DSH TTS Server" /f >nul
reg add "HKCU\Software\Classes\dsh-tts" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\dsh-tts\shell\open\command" /ve /d "\"wscript.exe\" \"%~dp0run-hidden.vbs\"" /f >nul

if errorlevel 1 (
  echo 注册失败。
  pause
  exit /b 1
)

echo 完成。刷新 dsh 页面后，面板里会出现「启动本地服务」按钮。
echo 取消注册：双击 uninstall-protocol.cmd
pause
