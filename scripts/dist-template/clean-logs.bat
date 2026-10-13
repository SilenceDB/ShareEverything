@echo off

rem ShareEverything - 磁盘资源发布与 Web 分享平台
rem
rem @author SilenceDB
rem @license Apache-2.0
rem SPDX-License-Identifier: Apache-2.0
rem Copyright 2026 SilenceDB

rem pm2 抓取的那两个日志文件被守护进程持着句柄，没法直接删，
rem 所以这里会先停服、再清理、最后自动重启。
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"

"%NODE%" "%~dp0tools\ctl.mjs" clean-logs
pause
