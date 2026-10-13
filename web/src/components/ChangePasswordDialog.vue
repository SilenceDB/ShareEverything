<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { useUserStore } from '../stores/user'

/**
 * 「修改密码」弹窗：给**已登录用户**改自己的密码用，需要提供原密码。
 * 管理员替别人重置密码不在这个弹窗里，走用户管理页。
 */
const visible = defineModel<boolean>({ required: true })

const { t } = useI18n()
const store = useUserStore()
const loading = ref(false)
const formRef = ref()
const form = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })

/** 写成 computed：校验提示都是文案，切语言时要立刻变 */
const rules = computed(() => ({
  oldPassword: [{ required: true, message: t('password.oldRequired'), trigger: 'blur' }],
  newPassword: [
    { required: true, message: t('password.newRequired'), trigger: 'blur' },
    { min: 6, message: t('password.newMin'), trigger: 'blur' },
    {
      validator: (_r: unknown, v: string, cb: (e?: Error) => void) =>
        v && v === form.oldPassword ? cb(new Error(t('password.sameAsOld'))) : cb(),
      trigger: 'blur',
    },
  ],
  confirmPassword: [
    { required: true, message: t('password.confirmRequired'), trigger: 'blur' },
    {
      validator: (_r: unknown, v: string, cb: (e?: Error) => void) =>
        v !== form.newPassword ? cb(new Error(t('password.mismatch'))) : cb(),
      trigger: 'blur',
    },
  ],
}))

// 每次打开都清空，避免上次的输入残留
watch(visible, (v) => {
  if (v) {
    form.oldPassword = ''
    form.newPassword = ''
    form.confirmPassword = ''
    formRef.value?.clearValidate()
  }
})

async function submit() {
  try {
    await formRef.value?.validate()
  } catch {
    return
  }
  loading.value = true
  try {
    const res = await api.auth.changePassword({
      oldPassword: form.oldPassword,
      newPassword: form.newPassword,
    })
    // 改密让该账号所有旧登录态失效，当前这台机器用新令牌续上，免得把自己也踢出去
    if (res.token) store.setToken(res.token)
    ElMessage.success(t('password.done'))
    visible.value = false
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="t('account.changePassword')" width="420px" append-to-body>
    <el-form ref="formRef" :model="form" :rules="rules" label-width="120px" @submit.prevent>
      <el-form-item :label="t('password.oldLabel')" prop="oldPassword">
        <el-input
          v-model="form.oldPassword"
          type="password"
          show-password
          :placeholder="t('password.oldPlaceholder')"
        />
      </el-form-item>
      <el-form-item :label="t('password.newLabel')" prop="newPassword">
        <el-input
          v-model="form.newPassword"
          type="password"
          show-password
          :placeholder="t('common.passwordMinHint')"
        />
      </el-form-item>
      <el-form-item :label="t('password.confirmLabel')" prop="confirmPassword">
        <el-input
          v-model="form.confirmPassword"
          type="password"
          show-password
          :placeholder="t('password.confirmPlaceholder')"
          @keyup.enter="submit"
        />
      </el-form-item>
    </el-form>
    <el-alert type="info" :closable="false" show-icon :title="t('password.warn')" />
    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="loading" @click="submit">{{ t('password.submit') }}</el-button>
    </template>
  </el-dialog>
</template>
