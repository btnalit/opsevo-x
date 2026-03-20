<template>
  <div class="ai-provider-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>AI 提供商管理</span>
            <span class="header-description">管理 AI 服务提供商配置、API Key 与用量统计</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" @click="showCreateDialog">
              <el-icon><i-ep-plus /></el-icon>
              添加提供商
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <el-tabs v-model="activeTab" type="border-card">
      <!-- 提供商列表 -->
      <el-tab-pane label="提供商配置" name="providers">
        <el-skeleton v-if="loading" :rows="5" animated />
        <el-empty v-else-if="!providers.length" description="暂无提供商配置">
          <el-button type="primary" @click="showCreateDialog">添加提供商</el-button>
        </el-empty>
        <el-row v-else :gutter="16">
          <el-col v-for="p in providers" :key="p.id" :span="8" style="margin-bottom:16px">
            <el-card shadow="hover" class="provider-card">
              <template #header>
                <div class="provider-header">
                  <div>
                    <span class="provider-name">{{ p.name }}</span>
                    <el-tag :type="p.enabled ? 'success' : 'info'" size="small" style="margin-left:8px">
                      {{ p.enabled ? '启用' : '禁用' }}
                    </el-tag>
                  </div>
                  <el-tag size="small">{{ p.provider }}</el-tag>
                </div>
              </template>
              <el-descriptions :column="1" size="small">
                <el-descriptions-item label="API Key">
                  <span class="masked-key">{{ maskApiKey(p.apiKey) }}</span>
                </el-descriptions-item>
                <el-descriptions-item label="模型">{{ p.model || '-' }}</el-descriptions-item>
                <el-descriptions-item label="Base URL">{{ p.baseUrl || '默认' }}</el-descriptions-item>
              </el-descriptions>
              <div class="provider-actions">
                <el-button type="primary" link size="small" @click="testConnection(p)">测试连接</el-button>
                <el-button type="warning" link size="small" @click="showEditDialog(p)">编辑</el-button>
                <el-button type="info" link size="small" @click="toggleProvider(p)">
                  {{ p.enabled ? '禁用' : '启用' }}
                </el-button>
                <el-button type="danger" link size="small" @click="deleteProvider(p)">删除</el-button>
              </div>
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- Token 用量统计 -->
      <el-tab-pane label="用量统计" name="usage">
        <el-skeleton v-if="usageLoading" :rows="5" animated />
        <el-empty v-else-if="!usageStats.length" description="暂无用量数据" />
        <template v-else>
          <el-row :gutter="16" style="margin-bottom:20px">
            <el-col :span="6" v-for="stat in summaryStats" :key="stat.label">
              <el-statistic :title="stat.label" :value="stat.value" />
            </el-col>
          </el-row>
          <el-table :data="usageStats" stripe>
            <el-table-column prop="provider" label="提供商" width="150" />
            <el-table-column prop="model" label="模型" width="200" />
            <el-table-column prop="totalTokens" label="总 Token" width="120">
              <template #default="{ row }">{{ formatNumber(row.totalTokens) }}</template>
            </el-table-column>
            <el-table-column prop="promptTokens" label="Prompt Token" width="120">
              <template #default="{ row }">{{ formatNumber(row.promptTokens) }}</template>
            </el-table-column>
            <el-table-column prop="completionTokens" label="Completion Token" width="140">
              <template #default="{ row }">{{ formatNumber(row.completionTokens) }}</template>
            </el-table-column>
            <el-table-column prop="requestCount" label="请求数" width="100" />
            <el-table-column prop="errorCount" label="错误数" width="100">
              <template #default="{ row }">
                <span :class="{ 'text-danger': row.errorCount > 0 }">{{ row.errorCount }}</span>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </el-tab-pane>
    </el-tabs>

    <!-- 创建/编辑对话框 -->
    <el-dialog v-model="dialogVisible" :title="editingProvider ? '编辑提供商' : '添加提供商'" width="600px" destroy-on-close>
      <el-form :model="formData" :rules="formRules" ref="formRef" label-width="100px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="formData.name" placeholder="配置名称" />
        </el-form-item>
        <el-form-item label="提供商" prop="provider">
          <el-select v-model="formData.provider" placeholder="选择提供商" style="width:100%" filterable allow-create>
            <el-option label="OpenAI" value="openai" />
            <el-option label="Claude" value="claude" />
            <el-option label="Gemini" value="gemini" />
            <el-option label="DeepSeek" value="deepseek" />
            <el-option label="Qwen (通义千问)" value="qwen" />
            <el-option label="智谱AI" value="zhipu" />
            <el-option label="Ollama (本地)" value="ollama" />
            <el-option label="自定义" value="custom" />
          </el-select>
        </el-form-item>
        <el-form-item label="API Key" prop="apiKey">
          <el-input v-model="formData.apiKey" placeholder="API Key" show-password />
        </el-form-item>
        <el-form-item label="模型">
          <el-input v-model="formData.model" placeholder="模型名称（如 gpt-4）" />
        </el-form-item>
        <el-form-item label="Base URL">
          <el-input v-model="formData.baseUrl" placeholder="自定义 API 地址（可选）" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="formData.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveProvider">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import api from '@/api/index'

