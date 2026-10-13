<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { api, type ShareItem } from '../api'

const props = defineProps<{
  modelValue: boolean
  target: { targetType: 'FILE' | 'MOUNT'; fileId?: string; mountId?: string; subPath?: string }
  defaultTitle?: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'created', s: ShareItem): void }>()

const { t } = useI18n()
const loading = ref(false)
const form = reactive({
  title: '',
  accessCode: '',
  expiresInHours: 0,
  maxDownloads: 0,
})

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      form.title = props.defaultTitle ?? ''
      form.accessCode = ''
      form.expiresInHours = 0
      form.maxDownloads = 0
    }
  },
)

async function create() {
  loading.value = true
  try {
    const share = await api.shares.create({
      targetType: props.target.targetType,
      fileId: props.target.fileId,
      mountId: props.target.mountId,
      subPath: props.target.subPath,
      title: form.title || undefined,
      accessCode: form.accessCode || undefined,
      expiresInHours: form.expiresInHours || undefined,
      maxDownloads: form.maxDownloads || undefined,
    })
    emit('created', share)
    emit('update:modelValue', false)
    ElMessage.success(t('shareDialog.created'))
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('shareDialog.title')"
    width="420px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-position="top">
      <el-form-item :label="t('shareDialog.titleLabel')">
        <el-input v-model="form.title" :placeholder="t('shareDialog.titlePlaceholder')" />
      </el-form-item>
      <el-form-item :label="t('shareDialog.accessCode')">
        <el-input v-model="form.accessCode" :placeholder="t('shareDialog.accessCodePlaceholder')" />
      </el-form-item>
      <el-form-item :label="t('shareDialog.expires')">
        <el-input-number v-model="form.expiresInHours" :min="0" :step="24" />
        <span class="hint">{{ t('shareDialog.expiresHint') }}</span>
      </el-form-item>
      <el-form-item :label="t('shareDialog.maxDownloads')">
        <el-input-number v-model="form.maxDownloads" :min="0" />
        <span class="hint">{{ t('shareDialog.maxDownloadsHint') }}</span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="loading" @click="create">{{ t('common.create') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.hint {
  margin-left: 10px;
  font-size: 12px;
  color: #909399;
}
</style>
