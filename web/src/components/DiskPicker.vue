<!--
  ShareEverything - 磁盘资源发布与 Web 分享平台

  @author SilenceDB
  @license Apache-2.0
  SPDX-License-Identifier: Apache-2.0
  Copyright 2026 SilenceDB
-->

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { api, type FsEntry } from '../api'
import { ellipsisPath, humanSize } from '../utils/format'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    /** dir = 只能选目录；file = 可以选文件（目录仍可进入） */
    mode?: 'dir' | 'file'
    /** 打开时优先定位到这个目录；为空则落到默认根目录 */
    initialPath?: string
  }>(),
  { mode: 'dir', initialPath: '' },
)

const emit = defineEmits<{
  'update:modelValue': [boolean]
  pick: [string]
}>()

const { t } = useI18n()

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v),
})

const loading = ref(false)
const ready = ref(false)
const currentPath = ref('')
const parent = ref<string | null>(null)
const roots = ref<string[]>([])
const entries = ref<FsEntry[]>([])
const selectedFile = ref<FsEntry | null>(null)

/** 目录模式下文件不参与选择，干脆不展示，免得误点 */
const visibleEntries = computed(() =>
  props.mode === 'file' ? entries.value : entries.value.filter((e) => e.isDir),
)

/** 当前处于哪个根目录下，用于那个下拉框的回显 */
const currentRoot = computed(() => {
  const p = currentPath.value.toLowerCase()
  return (
    roots.value.find(
      (r) => p === r.toLowerCase() || p.startsWith(r.endsWith('\\') ? r.toLowerCase() : `${r.toLowerCase()}\\`),
    ) ?? ''
  )
})

async function load(path: string) {
  loading.value = true
  try {
    const res = await api.mounts.fsList(path)
    currentPath.value = res.path
    parent.value = res.parent
    roots.value = res.roots.length ? res.roots : roots.value
    entries.value = res.entries
    selectedFile.value = null
  } catch (e: any) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function enter(entry: FsEntry) {
  if (entry.isDir) {
    void load(entry.path)
    return
  }
  if (props.mode === 'file') selectedFile.value = entry
}

function goUp() {
  if (parent.value) void load(parent.value)
}

function onRootChange(value: string) {
  void load(value)
}

function confirm() {
  if (props.mode === 'file') {
    if (!selectedFile.value) {
      ElMessage.warning(t('picker.selectFileFirst'))
      return
    }
    emit('pick', selectedFile.value.path)
  } else {
    if (!currentPath.value) {
      ElMessage.warning(t('picker.enterDirFirst'))
      return
    }
    emit('pick', currentPath.value)
  }
  visible.value = false
}

// 每次打开都从干净状态开始，并且按当前配置重新取一次可浏览范围
// （管理员可能刚改过 MOUNT_ALLOWED_ROOTS，不该沿用上一次的结果）
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    ready.value = false
    currentPath.value = ''
    parent.value = null
    entries.value = []
    selectedFile.value = null
    try {
      const info = await api.mounts.fsRoots()
      roots.value = info.roots
      ready.value = true
      const start = props.initialPath || info.defaultPath
      if (start) await load(start)
    } catch (e: any) {
      ElMessage.error(e.message)
    }
  },
)
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="mode === 'file' ? t('picker.titleFile') : t('picker.titleDir')"
    width="720px"
    append-to-body
  >
    <div class="picker">
      <div class="toolbar">
        <el-select
          v-if="roots.length > 1"
          :model-value="currentRoot"
          size="small"
          class="root-select"
          @change="onRootChange"
        >
          <el-option v-for="r in roots" :key="r" :label="r" :value="r" />
        </el-select>
        <el-button size="small" :disabled="!parent" @click="goUp">
          <el-icon><ArrowUp /></el-icon>
          <span>{{ t('common.up') }}</span>
        </el-button>
        <span class="path" :title="currentPath">
          {{ ellipsisPath(currentPath || t('picker.notChosen')) }}
        </span>
      </div>

      <div v-loading="loading" class="list">
        <!-- 还没进入任何目录：先把可选起点列出来 -->
        <template v-if="!currentPath">
          <div v-for="r in roots" :key="r" class="row" @click="load(r)">
            <el-icon class="icon dir"><FolderOpened /></el-icon>
            <span class="name">{{ r }}</span>
          </div>
          <el-empty v-if="ready && !roots.length" :description="t('picker.noRoots')" />
        </template>

        <template v-else>
          <div
            v-for="e in visibleEntries"
            :key="e.path"
            class="row"
            :class="{ active: selectedFile?.path === e.path, picked: e.isDir }"
            @click="enter(e)"
          >
            <el-icon class="icon" :class="e.isDir ? 'dir' : 'file'">
              <Folder v-if="e.isDir" />
              <Document v-else />
            </el-icon>
            <span class="name" :title="e.name">{{ e.name }}</span>
            <span class="size">{{ e.isDir ? '' : humanSize(e.size) }}</span>
          </div>
          <el-empty v-if="!visibleEntries.length" :description="t('picker.emptyDir')" />
        </template>
      </div>
    </div>

    <template #footer>
      <span class="hint">
        {{ mode === 'file' ? t('picker.hintFile') : t('picker.hintDir') }}
      </span>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :disabled="!currentPath" @click="confirm">
        {{ mode === 'file' ? t('picker.chooseFile') : t('picker.chooseDir') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.root-select {
  width: 180px;
}
.path {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: #606266;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.list {
  height: 360px;
  overflow: auto;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 4px 0;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  font-size: 13px;
}
.row:hover {
  background: #f5f7fa;
}
.row.active {
  background: #ecf5ff;
  color: #409eff;
}
.row .icon {
  color: #909399;
  flex: none;
}
.row .icon.dir {
  color: #e6a23c;
}
.row .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row .size {
  flex: none;
  font-size: 12px;
  color: #909399;
}
.hint {
  float: left;
  font-size: 12px;
  color: #909399;
  line-height: 32px;
}
</style>
