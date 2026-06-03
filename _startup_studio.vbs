' Image Workflow Studio 后端 - 开机隐藏自启
' 日志：backend\studio-autostart.log
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "d:\2026AI\image-workflow-studio\backend"
' 0 = 隐藏窗口, False = 不等待
WshShell.Run "cmd /c ""python app.py >> studio-autostart.log 2>&1""", 0, False
