/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

/**
 * 双语对齐校验。
 *
 * 三件事：
 *   1. 后端：源码里所有 `new AppError('...')` 的文案是否都进了 en 表（查不到的英文只会回退中文）；
 *   2. 前端：代码里用到的每个 t('...') 键，中英两份词典里是否都有；
 *   3. 前端：界面代码里是否还残留中文（词典目录本身除外），防止漏抽。
 *
 * 用法：node_modules/.bin/tsx scripts/check-i18n.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { en as backendEn } from '../server/src/i18n/en.js'
import enUS from '../web/src/locales/en-US.js'
import zhCN from '../web/src/locales/zh-CN.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const WEB_SRC = path.join(ROOT, 'web', 'src')
const SERVER_SRC = path.join(ROOT, 'server', 'src')
const CJK = /[\u4e00-\u9fff]/

/**
 * 运行时才拼出来的键，脚本看不到字面量，按前缀放行。
 * 改动这些拼接点时要同步这里，否则「废弃词条」检查会误报。
 */
const DYNAMIC_KEY_PREFIXES = [
  // Login.vue: t(`${key}.title`)，key 取自 hintResetOn / hintResetOnRemote / hintResetOffsite
  'login.hintResetOn.',
  'login.hintResetOnRemote.',
  'login.hintResetOffsite.',
  // uploadPolicy.ts: policyKey() → `policy.<档位>.<label|desc>`
  'policy.',
]

let failures = 0
function fail(msg: string): void {
  failures++
  console.log(`  ✗ ${msg}`)
}
function ok(msg: string): void {
  console.log(`  ✓ ${msg}`)
}
function head(msg: string): void {
  console.log(`\n${msg}`)
}

/* ---------------- 通用工具 ---------------- */

function walk(dir: string, exts: string[], skip: (p: string) => boolean = () => false): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (skip(full)) continue
    if (entry.isDirectory()) out.push(...walk(full, exts, skip))
    else if (exts.includes(path.extname(entry.name))) out.push(full)
  }
  return out
}

/** 把嵌套词典拍平成 `a.b.c` → 文案 */
function flatten(obj: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') Object.assign(out, flatten(v, key))
    else out[key] = String(v)
  }
  return out
}

/* ---------------- 1. 后端文案覆盖 ---------------- */

/** 从 AppError( 的左括号出发，返回括号内的整段内容（跳过字符串里的括号） */
function parenContent(src: string, openIdx: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return src.slice(openIdx + 1, i)
    }
  }
  return ''
}

/** 取第一个顶层参数（按顶层逗号切） */
function firstArg(content: string): string {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) return content.slice(0, i)
  }
  return content
}

function unescapeTs(s: string): string {
  return s.replace(/\\(['"`\\])/g, '$1')
}

/**
 * 抽出一段表达式里的全部字符串字面量。
 * 模板字面量里的 `${...}` 统一换成 `{}`，与词典里的占位符写法对齐。
 */
function literalsIn(arg: string): string[] {
  const out: string[] = []
  const re = /`((?:\\.|[^`\\])*)`|'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(arg))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? ''
    out.push(unescapeTs(raw.replace(/\$\{[^}]*\}/g, '{}')))
  }
  return out
}

/**
 * 后端文案的 msgid 一律是中文（见 server/src/i18n/en.ts 的说明），
 * 所以首参数里**不含中文**的字符串必然是代码字面量而不是文案 —— 比如
 * `new AppError(kind === 'DIR' ? '请选择要发布的目录' : '请选择要发布的文件')`
 * 里的 'DIR'、`plan.truncatedBy === 'files' ? … : …` 里的 'files'。
 * 这类字符单独列出来供人工扫一眼，不计入失败。
 */
function backendMessages(): { messages: string[]; skipped: string[] } {
  const all = new Set<string>()
  const skipped = new Set<string>()
  for (const file of walk(SERVER_SRC, ['.ts'])) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    const re = /new AppError\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const content = parenContent(src, m.index + 'new AppError'.length)
      for (const lit of literalsIn(firstArg(content))) {
        if (!lit.trim()) continue
        if (CJK.test(lit)) all.add(lit)
        else skipped.add(lit)
      }
    }
  }
  return { messages: [...all].sort(), skipped: [...skipped].sort() }
}

/**
 * 少数地方不走 AppError，而是直接 `reply.send({ error: t(locale, '文案') })`
 * （plugins/auth.ts、utils/stream.ts、index.ts 的 404）。
 * 这些字符串同样是 msgid，同样必须收录 —— 只是换个地方扫。
 */
function backendTMessages(): string[] {
  const out = new Set<string>()
  for (const file of walk(SERVER_SRC, ['.ts'])) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    const re = /(?<![\w.$])t\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const content = parenContent(src, m.index + 1)
      for (const lit of literalsIn(content)) {
        if (CJK.test(lit)) out.add(lit)
      }
    }
  }
  return [...out]
}

/* ---------------- 2. 前端键完整性 ---------------- */

function frontendTKeys(): { keys: Set<string>; dynamic: string[] } {
  const keys = new Set<string>()
  const dynamic: string[] = []
  const skip = (p: string) => p.includes(`${path.sep}locales`)
  for (const file of walk(WEB_SRC, ['.ts', '.vue'], skip)) {
    const src = fs.readFileSync(file, 'utf8')
    const re = /(?<![\w.$])t\(\s*(['"`])([\s\S]*?)\1/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const body = m[2]
      if (body.includes('${')) {
        dynamic.push(`${path.relative(ROOT, file)}: t(${m[1]}${body}${m[1]})`)
        continue
      }
      if (body.includes('.')) keys.add(body)
    }
  }
  return { keys, dynamic }
}

