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
 * ShareEverything 进程控制台：启动 / 停止 / 重启 / 状态 / 日志 / 清理日志 / 开机自启。
 *
 * 为什么这些逻辑放在 .mjs 而不是 .bat 里：
 *   1. .bat 只能靠 cmd.exe 跑，很难自动化验证；.mjs 可以直接用包内 node 执行、能测；
 *   2. Windows 与 Linux 共用同一份实现，不会出现两套行为不一致；
 *   3. .bat 里塞十来个带引号的参数很容易被搞坏。
 * 于是所有 .bat 都只是三行包装：找到 node → 调这里 → pause。
 *
 * pm2 的守护状态（daemon / dump / 日志文件句柄）一律放在包内 .pm2 目录，
 * 绿色便携：不往用户目录写东西，删包就是彻底清理。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_NAME = 'share-everything'
const TASK_NAME = 'ShareEverything'
const PM2_HOME = path.join(root, '.pm2')
const LOGS_DIR = path.join(root, 'logs')
const isWin = process.platform === 'win32'

/** 优先用包里自带的 node（离线包有），没有就用当前解释器 */
function resolveNode() {
  const bundled = isWin
    ? path.join(root, 'node', 'node.exe')
    : path.join(root, 'node', 'bin', 'node')
  return fs.existsSync(bundled) ? bundled : process.execPath
}
const NODE = resolveNode()
const PM2_BIN = path.join(root, 'node_modules', 'pm2', 'bin', 'pm2')
const ENV = { ...process.env, PM2_HOME }

function fmtBytes(n) {
  if (!n) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '-'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d} 天 ${h} 小时`
  if (h) return `${h} 小时 ${m} 分`
  if (m) return `${m} 分 ${s % 60} 秒`
  return `${s} 秒`
}

/* ---------------- 与 pm2 交互 ---------------- */

function pm2(args, { inherit = false } = {}) {
  const r = spawnSync(NODE, [PM2_BIN, ...args], {
    cwd: root,
    env: ENV,
    // stdin 必须显式设成 'ignore'：默认（或用 'pipe' 简写）会把 stdin 也开成管道，
    // Windows 上 libuv 读这个管道时偶发 ERROR_PIPE_BUSY，spawnSync 直接报 EBUSY。
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { code: r.status ?? -1, out, error: r.error?.code }
}

function hasPm2() {
  if (fs.existsSync(PM2_BIN)) return true
  console.error(`找不到 pm2: ${PM2_BIN}`)
  console.error('标准包需要先在本目录执行 npm install；离线包自带了 pm2，出现这个提示说明包不完整。')
  return false
}

/** pm2 jlist 输出里前面可能混着 daemon 启动提示，这里只取 JSON 数组那一段 */
function parseList(text) {
  const a = text.indexOf('[')
  const b = text.lastIndexOf(']')
  if (a < 0 || b <= a) return []
  try {
    const list = JSON.parse(text.slice(a, b + 1))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function appInfo() {
  const { out } = pm2(['jlist'])
  const p = parseList(out).find((x) => x.name === APP_NAME)
  if (!p) return null
  return {
    status: p.pm2_env?.status ?? 'unknown',
    pid: p.pid,
    restarts: p.pm2_env?.restart_time ?? 0,
    uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    memory: p.monit?.memory ?? 0,
    exitCode: p.pm2_env?.exit_code,
    unstable: p.pm2_env?.unstable_restarts ?? 0,
  }
}

function readEnvPort() {
  const fallback = 3000
  try {
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8')
    const m = env.match(/^\s*PORT\s*=\s*(\d+)/m)
    return m ? Number(m[1]) : fallback
  } catch {
    return fallback
  }
}

function readEnvInt(key, fallback) {
  try {
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8')
    const m = env.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)`, 'm'))
    return m ? Number(m[1]) : fallback
  } catch {
    return fallback
  }
}

function ensureConfig() {
  const r = spawnSync(NODE, [path.join(root, 'tools', 'setup.mjs')], {
    cwd: root,
    env: ENV,
    stdio: 'inherit',
  })
  return r.status === 0
}

/** 探一下端口是否真的在应答 HTTP —— pm2 显示 online 不等于服务可用 */
async function probeHealth() {
  const port = readEnvPort()
  const url = `http://127.0.0.1:${port}/api/health`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    const j = await res.json()
    return { ok: true, url, data: j }
  } catch (e) {
    return { ok: false, url, error: e?.message ?? String(e) }
  }
}

