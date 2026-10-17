/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import fs from 'node:fs'
import path from 'node:path'
import fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { config } from './config.js'
import { prisma } from './db.js'
import { localeFromRequest, t, translateError } from './i18n/index.js'
import { registerJwt } from './plugins/auth.js'
import { authRoutes } from './routes/auth.js'
import { fileRoutes } from './routes/files.js'
import { uploadRoutes } from './routes/uploads.js'
import { mountRoutes } from './routes/mounts.js'
import { shareRoutes } from './routes/shares.js'
import { userRoutes } from './routes/users.js'
import { startArchiveCleanup } from './services/archive.js'
import { AppError, safeJoin } from './utils/fs.js'
import { closeLogger, currentLogFile, initLogger } from './utils/logger.js'
import { isLocalRequest } from './utils/request.js'
import { buildInfo, versionLabel } from './version.js'

/* ---------- 日志与进程生命周期 ---------- */
// 尽早接管 console：后面任何一处 console 输出都会同时落到 logs/app-YYYY-MM-DD.log，
// 这样即使是被 pm2 反复拉起的进程，也能翻到上一次崩溃前发生了什么。
initLogger(config.logDir, { keepDays: config.logKeepDays })

// 密钥是本次现场生成的：说明没配 JWT_SECRET。能用，但必须让用户知道这件事。
if (config.jwtSecretSource === 'generated') {
  console.warn('[jwt] 未配置 JWT_SECRET，已生成随机密钥并保存到 .jwt-secret（请勿外泄，也不要提交到仓库）')
  console.warn('      换一把：删掉该文件后重启；固定下来：在 .env 里写 JWT_SECRET=<随机字符串>')
}

// 提取码的加密密钥同样兜底落盘。要特别提醒：它一换，库里已有的提取码就全解不开。
if (config.accessCodeKeySource === 'generated') {
  console.warn('[access-code] 未配置 ACCESS_CODE_KEY，已生成随机密钥并保存到 .access-code-key')
  console.warn('            库内提取码用它加密，该文件丢失/被换掉将导致所有提取码解不开（需重设）')
}

const startedAt = new Date()

/**
 * 未捕获异常：记完日志必须退出，让守护进程用干净的状态重新拉起。
 * 继续跑下去的进程状态已经不可信（可能持有半开的文件句柄、半截请求）。
 * unhandledRejection 在 Node 15+ 本来就会终止进程，这里只是补上日志。
 */
process.on('uncaughtException', (err) => {
  console.error('[FATAL] 未捕获异常，进程即将退出（守护进程会自动重启）', err)
  closeLogger()
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] 未处理的 Promise 拒绝，进程即将退出（守护进程会自动重启）', reason)
  closeLogger()
  process.exit(1)
})

let closing = false
/** 收到停止信号时先关服务、断数据库，再退出，避免半截请求和 SQLite 写坏 */
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  console.log(`收到 ${signal}，正在停止服务…`)
  try {
    await app.close()
  } catch (err) {
    console.error('关闭 HTTP 服务时出错', err)
  }
  try {
    await prisma.$disconnect()
  } catch {
    /* 数据库可能已经断了 */
  }
  closeLogger()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

const app = fastify({ logger: false, bodyLimit: config.bodyLimit })

/**
 * Fastify 自己抛的解析错误（不是我们的 AppError）原文是英文，而翻译表是
 * 「中文原文 → 译文」的结构，查不到就原样返回 —— 结果就是中文界面下冒出
 * 一句英文。这里把会真的回给客户端的几个框架错误换成本项目自己的文案，
 * 余下的（比如 4xx 的媒体类型错误）走原样返回，但状态码仍然正确。
 */
const FRAMEWORK_ERRORS: Record<string, string> = {
  FST_ERR_CTP_BODY_TOO_LARGE: '请求体过大',
  FST_ERR_CTP_INVALID_JSON_BODY: '请求体不是合法的 JSON',
  FST_ERR_CTP_EMPTY_JSON_BODY: '请求体不能为空',
}

