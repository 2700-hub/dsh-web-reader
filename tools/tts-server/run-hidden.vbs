' 后台启动本地语音服务（不显示窗口）
' 由 install-autostart.cmd 注册为登录时运行
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node server.mjs", 0, False