/* ---------------- 子命令 ---------------- */

async function cmdStart() {
  if (!hasPm2()) return 1
  const before = appInfo()

  if (before && before.status === 'online') {
    console.log(`ShareEverything 已在守护中运行（pid ${before.pid}），跳过启动。`)
  } else {
    if (before) {
      console.log(`发现一个残留的 ${before.status} 实例，重新拉起…`)
      const r = pm2(['restart', APP_NAME], { inherit: true })
      if (r.code !== 0) return 1
    } else {
      if (!ensureConfig()) return 1
      const r = pm2(['start', path.join(root, 'ecosystem.config.json')], { inherit: true })
      if (r.code !== 0) return 1
    }
    pm2(['save'])
  }

  const info = appInfo()
  console.log('')
  if (info && info.status === 'online') {
    console.log(`已启动：pid ${info.pid}，访问 http://localhost:${readEnvPort()}`)
    console.log(`日志：${path.join(LOGS_DIR, 'app-<日期>.log')}`)
    console.log('停止 stop.bat ／ 重启 restart.bat ／ 看日志 logs.bat')
    const h = await probeHealth()
    console.log(h.ok ? '健康检查：通过' : `健康检查：失败（${h.error}）—— 进程刚起来时端口可能还没就绪，稍等几秒看 logs.bat`)
    return 0
  }

  // 起不来的时候，把 pm2 抓到的输出直接摊出来，省得让人再去翻文件
  console.log('启动后状态不是 online，下面是最近的进程输出：')
  pm2(['logs', APP_NAME, '--lines', '50', '--nostream'], { inherit: true })
  console.log('')
  console.log('常见原因：端口被占用、.env 配置有误、数据库文件无写入权限。')
  return 1
}

function cmdStop() {
  if (!hasPm2()) return 1
  const info = appInfo()
  if (!info) {
    console.log('ShareEverything 当前没有在守护中运行。')
  } else {
    console.log(`正在停止 pid ${info.pid}（会先走优雅退出，8 秒超时后强杀）…`)
    pm2(['delete', APP_NAME], { inherit: true })
  }
  // 连 daemon 一起收掉：它平时只是一直占着几十 MB 内存和日志文件句柄。
  // PM2_HOME 在包内，不会影响这台机器上别人的 pm2。
  pm2(['kill'])
  console.log('已停止。')
  return 0
}

async function cmdRestart() {
  if (!hasPm2()) return 1
  const info = appInfo()
  // 没注册过就当成启动，别报"重启失败"让人一头雾水
  if (!info) return cmdStart()
  console.log('正在重启…')
  const r = pm2(['restart', APP_NAME], { inherit: true })
  if (r.code !== 0) return 1
  const after = appInfo()
  console.log(after && after.status === 'online' ? `已重启，新的 pid ${after.pid}` : '重启后状态异常，请看 logs.bat')
  return after && after.status === 'online' ? 0 : 1
}

async function cmdStatus() {
  if (!hasPm2()) return 1
  const info = appInfo()
  console.log('=== pm2 守护状态 ===')
  if (!info) {
    console.log('  没有在 pm2 中注册：服务没启动过，或者已经被 stop 掉了。')
  } else {
    console.log(`  状态      ${info.status}`)
    console.log(`  进程号    ${info.pid || '-'}`)
    console.log(`  已运行    ${fmtDuration(info.uptime)}`)
    console.log(`  重启次数  ${info.restarts}${info.unstable ? `（其中不稳定重启 ${info.unstable}）` : ''}`)
    console.log(`  内存占用  ${fmtBytes(info.memory)}`)
    if (info.status === 'errored' || info.status === 'stopped') {
      console.log(`  退出码    ${info.exitCode}`)
      console.log('  提示      已经超过连续崩溃上限，pm2 不会再自动拉起；查完日志后 restart.bat 重试。')
    }
  }
  console.log('')
  console.log('=== HTTP 健康检查 ===')
  const h = await probeHealth()
  if (h.ok) {
    console.log(`  ${h.url}  正常`)
    console.log(`  进程号 ${h.data.pid}   启动于 ${h.data.startedAt}   已运行 ${fmtDuration(h.data.uptimeSec * 1000)}`)
    console.log(`  Node ${h.data.node}`)
    console.log(`  当前日志 ${h.data.logFile}`)
  } else {
    console.log(`  ${h.url}  无响应（${h.error}）`)
  }
  console.log('')
  console.log(`日志目录: ${LOGS_DIR}`)
  return h.ok ? 0 : 1
}

