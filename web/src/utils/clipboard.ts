/**
 * ShareEverything - 磁盘资源发布与 Web 分享平台
 *
 * @author SilenceDB
 * @license Apache-2.0
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 SilenceDB
 */

import { h } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { t } from '../i18n'

export interface CopyResult {
  ok: boolean
  /** 失败原因，用于给用户看得懂的提示；成功时为空串 */
  reason: string
}

/**
 * 当前环境里"自动复制"为什么会失败。
 *
 * 两个常见场景，都不是代码能绕过去的：
 * 1. 页面嵌在 iframe 里 —— 父级没给 iframe 授 `clipboard-write` 权限，写入会被拒绝；
 * 2. 页面不是安全上下文 —— 用 http:// + 局域网 IP 访问时（没上 HTTPS），
 *    `navigator.clipboard` 整个是 undefined。
 */
function envReason(): string {
  const parts: string[] = []
  if (window.self !== window.top) parts.push(t('clipboard.inIframe'))
  if (!window.isSecureContext) parts.push(t('clipboard.insecure'))
  return parts.length ? t('clipboard.envWrap', { list: parts.join(t('clipboard.listSep')) }) : ''
}

/**
 * 老式复制：塞一个临时 textarea 再 execCommand('copy')。
 * 它不像 Clipboard API 那样受安全上下文和 iframe 权限策略约束，
 * 所以正好用来兜底。必须在用户手势的调用栈里同步执行。
 */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '-9999px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)

  // 记下原来的选区，复制完还回去，免得把用户的选择弄丢
  const selection = document.getSelection()
  const saved =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null

  let ok = false
  try {
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }

  document.body.removeChild(ta)
  if (selection && saved) {
    selection.removeAllRanges()
    selection.addRange(saved)
  }
  return ok
}

/** 尝试把文本写进剪贴板，不弹任何 UI */
export async function copyText(text: string): Promise<CopyResult> {
  // 1) 现代异步 API：需要安全上下文 + 未被权限策略拦截
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return { ok: true, reason: '' }
    } catch (e: any) {
      const name =
        e?.name === 'NotAllowedError' ? t('clipboard.denied') : e?.name || t('clipboard.writeFailed')
      // 不直接返回失败，继续用老办法试一次
      if (legacyCopy(text)) return { ok: true, reason: '' }
      return { ok: false, reason: `${name}${envReason()}` }
    }
  }

  // 2) 没有 Clipboard API（大多是 http + IP 访问），只能靠 execCommand
  if (legacyCopy(text)) return { ok: true, reason: '' }
  return { ok: false, reason: `${t('clipboard.notSupported')}${envReason()}` }
}

/**
 * 复制并给反馈：成功就一句轻提示；失败则弹一个**可手动复制**的框，
 * 且把真实原因写出来 —— 不要再像以前那样静默失败或只把 URL 打在角落的 toast 里。
 */
export async function copyTextWithFeedback(text: string, successMsg?: string): Promise<void> {
  const { ok, reason } = await copyText(text)
  if (ok) {
    ElMessage.success(successMsg ?? t('clipboard.copied'))
    return
  }

  try {
    await ElMessageBox({
      title: t('clipboard.title'),
      message: () =>
        h('div', { style: 'display:flex;flex-direction:column;gap:10px;width:100%' }, [
          h(
            'div',
            { style: 'font-size:13px;line-height:1.6' },
            t('clipboard.manual', { reason }),
          ),
          h('input', {
            value: text,
            readonly: true,
            class: 'se-copy-fallback',
            spellcheck: false,
            style:
              'width:100%;box-sizing:border-box;padding:6px 10px;border:1px solid #dcdfe6;' +
              'border-radius:4px;font-size:13px;color:#303133;background:#fff',
            // MessageBox 没有 onOpened 钩子，靠 vnode 的 ref 在真正插入 DOM 后聚焦并全选
            ref: (el: any) => {
              if (el) {
                const input = (el as HTMLElement).tagName === 'INPUT' ? (el as HTMLInputElement) : null
                setTimeout(() => {
                  input?.focus()
                  input?.select()
                }, 30)
              }
            },
          }),
        ]),
      showCancelButton: false,
      confirmButtonText: t('clipboard.close'),
    })
  } catch {
    // 用户直接关掉了弹框，不算错误
  }
}
