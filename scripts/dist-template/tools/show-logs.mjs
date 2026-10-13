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
 * 查看运行日志。
 *
 * 默认打印最新那个按天日志文件的末尾若干行；带 -f 就像 tail -f 一样跟着看。
 * 不依赖 pm2，也不依赖任何第三方包 —— pm2 没起来时同样能翻日志。
 *
 *   node tools/show-logs.mjs            末尾 80 行
 *   node tools/show-logs.mjs -n 300     末尾 300 行
 *   node tools/show-logs.mjs -f         实时跟随（Ctrl+C 退出）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const logsDir = path.join(root, 'logs')
const FILE_RE = /^app-\d{4}-\d{2}-\d{2}\.log$/

const argv = process.argv.slice(2)
const follow = argv.includes('-f') || argv.includes('--follow')
let lines = 80
const li = argv.findIndex((a) => a === '-n' || a === '--lines')
if (li >= 0 && argv[li + 1]) lines = Math.max(1, Number(argv[li + 1]) || 80)

function logFiles() {
  if (!fs.existsSync(logsDir)) return []
  return fs.readdirSync(logsDir).filter((f) => FILE_RE.test(f)).sort()
}

function newest() {
  const files = logFiles()
  return files.length ? path.join(logsDir, files[files.length - 1]) : null
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 只读文件末尾一段，避免几十 MB 的日志被整体读进内存 */
const TAIL_BYTES = 512 * 1024
function tail(file, n) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const all = buf.toString('utf8').split(/\r?\n/)
    // 截断点可能落在半行上，丢掉第一段残缺内容
    if (start > 0) all.shift()
    return all.slice(-n).join('\n')
  } finally {
    fs.closeSync(fd)
  }
}

const files = logFiles()
if (files.length === 0) {
  console.log(`还没有日志文件。日志目录: ${logsDir}`)
  console.log('服务启动后这里会出现 app-YYYY-MM-DD.log。')
  process.exit(0)
}

console.log(`日志目录: ${logsDir}`)
for (const f of files) {
  const st = fs.statSync(path.join(logsDir, f))
  const when = st.mtime.toISOString().slice(0, 19).replace('T', ' ')
  console.log(`  ${f}   ${fmtSize(st.size)}   最后写入 ${when}`)
}
console.log('')

const current = newest()
console.log(`--- ${path.basename(current)} 末尾 ${lines} 行 ---`)
console.log(tail(current, lines))

if (!follow) process.exit(0)

// 跟随模式：每秒看一次有没有新内容；跨天会自动切到新文件
console.log('\n--- 实时跟随中，Ctrl+C 退出 ---')
let watching = current
let offset = fs.statSync(current).size
process.on('SIGINT', () => {
  console.log('\n已退出跟随。')
  process.exit(0)
})

setInterval(() => {
  const target = newest()
  if (!target) return
  if (target !== watching) {
    console.log(`\n--- 切换到 ${path.basename(target)} ---`)
    watching = target
    offset = 0
  }
  let st
  try {
    st = fs.statSync(watching)
  } catch {
    return
  }
  if (st.size < offset) offset = 0 // 文件被清空或重建
  if (st.size === offset) return
  const fd = fs.openSync(watching, 'r')
  try {
    const buf = Buffer.alloc(st.size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
    offset = st.size
    process.stdout.write(buf.toString('utf8'))
  } finally {
    fs.closeSync(fd)
  }
}, 1000)
