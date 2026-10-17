/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import axios from 'axios'
import { appLocale, t } from '../i18n'

export const TOKEN_KEY = 'se_token'

const http = axios.create({ baseURL: '/api' })

http.interceptors.request.use((cfg) => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  // 告诉服务端界面当前用哪种语言，好让报错文案也跟着切。
  // 不能靠 Accept-Language：那是浏览器的禁止头，JS 改不了，它反映的是操作系统语言。
  cfg.headers['X-Locale'] = appLocale()
  return cfg
})

http.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY)
      if (!location.pathname.startsWith('/s/')) {
        location.href = '/login'
      }
    }
    // 保留原始响应，分片上传需要读 400 响应里的 missing 分片列表
    const wrapped = new Error(
      err.response?.data?.error || err.message || t('common.requestFailed'),
    ) as Error & { response?: { status: number; data: any } }
    wrapped.response = err.response
    return Promise.reject(wrapped)
  },
)

export interface UserInfo {
  id: string
  email: string
  username: string
  role: string
  quotaBytes: string
}

/** 用户管理页里列出的一条账号（比 UserInfo 多一个已用空间） */
export interface ManagedUser {
  id: string
  email: string
  username: string
  role: string
  quotaBytes: string
  usedBytes: string
  createdAt: string
}

export interface FileItem {
  id: string
  name: string
  relPath: string
  parent: string
  size: string
  isDir: boolean
  createdAt: string
}

/** 磁盘发布：全站共享资源，ownerName 只是记录谁发布的 */
export type MountKind = 'FOLDER' | 'DIR' | 'FILE'

/** 谁能看见这一项：全站 / 仅发布者 / 发布者 + 指定用户（管理员一律可见） */
export type MountVisibility = 'PUBLIC' | 'PRIVATE' | 'PROTECTED'

export interface MountItem {
  id: string
  name: string
  /** FOLDER = 纯逻辑文件夹（不对应磁盘路径）；DIR / FILE = 真实磁盘映射 */
  kind: MountKind
  /** FOLDER 恒为 null */
  absPath: string | null
  parentId: string | null
  sortOrder: number
  createdAt: string
  ownerId: string
  ownerName: string
  /** 发布者本人或管理员可以改名 / 移动 / 取消发布 */
  canManage: boolean
  visibility: MountVisibility
  /** 授权名单里的用户 id；只有 canManage 时才带内容，其余情况为空数组 */
  grants: string[]
  /** 当前用户是否被单独授权（PROTECTED 的名单里有我） */
  granted: boolean
}

/** 授权候选：把发布项设成 PROTECTED 时从这些人里挑 */
export interface GrantableUser {
  id: string
  username: string
  role: string
}

export interface DiskEntry {
  name: string
  isDir: boolean
  size: string
  sub: string
}

/** 选择器里的一条磁盘条目（服务端本机的真实路径） */
export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  isFile: boolean
  size: string
}

export interface FsListResult {
  /** 当前目录的真实路径，空串表示还没进到任何目录（此时只有 roots 可用） */
  path: string
  /** 上一级目录；null 表示已经到顶（磁盘根或配置的范围边界） */
  parent: string | null
  /** 可用的起始根目录 */
  roots: string[]
  entries: FsEntry[]
}

export interface ShareItem {
  id: string
  code: string
  title: string | null
  targetType: string
  /** 目标是目录还是文件 */
  isDir: boolean
  kind: 'FILE' | 'DIR'
  subPath: string
  hasAccessCode: boolean
  /** 提取码明文。只有「我的分享」这类创建者视角才有值，公开接口恒为 null */
  accessCode?: string | null
  /** 提取码解不开了（服务端换了 ACCESS_CODE_KEY），需要重设 */
  accessCodeBroken?: boolean
  expiresAt: string | null
  maxDownloads: number | null
  downloadCount: number
  createdAt: string
  status: 'ACTIVE' | 'EXPIRED' | 'EXHAUSTED'
}

