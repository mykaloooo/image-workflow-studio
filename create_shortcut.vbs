Set oWS = WScript.CreateObject("WScript.Shell")
sLinkFile = oWS.SpecialFolders("Desktop") & "\PDF价格批量打折工具.lnk"
Set oLink = oWS.CreateShortcut(sLinkFile)

oLink.TargetPath = "I:\xwechat_files\kaloooooooo_454d\msg\file\2026-03\PDF价格打折一键工具.bat"
oLink.WorkingDirectory = "I:\xwechat_files\kaloooooooo_454d\msg\file\2026-03"
oLink.Description = "拖拽PDF文件到此处自动打折"
oLink.Save
