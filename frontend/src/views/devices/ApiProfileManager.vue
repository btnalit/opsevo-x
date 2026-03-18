<template>
  <div class="api-profile-manager">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <span>API Profile 管理</span>
          <div class="header-actions">
            <el-upload :show-file-list="false" accept=".json,.yaml,.yml" :before-upload="handleImport">
              <el-button size="small">导入</el-button>
            </el-upload>
            <el-button type="primary" @click="showDialog = true">新建 Profile</el-button>
          </div>
        </div>
      </template>
    </el-card>

    <el-card v-loading="loading" shadow="hover">
      <el-table :data="profiles" stripe>
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column prop="targetSystem" label="目标系统" min-width="140" />
        <el-table-column prop="version" label="版本" width="100" />
        <el-table-column prop="created_at" label="创建时间" width="180" />
        <el-table-column label="操作" width="220" align="center" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" link @click="handleEdit(row)">编辑</el-button>
            <el-button type="success" size="small" link @click="handleExport(row)">导出</el-button>
            <el-popconfirm title="确定删除？" @confirm="handleDelete(row)">
              <template #reference>
                <el-button type="danger" size="small" link>删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新建/编辑对话框 -->
    <el-dialog v-model="showDialog" :title="editingProfile ? '编辑 Profile' : '新建 Profile'" width="500px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="100px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="Profile 名称" />
        </el-form-item>
        <el-form-item label="目标系统" prop="targetSystem">
          <el-input v-model="form.targetSystem" placeholder="如 RouterOS, Cisco IOS" />
        </el-form-item>
        <el-form-item label="版本" prop="version">
          <el-input v-model="form.version" placeholder="如 1.0.0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { profileApi, type ApiProfile } from '@/api/device'

defineOptions({ name: 'ApiProfileManager' })

const profiles = ref<ApiProfile[]>([])
const loading = ref(false)
const saving = ref(false)
const showDialog = ref(false)
const editingProfile = ref<ApiProfile | null>(null)
const formRef = ref<FormInstance>()

const form = reactive({ name: '', targetSystem: '', version: '1.0.0' })
const formRules: FormRules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  targetSystem: [{ required: true, message: '请输入目标系统', trigger: 'blur' }],
  version: [{ required: true, message: '请输入版本', trigger: 'blur' }],
}

async function fetchProfiles() {
  loading.value = true
  try {
    const res = await profileApi.list()
    if (res.data.success && res.data.data) profiles.value = res.data.data
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '获取 Profile 列表失败')
  } finally { loading.value = false }
}

function handleEdit(row: ApiProfile) {
  editingProfile.value = row
  Object.assign(form, { name: row.name, targetSystem: row.targetSystem, version: row.version })
  showDialog.value = true
}

async function handleSave() {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    if (editingProfile.value) {
      await profileApi.update(editingProfile.value.id, form)
      ElMessage.success('更新成功')
    } else {
      await profileApi.create(form)
      ElMessage.success('创建成功')
    }
    showDialog.value = false
    editingProfile.value = null
    fetchProfiles()
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  } finally { saving.value = false }
}

async function handleDelete(row: ApiProfile) {
  try {
    await profileApi.delete(row.id)
    ElMessage.success('已删除')
    fetchProfiles()
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败')
  }
}

async function handleExport(row: ApiProfile) {
  try {
    const res = await profileApi.export(row.id)
    const blob = new Blob([res.data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${row.name}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '导出失败')
  }
}

function handleImport(file: File) {
  profileApi.import(file).then(() => {
    ElMessage.success('导入成功')
    fetchProfiles()
  }).catch((e: unknown) => {
    ElMessage.error(e instanceof Error ? e.message : '导入失败')
  })
  return false // prevent default upload
}

onMounted(fetchProfiles)
</script>

<style scoped>
.api-profile-manager { height: 100%; padding: 20px; background: var(--el-bg-color-page); overflow-y: auto; }
.header-card { margin-bottom: 20px; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
.header-actions { display: flex; gap: 8px; }
</style>
