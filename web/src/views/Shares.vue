<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, type ShareItem } from '../api'
import { copyTextWithFeedback } from '../utils/clipboard'

const { t } = useI18n()
const list = ref<ShareItem[]>([])

async function load() {
  list.value = await api.shares.list()
}

function linkOf(s: ShareItem): string {
  return `${location.origin}/s/${s.code}`
}

async function copyLink(s: ShareItem) {
  // 以前用的是裸 navigator.clipboard：在 iframe 里或 http+IP 访问时
  // 要么被权限策略拒绝、要么整个 API 是 undefined，而且失败时只弹一个
  // 角落的 toast 把 URL 打出来，看起来像"复制了"其实没有。
  await copyTextWithFeedback(linkOf(s), t('shares.copied', { link: linkOf(s) }))
}

/** 提取码是加密码存储、由服务端解密后回显的，所以这里直接拿得到明文 */
async function copyCode(s: ShareItem) {
  if (!s.accessCode) return
  await copyTextWithFeedback(s.accessCode, t('shares.codeCopied', { code: s.accessCode }))
}

/**
 * 重设 / 设置 / 取消提取码。
 *
 * 需要一个「改」的入口不只是为了换码：服务端换了 ACCESS_CODE_KEY 之后，
 * 旧码会解不开（列表里标成不可用），没有这个入口就只能删掉分享重建。
 */
async function resetCode(s: ShareItem) {
  let next: string
  try {
    const { value } = await ElMessageBox.prompt(t('shares.resetCodePrompt'), t('shares.colCode'), {
      inputValue: s.accessCode ?? '',
      inputPlaceholder: t('shareDialog.accessCodePlaceholder'),
      // 留空 = 取消提取码；长度规则与服务端保持一致，免得白跑一趟再吃一个 400
      inputValidator: (v: string) => {
        const code = (v ?? '').trim()
        return !code || (code.length >= 4 && code.length <= 64)
          ? true
          : t('shares.resetCodeInvalid')
      },
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    })
    next = (value ?? '').trim()
  } catch {
    return
  }
  try {
    await api.shares.updateCode(s.id, next || null)
    ElMessage.success(t('shares.codeUpdated'))
    await load()
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

async function remove(s: ShareItem) {
  try {
    await ElMessageBox.confirm(t('shares.confirmDelete'), t('common.alertTitle'), { type: 'warning' })
  } catch {
    return
  }
  try {
    await api.shares.remove(s.id)
    ElMessage.success(t('common.deleted'))
    await load()
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

const statusTag = (s: ShareItem) =>
  s.status === 'ACTIVE' ? 'success' : s.status === 'EXPIRED' ? 'info' : 'warning'

const statusText = (s: ShareItem) =>
  s.status === 'ACTIVE'
    ? t('shares.status.active')
    : s.status === 'EXPIRED'
      ? t('shares.status.expired')
      : t('shares.status.exhausted')

onMounted(load)
</script>

<template>
  <div class="card">
    <div class="bar">
      <span class="title">{{ t('nav.shares') }}</span>
      <el-button @click="load">{{ t('common.refresh') }}</el-button>
    </div>

    <el-table :data="list" style="width: 100%">
      <el-table-column :label="t('shares.colTitle')" min-width="260">
        <template #default="{ row }">
          <div>{{ row.title || t('shares.untitled') }}</div>
          <el-link type="primary" :href="linkOf(row)" target="_blank">/s/{{ row.code }}</el-link>
        </template>
      </el-table-column>
      <el-table-column :label="t('shares.colSource')" width="120">
        <template #default="{ row }">
          {{ row.targetType === 'FILE' ? t('shares.sourceFile') : t('shares.sourceMount') }}
          <el-tag v-if="row.isDir" size="small" type="warning">{{ t('common.dir') }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('shares.colCode')" width="170">
        <template #default="{ row }">
          <div class="code-cell">
            <el-link
              v-if="row.accessCode"
              type="primary"
              :underline="false"
              class="code"
              :title="t('shares.copyCode')"
              @click="copyCode(row)"
            >
              {{ row.accessCode }}
            </el-link>
            <el-tag v-else-if="row.accessCodeBroken" size="small" type="danger">
              {{ t('shares.codeBroken') }}
            </el-tag>
            <span v-else class="muted">{{ t('common.noCode') }}</span>
            <el-button link size="small" type="primary" @click="resetCode(row)">
              {{ row.hasAccessCode ? t('shares.resetCode') : t('shares.setCode') }}
            </el-button>
          </div>
        </template>
      </el-table-column>
      <el-table-column :label="t('shares.colDownloads')" width="100">
        <template #default="{ row }">
          {{ row.downloadCount }}<template v-if="row.maxDownloads"> / {{ row.maxDownloads }}</template>
        </template>
      </el-table-column>
      <el-table-column :label="t('shares.colStatus')" width="90">
        <template #default="{ row }">
          <el-tag :type="statusTag(row)" size="small">{{ statusText(row) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="195">
        <template #default="{ row }">
          <el-button size="small" @click="copyLink(row)">{{ t('shares.copyLink') }}</el-button>
          <el-button size="small" type="danger" @click="remove(row)">{{ t('common.delete') }}</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :description="t('shares.empty')" />
      </template>
    </el-table>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  margin-bottom: 14px;
}
.title {
  font-size: 15px;
  font-weight: 600;
  margin-right: auto;
}
.code-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 提取码要能一眼抄走，等宽字体 + 略大的字距比正文更合适 */
.code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: 0.5px;
}
.muted {
  color: #909399;
}
</style>
