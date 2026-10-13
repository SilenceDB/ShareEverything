/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

/**
 * 一键打包脚本：把前后端编译产物组装成一个可以直接拷走运行的目录。
 *
 *   node scripts/build.mjs          # 产出 dist/
 *   node scripts/build.mjs --zip    # 产出 dist/ 并压缩成 release/*.zip
 *
 * 产出结构：
 *   dist/
 *     server/      后端编译后的 JS（入口 server/index.js）
 *     public/      前端构建产物
 *     prisma/      数据库 schema
 *     package.json 生产依赖（在 dist 里 npm install 即可独立运行）
 *     .env         首次打包时自动生成，含随机 JWT_SECRET；重打包会保留
 *     VERSION      本次发布的版本号（= 发包时刻，如 2026.10.12.1031）
 *     build-info.json  版本号 + 打包时间 + 打包模式
 *     start.bat / start.sh
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
/** 离线包：把生产依赖、Prisma 引擎、Node 运行时全部塞进包里，目标机器断网也能跑 */
const offline = args.includes('--offline') || args.includes('-o')
// --no-zip：只出目录不出压缩包。迭代验证时用，压缩那一步很慢
const wantZip = (offline || args.includes('--zip') || args.includes('-z')) && !args.includes('--no-zip')

const distDir = path.join(root, 'dist')
const releaseDir = path.join(root, 'release')

/* ---------- 发布版本 ---------- */
/**
 * 版本号 = 发包时刻，形如 2026.10.12.1031（年.月.日.时分）。
 *
 * 这个项目没有人工维护的版本梯度，发包时间本身就能唯一定位一次发布，
 * 拿线上显示的版本号就能反查是哪个包、什么时候打的。
 * 用本地时间而不是 UTC：打包的人看到的就是自己表上的时间。
 *
 * 四段数字 npm 是接受的（实测 `npm install` / package-lock 均正常），
 * 所以产物 package.json 的 version 直接用它，不再另编一套号。
 */
const pad2 = (n) => String(n).padStart(2, '0')
const _now = new Date()
const _Y = String(_now.getFullYear())
const _M = pad2(_now.getMonth() + 1)
const _D = pad2(_now.getDate())
const _h = pad2(_now.getHours())
const _m = pad2(_now.getMinutes())
const _s = pad2(_now.getSeconds())
/** 发布版本号，如 2026.10.12.1031 —— 界面、日志、VERSION 文件里显示的就是它 */
const buildVersion = `${_Y}.${_M}.${_D}.${_h}${_m}`
/** 紧凑标记，用于文件名，如 20261012-1031 */
const buildStamp = `${_Y}${_M}${_D}-${_h}${_m}`
/** 精确到秒的打包时刻，用于区分同一分钟内的多次打包 */
const builtAt = `${_Y}-${_M}-${_D} ${_h}:${_m}:${_s}`