app.setErrorHandler((err, req, reply) => {
  const status = typeof (err as { statusCode?: number }).statusCode === 'number'
    ? (err as { statusCode: number }).statusCode
    : 500
  if (status >= 500) console.error(err)
  // 日志里始终是中文原文；只有回给客户端的那一句跟请求语言走
  const raw =
    FRAMEWORK_ERRORS[(err as { code?: string }).code ?? ''] ??
    (err instanceof Error ? err.message : String(err))
  const message = translateError(localeFromRequest(req), {
    message: raw,
    i18n: (err as { i18n?: { key: string; params?: (string | number)[] } }).i18n,
  })
  reply.code(status > 599 ? 500 : status).send({ error: message || t(localeFromRequest(req), '服务器内部错误') })
})

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api')) {
    return reply.code(404).send({ error: t(localeFromRequest(req), '接口不存在') })
  }
  reply.code(404).send({ error: 'Not Found' })
})

/* ---------- 安全响应头 ---------- */

/**
 * helmet 把一组安全响应头统一加上：CSP、`X-Content-Type-Options`、
 * `X-Frame-Options`、`Referrer-Policy` 等等。
 *
 * 有两个默认值必须改掉，否则在**内网 HTTP 部署**下会直接把站点搞挂：
 *
 * 1. **HSTS**（默认开，max-age 半年）。浏览器收到后会记住「这个主机必须走 HTTPS」，
 *    之后再用 `http://` 访问会被自动升级成 `https://` —— 而服务端只有 HTTP，
 *    于是整个站点打不开，并且在 max-age 到期之前很难撤销。所以这里关掉，
 *    **等真正上了 HTTPS 再打开**（见 README「上线前必做」）。
 * 2. **CSP 的 `upgrade-insecure-requests`**。道理同上：它让浏览器把页面里所有
 *    `http://` 请求升级成 `https://`，纯 HTTP 部署下等于全部请求失败。
 *
 * 另外 CSP 这里没有沿用 helmet 的默认策略（`useDefaults: false`），而是按下述原则
 * 逐条写死：本项目是 Vite 构建的单页应用，产物只有**一个外链 module 脚本 + 一个外链 CSS**，
 * 页面里没有内联脚本、没有内联事件处理器、没有 `eval`、没有 Web Worker、没有 blob URL，
 * 因此 `script-src` 可以严格到 `'self'`，连内联脚本属性一起禁掉。
 */
await app.register(helmet, {
  // 见上面的第 1 条：HTTP 部署下发 HSTS 有害，上 HTTPS 后要改回来
  hsts: false,

  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      /**
       * Vue 的 `@click` 编译成 `addEventListener`，产物里没有任何 `onclick=` 这类
       * 内联事件处理器，所以可以彻底禁掉内联脚本属性。
       */
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      /**
       * 必须留 `'unsafe-inline'`：`style-src` 同时兜住了 CSP3 的 `style-src-attr`，
       * 而 Vue 的 `:style`、Element Plus 的定位样式写的都是元素的 style **属性**。
       * 少了它界面会大面积错版（不是「稍微丑一点」，是布局直接散架）。
       */
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      // 前端只调同源接口：开发时 Vite 把 /api 代理到本进程，生产共用一个端口
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      // 不需要被任何页面嵌进 iframe；与下面的 frameguard: deny 互为备份
      frameAncestors: ["'none'"],
      // 注意：**不要**在这里加 upgrade-insecure-requests，理由见上面的第 2 条
    },
  },

  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  // 本站资源只供本站页面加载
  crossOriginResourcePolicy: { policy: 'same-origin' },
  // COEP 是为 SharedArrayBuffer 这类高级特性准备的，本项目用不上，
  // 开了反而会给将来引入任何跨源资源埋雷
  crossOriginEmbedderPolicy: false,
})
console.log('[helmet] 安全响应头已启用；HSTS 未开启（HTTP 部署下发它有害，上 HTTPS 后需打开）')

/* ---------- 跨域 ---------- */

