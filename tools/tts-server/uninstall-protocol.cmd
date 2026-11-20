@echo off
chcp 65001 >nul
echo == 取消 dsh-tts:// 协议注册 ==
reg delete "HKCU\Software\Classes\dsh-tts" /f >nul 2>&1
if errorlevel 1 (
  echo 没有找到注册项，可能本来就没注册。
) else (
  echo 已取消。
)
pause