let stepNo = 0
function step(title, fn) {
  stepNo++
  process.stdout.write(`\n[${stepNo}] ${title}\n`)
  const t0 = Date.now()
  const r = fn()
  if (r && typeof r.then === 'function') return r.then(finish)
  finish()
  function finish(v) {
    process.stdout.write(`    完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
    return v
  }
}

function fail(msg) {
  console.error(`\n打包失败：${msg}`)
  process.exit(1)
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

/**
 * 手写递归拷贝。
 * 不用 fs.cpSync({recursive:true})：实测在 Windows + Node 22 上会直接把进程干掉
 * （退出码 127 且没有任何报错信息），换成自己遍历就正常了。
 */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name)
    const dst = path.join(to, e.name)
    if (e.isDirectory()) copyDir(src, dst)
    else if (e.isFile()) fs.copyFileSync(src, dst)
    else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst)
  }
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 自带 ZIP 写入器：不依赖 powershell / zip / tar，跨平台一致。
   只做 store（不压缩）—— 前端产物本来就是压缩过的，再压一遍收益极小。 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS 时间戳：本地时间，2038 年后会溢出，但对打包产物足够 */
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f)
  const year = Math.max(1980, d.getFullYear())
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

function listEntries(baseDir) {
  const out = []
  function walk(dir, prefix) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        out.push({ name: name + '/', isDir: true, size: 0 })
        walk(path.join(dir, e.name), name)
      } else if (e.isFile()) {
        out.push({ name, isDir: false, size: fs.statSync(path.join(dir, e.name)).size })
      }
    }
  }
  walk(baseDir, '')
  return out
}

function writeZip(outFile, baseDir, { compress = false } = {}) {
  const entries = listEntries(baseDir)
  const fd = fs.openSync(outFile, 'w')
  const central = []
  let offset = 0
  const { time, date } = dosTime(new Date())

  // 攒批写入：七千个文件逐个 writeSync 要两万多次系统调用，
  // 在某些环境（文件系统被中间层代理时）能占到整个打包 90% 的时间。攒到 8MB 再落一次盘。
  const pending = []
  let pendingBytes = 0
  const FLUSH_AT = 8 * 1024 * 1024
  const probe = { read: 0, crc: 0, deflate: 0, write: 0 }

  function flush() {
    if (pending.length === 0) return
    const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)
    pending.length = 0
    pendingBytes = 0
    const t = Date.now()
    let written = 0
    while (written < buf.length) {
      written += fs.writeSync(fd, buf, written, buf.length - written)
    }
    probe.write += Date.now() - t
  }

  function write(buf) {
    pending.push(buf)
    pendingBytes += buf.length
    offset += buf.length
    if (pendingBytes >= FLUSH_AT) flush()
  }

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    // 只读一遍：小文件无所谓，大文件读两次纯属浪费
    const tRead = Date.now()
    const raw = e.isDir ? null : fs.readFileSync(path.join(baseDir, ...e.name.split('/')))
    probe.read += Date.now() - tRead

    let method = 0
    let crc = 0
    let csize = 0
    let usize = 0
    let payload = null
    if (raw) {
      if (raw.length > 0xffffffff) fail(`zip 暂不支持 4GB 以上的单个文件: ${e.name}`)
      const tCrc = Date.now()
      crc = crc32(raw)
      probe.crc += Date.now() - tCrc
      usize = raw.length
      csize = raw.length
      payload = raw
      // 小文件压缩收益比不上开销，而且 headers 本身也会膨胀
      if (compress && raw.length > 512) {
        // 大文件用 level 1：node.exe 这种 80MB 的二进制，level 1 和 level 6 压出来差不多，
        // 速度却快十几倍（整包压缩时间从 3 分钟降到十几秒）
        const tDef = Date.now()
        const def = zlib.deflateRawSync(raw, { level: raw.length > 8 * 1024 * 1024 ? 1 : 6 })
        probe.deflate += Date.now() - tDef
        if (def.length < raw.length) {
          method = 8
          payload = def
          csize = def.length
        }
      }
    }

    // 本地文件头：bit 11 表示文件名是 UTF-8，否则中文名在 Windows 资源管理器里乱码
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(csize, 18)
    lh.writeUInt32LE(usize, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    write(lh)
    write(nameBuf)
    if (payload) write(payload)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(csize, 20)
    cd.writeUInt32LE(usize, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(e.isDir ? 0x41ed0010 : 0x81a40000, 38) // 目录带 / 结尾属性
    cd.writeUInt32LE(offset - csize - 30 - nameBuf.length, 42)
    central.push(cd, nameBuf)
  }

  const cdStart = offset
  let cdSize = 0
  for (const b of central) {
    cdSize += b.length
    write(b)
  }

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdStart, 16)
  eocd.writeUInt16LE(0, 20)
  write(eocd)
  flush()
  fs.closeSync(fd)
  process.stdout.write(
    `    明细: 读取 ${(probe.read / 1000).toFixed(1)}s / CRC ${(probe.crc / 1000).toFixed(1)}s` +
      ` / 压缩 ${(probe.deflate / 1000).toFixed(1)}s / 写入 ${(probe.write / 1000).toFixed(1)}s\n`,
  )
}

// 已有的 .env 要先捞出来，重打包时不能把用户改过的配置冲掉
const envPath = path.join(distDir, '.env')
const preservedEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null

console.log('ShareEverything 打包')
console.log(`项目根目录: ${root}`)
console.log(`输出目录  : ${distDir}`)
console.log(`发布版本  : ${buildVersion}（${builtAt}）`)
console.log(`打包模式  : ${offline ? '离线包（含依赖与 Node 运行时）' : '标准包（目标机器需 npm install）'}`)

await step('清理旧产物', () => {
  rmrf(distDir)
  rmrf(path.join(root, 'server', 'dist'))
  rmrf(path.join(root, 'web', 'dist'))
})

await step('编译后端（tsc）', () => {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!fs.existsSync(tsc)) fail(`找不到 tsc: ${tsc}`)
  const r = spawnSync(process.execPath, [tsc, '-p', path.join(root, 'server', 'tsconfig.json')], {
    stdio: 'inherit',
    cwd: path.join(root, 'server'),
  })
  if (r.status !== 0) fail('后端 TypeScript 编译未通过')
})

await step('构建前端（vite）', async () => {
  const vite = await import(pathToFileURL(path.join(root, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href)
  await vite.build({ root: path.join(root, 'web'), logLevel: 'warn' })
})

await step('组装产物目录', () => {
  const serverOut = path.join(root, 'server', 'dist')
  const webOut = path.join(root, 'web', 'dist')
  if (!fs.existsSync(path.join(serverOut, 'index.js'))) fail('后端产物缺失 entry: server/dist/index.js')
  if (!fs.existsSync(path.join(webOut, 'index.html'))) fail('前端产物缺失 index.html')

  copyDir(serverOut, path.join(distDir, 'server'))
  copyDir(webOut, path.join(distDir, 'public'))
  // 只带 schema，不带开发用的 dev.db
  fs.mkdirSync(path.join(distDir, 'prisma'), { recursive: true })
  fs.copyFileSync(
    path.join(root, 'server', 'prisma', 'schema.prisma'),
    path.join(distDir, 'prisma', 'schema.prisma'),
  )
})

await step('生成运行配置', () => {
  const serverPkg = JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8'))
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const pm2Version =
    rootPkg.devDependencies?.pm2 ?? rootPkg.dependencies?.pm2 ?? '^7.0.0'

  const pkg = {
    name: 'share-everything',
    version: buildVersion,
    private: true,
    type: 'module',
    main: 'server/index.js',
    scripts: {
      start: 'node tools/ctl.mjs start',
      stop: 'node tools/ctl.mjs stop',
      status: 'node tools/ctl.mjs status',
      logs: 'node tools/ctl.mjs logs',
      'db:push': 'prisma db push --schema prisma/schema.prisma',
      postinstall: 'prisma generate --schema prisma/schema.prisma',
    },
    // pm2 是运行期依赖：守护进程要用它，所以目标机器 npm install 就得装到，
    // 不能留在 devDependencies 里。
    dependencies: { ...(serverPkg.dependencies ?? {}), pm2: pm2Version },
    devDependencies: { prisma: serverPkg.devDependencies?.prisma ?? '^6.0.0' },
    engines: { node: '>=20' },
  }
  fs.writeFileSync(
    path.join(distDir, 'package.json'),
    JSON.stringify(pkg, null, 2) + '\n',
    'utf8',
  )

  // 版本号落到产物根目录：VERSION 给人（和外部脚本）直接看，build-info.json 给程序读。
  // 后端启动时会读它们，界面、日志、/api/version 里显示的版本都来自这里，
  // 所以「现在跑的是哪个包」不用靠猜。
  fs.writeFileSync(path.join(distDir, 'VERSION'), buildVersion + '\n', 'utf8')
  fs.writeFileSync(
    path.join(distDir, 'build-info.json'),
    JSON.stringify(
      {
        name: 'share-everything',
        version: buildVersion,
        builtAt,
        mode: offline ? 'offline' : 'standard',
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  process.stdout.write(`    发布版本: ${buildVersion}（${builtAt}）\n`)

  // .env：首次生成，重打包保留用户改动
  if (preservedEnv) {
    fs.writeFileSync(envPath, preservedEnv, 'utf8')
    process.stdout.write('    保留已存在的 .env\n')
  } else {
    const secret = crypto.randomBytes(32).toString('hex')
    const env = [
      '# 首次打包自动生成。JWT_SECRET 已是随机值，请不要外泄此文件。',
      '',
      'PORT=3000',
      'HOST=0.0.0.0',
      'JWT_SECRET=' + secret,
      'JWT_EXPIRES_IN=7d',
      '',
      '# SQLite 相对路径以 prisma/schema.prisma 所在目录为基准',
      'DATABASE_URL="file:./dev.db"',
      '',
      '# 运行时数据都放在 dist 目录下（相对启动目录）',
      'STORAGE_ROOT=./storage',
      'TMP_ROOT=./storage/.tmp',
      'ARCHIVE_ROOT=./storage/.archive',
      '# 硬盘不够用时：把 storage 整个搬到大盘，再把 STORAGE_ROOT 指过去即可（推荐）；',
      '# 或保持默认路径，用目录联接把它挂到大盘：mklink /J storage E:\\se-storage',
      '# STORAGE_ROOT=E:\\se-storage',
      '',
      '# 运行日志：按天滚动成 app-YYYY-MM-DD.log，只保留最近 LOG_KEEP_DAYS 天',
      'LOG_DIR=./logs',
      'LOG_KEEP_DAYS=14',
      '',
      '# 管理员密码找回（默认关闭）。打开后可用管理员账号在登录页直接重设密码，',
      '# 应对「管理员忘记密码」。该通道只认服务器本机（127.0.0.1 / localhost），',
      '# 所以要在服务器上打开 http://127.0.0.1:3000 操作；用完请改回 false，',
      '# 开着的时候本机任何错密码都会被写成新密码。',
      'ALLOW_ADMIN_RESET_PASSWORD=false',
      '',
      '# 谁能发布磁盘目录：ADMIN = 仅管理员，USER = 任何登录用户',
      'MOUNT_CREATE_ROLE=ADMIN',
      '',
      '# 允许发布、以及选择器可浏览的路径范围，分号（或竖线）分隔。',
      '# 不配置 = 默认收窄到 <安装目录>/Download（自动创建）；写 * = 不限制。',
      '# 想接第二块盘，把新盘路径追加到这一行即可，例如：',
      '# MOUNT_ALLOWED_ROOTS=D:\\SharedEverything;E:\\media',
      '# MOUNT_ALLOWED_ROOTS=',
      '',
    ].join('\n')
    fs.writeFileSync(envPath, env, 'utf8')
    process.stdout.write('    已生成新的 .env（随机 JWT_SECRET）\n')
  }

  fs.copyFileSync(
    path.join(root, 'server', '.env.example'),
    path.join(distDir, '.env.example'),
  )

  // 启动 / 守护脚本从模板目录整份拷进来。
  // 放在 scripts/dist-template/ 里的好处：它们是能直接读、直接改、能单独验证的真文件，
  // 而不是埋在这个打包脚本里的长字符串。
  copyDir(path.join(root, 'scripts', 'dist-template'), distDir)
  // .bat 一律转成 CRLF：cmd.exe 解析 LF 结尾的批处理时，跳到标签/语句拼接容易出错
  for (const f of fs.readdirSync(distDir).filter((f) => f.endsWith('.bat'))) {
    const p = path.join(distDir, f)
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'), 'utf8')
  }
  if (fs.existsSync(path.join(distDir, 'start.sh'))) {
    fs.chmodSync(path.join(distDir, 'start.sh'), 0o755)
  }

  const head = offline
    ? [
        '## 前置条件',
        '',
        '**什么都不用装。** 依赖、Prisma 引擎、Node 运行时、pm2 守护进程都已经打进包里，目标机器断网可用。',
        '',
        '## 启动',
        '',
        'Windows：**双击 `start.bat`**。它会做三件事：按当前路径生成 pm2 配置 → 启动服务 → 打印状态。',
        '',
        'Linux / macOS：',
        '',
        '```bash',
        './start.sh',
        '```',
        '',
        '不需要 `npm install`，也不需要 `npm run db:push`——数据库已经在打包时建好了。',
      ]
    : [
        '## 前置条件',
        '',
        '本机需要 **Node 20 或更高版本**（命令行执行 `node -v` 可查）。这个目录里只有程序代码，不含依赖和 Node 运行时。',
        '',
        '## 首次运行（三条命令）',
        '',
        '```bash',
        'npm install          # 装生产依赖（含 pm2），会自动 prisma generate',
        'npm run db:push      # 建表，生成 prisma/dev.db',
        '```',
        '',
        '之后每次**双击 `start.bat`** 即可（Linux / macOS 用 `./start.sh`）。',
      ]

  const tree = offline
    ? [
        '| 路径 | 内容 |',
        '| --- | --- |',
        '| `start.bat` 等脚本 | 启动 / 停止 / 重启 / 状态 / 日志 / 开机自启，双击即用 |',
        '| `tools/` | 脚本背后的实现（Node 写的），`.bat` 只是包装 |',
        '| `node/` | 自带的 Node 运行时，脚本优先用它 |',
        '| `node_modules/` | 已装好的生产依赖，含 pm2 与 Prisma 引擎 |',
        '| `server/` | 后端编译产物，入口 `server/index.js` |',
        '| `public/` | 前端静态资源，由后端直接托管 |',
        '| `prisma/dev.db` | **已建好表**的 SQLite 库，开箱即用 |',
        '| `logs/` | 运行日志，`app-YYYY-MM-DD.log` 按天滚动 |',
        '| `storage/` | 上传的文件、分片临时目录、打包临时文件 |',
        '| `.pm2/` | pm2 守护进程的状态，放到包内以便整个目录可以搬走 |',
        '| `ecosystem.config.json` | 守护参数，首次启动自动生成，可手动调 |',
        '| `.env` | 运行配置。**已生成随机 JWT_SECRET，请勿外泄** |',
        '| `VERSION` / `build-info.json` | 本次发布的版本号与打包时间（版本号即发包时间） |',
      ]
    : [
        '| 路径 | 内容 |',
        '| --- | --- |',
        '| `start.bat` 等脚本 | 启动 / 停止 / 重启 / 状态 / 日志 / 开机自启，双击即用 |',
        '| `tools/` | 脚本背后的实现（Node 写的），`.bat` 只是包装 |',
        '| `server/` | 后端编译产物，入口 `server/index.js` |',
        '| `public/` | 前端静态资源，由后端直接托管 |',
        '| `prisma/` | 数据库 schema，运行 `db:push` 后生成 `dev.db` |',
        '| `logs/` | 运行日志，`app-YYYY-MM-DD.log` 按天滚动 |',
        '| `storage/` | 上传的文件、分片临时目录、打包临时文件 |',
        '| `.pm2/` | pm2 守护进程的状态，放到包内以便整个目录可以搬走 |',
        '| `ecosystem.config.json` | 守护参数，首次启动自动生成，可手动调 |',
        '| `.env` | 运行配置。**已生成随机 JWT_SECRET，请勿外泄** |',
        '| `VERSION` / `build-info.json` | 本次发布的版本号与打包时间（版本号即发包时间） |',
      ]

  fs.writeFileSync(
    path.join(distDir, '运行说明.md'),
    [
      '# ShareEverything 部署说明',
      '',
      `（${offline ? '离线包：自带 Node 运行时与全部依赖' : '标准包：需要目标机器联网 npm install'}）`,
      '',
      `**发布版本：${buildVersion}**（打包于 ${builtAt}）`,
      '',
      ...head,
      '',
      '## 日常操作',
      '',
      '| 双击这个 | 作用 |',
      '| --- | --- |',
      '| `start.bat` | 启动服务（已经在跑就跳过，不会起第二个） |',
      '| `status.bat` | 看守护状态 + 探一次 HTTP 健康检查 |',
      '| `logs.bat` | 实时跟随日志，Ctrl+C 退出 |',
      '| `restart.bat` | 重启 |',
      '| `stop.bat` | 停止（连 pm2 守护一起收掉，内存彻底释放） |',
      '| `clean-logs.bat` | 清理 pm2 抓取的日志与超期日志，然后自动重启 |',
      '| `autostart-on.bat` / `autostart-off.bat` | 注册 / 取消开机自启（需管理员权限） |',
      '',
      '命令行等价写法（Linux / macOS 也能用）：',
      '',
      '```bash',
      'node tools/ctl.mjs start|stop|restart|status|logs|clean-logs|autostart on|off',
      '```',
      '',
      '## 启动之后',
      '',
      '- 浏览器打开 http://localhost:3000 —— 前端和 API 共用同一个端口，不需要 Nginx 反代',
      '- **第一个注册的账号自动成为管理员**；它一旦建好，登录页的注册入口就自动消失（没有开关可配）',
      '- 改端口：编辑 `.env` 里的 `PORT` 后 restart.bat',
      '- 服务在后台运行，**关掉命令行窗口不影响它**',
      '- 查当前跑的是哪个版本：界面侧边栏左下角的版本号，或直接访问 http://localhost:3000/api/version',
      '',
      '## 保活与守护',
      '',
      '服务由 pm2 托管，实际行为：',
      '',
      '- 进程意外退出（崩溃、未捕获异常、被任务管理器结束）会在 3 秒后自动拉起',
      '- 反复重启会指数退避，不会把 CPU 和日志刷爆；连续 20 次不稳定重启后停下来，避免无限重启',
      '- 内存超过 1GB 会自动重启，防止长时间运行后越吃越多',
      '- 重启前先走优雅退出（关 HTTP 服务 → 断开数据库），8 秒还没退干净才强杀',
      '- **单实例**：端口就是互斥量。已有实例在跑时新的会拒绝启动并提示，不会出现两个进程抢同一个数据库',
      '- 开机自启：跑一次 `autostart-on.bat`（右键以管理员身份运行）注册计划任务，之后登录 Windows 就自动启动',
      '',
      '要调这些参数，改 `ecosystem.config.json` 里的 `max_memory_restart` / `restart_delay` / `max_restarts` 等，然后 restart.bat。',
      '',
      '## 日志',
      '',
      '| 文件 | 说明 |',
      '| --- | --- |',
      '| `logs/app-YYYY-MM-DD.log` | **主日志**，按天滚动，自动保留最近 14 天（`LOG_KEEP_DAYS` 可调） |',
      '| `logs/pm2-out.log` / `pm2-error.log` | pm2 抓的同一份控制台输出，内容与主日志重复 |',
      '',
      '主日志跟着进程走，不用 pm2 也能看；`logs.bat` 就是读它。',
      'pm2 那两个文件由它自己一直持有句柄，Windows 上没法从外部截断或删除，',
      '所以给了一个 `clean-logs.bat`：先停服释放句柄，再删文件，最后自动重启。',
      '',
      '## 目录说明',
      '',
      ...tree,
      '',
      '## 数据放在哪',
      '',
      '上传的文件、打包临时文件、SQLite 数据库都在这个目录下（`storage/` 与 `prisma/dev.db`）。',
      '整个目录拷贝走就是完整备份；反过来，**删掉这个目录里的数据就等于清空所有内容**。',
      '',
      '这个目录可以整体搬到别的盘或别的机器：启动脚本每次都按当前位置重算路径。',
      '搬动后如果 `ecosystem.config.json` 里的路径对不上，会自动重新生成，原文件备份为 `.bak`。',
      '',
      '## 上线前必做',
      '',
      '1. 改 `.env` 里的 `JWT_SECRET`（默认已是随机值，换环境请手动改一个）',
      '2. 配置 `MOUNT_ALLOWED_ROOTS`，限制可发布的目录范围',
      '3. 确认 `ALLOW_ADMIN_RESET_PASSWORD` 是 `false`（只在管理员忘密码时临时打开，且只能从服务器本机操作）',
      '4. 用 HTTPS（登录 token 会出现在 URL query 里）',
      '5. 用低权限系统账号启动进程',
      '',
      '## 版本号',
      '',
      '版本号就是**发包时刻**，形如 `2026.10.12.1031`（年.月.日.时分），紧凑形式是 `20261012-1031`。',
      '每次打包生成一个新号，同时写进三处：',
      '',
      '- `VERSION` —— 单行版本号，给人看、给外部脚本读',
      '- `build-info.json` —— 版本号 + 打包时间 + 打包模式 + 打包时的 Node 版本',
      '- `package.json` 的 `version` —— 让 npm 那边也认得这个版本',
      '',
      '压缩包名里用的是紧凑形式，两者一一对应。所以一个版本号唯一对应一次打包，',
      '拿到线上显示的版本号就能反查是哪个包、什么时候打的。',
      '服务运行时会读这些文件：界面侧边栏左下角、启动日志、`/api/version` 显示的版本都来自它。',
      '',
      '## 重新打包',
      '',
      '在源码目录执行 `npm run pack:offline`（离线包）或 `npm run pack`（标准包）。',
      '已存在的 `dist/.env` 会被保留，不会被覆盖；版本号则每次按新的发包时刻重新生成。',
      '',
    ].join('\n'),
    'utf8',
  )
})

