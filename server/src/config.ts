/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import dotenv from 'dotenv'

dotenv.config()

const serverRoot = process.cwd()

function resolveDir(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(serverRoot, p)
  fs.mkdirSync(abs, { recursive: true })
  return abs
}

/**
 * 磁盘发布允许的路径范围，分号（或竖线）分隔。
 *
 * 默认收窄到 <运行目录>/Download —— 也就是安装包里的 Download 目录（自动创建）。
 * 这同时约束两件事：① 只能把该范围内的路径发布出去；② 选择器弹窗只能浏览到这儿。
 * 「能登录就能发布任意目录」的旧行为需要显式写 MOUNT_ALLOWED_ROOTS=* 才会开启。
 */
/**
 * 把配置里的根目录解析成**真实路径**（展开 junction / 软链接）。
 *
 * 必须与「发布时对目标做的 realpathSync」保持同一基准。否则会出现这样一对矛盾：
 * 把 Download 整个做成指向大容量磁盘的目录联接（junction）之后，
 * 选择器能正常浏览（pickerRoots 会对根做 realpath），但一点「发布」就被 403
 * 拦下（这里拿未展开的路径去比）。目录还不存在时退回解析后的字面路径。
 */
function realRootOrSame(p: string): string {
  const abs = path.resolve(p)
  try {
    return fs.realpathSync(abs)
  } catch {
    return abs
  }
}

const rawMountRoots = (process.env.MOUNT_ALLOWED_ROOTS ?? '').trim()
const mountRootsUnrestricted = rawMountRoots === '*'
const mountAllowedRoots: string[] = mountRootsUnrestricted
  ? []
  : rawMountRoots
    ? rawMountRoots
        .split(/[;|]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => realRootOrSame(s))
    : [realRootOrSame(resolveDir('./Download'))]

/**
 * 代码与模板里出现过的占位密钥。见到它们等同于「没配」。
 */
const PLACEHOLDER_SECRETS = new Set([
  'please-change-this-secret',
  'dev-secret-please-change',
  'change-me',
  'secret',
])

/**
 * 解析 JWT 签名密钥，优先级：环境变量 → 持久化文件 → 现场生成并落盘。
 *
 * 为什么要有「落盘」这一层：源码直跑（没有 .env）、或者用户把 .env 里的
 * JWT_SECRET 删掉时，绝不能退回一个**写在代码里的**固定密钥 —— 那个值是公开的，
 * 任何人拿它就能签出管理员令牌。生成的文件与 .env / dev.db 同级，是运行时文件，
 * 已在 .gitignore 里；打包脚本 build.mjs 首次生成 .env 时也会写入随机值。
 */
function resolveJwtSecret(): { secret: string; source: 'env' | 'file' | 'generated' } {
  const fromEnv = (process.env.JWT_SECRET ?? '').trim()
  if (fromEnv && !PLACEHOLDER_SECRETS.has(fromEnv)) return { secret: fromEnv, source: 'env' }

  const file = path.join(serverRoot, '.jwt-secret')
  try {
    const saved = fs.readFileSync(file, 'utf8').trim()
    if (saved.length >= 32) return { secret: saved, source: 'file' }
  } catch {
    /* 第一次运行，往下走生成 */
  }
  const secret = crypto.randomBytes(48).toString('base64url')
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 })
  return { secret, source: 'generated' }
}

const jwtSecret = resolveJwtSecret()

/**
 * 允许跨域访问的来源白名单，逗号或分号分隔。
 *
 * 默认**为空**，而空的意思是「根本不注册 CORS 插件」—— 本应用前后端同源
 * （开发时靠 Vite 代理，生产共用一个端口），同源请求压根不需要 CORS。
 * 原来的 `origin: true` 会把任意来源原样回显并允许携带凭证，是纯敞口。
 * 写 `*` 表示放开任意来源，此时会强制放弃凭证（浏览器不允许两者并存）。
 */
