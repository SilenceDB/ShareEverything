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
 * 生成一张自签证书，让内网在没有 CA、也没有域名的情况下也能直接开 HTTPS。
 *
 *   node tools/gen-cert.mjs                          # 读运行目录下的 cert-hosts.conf；空配置则自动收集网卡 IP
 *   node tools/gen-cert.mjs --host se.internal       # 临时追加一个名字，可重复
 *   node tools/gen-cert.mjs --config other.conf      # 换一份配置（同样在运行目录下）
 *   node tools/gen-cert.mjs --days 3650 --no-env     # 只生成证书，不动 .env
 *
 * 访问名从三处汇总，按下面的优先级：
 *
 * 1. **恒定项**：`127.0.0.1` / `localhost` / `::1` 无条件写进 SAN。本机调试、
 *    curl 探活、服务自检都靠它们，不该因为「没配置」就把本机访问弄丢。
 * 2. **配置文件**（默认 `cert-hosts.conf`，和 `.env` 同一个层级，即运行目录根）：
 *    每行一个域名或 IP。写了任意一项就以它为准，不再自动收集网卡地址 —— 配置里
 *    写 IP 意味着这个 IP 是固定的，没必要每次生成都去探测。没有配置或全是注释时
 *    才退回自动收集。
 * 3. **命令行 --host**：临时追加，和配置项合并去重。
 *
 * 另外两个刻意的设计：SAN 条目的类型必须和名字匹配（IP 写 `IP.x`、域名写
 * `DNS.x`，写反了浏览器永远匹配不上）；生成完顺手改 `.env`（`--no-env` 可关），
 * 手抄路径最容易写错斜杠，而那类错误报的是「读取证书失败」，看着像文件没了。
 *
 * 依赖系统 openssl（1.1.1 以上）。Linux 发行版基本自带；Windows 上随 Git 一起装。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const certDir = path.join(root, 'certs')
const certPath = path.join(certDir, 'server.crt')
const keyPath = path.join(certDir, 'server.key')

/* ---------------- 参数 ---------------- */

function printHelp() {
  console.log(`用法: node tools/gen-cert.mjs [选项]

  --host <ip或域名>   临时追加一个访问名，可重复
  --config <文件>     访问名配置文件，默认读运行目录下的 cert-hosts.conf
                      （和 .env 同一个层级）；文件不存在时退回自动收集网卡 IP
  --auto-ip           配置文件和自动收集的网卡 IP 都写入证书
  --days <天数>       有效期，默认 3650（10 年）
  --no-env            只生成证书，不修改 .env
  -h, --help          显示本帮助

示例：
  node tools/gen-cert.mjs                    # 读 cert-hosts.conf，没有就自动收集
  node tools/gen-cert.mjs --host se.internal # 临时加一个域名（客户机配 hosts）
  # 客户机 hosts 加一行： <服务器当前IP>  se.internal
  # 之后 IP 再变只改这一行，证书与客户端信任都不用动`)
}

const extraHosts = []
let configFile = ''
let autoIp = false
let days = 3650
let writeEnv = true

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const take = () => argv[++i]
  if (a === '--host') {
    const v = take()
    if (!v) {
      console.error('--host 后面要跟一个地址')
      process.exit(2)
    }
    extraHosts.push(v)
  } else if (a.startsWith('--host=')) {
    extraHosts.push(a.slice('--host='.length))
  } else if (a === '--config') {
    const v = take()
    if (!v) {
      console.error('--config 后面要跟一个文件名')
      process.exit(2)
    }
    configFile = v
  } else if (a.startsWith('--config=')) {
    configFile = a.slice('--config='.length)
  } else if (a === '--auto-ip') {
    autoIp = true
  } else if (a === '--days') {
    days = Number(take()) || 0
  } else if (a.startsWith('--days=')) {
    days = Number(a.slice('--days='.length)) || 0
  } else if (a === '--no-env') {
    writeEnv = false
  } else if (a === '-h' || a === '--help') {
    printHelp()
    process.exit(0)
  } else {
    console.error(`未知参数：${a}`)
    printHelp()
    process.exit(2)
  }
}
if (!Number.isInteger(days) || days < 1 || days > 36500) {
  console.error('--days 需要是 1 到 36500 之间的整数')
  process.exit(2)
}

/* ---------------- 找 openssl ---------------- */

/**
 * Windows 上 openssl 通常不在 PATH 里（它随 Git 装），所以按常见位置再找一遍。
 * 找不到就明确告诉用户怎么办，而不是抛一个 ENOENT 让人猜。
 */
function findOpenssl() {
  const candidates = ['openssl']
  if (process.platform === 'win32') {
    for (const base of [
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
      'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
    ]) {
      candidates.push(base)
    }
  }
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['version'], { stdio: 'ignore' })
    if (r.status === 0) return cmd
  }
  return null
}

const openssl = findOpenssl()
if (!openssl) {
  console.error('找不到 openssl，无法生成证书。')
  console.error('  Linux:  yum install -y openssl  或  apt-get install -y openssl')
  console.error('  Windows: 安装 Git 时会自带（C:\\Program Files\\Git\\usr\\bin\\openssl.exe）')
  console.error('也可以改用公司内部 CA 签发的证书，直接把路径写进 .env 的 TLS_CERT / TLS_KEY。')
  process.exit(1)
}