/* ---------- 离线包才做的三件事：装依赖 / 生成 Client + 建库 / 塞 Node ---------- */

if (offline) {
  await step('安装生产依赖到包内', () => {
    const npmCli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    )
    if (!fs.existsSync(npmCli)) fail(`找不到 npm-cli.js: ${npmCli}`)
    // 跳过 postinstall：Prisma Client 由下一步用源码目录里的 CLI 生成，
    // 这样包里就不用带 prisma CLI（能省几十 MB）
    const r = spawnSync(
      process.execPath,
      [npmCli, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: distDir, stdio: 'inherit' },
    )
    if (r.status !== 0) fail('在包内安装生产依赖失败（这一步需要联网）')
    const nm = path.join(distDir, 'node_modules')
    if (!fs.existsSync(nm)) fail('node_modules 没有生成')
  })

  await step('生成 Prisma Client 并预建数据库', () => {
    const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js')
    if (!fs.existsSync(prismaCli)) fail(`找不到 prisma CLI: ${prismaCli}`)
    const schema = path.join('prisma', 'schema.prisma')

    const gen = spawnSync(process.execPath, [prismaCli, 'generate', '--schema', schema], {
      cwd: distDir,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: 'file:./dev.db' },
    })
    if (gen.status !== 0) fail('prisma generate 失败')

    // 预建表：目标机器就不用装 prisma CLI、也不用跑 db:push 了
    const push = spawnSync(process.execPath, [prismaCli, 'db', 'push', '--schema', schema, '--skip-generate'], {
      cwd: distDir,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: 'file:./dev.db' },
    })
    if (push.status !== 0) fail('prisma db push 失败，未能预建数据库')
    const dbFile = path.join(distDir, 'prisma', 'dev.db')
    if (!fs.existsSync(dbFile)) fail('预建数据库文件不存在')
    process.stdout.write(`    数据库已预建: prisma/dev.db (${(fs.statSync(dbFile).size / 1024).toFixed(0)} KB)\n`)
  })

  await step('捆绑 Node 运行时', () => {
    if (process.platform === 'win32') {
      const dst = path.join(distDir, 'node', 'node.exe')
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(process.execPath, dst)
      process.stdout.write(`    已捆绑 ${process.version} (${(fs.statSync(dst).size / 1024 / 1024).toFixed(0)} MB)\n`)
    } else {
      // POSIX 上 node 是共享库依赖的动态可执行文件，只拷二进制在部分发行版上跑不起来
      const dst = path.join(distDir, 'node', 'bin', 'node')
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(process.execPath, dst)
      fs.chmodSync(dst, 0o755)
      process.stdout.write(
        `    已捆绑 ${process.version}（仅二进制；跨发行版/glibc 版本时可能需要在目标机重装 Node）\n`,
      )
    }
  })
}

