<template>
  <div class="user-management-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>用户管理</span>
            <span class="header-description">管理系统用户、角色分配与密码</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" @click="showCreateDialog">
              <el-icon><i-ep-plus /></el-icon>
              添加用户
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <el-skeleton v-if="loading" :rows="5" animated />
    <el-empty v-else-if="!users.length" description="暂无用户" />
    <el-table v-else :data="users" stripe>
      <el-table-column prop="username" label="用户名" width="150" />
      <el-table-column prop="role" label="角色" width="120">
        <template #default="{ row }">
          <el-tag :type="row.role === 'admin' ? 'danger' : 'info'" size="small">{{ row.role }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="email" label="邮箱" min-width="200" />
      <el-table-column prop="enabled" label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.enabled !== false ? 'success' : 'info'" size="small">
            {{ row.enabled !== false ? '启用' : '禁用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="lastLoginAt" label="最后登录" width="180">
        <template #default="{ row }">{{ row.lastLoginAt ? formatTime(row.lastLoginAt) : '-' }}</template>
      </el-table-column>
      <el-table-column prop="createdAt" label="创建时间" width="180">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link size="small" @click="showEditDialog(row)">编辑</el-button>
          <el-button type="warning" link size="small" @click="resetPassword(row)">重置密码</el-button>
          <el-button type="danger" link size="small" @click="deleteUser(row)" :disabled="row.role === 'admin'">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 创建/编辑对话框 -->
    <el-dialog v-model="dialogVisible" :title="editingUser ? '编辑用户' : '添加用户'" width="500px" destroy-on-close>
      <el-form :model="formData" :rules="formRules" ref="formRef" label-width="80px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="formData.username" :disabled="!!editingUser" placeholder="用户名" />
        </el-form-item>
        <el-form-item v-if="!editingUser" label="密码" prop="password">
          <el-input v-model="formData.password" type="password" show-password placeholder="密码" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="formData.email" placeholder="邮箱（可选）" />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="formData.role" style="width:100%">
            <el-option label="管理员" value="admin" />
            <el-option label="操作员" value="operator" />
            <el-option label="只读" value="viewer" />
          </el-select>
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="formData.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveUser">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import api from '@/api/index'

interface User {
  id: string; username: string; role: string; email?: string
  enabled?: boolean; lastLoginAt?: string; createdAt: string
}

const loading = ref(false)
const saving = ref(false)
const users = ref<User[]>([])
const dialogVisible = ref(false)
const editingUser = ref<User | null>(null)
const formRef = ref<FormInstance>()
const formData = ref({ username: '', password: '', email: '', role: 'operator', enabled: true })
const formRules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur', min: 6 }],
  role: [{ required: true, message: '请选择角色', trigger: 'change' }],
}

function formatTime(ts: string | number) { return ts ? new Date(ts).toLocaleString() : '-' }

async function loadUsers() {
  loading.value = true
  try {
    const res = await api.get('/auth/users')
    users.value = res.data.data || []
  } catch { ElMessage.error('加载用户失败') }
  finally { loading.value = false }
}

function showCreateDialog() {
  editingUser.value = null
  formData.value = { username: '', password: '', email: '', role: 'operator', enabled: true }
  dialogVisible.value = true
}

function showEditDialog(user: User) {
  editingUser.value = user
  formData.value = { username: user.username, password: '', email: user.email || '', role: user.role, enabled: user.enabled !== false }
  dialogVisible.value = true
}

async function saveUser() {
  if (!formRef.value) return
  try { await formRef.value.validate() } catch { return }
  saving.value = true
  try {
    if (editingUser.value) {
      const { password, ...rest } = formData.value
      await api.put(`/auth/users/${editingUser.value.id}`, rest)
      ElMessage.success('更新成功')
    } else {
      await api.post('/auth/users', formData.value)
      ElMessage.success('创建成功')
    }
    dialogVisible.value = false
    loadUsers()
  } catch { ElMessage.error('保存失败') }
  finally { saving.value = false }
}

async function resetPassword(user: User) {
  try {
    const { value } = await ElMessageBox.prompt('请输入新密码', '重置密码', { inputType: 'password', inputPattern: /.{6,}/, inputErrorMessage: '密码至少6位' })
    await api.post(`/auth/users/${user.id}/reset-password`, { password: value })
    ElMessage.success('密码已重置')
  } catch (e) { if (e !== 'cancel') ElMessage.error('重置失败') }
}

async function deleteUser(user: User) {
  try {
    await ElMessageBox.confirm(`确定删除用户 "${user.username}"？`, '删除确认', { type: 'warning' })
    await api.delete(`/auth/users/${user.id}`)
    ElMessage.success('删除成功')
    loadUsers()
  } catch (e) { if (e !== 'cancel') ElMessage.error('删除失败') }
}

onMounted(loadUsers)
</script>

<style scoped>
.user-management-view { padding: 20px; background: var(--el-bg-color-page); min-height: 100%; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
.header-description { margin-left: 12px; font-size: 14px; font-weight: normal; color: var(--el-text-color-secondary); }
.header-actions { display: flex; gap: 8px; }
</style>
