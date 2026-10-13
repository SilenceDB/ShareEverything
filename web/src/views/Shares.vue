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
      <el-table-column :label="t('shares.colCode')" width="90">
        <template #default="{ row }">
          {{ row.hasAccessCode ? t('common.needsCode') : t('common.noCode') }}
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
</style>
