@echo off

rem ShareEverything - 磁盘资源发布与 Web 分享平台
rem
rem @author SilenceDB
rem @license Apache-2.0
rem SPDX-License-Identifier: Apache-2.0
rem Copyright 2026 SilenceDB

rem 注册「登录 Windows 后自动启动」。需要管理员权限，右键选「以管理员身份运行」。
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"

"%NODE%" "%~dp0tools\ctl.mjs" autostart on
pause