interface AiProvider {
  id: string; name: string; provider: string; apiKey: string; model?: string
  baseUrl?: string; enabled: boolean
}
interface UsageStat {
  provider: string; model: string; totalTokens: number; promptTokens: number
  completionTokens: number; requestCount: number; errorCount: number
}

const activeTab = ref('providers')
const loading = ref(false)
const saving = ref(false)
const usageLoading = ref(false)
const providers = ref<AiProvider[]>([])
const usageStats = ref<UsageStat[]>([])
const dialogVisible = ref(false)
const editingProvider = ref<AiProvider | null>(null)
const formRef = ref<FormInstance>()

const formData = ref({ name: '', provider: 'openai', apiKey: '', model: '', baseUrl: '', enabled: true })
const formRules: FormRules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  provider: [{ required: true, message: '请选择提供商', trigger: 'change' }],
  apiKey: [{ required: true, message: '请输入 API Key', trigger: 'blur' }],
}

const summaryStats = computed(() => {
  const total = usageStats.value.reduce((s, u) => s + u.totalTokens, 0)
  const requests = usageStats.value.reduce((s, u) => s + u.requestCount, 0)
  const errors = usageStats.value.reduce((s, u) => s + u.errorCount, 0)
  return [
    { label: '总 Token 消耗', value: total },
    { label: '总请求数', value: requests },
    { label: '总错误数', value: errors },
    { label: '提供商数', value: providers.value.length },
  ]
})

function maskApiKey(key: string) {
  if (!key || key.length < 8) return '****'
  return key.substring(0, 4) + '****' + key.substring(key.length - 4)
}

function formatNumber(n: number) {
  return n?.toLocaleString() || '0'
}

async function loadProviders() {
  loading.value = true
  try {
    const res = await api.get('/ai-ops/ai-providers')
    providers.value = res.data.data || []
  } catch {
    ElMessage.error('加载提供商失败')
  } finally {
    loading.value = false
  }
}

async function loadUsage() {
  usageLoading.value = true
  try {
    const res = await api.get('/ai-ops/ai-providers/usage')
    usageStats.value = res.data.data || []
  } catch {
    usageStats.value = []
  } finally {
    usageLoading.value = false
  }
}

function showCreateDialog() {
  editingProvider.value = null
  formData.value = { name: '', provider: 'openai', apiKey: '', model: '', baseUrl: '', enabled: true }
  dialogVisible.value = true
}

function showEditDialog(p: AiProvider) {
  editingProvider.value = p
  formData.value = { name: p.name, provider: p.provider, apiKey: p.apiKey, model: p.model || '', baseUrl: p.baseUrl || '', enabled: p.enabled }
  dialogVisible.value = true
}

async function saveProvider() {
  if (!formRef.value) return
  try { await formRef.value.validate() } catch { return }
  saving.value = true
  try {
    if (editingProvider.value) {
      await api.put(`/ai-ops/ai-providers/${editingProvider.value.id}`, formData.value)
      ElMessage.success('更新成功')
    } else {
      await api.post('/ai-ops/ai-providers', formData.value)
      ElMessage.success('创建成功')
    }
    dialogVisible.value = false
    loadProviders()
  } catch {
    ElMessage.error('保存失败')
  } finally {
    saving.value = false
  }
}

async function testConnection(p: AiProvider) {
  try {
    const res = await api.post(`/ai-ops/ai-providers/${p.id}/test`)
    if (res.data.success) ElMessage.success('连接测试成功')
    else ElMessage.error(res.data.error || '连接测试失败')
  } catch {
    ElMessage.error('连接测试失败')
  }
}

async function toggleProvider(p: AiProvider) {
  try {
    await api.put(`/ai-ops/ai-providers/${p.id}`, { enabled: !p.enabled })
    ElMessage.success(p.enabled ? '已禁用' : '已启用')
    loadProviders()
  } catch {
    ElMessage.error('操作失败')
  }
}

async function deleteProvider(p: AiProvider) {
  try {
    await ElMessageBox.confirm(`确定删除提供商 "${p.name}"？`, '删除确认', { type: 'warning' })
    await api.delete(`/ai-ops/ai-providers/${p.id}`)
    ElMessage.success('删除成功')
    loadProviders()
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('删除失败')
  }
}

onMounted(() => {
  loadProviders()
  loadUsage()
})
</script>

<style scoped>
.ai-provider-view { padding: 20px; background: var(--el-bg-color-page); min-height: 100%; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
.header-description { margin-left: 12px; font-size: 14px; font-weight: normal; color: var(--el-text-color-secondary); }
.header-actions { display: flex; gap: 8px; }
.provider-card { height: 100%; }
.provider-header { display: flex; justify-content: space-between; align-items: center; }
.provider-name { font-weight: 600; }
.masked-key { font-family: monospace; color: var(--el-text-color-secondary); }
.provider-actions { margin-top: 12px; display: flex; gap: 4px; flex-wrap: wrap; }
.text-danger { color: var(--el-color-danger); }
</style>
