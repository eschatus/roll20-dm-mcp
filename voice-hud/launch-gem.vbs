Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "E:\personalProjects\roll20-dm-mcp\voice-hud"
objShell.Run "cmd /c npm run start 2>&1 >> E:\personalProjects\roll20-dm-mcp\voice-hud\gem-launch.log", 0, False
