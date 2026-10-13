@echo off

rem ShareEverything - 磁盘资源发布与 Web 分享平台
rem
rem @author SilenceDB
rem @license Apache-2.0
rem SPDX-License-Identifier: Apache-2.0
rem Copyright 2026 SilenceDB

rem 默认实时跟随最新日志，Ctrl+C 退出。想只看一眼可以用：
rem   node tools\ctl.mjs logs -n 200
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"

"%NODE%" "%~dp0tools\ctl.mjs" logs -f