const ver = spawnSync(openssl, ['version'], { encoding: 'utf8' }).stdout?.trim() ?? ''
console.log(`使用 ${ver}`)

/* ---------------- 收集地址 ---------------- */

const isIpv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s)
const isIpv6 = (s) => s.includes(':')

const hosts = []
const pushHost = (h) => {
  const v = String(h ?? '').trim()
  if (v && !hosts.includes(v)) hosts.push(v)
}

// 回环与主机名先放进去：本机调试、curl 探活都要用得上
pushHost('127.0.0.1')
pushHost('localhost')
pushHost(os.hostname())
// 最后一个 IPv6 回环，有些环境会优先解析成 ::1
pushHost('::1')

/**
 * 从配置文件里逐行取访问名：去掉注释（# 及其后内容）与空白，每行一个。
 * 返回有效条目数组；文件不存在或读不了时返回空数组（由调用方决定回退）。
 */
function readConfigEntries(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    // 行内注释：从第一个 # 截断（域名/IP 里不会出现 #，安全）
    const line = raw.split('#')[0].trim()
    if (line) out.push(line)
  }
  return out
}

// 配置文件名：命令行指定用指定的，否则默认运行目录下的 cert-hosts.conf，
// 与 .env 同一个层级。相对路径一律以运行目录（root）为基准，和 .env 对齐。
const confPath = configFile
  ? path.resolve(root, configFile)
  : path.join(root, 'cert-hosts.conf')

const confEntries = readConfigEntries(confPath)

if (confEntries.length) {
  // 配置里写了内容，就以它为准，不再自动收集网卡地址（写 IP 说明 IP 是固定的）
  for (const h of confEntries) pushHost(h)
  console.log(`访问名取自配置文件：${confPath}（${confEntries.length} 项）`)
} else {
  if (configFile && !fs.existsSync(confPath)) {
    console.log(`未找到配置文件 ${confPath}，退回自动收集本机网卡 IP。`)
  } else if (configFile) {
    console.log(`配置文件 ${confPath} 为空或全是注释，退回自动收集本机网卡 IP。`)
  } else {
    console.log('未配置访问名（cert-hosts.conf 不存在或为空），自动收集本机网卡 IP。')
  }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) pushHost(ni.address)
    }
  }
}

// 命令行 --host 与 --auto-ip 里的网卡地址，作为补充项合并进去
if (autoIp) {
  console.log('--auto-ip：额外并入本机网卡 IP。')
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) pushHost(ni.address)
    }
  }
}
for (const h of extraHosts) pushHost(h)

/**
 * 用户显式指定的域名。IP 会变的场景下它是唯一稳定的名字，所以既拿来做 CN，
 * 也拿来做末尾提示里的访问地址（现代浏览器只看 SAN，但一些老客户端仍会看 CN）。
 * 域名来源：命令行 --host 优先，其次配置文件里的域名项。
 */
const namedHost =
  extraHosts.find((h) => !isIpv4(h) && !isIpv6(h)) ??
  confEntries.find((h) => !isIpv4(h) && !isIpv6(h))

/* ---------------- 生成配置与证书 ---------------- */

const cn = namedHost ?? hosts.find((h) => !isIpv4(h) && h !== '::1') ?? hosts[0]
/**
 * SAN 条目的类型必须和人一样对：IP 写成 `DNS:` 的话，浏览器按域名去匹配
 * 一个 IP 字面量，永远匹配不上。IPv6 也走 `IP:` 分支（写法是 `IP:::1`，
 * `IP:` 前缀后面直接跟地址，不需要方括号）。
 */
const isAddr = (s) => isIpv4(s) || isIpv6(s)
const altLines = hosts.map((h, i) =>
  isAddr(h) ? `IP.${i + 1} = ${h}` : `DNS.${i + 1} = ${h}`,
)

const cnf = [
  '[req]',
  'prompt = no',
  'distinguished_name = dn',
  'x509_extensions = v3',
  '',
  '[dn]',
  'C = CN',
  'O = ShareEverything',
  `CN = ${cn}`,
  '',
  '[v3]',
  'basicConstraints = critical,CA:FALSE',
  'keyUsage = critical,digitalSignature,keyEncipherment',
  'extendedKeyUsage = serverAuth',
  'subjectAltName = @alt',
  '',
  '[alt]',
  ...altLines,
  '',
].join('\n')

fs.mkdirSync(certDir, { recursive: true })
const cnfPath = path.join(certDir, '.gen.cnf')
fs.writeFileSync(cnfPath, cnf, 'utf8')

console.log(`\n生成证书：${days} 天有效期，SAN 共 ${hosts.length} 项`)
const gen = spawnSync(
  openssl,
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    String(days),
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-config',
    cnfPath,
    '-extensions',
    'v3',
  ],
  { encoding: 'utf8' },
)

// 配置文件里有 SAN 列表，属于中间产物，不留在目录里
try {
  fs.unlinkSync(cnfPath)
} catch {
  /* 删不掉也不影响使用 */
}