/**
 * 默认**不注册** CORS 插件。
 *
 * 前后端是同源的：开发时 Vite 把 `/api` 代理到本进程，生产共用一个端口。
 * 同源请求不需要 CORS，而随手挂一个宽松的 CORS 是纯粹的敞口 ——
 * `origin: true` 会把任意来源原样回显给浏览器，配合 `credentials: true`
 * 等于允许任意站点带着用户身份调接口。只有确实把前端部署到别的域名时，
 * 才需要在 .env 里用 CORS_ORIGINS 显式列出白名单。
 */
if (config.corsOrigins) {
  const wildcard = config.corsOrigins.includes('*')
  await app.register(cors, {
    origin: wildcard ? '*' : config.corsOrigins,
    // 浏览器不允许 `*` 与 credentials 同时成立，通配时只能放弃携带凭证
    credentials: !wildcard,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Locale'],
  })
  console.log(
    wildcard
      ? '[cors] 已放开任意来源（不带凭证）—— 只建议临时排障时使用'
      : `[cors] 允许的来源：${config.corsOrigins.join('、')}`,
  )
} else {
  console.log('[cors] 未配置 CORS_ORIGINS，仅接受同源请求（默认）')
}

/* ---------- 限流 ---------- */

/**
 * 按 HTTP 请求数限流。
 *
 * 注意它**管不了**两类路径，那些路由上会显式关掉（见各自的 `rateLimit: false`）：
 *   ① 分片上传：一个文件天然就是成百上千个请求；
 *   ② 可续传下载：前端按 4MB 一段顺序发 Range，一个 1GB 的文件就是 256 个请求，
 *      在千兆局域网下一分钟内就超过任何合理的「每分钟请求数」阈值。
 * 这两类都是**一次用户操作引发的连续请求**，按请求数限流只会打到正常用户头上，
 * 所以它们的边界交给别的手段管（并发分片数上限、单文件大小上限、下载次数上限）。
 *
 * 不启用 trustProxy：req.ip 取的就是 TCP 源地址，与本项目「带转发头一律不算本机」
 * 的 fail-closed 口径保持一致。代价是挂在反向代理后面时所有人共用一个限流桶 ——
 * 这是刻意选的保守方向，宁可误伤也不放行。
 */
await app.register(rateLimit, {
  global: true,
  max: config.rateLimitMax,
  timeWindow: 60_000,
  // 注意：这个回调的返回值是被插件 **throw** 出去的（插件默认返回的也是一个
  // 带 statusCode 的 Error），所以这里必须返回 Error 而不是普通对象 ——
  // 返回对象会被当成「非 Error 的异常」，最终变成 500 和一句 [object Object]。
  // 抛 AppError 还有个好处：它会走我们统一的错误处理器，文案自动跟着语言走。
  errorResponseBuilder: (_req, context) => new AppError('请求过于频繁，请稍后再试', context.statusCode),
})

await app.register(multipart, { limits: { fileSize: config.maxUploadSize, files: 1 } })
await registerJwt(app)

await app.register(authRoutes)
await app.register(fileRoutes)
await app.register(uploadRoutes)
await app.register(mountRoutes)
await app.register(shareRoutes)
await app.register(userRoutes)

/* ---------- 前端静态资源（生产环境单端口部署） ---------- */

const webDist = resolveWebDist()
if (webDist) {
  app.get('/*', async (req, reply) => {
    const raw = decodeURIComponent(req.url.split('?')[0] ?? '/')
    // 未命中的 /api 请求必须回 JSON 404，不能被前端路由吞掉
    if (raw === '/api' || raw.startsWith('/api/')) {
      return reply.code(404).send({ error: t(localeFromRequest(req), '接口不存在') })
    }
    const rel = raw.replace(/^\/+/, '') || 'index.html'

    let file: string | null = null
    try {
      const abs = safeJoin(webDist, rel)
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) file = abs
    } catch {
      file = null // 路径越界，当作不存在
    }
    // 前端路由：不带扩展名的路径（如 /s/AbCd）统一回退到 index.html
    if (!file && !path.extname(rel)) {
      const idx = path.join(webDist, 'index.html')
      if (fs.existsSync(idx)) file = idx
    }
    if (!file) return reply.code(404).send({ error: 'Not Found' })

    // 带 hash 的产物可以长期缓存，index.html 必须每次校验
    if (rel.startsWith('assets/')) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      reply.header('Cache-Control', 'no-cache')
    }
    reply.type(MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
    return reply.send(fs.createReadStream(file))
  })
}

