@echo off
REM DM Whisper gem launcher.
REM - clears the ELECTRON_RUN_AS_NODE gotcha (only set inside the Claude Code harness, harmless to clear)
REM - starts the long-running MCP HTTP server on :39200 if it isn't already up
REM - launches the Electron scrying-gem HUD detached
setlocal
set "ELECTRON_RUN_AS_NODE="
REM Force the HUD agent onto cloud Claude (Haiku) instead of the local 7B — the
REM 7B hallucinates token IDs and flubs tool calls at the live table. Uses
REM ANTHROPIC_API_KEY from the root .env. Remove this line to fall back to local.
set "DMW_PROVIDER=anthropic"
set "ROOT=E:\personalProjects\roll20-dm-mcp"
set "NODE=C:\Program Files\nodejs\node.exe"
set "ELECTRON=%ROOT%\voice-hud\node_modules\electron\dist\electron.exe"

REM Start the MCP server only if nothing is listening on 39200.
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 39200 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath '%NODE%' -ArgumentList 'dist\index-http.js' -WorkingDirectory '%ROOT%' -WindowStyle Hidden }"

REM Give a freshly-started server a moment to bind before the gem connects.
timeout /t 3 /nobreak >nul

cd /d "%ROOT%\voice-hud"
start "" "%ELECTRON%" .
endlocal
