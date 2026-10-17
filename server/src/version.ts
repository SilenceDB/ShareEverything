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

/**
 * 发布版本信息。
 *
 * 版本号由打包脚本生成，形如 `0.2.0+2026.10.17.1435`：`+` 之前是根 package.json 里的
 * 语义版本（与 CHANGELOG.md 的条目对应），`+` 之后是打包时刻（区分同版本的多次打包）。
 * 它落在产物根目录的 VERSION / build-info.json 里，这里只负责读出来，供启动日志、
 * /api/health、/api/version 使用 —— 这样「线上跑的到底是哪个包」不用靠猜。
 *
 * 开发环境（tsx 直接跑源码）没有这些文件，版本记为 dev：明确区分于任何一次正式发布，
 * 免得把本地误认成某个历史版本。
 */
export interface BuildInfo {
  /** 发布版本号，形如 0.2.0+2026.10.17.1435；开发环境为 dev */
  version: string
  /** 打包时刻（本地时间字符串），开发环境为 null */
  builtAt: string | null
  /** 打包模式：offline / standard；开发环境为 dev */
  mode: string
  /** 打包时使用的 Node 版本 */
  node: string | null
}

const DEV: BuildInfo = { version: 'dev', builtAt: null, mode: 'dev', node: null }

/**
 * 产物根目录。正常启动时 cwd 就是包目录（start.bat 会先切过去），
 * 源码开发时 cwd 是 server/，包目录在上一级，所以两个位置都找。
 */
function findInRoots(name: string): string | null {
  const roots = [process.cwd(), path.resolve(process.cwd(), '..')]
  for (const root of roots) {
    const p = path.join(root, name)
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* 路径不可读，换下一个 */
    }
  }
  return null
}

function load(): BuildInfo {
  const infoPath = findInRoots('build-info.json')
  if (infoPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as Partial<BuildInfo>
      if (raw.version) {
        return {
          version: String(raw.version),
          builtAt: raw.builtAt ? String(raw.builtAt) : null,
          mode: raw.mode ? String(raw.mode) : 'unknown',
          node: raw.node ? String(raw.node) : null,
        }
      }
    } catch {
      /* 文件坏了就当没有，往下退 */
    }
  }

  // 退路：只搬了 VERSION 文件（或者手工做的最小部署）
  const versionPath = findInRoots('VERSION')
  if (versionPath) {
    try {
      const v = (fs.readFileSync(versionPath, 'utf8').split('\n')[0] ?? '').trim()
      if (v) return { ...DEV, version: v, mode: 'unknown' }
    } catch {
      /* 读不到就当开发环境 */
    }
  }

  return DEV
}

export const buildInfo: BuildInfo = load()

/** 适合打日志/展示的一行文本，例如 "2026.10.12.1031（2026-10-12 10:31:38 打包）" */
export function versionLabel(): string {
  if (!buildInfo.builtAt) return `${buildInfo.version}（开发模式）`
  return `${buildInfo.version}（${buildInfo.builtAt} 打包）`
}
