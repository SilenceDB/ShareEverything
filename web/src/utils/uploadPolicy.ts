/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

/**
 * 上传策略：决定「分片大小」和「并发数」。
 *
 * 为什么不把它们做成两个可填的数字：
 *   1. 两者互相耦合 —— 内存峰值 ≈ 并发数 × 分片大小，分开调很容易配出爆内存的组合
 *   2. 还跟服务端耦合 —— 分片数 = 文件大小 / 分片大小，而服务端合并是串行的
 *      「读一个分片写一个分片」，分片数太多会把 complete 拖成分钟级
 *   3. 用户其实不关心这两个数，关心的是「快」还是「稳」
 *
 * 所以这里只暴露「策略档位」，具体数值由文件体积反推：
 *   - 分片大小：按目标分片数反推，再取到 2 的幂、夹在上下限之间
 *   - 并发数：按内存预算 ÷ 分片大小推导上限，运行时再用 AIMD 探测实际带宽
 */

export type PolicyName = 'steady' | 'balanced' | 'turbo'

/**
 * 只描述「数值」，不含任何文案 —— 档位的名字与说明在语言包里
 * （`policy.<name>.label` / `policy.<name>.desc`），界面用 t() 取。
 * 这样加语言不用碰这份策略表。
 */
export interface UploadPolicy {
  name: PolicyName
  /** 目标分片数：用来按文件体积反推分片大小，控制在几十到几百之间 */
  targetChunks: number
  minChunk: number
  maxChunk: number
  /** 并发数 × 分片大小 的内存预算（字节） */
  memBudget: number
  /** 并发硬上限，即使内存预算还很宽也不超过它 */
  hardMaxConcurrency: number
  /** 起始并发：慢启动的起点，档位越高起步越激进 */
  startConcurrency: number
}

const MB = 1024 * 1024

export const POLICIES: Record<PolicyName, UploadPolicy> = {
  steady: {
    name: 'steady',
    targetChunks: 256,
    minChunk: 512 * 1024,
    maxChunk: 8 * MB,
    memBudget: 16 * MB,
    hardMaxConcurrency: 2,
    startConcurrency: 1,
  },
  balanced: {
    name: 'balanced',
    targetChunks: 128,
    minChunk: 1 * MB,
    maxChunk: 16 * MB,
    memBudget: 64 * MB,
    hardMaxConcurrency: 4,
    startConcurrency: 2,
  },
  turbo: {
    name: 'turbo',
    targetChunks: 64,
    minChunk: 4 * MB,
    maxChunk: 32 * MB,
    memBudget: 128 * MB,
    hardMaxConcurrency: 8,
    startConcurrency: 4,
  },
}

export const POLICY_NAMES = Object.keys(POLICIES) as PolicyName[]

/** 档位在语言包里的键前缀，界面侧用它取 label / desc */
export function policyKey(name: PolicyName, field: 'label' | 'desc'): string {
  return `policy.${name}.${field}`
}

const STORAGE_KEY = 'se_upload_policy'

export function loadPolicyName(): PolicyName {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'steady' || v === 'turbo' ? v : 'balanced'
}

export function savePolicyName(name: PolicyName): void {
  localStorage.setItem(STORAGE_KEY, name)
}

export function getPolicy(name: PolicyName = loadPolicyName()): UploadPolicy {
  return POLICIES[name] ?? POLICIES.balanced
}

/** 取到不小于 n 的 2 的幂，让分片大小是整齐的值（便于对齐、也方便排查问题） */
function ceilPow2(n: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, n)))
}

/** 按文件体积反推分片大小 */
export function resolveChunkSize(size: number, policy: UploadPolicy): number {
  const raw = Math.ceil(size / policy.targetChunks)
  const pow = ceilPow2(Math.max(raw, policy.minChunk))
  return Math.min(policy.maxChunk, Math.max(policy.minChunk, pow))
}

/**
 * 并发上限 = 内存预算 ÷ 分片大小，再夹到 [1, 硬上限]。
 * 这样大分片自动降并发、小分片才允许开高，内存峰值不会失控。
 */
export function maxConcurrency(chunkSize: number, policy: UploadPolicy): number {
  const byMem = Math.floor(policy.memBudget / Math.max(1, chunkSize))
  return Math.max(1, Math.min(policy.hardMaxConcurrency, byMem))
}