let zipFile = null
if (wantZip) {
  await step('压缩成 zip', () => {
    fs.mkdirSync(releaseDir, { recursive: true })
    // 包名里带同一个版本号（紧凑形式，与 VERSION 文件里的点分形式一一对应）。
    // 同一分钟内重复打包时补上秒，免得把刚打出来的包覆盖掉。
    const base = `share-everything-${offline ? 'offline-' : ''}${buildStamp}`
    zipFile = path.join(releaseDir, `${base}.zip`)
    if (fs.existsSync(zipFile)) zipFile = path.join(releaseDir, `${base}-${_s}.zip`)
    if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile)
    // 离线包里有 node.exe（80MB+）这类可压缩的大文件，在线包产物基本已压缩过，压了反而不划算
    writeZip(zipFile, distDir, { compress: offline })
    const size = fs.statSync(zipFile).size
    process.stdout.write(`    归档: ${zipFile} (${(size / 1024 / 1024).toFixed(2)} MB)\n`)
  })
}

/* ------------------------------------------------------------------ */

console.log('\n打包完成')
console.log(`  发布版本: ${buildVersion}（${builtAt} 打包）`)
console.log(`  产物目录: ${distDir}`)
if (offline) {
  console.log('  运行方式: 把 dist 拷到目标机器，双击 start.bat（无需 npm install / 无需联网）')
} else {
  console.log(`  运行方式: cd ${distDir} && npm install && npm run db:push，然后双击 start.bat`)
}
console.log('  守护     : start.bat / stop.bat / restart.bat / status.bat / logs.bat')
if (zipFile) console.log(`  压缩包  : ${zipFile}`)
console.log('')