// 打包任务留下的临时文件：启动时先扫一遍，之后定时清理
startArchiveCleanup()

/**
 * 健康检查。
 *
 * 这个接口**公开、无需登录**，所以它只回答「活着吗、跑的是哪个版本」。
 * 早期版本把 pid、启动时间、存储根目录、日志路径一起返回，等于对外公布服务器的
 * 目录布局、进程号与运行时长（后者能推断重启与补丁周期）。这些信息排障时确实有用，
 * 但排障的人本来就在服务器旁边 —— 于是改成 **仅本机请求附带诊断字段**。
 *
 * 本机判定复用 `utils/request.ts` 的 fail-closed 实现：只看 TCP 对端地址，
 * 带任何转发头都一律不算本机。因此反向代理部署下会稳定地只给最小集合，
 * 不会因为「所有请求都来自 127.0.0.1」而把诊断信息放给所有人。
 */
app.get('/api/health', async (req, reply) => {
  // 健康检查的意义就是拿当下状态，别让中间层缓存住
  reply.header('Cache-Control', 'no-store')

  const base = {
    ok: true,
    version: buildInfo.version,
    time: new Date().toISOString(),
  }
  if (!isLocalRequest(req)) return base

  return {
    ...base,
    /** ↓ 以下字段仅本机可见 */
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    storageRoot: config.storageRoot,
    logFile: currentLogFile(),
    webDist,
  }
})

/**
 * 版本信息。公开、无需登录：排障时想确认线上跑的是哪个包，
 * 打开这个地址（或看界面侧边栏）就知道，不必登进系统。
 *
 * 这里只放「这个包是什么」，不放运行时状态（pid / 启动时间 / uptime）——
 * 那些属于诊断信息，已经收进 `/api/health` 且仅本机可见。
 */
app.get('/api/version', async (_req, reply) => {
  reply.header('Cache-Control', 'no-store')
  return {
    name: 'ShareEverything',
    version: buildInfo.version,
    builtAt: buildInfo.builtAt,
    mode: buildInfo.mode,
    /** 打包时用的 Node 版本；下面这个是当前进程实际运行的版本，换机器后能看出差异 */
    packedNode: buildInfo.node,
    node: process.version,
  }
})

/** 前端产物目录：优先用配置，其次按部署形态依次探测 */
function resolveWebDist(): string | null {
  const candidates = [
    config.webDist,
    path.resolve(process.cwd(), 'public'),
    path.resolve(process.cwd(), '..', 'public'),
    path.resolve(process.cwd(), '..', 'web', 'dist'),
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      if (fs.existsSync(path.join(p, 'index.html'))) return path.resolve(p)
    } catch {
      /* 路径不可读，换下一个 */
    }
  }
  return null
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

try {
  await app.listen({ port: config.port, host: config.host })
  console.log(`ShareEverything 已启动: http://localhost:${config.port}  (pid ${process.pid})`)
  console.log(`版本: ${versionLabel()}`)
  console.log(`文件存储根目录: ${config.storageRoot}`)
  console.log(`运行日志: ${currentLogFile()}`)
  if (webDist) console.log(`前端静态资源: ${webDist}`)
} catch (err) {
  // 单实例保护：端口就是互斥量。已在运行的实例占着端口时，这里必须明确失败，
  // 而不是让第二个进程起一半、两个进程抢同一个 SQLite。
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') {
    console.error(`[FATAL] 端口 ${config.port} 已被占用，本次启动终止。`)
    console.error('  可能已有一个 ShareEverything 实例在运行（同一份数据库不允许两个进程同时写）。')
    console.error('  查看状态 / 停止旧实例：status.bat、stop.bat；或改 .env 里的 PORT 后重试。')
    closeLogger()
    process.exit(2)
  }
  console.error('[FATAL] 服务启动失败，进程即将退出（守护进程会自动重启）', err)
  closeLogger()
  process.exit(1)
}