const rawCorsOrigins = (process.env.CORS_ORIGINS ?? '').trim()
const corsOrigins: string[] | null = rawCorsOrigins
  ? rawCorsOrigins
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  : null

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  /** JWT 签名密钥。永远不会是硬编码的固定值，来源见 resolveJwtSecret */
  jwtSecret: jwtSecret.secret,
  /** 密钥来源：env = .env 里配的；file = 复用上次生成的；generated = 本次新生成（启动时会提示） */
  jwtSecretSource: jwtSecret.source,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  /**
   * JSON / urlencoded 请求体的全局上限。
   *
   * 默认只给 1MB：Fastify 会把非 multipart 的请求体**整个缓冲进内存**，
   * 原来的 2GB 意味着任意一个巨大的 JSON 请求就能把内存打出一个尖峰。
   * 文件上传走 multipart，不受这里约束（见 index.ts 里对上传路由的单独放宽）。
   */
  bodyLimit: Number(process.env.BODY_LIMIT ?? 1024 * 1024),
  /** 跨域来源白名单；null = 不注册 CORS（同源部署的正确状态） */
  corsOrigins,
  /** 全局限流：每个 IP 每分钟的请求数上限 */
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 1200),
  /** 登录接口限流：每个 IP 在窗口内的尝试次数上限 */
  rateLimitLoginMax: Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 10),
  /** 登录限流的窗口长度（分钟） */
  rateLimitLoginWindowMinutes: Number(process.env.RATE_LIMIT_LOGIN_WINDOW_MINUTES ?? 5),
  /** 高开销的公开接口（整目录打包、建打包任务）每个 IP 每分钟的上限 */
  rateLimitArchiveMax: Number(process.env.RATE_LIMIT_ARCHIVE_MAX ?? 120),
  /**
   * 提取码连续错误多少次之后暂时拒绝（同一个 IP + 同一个分享单独计数）。
   * 计数只累加**失败**，校验成功即清零 —— 详见 utils/guard.ts。
   */
  accessCodeMaxFails: Number(process.env.ACCESS_CODE_MAX_FAILS ?? 8),
  /** 上面这个计数的滑动窗口长度（秒） */
  accessCodeWindowSeconds: Number(process.env.ACCESS_CODE_WINDOW_SECONDS ?? 600),
  databaseUrl: process.env.DATABASE_URL ?? 'file:./dev.db',
  /** 上传文件的存储根目录 */
  storageRoot: resolveDir(process.env.STORAGE_ROOT ?? './storage'),
  /** 生产环境下前端静态资源目录，留空则自动探测 public / ../web/dist */
  webDist: process.env.WEB_DIST ?? '',
  /** 运行日志目录（按天滚动成 app-YYYY-MM-DD.log） */
  logDir: resolveDir(process.env.LOG_DIR ?? './logs'),
  /** 日志保留天数，超出后删最旧的 */
  logKeepDays: Number(process.env.LOG_KEEP_DAYS ?? 14),
  /** 单个文件上传上限（字节） */
  maxUploadSize: Number(process.env.MAX_UPLOAD_SIZE ?? 2 * 1024 * 1024 * 1024),
  /** 分片上传的默认分片大小（字节），前端可覆盖 */
  chunkSize: Number(process.env.CHUNK_SIZE ?? 5 * 1024 * 1024),
  /** 分片大小下限，防止用极小分片刷出海量小文件 */
  minChunkSize: Number(process.env.MIN_CHUNK_SIZE ?? 512 * 1024),
  /** 分片大小上限，同时也是服务端处理单个分片时的内存峰值 */
  maxChunkSize: Number(process.env.MAX_CHUNK_SIZE ?? 32 * 1024 * 1024),
  /** 单个任务允许的最大分片数，超过会自动放大分片大小 */
  maxChunksPerTask: Number(process.env.MAX_CHUNKS_PER_TASK ?? 3000),
  /** 同一用户同时在传的分片数上限（前端并发数不可信，服务端必须自己挡） */
  maxConcurrentChunks: Number(process.env.MAX_CONCURRENT_CHUNKS ?? 8),
  /** 未完成分片的临时存放目录 */
  tmpRoot: resolveDir(process.env.TMP_ROOT ?? './storage/.tmp'),
  /** 超过这个天数未完成的上传任务会被清理 */
  uploadTaskTtlDays: Number(process.env.UPLOAD_TASK_TTL_DAYS ?? 3),
  /**
   * 是否允许通过登录页重设管理员密码（默认否）。
   *
   * 应对「管理员把密码忘了，进不去系统」的场景：开启后，用管理员账号
   * 在登录页提交一个校验不通过的新密码，就会把该账号的密码改成它并直接登录。
   * 这等于把入口整个放开，用完请立刻改回 false。
   */
  allowAdminResetPassword: (process.env.ALLOW_ADMIN_RESET_PASSWORD ?? 'false') === 'true',
  /**
   * 谁能发布磁盘目录：USER = 任何登录用户，ADMIN = 仅管理员。
   * 磁盘发布是全站共享的，发布一个目录等于把它广播给所有登录用户，
   * 所以默认收窄到管理员；确认所有人互信时可改成 USER。
   */
  mountCreateRole: (process.env.MOUNT_CREATE_ROLE ?? 'ADMIN').toUpperCase() === 'USER' ? 'USER' : 'ADMIN',
  /**
   * 可选的路径白名单，分号分隔，例如 D:\share;C:\Users\Public
   * 不配置时默认取 <运行目录>/Download（自动创建）；写 * 表示不限制。
   * 详见文件下方 isMountPathAllowed。
   */
  mountAllowedRoots,
  /** 路径范围是否完全不限制（MOUNT_ALLOWED_ROOTS=*） */
  mountRootsUnrestricted,
  /** 目录打包：单次打包的文件数上限 */
  zipMaxFiles: Number(process.env.ZIP_MAX_FILES ?? 50000),
  /** 目录打包：单次的原始字节总量上限（默认 20GB） */
  zipMaxTotalBytes: Number(process.env.ZIP_MAX_TOTAL_BYTES ?? 20 * 1024 * 1024 * 1024),
  /** 目录打包：遍历深度上限，同时是软链接成环的兜底 */
  zipMaxDepth: Number(process.env.ZIP_MAX_DEPTH ?? 32),
  /** 同时允许的打包请求数，超出的排队等待 */
  zipConcurrency: Number(process.env.ZIP_CONCURRENCY ?? 2),
  /**
   * 默认压缩档位：store = 只打包不压缩（最快，能算出精确 Content-Length）
   * smart = 影音/图片/已压缩包走 store，其余走 deflate（默认）
   * deflate = 全部压缩（level 9 由前端档位决定，这里是默认值）
   */
  zipDefaultMode: (['store', 'smart', 'deflate'] as const).includes(
    (process.env.ZIP_DEFAULT_MODE ?? 'smart').toLowerCase() as 'store' | 'smart' | 'deflate',
  )
    ? ((process.env.ZIP_DEFAULT_MODE ?? 'smart').toLowerCase() as 'store' | 'smart' | 'deflate')
    : ('smart' as const),
  /**
   * 单个文件走 deflate 的体积上限。压缩需要把结果攒在内存里才知道大小，
   * 超限的大文件强制退回 store，避免内存被单个超大文件撑爆。
   */
  zipDeflateMaxFileBytes: Number(process.env.ZIP_DEFLATE_MAX_FILE_BYTES ?? 256 * 1024 * 1024),
  /** 预检结果缓存秒数（同一个分享短时间内重复点开不必反复遍历） */
  zipPlanCacheTtl: Number(process.env.ZIP_PLAN_CACHE_TTL ?? 60),
  /** 同一个分享两次打包之间的最小间隔（秒），防止反复点击把 CPU 打满 */
  zipThrottleSeconds: Number(process.env.ZIP_THROTTLE_SECONDS ?? 60),
  /** 后台打包任务的临时文件存放目录 */
  archiveRoot: resolveDir(process.env.ARCHIVE_ROOT ?? './storage/.archive'),
  /** 打包结果保留小时数，过期后临时文件与记录一起清理 */
  archiveJobTtlHours: Number(process.env.ARCHIVE_JOB_TTL_HOURS ?? 6),
  /** 原始体积超过这个值就建议走后台打包（同步流式太容易中途断掉） */
  archiveAsyncThresholdBytes: Number(
    process.env.ARCHIVE_ASYNC_THRESHOLD_BYTES ?? 2 * 1024 * 1024 * 1024,
  ),
  /** 文件数超过这个值也建议走后台打包 */
  archiveAsyncThresholdFiles: Number(process.env.ARCHIVE_ASYNC_THRESHOLD_FILES ?? 2000),
  /** 同时存在的打包任务数上限（含排队与进行中） */
  archiveMaxJobs: Number(process.env.ARCHIVE_MAX_JOBS ?? 8),
  /** 过期任务扫描间隔（分钟） */
  archiveCleanupIntervalMinutes: Number(process.env.ARCHIVE_CLEANUP_INTERVAL_MINUTES ?? 30),
}

function sameOrChild(root: string, target: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  const r = norm(root)
  const t = norm(target)
  return t === r || t.startsWith(r + path.sep)
}

/**
 * 检查要发布的路径是否在允许范围内。
 * 传入的应已是 realpath 解析后的真实路径，否则软链接可能绕过白名单。
 */
export function isMountPathAllowed(realAbsPath: string): boolean {
  if (config.mountRootsUnrestricted) return true
  return config.mountAllowedRoots.some((r) => sameOrChild(r, realAbsPath))
}

/** 当前用户是否有权发布磁盘目录 */
export function canCreateMount(role: string): boolean {
  return config.mountCreateRole === 'USER' || role === 'ADMIN'
}

export function userStorageDir(userId: string): string {
  const dir = path.join(config.storageRoot, 'users', userId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 分片临时目录。uploadId 必须来自数据库查询结果（不能直接用请求参数拼路径），
 * 否则会变成目录穿越入口。
 */
export function uploadTmpDir(userId: string, uploadId: string): string {
  const dir = path.join(config.tmpRoot, userId, uploadId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
