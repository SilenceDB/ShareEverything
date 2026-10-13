/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

/**
 * 极简文件日志：按天滚动、保留 N 天、同时输出到控制台。
 *
 * 为什么不直接用 pm2 的日志能力：pm2 只在"被 pm2 托管"时才存在，而开发时是
 * tsx watch、手工排查时是裸 node。日志应该跟着进程走，而不是跟着守护方式走。
 *
 * 零依赖，拦截 console 做 tee —— 这样进程里任何地方（包括框架内部）打的
 * 日志都会落盘，不用逐个改造调用点。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE_RE = /^app-\d{4}-\d{2}-\d{2}\.log$/

let dir = ''
let keepDays = 14
let stream: fs.WriteStream | null = null
let currentDay = ''
let installed = false
let closed = false

function dayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 把参数压成一行；Error 带栈，对象走 JSON，循环引用兜底 */
function stringify(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`
      if (a === undefined) return 'undefined'
      if (a === null) return 'null'
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a)
        } catch {
          return Object.prototype.toString.call(a)
        }
      }
      return String(a)
    })
    .join(' ')
}

function openFile(day: string): void {
  if (stream) {
    try {
      stream.end()
    } catch {
      /* 已经关了 */
    }
    stream = null
  }
  const file = path.join(dir, `app-${day}.log`)
  const s = fs.createWriteStream(file, { flags: 'a' })
  // 磁盘写满、目录被删、权限变化都不该把业务拖死：静默降级成"只有控制台日志"
  s.on('error', () => {
    if (stream === s) stream = null
  })
  stream = s
  currentDay = day
}

function cleanup(): void {
  try {
    const files = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort()
    const drop = files.length - keepDays
    for (const f of files.slice(0, Math.max(0, drop))) {
      try {
        fs.unlinkSync(path.join(dir, f))
      } catch {
        /* 被占用就留到下次启动再删 */
      }
    }
  } catch {
    /* 目录不可读时忽略 */
  }
}

function write(level: string, args: unknown[]): void {
  if (closed) return
  try {
    const day = dayKey()
    if (day !== currentDay) {
      openFile(day)
      cleanup()
    }
    stream?.write(`${new Date().toISOString()} [${level}] ${stringify(args)}\n`)
  } catch {
    /* 日志失败绝不能影响业务 */
  }
}

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const

/**
 * 初始化并接管 console。重复调用只会切换目录，不会重复包裹 console。
 * 返回实际使用的日志目录。
 */
export function initLogger(logDir: string, opts: { keepDays?: number } = {}): string {
  dir = path.resolve(logDir)
  keepDays = Math.max(1, opts.keepDays ?? 14)
  fs.mkdirSync(dir, { recursive: true })
  openFile(dayKey())
  cleanup()

  if (!installed) {
    installed = true
    for (const m of LEVELS) {
      const original = console[m].bind(console)
      const label = m === 'log' ? 'INFO' : m.toUpperCase()
      console[m] = (...args: unknown[]) => {
        original(...args)
        write(label, args)
      }
    }
  }
  return dir
}

/** 退出前调用：把缓冲刷进文件，避免最后几行丢失 */
export function closeLogger(): void {
  closed = true
  if (stream) {
    try {
      stream.end()
    } catch {
      /* ignore */
    }
    stream = null
  }
}

export function logDir(): string {
  return dir
}

/** 当前生效的日志文件绝对路径（health 接口用得上） */
export function currentLogFile(): string {
  return dir ? path.join(dir, `app-${currentDay || dayKey()}.log`) : ''
}