/* ---------------- 3. 前端残留中文 ---------------- */

/**
 * 去注释，但**保留换行**（块注释整体换成等量空白/换行），
 * 否则报出来的行号会和真实文件对不上。
 */
function stripComments(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 界面代码里残留的中文。
 *
 * 行尾写上 `i18n-ignore` 可以豁免该行 —— 目前只有语言下拉的语言名用得上：
 * 「简体中文 / English」必须各用**自己语言的写法**，跟着界面语言翻译反而找不到入口。
 */
function leftovers(): string[] {
  const out: string[] = []
  const skip = (p: string) => p.includes(`${path.sep}locales`)
  for (const file of walk(WEB_SRC, ['.ts', '.vue'], skip)) {
    const raw = fs.readFileSync(file, 'utf8')
    const rawLines = raw.split(/\r?\n/)
    const lines = stripComments(raw).split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!CJK.test(line)) return
      if (/i18n-ignore/.test(rawLines[i] ?? '')) return
      out.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`)
    })
  }
  return out
}

/* ---------------- 跑起来 ---------------- */

const zh = flatten(zhCN)
const enFe = flatten(enUS)

head('【1】后端文案 → en 表')
const { messages: fromAppError, skipped: backendSkipped } = backendMessages()
const fromT = backendTMessages().filter((m) => !fromAppError.includes(m))
const backend = [...new Set([...fromAppError, ...fromT])].sort()
const backendMiss = backend.filter((m) => !(m in backendEn))
console.log(`  后端共 ${backend.length} 条中文文案（AppError ${fromAppError.length} + 直接 t() ${fromT.length}）`)
if (backendMiss.length) backendMiss.forEach((m) => fail(`未收录：${m}`))
else ok('全部已收录')
if (backendSkipped.length) {
  console.log(`  · 首参数内的非中文字面量（视为代码，未校验）：${backendSkipped.join('、')}`)
}

head('【2】前端 t() 键 → 中英词典')
const { keys, dynamic } = frontendTKeys()
console.log(`  共引用 ${keys.size} 个键`)
const missZh = [...keys].filter((k) => !(k in zh)).sort()
const missEn = [...keys].filter((k) => !(k in enFe)).sort()
if (missZh.length) missZh.forEach((k) => fail(`zh-CN 缺键：${k}`))
else ok('zh-CN 全部命中')
if (missEn.length) missEn.forEach((k) => fail(`en-US 缺键：${k}`))
else ok('en-US 全部命中')

// 两份词典必须结构一致：一边有一边没有，就是漏译
const onlyZh = Object.keys(zh).filter((k) => !(k in enFe)).sort()
const onlyEn = Object.keys(enFe).filter((k) => !(k in zh)).sort()
if (onlyZh.length) onlyZh.forEach((k) => fail(`en-US 缺少词条：${k}`))
if (onlyEn.length) onlyEn.forEach((k) => fail(`zh-CN 缺少词条：${k}`))
if (!onlyZh.length && !onlyEn.length) ok('两份词典结构一致')

// 代码里没用到的词条：动态拼接的按前缀放行，其余视为废弃
const unused = Object.keys(zh)
  .filter((k) => !keys.has(k) && !DYNAMIC_KEY_PREFIXES.some((p) => k.startsWith(p)))
  .sort()
if (unused.length) unused.forEach((k) => fail(`词条已废弃（无人引用）：${k}`))
else ok('无废弃词条')

if (dynamic.length) {
  console.log('  · 动态拼接的键（靠 DYNAMIC_KEY_PREFIXES 放行，见脚本顶部）：')
  dynamic.forEach((d) => console.log(`      ${d}`))
}

head('【3】前端界面代码残留中文')
const left = leftovers()
if (left.length) {
  left.forEach((l) => fail(l))
} else {
  ok('无残留')
}

head('结果')
if (failures) {
  console.log(`  ${failures} 处需要处理`)
  process.exit(1)
}
console.log('  全部通过')
