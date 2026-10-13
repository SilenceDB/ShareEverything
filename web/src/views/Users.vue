<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, type ManagedUser } from '../api'
import { useUserStore } from '../stores/user'
import { formatDateTime, humanSize } from '../utils/format'

const { t } = useI18n()
const store = useUserStore()
const list = ref<ManagedUser[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    list.value = await api.users.list()
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

/* ---------- 新增用户 ---------- */

const createVisible = ref(false)
const creating = ref(false)
const createFormRef = ref()
const createForm = reactive({
  email: '',
  username: '',
  password: '',
  role: 'USER',
  /** 留空表示用服务端默认配额（2GB）；填的数字单位是 MB */
  quotaMb: '' as string | number,
})

/** 写成 computed：校验提示也是文案，切语言时要跟着变 */
const createRules = computed(() => ({
  email: [
    { required: true, message: t('users.emailRequired'), trigger: 'blur' },
    { type: 'email' as const, message: t('users.emailInvalid'), trigger: 'blur' },
  ],
  username: [{ required: true, message: t('users.usernameRequired'), trigger: 'blur' }],
  password: [
    { required: true, message: t('users.passwordRequired'), trigger: 'blur' },
    { min: 6, message: t('users.passwordMin'), trigger: 'blur' },
  ],
}))

/** 角色标签的配色：管理员高亮一下，方便一眼分辨 */
const roleTag = (role: string) => (role === 'ADMIN' ? 'danger' : 'info')
const roleText = (role: string) => (role === 'ADMIN' ? t('common.admin') : t('common.user'))

const isSelf = (u: ManagedUser) => u.id === store.user?.id

const usedPercent = (u: ManagedUser) => {
  const quota = Number(u.quotaBytes)
  if (!quota) return 0
  return Math.min(100, Math.round((Number(u.usedBytes) / quota) * 100))
}

function openCreate() {
  createForm.email = ''
  createForm.username = ''
  createForm.password = ''
  createForm.role = 'USER'
  createForm.quotaMb = ''
  createVisible.value = true
  createFormRef.value?.clearValidate()
}

async function submitCreate() {
  try {
    await createFormRef.value?.validate()
  } catch {
    return
  }
  creating.value = true
  try {
    const quotaMb = createForm.quotaMb === '' ? undefined : Number(createForm.quotaMb)
    if (quotaMb !== undefined && (!Number.isFinite(quotaMb) || quotaMb < 0)) {
      ElMessage.error(t('users.quotaInvalid'))
      return
    }
    await api.users.create({
      email: createForm.email.trim(),
      username: createForm.username.trim(),
      password: createForm.password,
      role: createForm.role,
      quotaBytes: quotaMb === undefined ? undefined : Math.floor(quotaMb * 1024 * 1024),
    })
    ElMessage.success(t('users.created'))
    createVisible.value = false
    await load()
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    creating.value = false
  }
}

/* ---------- 重置他人密码 ---------- */

const resetVisible = ref(false)
const resetting = ref(false)
const resetTarget = ref<ManagedUser | null>(null)
const resetForm = reactive({ password: '' })

function openReset(u: ManagedUser) {
  resetTarget.value = u
  resetForm.password = ''
  resetVisible.value = true
}

async function submitReset() {
  if (!resetTarget.value) return
  if (resetForm.password.length < 6) {
    ElMessage.error(t('users.newPasswordMin'))
    return
  }
  resetting.value = true
  try {
    await api.users.resetPassword(resetTarget.value.id, resetForm.password)
    ElMessage.success(t('users.resetDone', { name: resetTarget.value.username }))
    resetVisible.value = false
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    resetting.value = false
  }
}

/* ---------- 删除 ---------- */

async function remove(u: ManagedUser) {
  try {
    await ElMessageBox.confirm(t('users.confirmDelete', { name: u.username }), t('users.deleteTitle'), {
      type: 'warning',
      confirmButtonText: t('common.delete'),
      confirmButtonClass: 'el-button--danger',
    })
  } catch {
    return
  }
  try {
    await api.users.remove(u.id)
    ElMessage.success(t('common.deleted'))
    await load()
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

const total = computed(() => list.value.length)

onMounted(load)
</script>

<template>
  <div class="card">
    <div class="bar">
      <span class="title">{{ t('nav.users') }}</span>
      <span class="count">{{ t('users.count', total) }}</span>
      <el-button @click="load">{{ t('common.refresh') }}</el-button>
      <el-button type="primary" @click="openCreate">{{ t('users.create') }}</el-button>
    </div>

    <el-table v-loading="loading" :data="list" style="width: 100%">
      <!-- 列宽按较长的英文标签留够，同时保证整表能装进常规窗口（否则末列按钮会被横向溢出切掉） -->
      <el-table-column :label="t('common.username')" min-width="130">
        <template #default="{ row }">
          <span>{{ row.username }}</span>
          <el-tag v-if="isSelf(row)" size="small" class="me">{{ t('users.self') }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="email" :label="t('common.email')" min-width="170" show-overflow-tooltip />
      <el-table-column :label="t('users.role')" width="100">
        <template #default="{ row }">
          <el-tag :type="roleTag(row.role)" size="small">{{ roleText(row.role) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('users.usage')" min-width="155">
        <template #default="{ row }">
          <div class="usage">
            <span>{{ humanSize(row.usedBytes) }} / {{ humanSize(row.quotaBytes) }}</span>
            <el-progress :percentage="usedPercent(row)" :stroke-width="6" :show-text="false" />
          </div>
        </template>
      </el-table-column>
      <el-table-column :label="t('users.createdAt')" min-width="185">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column :label="t('common.actions')" width="235">
        <template #default="{ row }">
          <el-button size="small" @click="openReset(row)">{{ t('users.resetPassword') }}</el-button>
          <el-button size="small" type="danger" :disabled="isSelf(row)" @click="remove(row)">
            {{ t('common.delete') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :description="t('users.empty')" />
      </template>
    </el-table>

    <!-- 新增用户 -->
    <el-dialog v-model="createVisible" :title="t('users.createTitle')" width="460px">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="120px">
        <el-form-item :label="t('common.email')" prop="email">
          <el-input v-model="createForm.email" placeholder="you@example.com" />
        </el-form-item>
        <el-form-item :label="t('common.username')" prop="username">
          <el-input v-model="createForm.username" :placeholder="t('users.usernamePlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('users.initialPassword')" prop="password">
          <el-input
            v-model="createForm.password"
            type="password"
            show-password
            :placeholder="t('common.passwordMinHint')"
          />
        </el-form-item>
        <el-form-item :label="t('users.role')">
          <el-select v-model="createForm.role" style="width: 100%">
            <el-option :label="t('common.user')" value="USER" />
            <el-option :label="t('common.admin')" value="ADMIN" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('users.quota')">
          <el-input v-model="createForm.quotaMb" :placeholder="t('users.quotaPlaceholder')">
            <template #append>MB</template>
          </el-input>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">
          {{ t('common.create') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 重置他人密码 -->
    <el-dialog v-model="resetVisible" :title="t('users.resetTitle')" width="420px">
      <p class="reset-tip">{{ t('users.resetHint', { name: resetTarget?.username ?? '' }) }}</p>
      <el-input
        v-model="resetForm.password"
        type="password"
        show-password
        :placeholder="t('users.newPasswordPlaceholder')"
        @keyup.enter="submitReset"
      />
      <template #footer>
        <el-button @click="resetVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="resetting" @click="submitReset">
          {{ t('users.resetConfirm') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  margin-bottom: 14px;
  gap: 8px;
}
.title {
  font-size: 15px;
  font-weight: 600;
}
.count {
  margin-right: auto;
  font-size: 13px;
  color: #909399;
}
.me {
  margin-left: 6px;
}
.usage {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: #606266;
}
.reset-tip {
  margin: 0 0 12px;
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
}
</style>
