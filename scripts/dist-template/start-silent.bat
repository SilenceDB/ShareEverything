@echo off

rem ShareEverything - 磁盘资源发布与 Web 分享平台
rem
rem @author SilenceDB
rem @license Apache-2.0
rem SPDX-License-Identifier: Apache-2.0
rem Copyright 2026 SilenceDB

rem 由计划任务调用，故意不 pause：开机自启后不能留一个窗口等人按键
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"

"%NODE%" "%~dp0tools\ctl.mjs" start
exit /b %errorlevel%
