/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import crypto from 'node:crypto'
import { config } from '../config.js'
import { AppError } from './fs.js'

/**
 * 提取码的**可逆**加密存储。
 *
 * 为什么是可逆而不是哈希：提取码需要能反复回显——创建者过了几天回来，还得能看见
 * 自己当初设的是什么，拿去发给别人。哈希方案只能做到「只显示一次，忘了就重置」。
 * 这是产品取舍，代价是「加密密钥」本身成了需要保管的东西。
 *
 * 威胁模型定得很明确：**只泄露了数据库、没泄露密钥**（手动拷 dev.db 去备份、
 * 排查问题时把库发给别人、SQLite 的 -wal / 空闲页残留）。整盘沦陷时，
 * 库文件和 Download 都在同一块盘上，加不加密已经没有区别。
 *
 * 加密形状（单列文本，自描述）：
 *
 *     v1:<salt>:<iv>:<tag>:<ciphertext>
 *
 * 全部 base64url。四段都定长或带长度前缀，解析不会歧义。
 *
 * 两道密钥派生：
 *   1. 配置里的 `ACCESS_CODE_KEY` → scrypt(固定盐) → **主密钥**。这一层是为了
 *      容忍人类可读的口令：口令直接当 AES 密钥熵不够，scrypt 把爆破成本拉高。
 *      进程内只算一次（scrypt 是故意的慢函数，不能每条记录都算）。
 *   2. 主密钥 + **每条记录独立的随机盐** → HKDF-SHA256 → **记录密钥**。
 *      这就是「加密前先加盐」：同样的提取码在库里得到完全不同的密文，
 *      彩虹表失效，一条记录被攻破也不影响其他记录（密钥不跨记录复用）。
 *      HKDF 很快，所以这里可以每条都算，不必缓存。
 *
 * 完整性由 AES-GCM 的认证标签保证：密文被改一个字节，解密直接抛错，
 * 不会得到一段「看起来合法」的垃圾。不需要额外挂 HMAC。
 */

const VERSION = 'v1'
const SEP = ':'

/** 每条记录的盐长度。16 字节足够，且和 IV 分开，不复用 */
const SALT_BYTES = 16
/** GCM 推荐的 IV 长度 */
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

/**
 * scrypt 参数。N=2^15、r=8、p=1 —— 单次约 30~80ms、占 32MB 内存，
 * 对「人手敲的口令」是一个合理的成本点，对一个进程只算一次又完全不痛。
 * maxmem 必须显式给，Node 默认上限是 32MB，刚好卡在边界上会报错。
 */
const MASTER_N = 1 << 15
const MASTER_R = 8
const MASTER_P = 1
const MASTER_MAXMEM = 64 * 1024 * 1024

/** 派生主密钥用的固定盐。它不需要保密，作用只是让派生结果不与别的用途撞车 */
const MASTER_SALT = Buffer.from('ShareEverything/access-code#master', 'utf8')
/** HKDF 的 info，同样只是用途隔离 */
const RECORD_INFO = Buffer.from('ShareEverything/access-code#record', 'utf8')

/** 提取码长度范围。太短的码（比如 "1"）在库泄露后基本等于没有 */
export const ACCESS_CODE_MIN = 4
export const ACCESS_CODE_MAX = 64

/**
 * 随机生成用的字符表：去掉了 0/O/1/I/L 这些肉眼分不清的字符。
 * 32 个符号 × 8 位 ≈ 1.1e12 种，配合失败次数节流足够挡在线爆破。
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

/** 解密失败（密钥变更、密文被改）专用，好让调用方与「码不对」区分开 */
export class AccessCodeCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccessCodeCryptoError'
  }
}

let cachedMaster: Buffer | null = null

/**
 * 主密钥，惰性派生并缓存。
 *
 * 不在模块顶层直接算，是为了让「没配提取码功能」的进程（比如只想跑单元测试）
 * 不必白付这几十毫秒；一旦有分享被创建或校验，就会算这一次然后一直复用。
 */