export type ArchiveMode = 'store' | 'smart' | 'deflate'

/** 后台打包任务的状态 */
export interface ArchiveJobInfo {
  id: string
  mode: ArchiveMode
  status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED'
  fileCount: number
  totalBytes: string
  zipBytes: string | null
  processedFiles: number
  processedBytes: string
  error: string | null
  createdAt: string
  expiresAt: string
  percent: number
}

/** 目录打包预检结果：先看清有多少文件多大，再决定要不要下 */
export interface ArchivePlanResult {
  mode: ArchiveMode
  /** 目录够大，建议走后台打包任务（可断点续传）而不是同步流式 */
  suggestAsync: boolean
  fileCount: number
  dirCount: number
  totalBytes: number
  /** 压缩包大小。有文件走压缩时无法预知，为 null */
  zipBytes: number | null
  deflateCount: number
  skipped: number
  truncated: boolean
  truncatedBy: 'files' | 'bytes' | 'depth' | null
  limits: { maxFiles: number; maxTotalBytes: number; maxDepth: number }
}

export interface UploadLimits {
  minChunkSize: number
  maxChunkSize: number
  maxChunksPerTask: number
  maxConcurrentChunks: number
}

export interface UploadInitResult {
  instant: boolean
  file?: FileItem
  uploadId?: string
  /** 服务端实际生效的分片大小（可能被 clamp 或自动放大，前端必须用它切片） */
  chunkSize?: number
  totalChunks?: number
  uploaded?: number[]
  limits?: UploadLimits
}

export interface UploadStatusResult {
  uploadId: string
  name: string
  size: string
  chunkSize: number
  totalChunks: number
  uploaded: number[]
}

/**
 * 服务端构建信息：版本号就是最后一次打包的时刻，如 2026.10.12.1031。
 *
 * 这里只描述「这个包是什么」。进程 pid / 启动时间 / uptime 属于运行时诊断，
 * 服务端已不再随公开接口下发（`/api/health` 里也只对本机可见），所以类型里一并去掉，
 * 免得声明与实际响应对不上。
 */
export interface BuildInfo {
  name: string
  version: string
  /** 打包时刻；开发环境为 null */
  builtAt: string | null
  /** offline / standard / dev */
  mode: string
  packedNode: string | null
  node: string
}

