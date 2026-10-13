#!/usr/bin/env sh

# ShareEverything - 磁盘资源发布与 Web 分享平台
#
# @author SilenceDB
# @license Apache-2.0
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 SilenceDB

# Linux / macOS 启动入口。首次建议先 ./start.sh status 看一眼。
cd "$(dirname "$0")"

NODE=node
if [ -x "node/bin/node" ]; then
  NODE="$(pwd)/node/bin/node"
fi

exec "$NODE" tools/ctl.mjs "${1:-start}"