if (gen.status !== 0) {
  console.error('生成失败：')
  console.error((gen.stderr || gen.stdout || '').trim())
  process.exit(1)
}

// 私钥只给属主读：同一台机器上还有其他账号时，这个权限区别很重要
try {
  fs.chmodSync(keyPath, 0o600)
} catch {
  /* Windows 上 chmod 基本无效，跳过 */
}

/* ---------------- 回显证书摘要 ---------------- */

const info = spawnSync(
  openssl,
  ['x509', '-in', certPath, '-noout', '-subject', '-dates', '-fingerprint', '-sha256', '-ext', 'subjectAltName'],
  { encoding: 'utf8' },
)
console.log('')
console.log((info.stdout || '').trim())
console.log('')
console.log(`证书: ${certPath}`)
console.log(`私钥: ${keyPath}`)

/* ---------------- 写入 .env ---------------- */

const envPath = path.join(root, '.env')
const certRel = path.relative(root, certPath).split(path.sep).join('/')
const keyRel = path.relative(root, keyPath).split(path.sep).join('/')

if (!writeEnv) {
  console.log('\n按要求未修改 .env。请手动设置：')
  console.log(`  TLS_CERT=${certRel}`)
  console.log(`  TLS_KEY=${keyRel}`)
} else if (!fs.existsSync(envPath)) {
  console.log('\n未找到 .env（先启动一次会自动生成），请手动加入：')
  console.log(`  TLS_CERT=${certRel}`)
  console.log(`  TLS_KEY=${keyRel}`)
} else {
  const text = fs.readFileSync(envPath, 'utf8')
  if (/^\s*TLS_CERT\s*=\s*\S/m.test(text) && /^\s*TLS_KEY\s*=\s*\S/m.test(text)) {
    const same =
      new RegExp(`^\\s*TLS_CERT\\s*=\\s*${certRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text)
    console.log(
      same
        ? '\n.env 里已经指向这份证书，无需改动。'
        : '\n.env 里已配置过 TLS_CERT / TLS_KEY，为免覆盖你的设置没有改动。请确认它们指向正确：',
    )
    if (!same) {
      console.log(`  TLS_CERT=${certRel}`)
      console.log(`  TLS_KEY=${keyRel}`)
    }
  } else {
    // 把样例里的注释行替换掉，避免同一个键出现两次（注释行无害，但看起来乱）
    let next = text
      .replace(/^#\s*TLS_CERT\s*=.*$/m, `TLS_CERT=${certRel}`)
      .replace(/^#\s*TLS_KEY\s*=.*$/m, `TLS_KEY=${keyRel}`)

    // 样例里没有注释行时，追加到末尾
    if (!/^\s*TLS_CERT\s*=/m.test(next)) {
      const block = [
        '',
        '# 由 tools/gen-cert.mjs 写入（自签证书）',
        `TLS_CERT=${certRel}`,
        `TLS_KEY=${keyRel}`,
        '',
      ].join('\n')
      if (!next.endsWith('\n')) next += '\n'
      next += block
    }
    fs.writeFileSync(envPath, next, 'utf8')
    console.log(`\n已写入 .env：TLS_CERT=${certRel} / TLS_KEY=${keyRel}`)
  }
}

/* ---------------- 后续步骤 ---------------- */

/**
 * 显式指定的域名优先当访问地址。否则明明签了一张带域名的证书，最后却提示
 * 用 IP 访问 —— 那样域名方案等于白设，IP 一变又回到「证书不匹配」。
 */
const addr =
  namedHost ?? hosts.find((h) => isIpv4(h) && h !== '127.0.0.1') ?? hosts[0]
const port = (() => {
  try {
    const m = fs.readFileSync(envPath, 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m)
    return m ? Number(m[1]) : 3000
  } catch {
    return 3000
  }
})()

console.log('')
console.log('下一步：')
console.log('  1. 重启服务：restart.bat（Linux: ./start.sh restart）')
console.log('  2. 浏览器访问时会提示「不安全」，因为这张证书不是公信 CA 签的。')
console.log('     这是预期行为，不是配置错误。两种处理方式：')
console.log('       · 内网长期使用：把 certs/server.crt 导入客户端「受信任的根证书颁发机构」')
console.log('       · 临时验证：点「高级」→ 继续前往')
console.log(`  3. 访问地址改用 https：https://${addr}:${port}`)
if (namedHost) {
  console.log('')
  console.log(`  4. 每台客户机把 ${namedHost} 解析到服务器 IP：`)
  console.log('       Windows   C:\\Windows\\System32\\drivers\\etc\\hosts')
  console.log('       Linux/Mac /etc/hosts')
  console.log('     加一行： <服务器当前IP>  ' + namedHost)
  console.log('     之后 IP 再变只改这一行，证书与客户端信任都不用动。')
  console.log('     域名别用 .local（mDNS 保留），推荐 .internal 或 .home.arpa。')
}
console.log('')
console.log('提示：证书建议连同私钥一起备份。换机器重新生成不影响已分享的数据，')
console.log('      但客户端要重新信任一次新证书。')