export const api = {
  /** 公开接口，无需登录 */
  version: () => http.get<BuildInfo>('/version').then((r) => r.data),

  auth: {
    /** 登录页公开配置：注册入口该不该出现、有没有开管理员密码找回 */
    publicConfig: () =>
      http
        .get<{
          canRegister: boolean
          hasAdmin: boolean
          adminResetEnabled: boolean
          /** 密码找回恒为「仅服务器本机可用」 */
          adminResetLocalOnly: boolean
          /** 本次请求是否来自服务器本机 */
          fromLocalhost: boolean
        }>('/auth/config')
        .then((r) => r.data),
    register: (data: { email: string; username: string; password: string }) =>
      http.post<{ token: string; user: UserInfo }>('/auth/register', data).then((r) => r.data),
    login: (data: { account: string; password: string }) =>
      http
        .post<{ token: string; user: UserInfo; resetPassword: boolean }>('/auth/login', data)
        .then((r) => r.data),
    me: () =>
      http
        .get<{ user: UserInfo; usedBytes: string; canCreateMount: boolean }>('/auth/me')
        .then((r) => r.data),
    /**
     * 本人修改自己的密码，需要原密码。
     * 返回的新 token 用来续上当前会话（改密会让该账号其他登录态全部失效）。
     */
    changePassword: (data: { oldPassword: string; newPassword: string }) =>
      http.post<{ ok: boolean; token: string }>('/auth/password', data).then((r) => r.data),
  },

  /** 用户管理：全部需要管理员权限 */
  users: {
    list: () => http.get<ManagedUser[]>('/users').then((r) => r.data),
    create: (data: {
      email: string
      username: string
      password: string
      role?: string
      /** 字节数；不传则用服务端默认配额 */
      quotaBytes?: number
    }) => http.post<ManagedUser>('/users', data).then((r) => r.data),
    /** 管理员重置他人密码，无需原密码；该用户已有登录态会立即失效 */
    resetPassword: (id: string, password: string) =>
      http.patch<{ ok: boolean }>(`/users/${id}/password`, { password }).then((r) => r.data),
    /** 删除账号：连带清除其文件库、分享与磁盘发布记录，不可恢复 */
    remove: (id: string) => http.delete<{ ok: boolean }>(`/users/${id}`).then((r) => r.data),
  },

  files: {
    list: (parent = '') =>
      http.get<{ parent: string; items: FileItem[] }>('/files', { params: { parent } }).then((r) => r.data),
    usage: () =>
      http.get<{ usedBytes: string; quotaBytes: string }>('/files/usage').then((r) => r.data),
    mkdir: (parent: string, name: string) =>
      http.post<FileItem>('/files/mkdir', { parent, name }).then((r) => r.data),
    upload: (file: File, parent = '', onProgress?: (p: number) => void) => {
      const form = new FormData()
      form.append('file', file)
      form.append('path', parent)
      return http
        .post<FileItem>('/files/upload', form, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (e) => {
            if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total))
          },
        })
        .then((r) => r.data)
    },
    // 下载是浏览器直接发起的，带不上 Authorization 头，改用 token 参数透传
    downloadUrl: (id: string) =>
      `/api/files/${id}/download?token=${encodeURIComponent(localStorage.getItem(TOKEN_KEY) ?? '')}`,
    remove: (id: string) => http.delete(`/files/${id}`).then((r) => r.data),
  },

  uploads: {
    init: (data: {
      name: string
      size: number
      parent?: string
      hash?: string
      chunkSize?: number
    }) => http.post<UploadInitResult>('/uploads/init', data).then((r) => r.data),
    status: (id: string) => http.get<UploadStatusResult>(`/uploads/${id}`).then((r) => r.data),
    chunk: (id: string, index: number, blob: Blob, signal?: AbortSignal) => {
      const form = new FormData()
      form.append('index', String(index))
      form.append('file', blob)
      return http.post(`/uploads/${id}/chunk`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        signal,
      })
    },
    /** 缺分片时后端返回 400 + missing，这里把它变成正常返回值而不是抛异常 */
    complete: async (
      id: string,
    ): Promise<{ done: true; file: FileItem } | { done: false; missing: number[] }> => {
      try {
        const r = await http.post<FileItem>(`/uploads/${id}/complete`)
        return { done: true, file: r.data }
      } catch (e: any) {
        const missing = e?.response?.data?.missing
        if (Array.isArray(missing)) return { done: false, missing }
        throw e
      }
    },
    cancel: (id: string) => http.delete(`/uploads/${id}`).then((r) => r.data),
  },

  mounts: {
    list: () => http.get<MountItem[]>('/mounts').then((r) => r.data),
    create: (data: {
      name: string
      kind: MountKind
      parentId?: string | null
      /** FOLDER 不需要；DIR / FILE 必填 */
      absPath?: string
      visibility?: MountVisibility
      /** visibility 为 PROTECTED 时生效：授权给这些用户 */
      grants?: string[]
    }) => http.post<MountItem>('/mounts', data).then((r) => r.data),
    update: (
      id: string,
      data: {
        name?: string
        parentId?: string | null
        sortOrder?: number
        visibility?: MountVisibility
        grants?: string[]
      },
    ) => http.patch<MountItem>(`/mounts/${id}`, data).then((r) => r.data),
    grantableUsers: () => http.get<GrantableUser[]>('/mounts/grantable-users').then((r) => r.data),
    remove: (id: string) =>
      http.delete<{ ok: boolean; removed: number }>(`/mounts/${id}`).then((r) => r.data),
    browse: (id: string, sub = '') =>
      http
        .get<{ mount: MountItem; sub: string; items: DiskEntry[] }>(`/mounts/${id}/browse`, {
          params: { sub },
        })
        .then((r) => r.data),
    /** 选择器可用的起始根目录 */
    fsRoots: () =>
      http
        .get<{ roots: string[]; unrestricted: boolean; defaultPath: string }>('/mounts/fs/roots')
        .then((r) => r.data),
    /** 列举服务端磁盘目录；path 为空则只返回可选起点 */
    fsList: (path = '') =>
      http
        .get<FsListResult>('/mounts/fs/list', { params: path ? { path } : {} })
        .then((r) => r.data),
    downloadUrl: (id: string, sub = '') =>
      `/api/mounts/${id}/download?sub=${encodeURIComponent(sub)}&token=${encodeURIComponent(
        localStorage.getItem(TOKEN_KEY) ?? '',
      )}`,
  },

  shares: {
    list: () => http.get<ShareItem[]>('/shares').then((r) => r.data),
    create: (data: {
      targetType: 'FILE' | 'MOUNT'
      fileId?: string
      mountId?: string
      subPath?: string
      title?: string
      accessCode?: string
      expiresInHours?: number
      maxDownloads?: number
    }) => http.post<ShareItem>('/shares', data).then((r) => r.data),
    /** 重设或清除提取码：传 null / 空字符串表示去掉 */
    updateCode: (id: string, accessCode: string | null) =>
      http.patch<ShareItem>(`/shares/${id}`, { accessCode }).then((r) => r.data),
    remove: (id: string) => http.delete(`/shares/${id}`).then((r) => r.data),
    publicInfo: (code: string) =>
      http
        .get<
          ShareItem & { title: string; needAccessCode: boolean; available: boolean }
        >(`/s/${code}`)
        .then((r) => r.data),
    publicDownloadUrl: (code: string, accessCode?: string) =>
      `/api/s/${code}/download${accessCode ? `?accessCode=${encodeURIComponent(accessCode)}` : ''}`,
    archivePlan: (code: string, accessCode?: string, mode?: ArchiveMode) =>
      http
        .get<ArchivePlanResult>(`/s/${code}/archive/plan`, {
          params: { ...(accessCode ? { accessCode } : {}), ...(mode ? { mode } : {}) },
        })
        .then((r) => r.data),
    archiveUrl: (code: string, accessCode?: string, mode?: ArchiveMode) => {
      const q = new URLSearchParams()
      if (accessCode) q.set('accessCode', accessCode)
      if (mode) q.set('mode', mode)
      const s = q.toString()
      return `/api/s/${code}/archive${s ? `?${s}` : ''}`
    },
    jobs: {
      /** 建一个后台打包任务；同一分享同一档位会复用已有任务 */
      create: (code: string, accessCode?: string, mode?: ArchiveMode) =>
        http
          .post<ArchiveJobInfo>(`/s/${code}/archive/jobs`, { accessCode, mode })
          .then((r) => r.data),
      status: (code: string, jobId: string, accessCode?: string) =>
        http
          .get<ArchiveJobInfo>(`/s/${code}/archive/jobs/${jobId}`, {
            params: accessCode ? { accessCode } : {},
          })
          .then((r) => r.data),
      // 打包结果是普通文件，走浏览器原生下载或 Range 续传都可以
      fileUrl: (code: string, jobId: string, accessCode?: string) =>
        `/api/s/${code}/archive/jobs/${jobId}/file${
          accessCode ? `?accessCode=${encodeURIComponent(accessCode)}` : ''
        }`,
      remove: (code: string, jobId: string, accessCode?: string) =>
        http
          .delete(`/s/${code}/archive/jobs/${jobId}`, {
            params: accessCode ? { accessCode } : {},
          })
          .then((r) => r.data),
    },
  },
}