function masterKey(): Buffer {
  if (cachedMaster) return cachedMaster
  cachedMaster = crypto.scryptSync(config.accessCodeKey, MASTER_SALT, KEY_BYTES, {
    N: MASTER_N,
    r: MASTER_R,
    p: MASTER_P,
    maxmem: MASTER_MAXMEM,
  })
  return cachedMaster
}

/** 主密钥 + 本条记录的盐 → 本条记录的数据密钥 */
function recordKey(salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey(), salt, RECORD_INFO, KEY_BYTES))
}

/** 是不是加密后的存储格式。老数据（明文）返回 false，据此做兼容与懒迁移 */
export function isEncryptedCode(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(`${VERSION}${SEP}`)
}

/**
 * 加密一个提取码，返回可直接写库的字符串。
 * 每次调用都会生成新的盐和 IV，所以同一个码两次加密的结果不同 —— 这正是要的效果。
 */
export function encryptAccessCode(plain: string): string {
  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', recordKey(salt), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    salt.toString('base64url'),
    iv.toString('base64url'),
    tag.toString('base64url'),
    body.toString('base64url'),
  ].join(SEP)
}

/**
 * 解密。**只接受密文**，明文请走 readAccessCode。
 * 格式不对、密钥换了、密文被改过，都会抛 AccessCodeCryptoError。
 */
export function decryptAccessCode(stored: string): string {
  const parts = stored.split(SEP)
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new AccessCodeCryptoError('提取码密文格式不正确')
  }
  const [, saltB64, ivB64, tagB64, bodyB64] = parts
  const salt = Buffer.from(saltB64, 'base64url')
  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const body = Buffer.from(bodyB64, 'base64url')
  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new AccessCodeCryptoError('提取码密文长度异常')
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', recordKey(salt), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // 认证失败给不出更细的原因，也不该给：能区分的细节等于给攻击者一个试探口
    throw new AccessCodeCryptoError('提取码无法解密')
  }
}

/**
 * 读出提取码明文。
 *
 * 兼容升级前写进去的明文：没有 `v1:` 前缀就原样返回，由调用方决定何时懒迁移。
 * 这样老库不需要停机迁移，第一次被访问到哪条就转哪条。
 */
export function readAccessCode(stored: string | null | undefined): string | null {
  if (!stored) return null
  return isEncryptedCode(stored) ? decryptAccessCode(stored) : stored
}

/**
 * 规整并校验用户填的提取码。空值表示「不要提取码」，返回 null。
 *
 * 原来这里是 `body.accessCode || null`，完全没有约束 —— 能设成 "1"。
 * 库泄露后这种码不用爆破，看一眼就出来了，所以长度下限是实质性的防线，
 * 不是形式主义。上限与字符集约束则是为了不让控制字符混进日志和比对逻辑。
 */
export function normalizeAccessCode(raw: unknown): string | null {
  if (raw == null) return null
  if (typeof raw !== 'string') throw new AppError('提取码格式不正确')
  const code = raw.trim()
  if (!code) return null
  if (code.length < ACCESS_CODE_MIN || code.length > ACCESS_CODE_MAX) {
    throw new AppError(`提取码长度需在 ${ACCESS_CODE_MIN}-${ACCESS_CODE_MAX} 位之间`, 400, {
      key: '提取码长度需在 {}-{} 位之间',
      params: [ACCESS_CODE_MIN, ACCESS_CODE_MAX],
    })
  }
  // 控制字符（含换行、NUL）在日志里会被截断，在界面上也看不见，没有保留的理由
  if (/[\u0000-\u001F\u007F]/.test(code)) {
    throw new AppError('提取码不能包含控制字符或换行')
  }
  return code
}

/** 生成一个随机提取码，给界面上的「随机生成」按钮用 */
export function generateAccessCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH)
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    // 256 % 32 == 0，直接取模不会引入偏置
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  return out
}