function cmdLogs() {
  const args = process.argv.slice(3)
  const r = spawnSync(NODE, [path.join(root, 'tools', 'show-logs.mjs'), ...args], {
    cwd: root,
    env: ENV,
    stdio: 'inherit',
  })
  return r.status ?? 0
}

async function cmdCleanLogs() {
  if (!hasPm2()) return 1
  console.log('停止服务并释放日志文件句柄…')
  pm2(['delete', APP_NAME])
  // 必须把 daemon 也停掉：pm2 的日志文件被它持有，不释放的话删不掉也截断不了
  pm2(['kill'])

  let freed = 0
  for (const f of ['pm2-out.log', 'pm2-error.log']) {
    const p = path.join(LOGS_DIR, f)
    if (fs.existsSync(p)) {
      freed += fs.statSync(p).size
      fs.unlinkSync(p)
      console.log(`  已删除 ${f}`)
    }
  }

  const keep = Math.max(1, readEnvInt('LOG_KEEP_DAYS', 14))
  if (fs.existsSync(LOGS_DIR)) {
    const files = fs
      .readdirSync(LOGS_DIR)
      .filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort()
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      freed += fs.statSync(path.join(LOGS_DIR, f)).size
      fs.unlinkSync(path.join(LOGS_DIR, f))
      console.log(`  已删除 ${f}`)
    }
  }

  console.log(`共清理 ${fmtBytes(freed)}（主日志保留最近 ${keep} 天，pm2 抓取的文件全清）`)
  console.log('')
  return cmdStart()
}

function cmdAutostart(on) {
  if (!isWin) {
    console.log('Linux / macOS 用 systemd 或 crontab 做开机自启，具体见 运行说明.md 的「开机自启」一节。')
    return 1
  }
  if (on) {
    const target = path.join(root, 'start-silent.bat')
    const r = spawnSync('schtasks', ['/create', '/tn', TASK_NAME, '/tr', target, '/sc', 'onlogon', '/f'], {
      stdio: 'inherit',
    })
    if (r.status !== 0) {
      console.log('')
      console.log('注册失败。多半是权限不足，请右键 autostart-on.bat 选「以管理员身份运行」再试一次。')
      return 1
    }
    console.log('')
    console.log(`已注册开机自启（计划任务名 ${TASK_NAME}）。`)
    console.log('行为：当前用户登录 Windows 后自动启动，不需要手动双击 start.bat。')
    console.log('注意：是「登录后」而不是「开机即启」—— 这样进程拥有你自己的文件访问权限，')
    console.log('      磁盘发布里挂载本机目录才不会因为权限问题读不到。')
    console.log('确认：cmd 里执行  schtasks /query /tn ShareEverything')
    return 0
  }

  const r = spawnSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.log('')
    console.log('取消失败：可能本来就没注册过，或者需要管理员权限。')
    return 1
  }
  console.log('')
  console.log('已取消开机自启。已经跑着的服务不受影响，需要停止请用 stop.bat。')
  return 0
}

function cmdHelp() {
  console.log(`ShareEverything 控制台

  node tools/ctl.mjs start          启动（已在运行则跳过）
  node tools/ctl.mjs stop           停止（连 pm2 守护一起收掉）
  node tools/ctl.mjs restart        重启
  node tools/ctl.mjs status         查看守护状态 + HTTP 健康检查
  node tools/ctl.mjs logs [-f] [-n N]   查看日志，-f 实时跟随
  node tools/ctl.mjs clean-logs     清理 pm2 抓取的日志与超期日志后重启
  node tools/ctl.mjs autostart on|off   注册 / 取消开机自启（Windows）
`)
  return 0
}

const cmd = (process.argv[2] ?? 'help').toLowerCase()
let code = 1
if (cmd === 'start') code = await cmdStart()
else if (cmd === 'stop') code = cmdStop()
else if (cmd === 'restart') code = await cmdRestart()
else if (cmd === 'status') code = await cmdStatus()
else if (cmd === 'logs') code = cmdLogs()
else if (cmd === 'clean-logs') code = await cmdCleanLogs()
else if (cmd === 'autostart') code = cmdAutostart((process.argv[3] ?? '').toLowerCase() === 'on')
else code = cmdHelp()

// 兜底：任何子命令不小心返回了非数字，都别让 process.exit 抛 ERR_INVALID_ARG_TYPE
process.exit(typeof code === 'number' ? code : 0)
