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
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { config } from '../config.js'
import { isEscapeLink } from './fs.js'

/**
 * 目录打包：零依赖的流式 ZIP 生成器。
 *
 * 设计要点：
 * - 只依赖 Node 内置模块。store 模式自己拼字节，deflate 模式用内置 zlib。
 * - 全程流式：不落临时文件、不在内存里攒整个压缩包，边遍历边发。
 * - 生成函数与 HTTP 解耦，返回的就是一个 Readable，将来要做「后台打包任务」
 *   直接把同一个流 pipe 到临时文件即可，无需重写。
 */

export type ZipMode = 'store' | 'smart' | 'deflate'

const SKIP_NAMES = new Set([
  '$RECYCLE.BIN',
  'System Volume Information',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
])

/** 已经压过的格式再压一遍几乎没收益，只有 CPU 开销 */
const INCOMPRESSIBLE = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'rmvb',
  'mp3', 'flac', 'wav', 'aac', 'ogg', 'wma', 'm4a', 'opus',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'heic', 'avif',
  'zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'zst', 'tar', 'iso', 'jar', 'apk', 'exe', 'msi', 'dmg',
])

function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** 判断某个文件在这个档位下是否走 deflate */
export function shouldDeflate(name: string, size: number, mode: ZipMode): boolean {
  if (mode === 'store') return false
  if (size <= 0 || size > config.zipDeflateMaxFileBytes) return false
  if (mode === 'deflate') return true
  return !INCOMPRESSIBLE.has(ext(name))
}

export interface ArchiveEntry {
  /** 磁盘上的绝对路径 */
  abs: string
  /** 压缩包内的路径，用 / 分隔，目录以 / 结尾 */
  name: string
  size: number
  mtime: Date
  isDir: boolean
  /** 生成时是否走 deflate（已考虑档位、体积上限） */
  useDeflate: boolean
}

export interface ArchivePlan {
  entries: ArchiveEntry[]
  fileCount: number
  dirCount: number
  totalBytes: number
  /** 会被压缩的文件数，前端据此判断有没有精确进度 */
  deflateCount: number
  /** 因无权限 / 逃逸链接 / 系统文件而跳过的条目数 */
  skipped: number
  /** 命中限额被截断 */
  truncated: boolean
  /** 截断原因，truncated 为 true 时有值 */
  truncatedBy: 'files' | 'bytes' | 'depth' | null
  /** 是否启用 ZIP64 */
  zip64: boolean
  /**
   * 压缩包的总字节数。只有没有任何文件走 deflate 时才能精确计算，
   * 否则返回 null（响应改为 chunked，前端只能显示已下载字节数）。
   */
  zipBytes: number | null
}

function cmpKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** DOS 时间戳：ZIP 的元祖格式，最小年份 1980 */
function dosStamp(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

function zipBytesOf(entries: ArchiveEntry[], zip64: boolean): number | null {
  let n = 22 + (zip64 ? 56 + 20 : 0)
  for (const e of entries) {
    const nl = Buffer.byteLength(e.name, 'utf8')
    // 本地头 + 名字 + zip64 扩展
    n += 30 + nl + (zip64 ? 20 : 0)
    if (!e.isDir) {
      if (e.useDeflate) return null // 压缩后多大无法预知
      n += e.size + (zip64 ? 24 : 16) // 数据 + 数据描述符
    }
    // 中央目录项
    n += 46 + nl + (zip64 ? 32 : 0)
  }
  return n
}

/**
 * 遍历目录，产出打包清单。
 *
 * rootAbs 用于判定软链接是否逃逸（沿用既有的根内放行 / 根外拦截语义），
 * targetAbs 是要打包的那个目录，topName 是压缩包里的顶层目录名。
 */
export function planDirectory(
  rootAbs: string,
  targetAbs: string,
  topName: string,
  mode: ZipMode = config.zipDefaultMode,
): ArchivePlan {
  const entries: ArchiveEntry[] = []
  const visited = new Set<string>([cmpKey(targetAbs)])
  let fileCount = 0
  let dirCount = 0
  let totalBytes = 0
  let deflateCount = 0
  let skipped = 0
  let truncated = false
  let truncatedBy: ArchivePlan['truncatedBy'] = null

  const stop = (reason: NonNullable<ArchivePlan['truncatedBy']>) => {
    truncated = true
    truncatedBy = reason
  }

  const top = topName.replace(/\\/g, '/').replace(/^\/+/, '') || 'archive'
  const topStat = fs.statSync(targetAbs)
  entries.push({
    abs: targetAbs,
    name: `${top}/`,
    size: 0,
    mtime: topStat.mtime,
    isDir: true,
    useDeflate: false,
  })
  dirCount++

  function walk(dir: string, prefix: string, depth: number): void {
    if (truncated) return
    if (depth > config.zipMaxDepth) {
      stop('depth')
      return
    }
    let list: fs.Dirent[]
    try {
      list = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      skipped++
      return
    }

    for (const d of list) {
      if (truncated) return
      if (SKIP_NAMES.has(d.name)) {
        skipped++
        continue
      }
      const full = path.join(dir, d.name)
      // 指向根外部的软链接直接跳过（根内的软链接照常打包原始内容）
      if (isEscapeLink(rootAbs, full)) {
        skipped++
        continue
      }

      let st: fs.Stats
      try {
        st = fs.statSync(full)
      } catch {
        skipped++
        continue
      }
      const name = `${prefix}/${d.name}`

      if (st.isDirectory()) {
        // 软链接成环的保护：同一个真实目录不进第二次
        let real: string
        try {
          real = fs.realpathSync(full)
        } catch {
          skipped++
          continue
        }
        const key = cmpKey(real)
        if (visited.has(key)) {
          skipped++
          continue
        }
        visited.add(key)
        if (fileCount + dirCount >= config.zipMaxFiles) {
          stop('files')
          return
        }
        entries.push({ abs: full, name: `${name}/`, size: 0, mtime: st.mtime, isDir: true, useDeflate: false })
        dirCount++
        walk(full, name, depth + 1)
        continue
      }

      if (!st.isFile()) {
        skipped++
        continue
      }
      if (fileCount + dirCount >= config.zipMaxFiles) {
        stop('files')
        return
      }
      if (totalBytes + st.size > config.zipMaxTotalBytes) {
        stop('bytes')
        return
      }
      const useDeflate = shouldDeflate(d.name, st.size, mode)
      if (useDeflate) deflateCount++
      entries.push({ abs: full, name, size: st.size, mtime: st.mtime, isDir: false, useDeflate })
      fileCount++
      totalBytes += st.size
    }
  }

  walk(targetAbs, top, 1)

  // zip64 的判定依赖总大小，而总大小又受 zip64 扩展长度影响，
  // 所以先按非 zip64 估一次，再决定是否重算。
  let zip64 = false
  const approx = zipBytesOf(entries, false)
  if (
    entries.length > 65535 ||
    entries.some((e) => e.size > 0xfffffffe) ||
    (approx != null && approx > 0xfffffffe) ||
    (approx == null && totalBytes > 0xfffffffe)
  ) {
    zip64 = true
  }

  return {
    entries,
    fileCount,
    dirCount,
    totalBytes,
    deflateCount,
    skipped,
    truncated,
    truncatedBy,
    zip64,
    zipBytes: zipBytesOf(entries, zip64),
  }
}

/** Node 20.15+ 提供原生 crc32；老版本回退到表驱动实现 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

function crc32Js(buf: Buffer, prev = 0): number {
  let c = ~prev >>> 0
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return ~c >>> 0
}

type CrcFn = (data: Buffer, value?: number) => number
const nativeCrc = (zlib as unknown as { crc32?: CrcFn }).crc32
const crc32: CrcFn =
  typeof nativeCrc === 'function'
    ? (data, value) => nativeCrc(data, value ?? 0) >>> 0
    : (data, value) => crc32Js(data, value ?? 0) >>> 0

function zip64LocalExtra(): Buffer {
  const b = Buffer.alloc(20)
  b.writeUInt16LE(0x0001, 0)
  b.writeUInt16LE(16, 2)
  // 实际大小写进数据描述符，这里留 0
  return b
}

function zip64CentralExtra(usize: number, csize: number, offset: number): Buffer {
  const b = Buffer.alloc(32)
  b.writeUInt16LE(0x0001, 0)
  b.writeUInt16LE(28, 2)
  b.writeBigUInt64LE(BigInt(usize), 4)
  b.writeBigUInt64LE(BigInt(csize), 12)
  b.writeBigUInt64LE(BigInt(offset), 20)
  b.writeUInt32LE(0, 28) // 起始磁盘号
  return b
}

/** 读取一个文件并压缩（结果攒在内存里，调用方已保证体积不超过上限） */
async function deflateFile(
  abs: string,
  level: number,
): Promise<{ data: Buffer; crc: number; usize: number }> {
  const chunks: Buffer[] = []
  let crc = 0
  let usize = 0
  const def = zlib.createDeflateRaw({ level })
  def.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<void>((resolve, reject) => {
    def.on('end', () => resolve())
    def.on('error', reject)
  })
  const src = fs.createReadStream(abs)
  try {
    for await (const chunk of src) {
      const buf = chunk as Buffer
      crc = crc32(buf, crc)
      usize += buf.length
      if (!def.write(buf)) {
        await new Promise((r) => def.once('drain', r))
      }
    }
    def.end()
    await done
  } catch (e) {
    def.destroy()
    src.destroy()
    throw e
  }
  return { data: Buffer.concat(chunks), crc: crc >>> 0, usize }
}

export interface ArchiveStreamOptions {
  /**
   * 每写完一个条目回调一次：done 是已完成的条目序号（从 1 开始），
   * bytesWritten 是到目前为止写出的总字节数。后台打包任务靠它上报进度。
   */
  onEntry?: (done: number, bytesWritten: number) => void
}

/**
 * 按清单生成 ZIP 字节流。
 *
 * 所有文件条目统一使用「数据描述符」（general purpose bit 3）：
 * 本地文件头里不写 CRC 和大小，数据发完后再补一段描述符。
 * 这样每个文件只需要读一遍磁盘 —— 否则 store 模式为了在头里填 CRC
 * 必须先整读一次、发送时再读一次，机械盘上直接翻倍。
 */
export function createArchiveStream(plan: ArchivePlan, opts: ArchiveStreamOptions = {}): Readable {
  const zip64 = plan.zip64

  async function* generate(): AsyncGenerator<Buffer> {
    const central: Buffer[] = []
    let cdSize = 0
    let offset = 0
    let done = 0

    const emit = (buf: Buffer): Buffer => {
      offset += buf.length
      return buf
    }

    for (const e of plan.entries) {
      const nameBuf = Buffer.from(e.name, 'utf8')
      const { time, date } = dosStamp(e.mtime)
      const localExtra = zip64 ? zip64LocalExtra() : Buffer.alloc(0)

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(zip64 ? 45 : 20, 4)
      // bit 11 = 文件名是 UTF-8（中文名不乱码的关键）；bit 3 = 大小写在数据描述符里
      local.writeUInt16LE(e.isDir ? 0x0800 : 0x0808, 6)
      local.writeUInt16LE(e.useDeflate ? 8 : 0, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(0, 14) // crc，描述符里给
      local.writeUInt32LE(zip64 ? 0xffffffff : 0, 18) // compressed size
      local.writeUInt32LE(zip64 ? 0xffffffff : 0, 22) // uncompressed size
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(localExtra.length, 28)

      const localOffset = offset
      yield emit(local)
      yield emit(nameBuf)
      if (localExtra.length) yield emit(localExtra)

      let crc = 0
      let csize = 0
      let usize = 0

      if (e.isDir) {
        // 目录条目没有数据，也没有描述符
      } else if (e.useDeflate) {
        try {
          const out = await deflateFile(e.abs, 6)
          crc = out.crc
          csize = out.data.length
          usize = out.usize
          yield emit(out.data)
        } catch {
          // 读失败（权限 / 文件被占用）就当作 0 字节条目，压缩包结构仍然完整
          crc = 0
          csize = 0
          usize = 0
        }
      } else {
        try {
          const src = fs.createReadStream(e.abs)
          for await (const chunk of src) {
            const buf = chunk as Buffer
            crc = crc32(buf, crc)
            usize += buf.length
            csize += buf.length
            yield emit(buf)
          }
        } catch {
          /* 读失败同上，跳过内容 */
        }
        crc = crc >>> 0
      }

      if (!e.isDir) {
        const desc = Buffer.alloc(zip64 ? 24 : 16)
        desc.writeUInt32LE(0x08074b50, 0)
        desc.writeUInt32LE(crc >>> 0, 4)
        if (zip64) {
          desc.writeBigUInt64LE(BigInt(csize), 8)
          desc.writeBigUInt64LE(BigInt(usize), 16)
        } else {
          desc.writeUInt32LE(csize, 8)
          desc.writeUInt32LE(usize, 12)
        }
        yield emit(desc)
      }

      done++
      opts.onEntry?.(done, offset)

      const centralExtra = zip64 ? zip64CentralExtra(usize, csize, localOffset) : Buffer.alloc(0)
      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(0x02014b50, 0)
      cd.writeUInt16LE(zip64 ? 45 : 20, 4)
      cd.writeUInt16LE(zip64 ? 45 : 20, 6)
      cd.writeUInt16LE(0x0800, 8)
      cd.writeUInt16LE(e.useDeflate ? 8 : 0, 10)
      cd.writeUInt16LE(time, 12)
      cd.writeUInt16LE(date, 14)
      cd.writeUInt32LE(crc >>> 0, 16)
      cd.writeUInt32LE(zip64 ? 0xffffffff : csize, 20)
      cd.writeUInt32LE(zip64 ? 0xffffffff : usize, 24)
      cd.writeUInt16LE(nameBuf.length, 28)
      cd.writeUInt16LE(centralExtra.length, 30)
      cd.writeUInt16LE(0, 32) // 注释长度
      cd.writeUInt16LE(0, 34) // 起始磁盘号
      cd.writeUInt16LE(0, 36) // 内部属性
      cd.writeUInt32LE(e.isDir ? 0x10 : 0, 38) // 外部属性：目录位
      cd.writeUInt32LE(zip64 ? 0xffffffff : localOffset, 42)
      cdSize += cd.length + nameBuf.length + centralExtra.length
      central.push(cd, nameBuf, centralExtra)
    }

    const cdOffset = offset
    for (const b of central) yield emit(b)

    if (zip64) {
      const eocd64 = Buffer.alloc(56)
      eocd64.writeUInt32LE(0x06064b50, 0)
      eocd64.writeBigUInt64LE(BigInt(44), 4) // 剩余字段长度
      eocd64.writeUInt16LE(45, 12)
      eocd64.writeUInt16LE(45, 14)
      eocd64.writeUInt32LE(0, 16)
      eocd64.writeUInt32LE(0, 20)
      eocd64.writeBigUInt64LE(BigInt(plan.entries.length), 24)
      eocd64.writeBigUInt64LE(BigInt(plan.entries.length), 32)
      eocd64.writeBigUInt64LE(BigInt(cdSize), 40)
      eocd64.writeBigUInt64LE(BigInt(cdOffset), 48)
      yield emit(eocd64)

      const locator = Buffer.alloc(20)
      locator.writeUInt32LE(0x07064b50, 0)
      locator.writeUInt32LE(0, 4)
      locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8)
      locator.writeUInt32LE(1, 16)
      yield emit(locator)
    }

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(Math.min(0xffff, plan.entries.length), 8)
    eocd.writeUInt16LE(Math.min(0xffff, plan.entries.length), 10)
    eocd.writeUInt32LE(Math.min(0xffffffff, cdSize), 12)
    eocd.writeUInt32LE(Math.min(0xffffffff, cdOffset), 16)
    eocd.writeUInt16LE(0, 20)
    yield emit(eocd)
  }

  // Readable.from 会在流被销毁（客户端断开）时调用 generator.return()，
  // 遍历和读取也就随之停止，不会在后台继续空转。
  return Readable.from(generate())
}
