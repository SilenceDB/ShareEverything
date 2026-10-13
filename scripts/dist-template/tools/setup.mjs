#!/usr/bin/env node

/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

/**
 * 生成 ecosystem.config.json。
 *
 * 为什么不在打包时直接写死路径：包里所有路径都必须是"当前所在位置"的绝对路径，
 * 而 dist 会被拷到别的机器、别的盘符、别的目录名下面。所以每次启动时按本文件
 * 自身的位置重新算一遍。
 *
 * 已经存在、且包的所在位置没变时不会覆盖 —— 手动改过的设置会保留下来。
 * 一旦整包被搬走（记录的位置对不上），会先备份成 .bak 再重新生成。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configFile = path.join(root, 'ecosystem.config.json')
const logsDir = path.join(root, 'logs')
// 位置标记单独放一个文件，避免往 pm2 的配置里塞自定义字段
const markerFile = path.join(logsDir, '.pm2-root')

fs.mkdirSync(logsDir, { recursive: true })

const stamped = fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8').trim() : ''
if (fs.existsSync(configFile) && stamped === root) {
  // 位置没变：保留现有配置（可能被手动调整过）
  process.exit(0)
}

if (fs.existsSync(configFile)) {
  fs.copyFileSync(configFile, `${configFile}.bak`)
  console.log(`检测到整个目录被移动过，原配置已备份为 ecosystem.config.json.bak`)
}

const config = {
  apps: [
    {
      name: 'share-everything',
      script: path.join(root, 'server', 'index.js'),
      cwd: root,
      // fork + 单实例：SQLite 只允许一个写进程，cluster 模式会立刻互相踩
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // 连续 10 秒内又挂了才算"不稳定重启"，避免正常重启被判成崩溃
      min_uptime: '10s',
      // 崩溃循环上限：连续不稳定重启超过这个次数 pm2 会停下来，不再无脑拉
      max_restarts: 20,
      restart_delay: 3000,
      // 反复重启时指数退避，防止把 CPU 和日志刷爆
      exp_backoff_restart_delay: 200,
      // 给优雅退出（关 HTTP、断数据库）留时间，不够就会被强杀
      kill_timeout: 8000,
      max_memory_restart: '1G',
      // 这两个文件是 pm2 抓的同一份控制台输出，与 logs/app-*.log 内容重复。
      // 体积由 clean-logs.bat 清理（pm2 持有句柄时无法从外部截断）。
      out_file: path.join(logsDir, 'pm2-out.log'),
      error_file: path.join(logsDir, 'pm2-error.log'),
      merge_logs: true,
      time: true,
      env: { NODE_ENV: 'production' },
    },
  ],
}

fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
fs.writeFileSync(markerFile, `${root}\n`, 'utf8')
console.log(`已生成 ecosystem.config.json（根目录: ${root}）`)
