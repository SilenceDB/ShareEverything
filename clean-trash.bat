@echo off
rem ============================================================
rem  ShareEverything - 磁盘资源发布与 Web 分享平台
rem
rem  @author SilenceDB
rem  @license Apache-2.0
rem  SPDX-License-Identifier: Apache-2.0
rem  Copyright 2026 SilenceDB
rem
rem  清理重打包时改名挪开的旧产物目录（*.trash-*）。
rem  打包脚本在无法直接删除旧目录时会把它改名成 dist.trash-<时间戳>，
rem  这些目录不会再被用到，确认新包跑起来没问题后双击本文件即可删除。
rem ============================================================

setlocal
cd /d "%~dp0"

echo 正在清理旧产物目录...
echo.

for /d %%D in ("dist.trash-*") do (
    echo   删除 %%~nxD
    rd /s /q "%%~fD"
)
for /d %%D in ("server\dist.trash-*") do (
    echo   删除 server\%%~nxD
    rd /s /q "%%~fD"
)
for /d %%D in ("web\dist.trash-*") do (
    echo   删除 web\%%~nxD
    rd /s /q "%%~fD"
)

echo.
echo 清理完成。剩余：
dir /b /ad "dist.trash-*" 2>nul
dir /b /ad "server\dist.trash-*" 2>nul
dir /b /ad "web\dist.trash-*" 2>nul
echo.
pause
