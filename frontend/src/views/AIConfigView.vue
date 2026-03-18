<template>
  <div class="ai-config-view">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>AI 服务配置</span>
          <div class="header-actions">
            <el-button
              :icon="Refresh"
              :loading="loading"
              @click="loadConfigs"
            >
              刷新
            </el-button>
            <el-button
              type="primary"
              :icon="Plus"
              @click="handleAdd"
            >
              添加配置
            </el-button>
          </div>
        </div>
      </template>

      <!-- Loading State -->
      <el-skeleton v-if="loading && configs.length === 0" :rows="5" animated />

      <!-- Error State -->
      <el-alert
        v-else-if="error"
        :title="error"
        type="error"
        show-icon
        closable
        @close="error = ''"
      />

      <!-- Empty State -->
      <el-empty
        v-else-if="configs.length === 0"
        description="暂无 AI 服务配置，点击上方按钮添加"
      />

      <!-- Config List -->
      <el-table
        v-else
        v-loading="loading"
        :data="configs"
        stripe
        style="width: 100%"
      >
        <el-table-column prop="name" label="名称" min-width="120" />
        <el-table-column prop="provider" label="提供商" width="120">
          <template #default="{ row }">
            <el-tag :type="getProviderTagType(row.provider)" size="small">
              {{ getProviderDisplayName(row.provider) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="model" label="模型" min-width="140" show-overflow-tooltip />
        <el-table-column prop="endpoint" label="端点" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.endpoint || getDefaultEndpoint(row.provider) }}
          </template>
        </el-table-column>
        <el-table-column prop="apiKeyMasked" label="API Key" width="140">
          <template #default="{ row }">
            <code class="api-key-masked">{{ row.apiKeyMasked }}</code>
          </template>
        </el-table-column>
        <el-table-column label="默认" width="80" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.isDefault" type="success" size="small">默认</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              type="primary"
              link
              :loading="testingId === row.id"
              @click="handleTestConnection(row)"
            >
              测试
            </el-button>
            <el-button
              v-if="!row.isDefault"
              size="small"
              type="success"
              link
              @click="handleSetDefault(row)"
            >
              设为默认
            </el-button>
            <el-button
              size="small"
              type="warning"
              link
              @click="handleEdit(row)"
            >
              编辑
            </el-button>
            <el-button
              size="small"
              type="danger"
              link
              @click="handleDelete(row)"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Add/Edit Dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑配置' : '添加配置'"
      width="550px"
      destroy-on-close
      @close="resetForm"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="100px"
      >
        <el-form-item label="名称" prop="name">
          <el-input
            v-model="form.name"
            placeholder="请输入配置名称"
            clearable
          />
        </el-form-item>

        <el-form-item label="提供商" prop="provider">
          <el-select
            v-model="form.provider"
            placeholder="请选择 AI 提供商"
            style="width: 100%"
            @change="handleProviderChange"
          >
            <el-option
              v-for="provider in providers"
              :key="provider.id"
              :label="provider.name"
              :value="provider.id"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="API Key" prop="apiKey">
          <el-input
            v-model="form.apiKey"
            type="password"
            :placeholder="isEditing ? '留空则保持原有 Key' : '请输入 API Key'"
            show-password
            clearable
          />
        </el-form-item>

        <el-form-item label="模型" prop="model">
          <el-select
            v-model="form.model"
            :placeholder="form.provider === 'custom' ? '请输入模型名称' : '输入或选择模型名称'"
            style="width: 100%"
            filterable
            allow-create
            default-first-option
          >
            <el-option
              v-for="model in availableModels"
              :key="model"
              :label="model"
              :value="model"
            />
          </el-select>
          <div class="form-tip">支持手动输入任意模型名称/版本</div>
        </el-form-item>

        <el-form-item :label="form.provider === 'custom' ? 'API 端点' : '自定义端点'" :required="form.provider === 'custom'">
          <el-input
            v-model="form.endpoint"
            :placeholder="form.provider === 'custom' ? '请输入 API 端点地址（必填）' : currentDefaultEndpoint"
            clearable
          />
          <div class="form-tip">
            {{ form.provider === 'custom' ? '自定义供应商必须提供 API 端点，需兼容 OpenAI API 格式' : '留空使用默认端点' }}
          </div>
        </el-form-item>

        <el-form-item label="设为默认">
          <el-switch v-model="form.isDefault" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="saving"
          @click="handleSave"
        >
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Refresh, Plus } from '@element-plus/icons-vue'

import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import {
  configApi,
  providerApi,
  AIProvider,
  type APIConfigDisplay,
  type ProviderInfo,
  type CreateAPIConfigInput,
  type UpdateAPIConfigInput
} from '@/api/ai'

// ==================== 常量 ====================

const DEFAULT_ENDPOINTS: Record<AIProvider, string> = {
  [AIProvider.OPENAI]: 'https://api.openai.com/v1',
  [AIProvider.GEMINI]: 'https://generativelanguage.googleapis.com/v1beta',
  [AIProvider.CLAUDE]: 'https://api.anthropic.com/v1',
  [AIProvider.DEEPSEEK]: 'https://api.deepseek.com/v1',
  [AIProvider.QWEN]: 'https://dashscope.aliyuncs.com/api/v1',
  [AIProvider.ZHIPU]: 'https://open.bigmodel.cn/api/paas/v4',
  [AIProvider.CUSTOM]: ''
}

const PROVIDER_DISPLAY_NAMES: Record<AIProvider, string> = {
  [AIProvider.OPENAI]: 'OpenAI',
  [AIProvider.GEMINI]: 'Gemini',
  [AIProvider.CLAUDE]: 'Claude',
  [AIProvider.DEEPSEEK]: 'DeepSeek',
  [AIProvider.QWEN]: 'Qwen',
  [AIProvider.ZHIPU]: '智谱AI',
  [AIProvider.CUSTOM]: '自定义'
}

// ==================== 状态 ====================

const loading = ref(false)
const saving = ref(false)
const error = ref('')
const configs = ref<APIConfigDisplay[]>([])
const providers = ref<ProviderInfo[]>([])
const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref<string | null>(null)
const testingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

// 表单数据
const form = reactive<{
  name: string
  provider: AIProvider | ''
  apiKey: string
  model: string
  endpoint: string
  isDefault: boolean
}>({
  name: '',
  provider: '',
  apiKey: '',
  model: '',
  endpoint: '',
  isDefault: false
})

// 表单验证规则
const rules: FormRules = {
  name: [
    { required: true, message: '请输入配置名称', trigger: 'blur' },
    { min: 1, max: 50, message: '名称长度在 1 到 50 个字符', trigger: 'blur' }
  ],
  provider: [
    { required: true, message: '请选择 AI 提供商', trigger: 'change' }
  ],
  apiKey: [
    {
      validator: (_rule, value, callback) => {
        if (!isEditing.value && !value) {
          callback(new Error('请输入 API Key'))
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ],
  model: [
    { required: true, message: '请选择或输入模型', trigger: 'change' }
  ]
}

// ==================== 计算属性 ====================

// 当前选中提供商的可用模型
const availableModels = computed(() => {
  if (!form.provider) return []
  const provider = providers.value.find(p => p.id === form.provider)
  return provider?.defaultModels || []
})

// 当前选中提供商的默认端点
const currentDefaultEndpoint = computed(() => {
  if (!form.provider) return '请先选择提供商'
  return DEFAULT_ENDPOINTS[form.provider as AIProvider] || ''
})

// ==================== 生命周期 ====================

// 初始化数据加载
const initData = () => {
  loadConfigs()
  loadProviders()
}

onMounted(() => {
  initData()
})

// ==================== 方法 ====================

// 加载配置列表
const loadConfigs = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await configApi.getAll()
    const result = response.data
    if (result.success && Array.isArray(result.data)) {
      configs.value = result.data
    } else {
      configs.value = []
      if (!result.success && result.error) {
        throw new Error(result.error)
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '加载配置列表失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// 加载提供商列表
const loadProviders = async () => {
  try {
    const response = await providerApi.getAll()
    const result = response.data
    if (result.success && Array.isArray(result.data)) {
      providers.value = result.data
    }
  } catch (err: unknown) {
    console.error('加载提供商列表失败:', err)
  }
}

// 获取提供商显示名称
const getProviderDisplayName = (provider: AIProvider): string => {
  return PROVIDER_DISPLAY_NAMES[provider] || provider
}

// 获取提供商标签类型
const getProviderTagType = (provider: AIProvider): 'success' | 'warning' | 'info' | 'primary' | 'danger' => {
  const typeMap: Record<AIProvider, 'success' | 'warning' | 'info' | 'primary' | 'danger'> = {
    [AIProvider.OPENAI]: 'success',
    [AIProvider.GEMINI]: 'primary',
    [AIProvider.CLAUDE]: 'warning',
    [AIProvider.DEEPSEEK]: 'info',
    [AIProvider.QWEN]: 'warning',
    [AIProvider.ZHIPU]: 'danger',
    [AIProvider.CUSTOM]: 'info'
  }
  return typeMap[provider] || 'info'
}

// 获取默认端点
const getDefaultEndpoint = (provider: AIProvider): string => {
  return DEFAULT_ENDPOINTS[provider] || ''
}

// 处理提供商变更
const handleProviderChange = (provider: AIProvider) => {
  // 自动选择第一个模型
  const providerInfo = providers.value.find(p => p.id === provider)
  if (providerInfo && providerInfo.defaultModels.length > 0) {
    form.model = providerInfo.defaultModels[0]
  } else {
    form.model = ''
  }
  // 清空自定义端点
  form.endpoint = ''
}

// 打开添加对话框
const handleAdd = () => {
  isEditing.value = false
  editingId.value = null
  resetForm()
  dialogVisible.value = true
}

// 打开编辑对话框
const handleEdit = (row: APIConfigDisplay) => {
  isEditing.value = true
  editingId.value = row.id
  form.name = row.name
  form.provider = row.provider
  form.apiKey = '' // 编辑时不显示原有 Key
  form.model = row.model
  form.endpoint = row.endpoint || ''
  form.isDefault = row.isDefault
  dialogVisible.value = true
}

// 重置表单
const resetForm = () => {
  form.name = ''
  form.provider = ''
  form.apiKey = ''
  form.model = ''
  form.endpoint = ''
  form.isDefault = false
  formRef.value?.resetFields()
}

// 保存配置
const handleSave = async () => {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  // 自定义供应商端点必填校验
  if (form.provider === AIProvider.CUSTOM && !form.endpoint) {
    ElMessage.error('自定义供应商必须提供 API 端点地址')
    return
  }

  saving.value = true

  try {
    if (isEditing.value && editingId.value) {
      // 更新配置
      const updateData: UpdateAPIConfigInput = {
        name: form.name,
        provider: form.provider as AIProvider,
        model: form.model,
        endpoint: form.endpoint || undefined,
        isDefault: form.isDefault
      }
      // 只有输入了新的 API Key 才更新
      if (form.apiKey) {
        updateData.apiKey = form.apiKey
      }
      await configApi.update(editingId.value, updateData)
      ElMessage.success('配置已更新')
    } else {
      // 创建配置
      const createData: CreateAPIConfigInput = {
        name: form.name,
        provider: form.provider as AIProvider,
        apiKey: form.apiKey,
        model: form.model,
        endpoint: form.endpoint || undefined,
        isDefault: form.isDefault
      }
      await configApi.create(createData)
      ElMessage.success('配置已添加')
    }

    dialogVisible.value = false
    await loadConfigs()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '保存失败'
    ElMessage.error(message)
  } finally {
    saving.value = false
  }
}

// 删除配置
const handleDelete = async (row: APIConfigDisplay) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除配置 "${row.name}" 吗？`,
      '删除确认',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    await configApi.delete(row.id)
    ElMessage.success('配置已删除')
    await loadConfigs()
  } catch (err: unknown) {
    if ((err as { message?: string })?.message !== 'cancel') {
      const message = err instanceof Error ? err.message : '删除失败'
      ElMessage.error(message)
    }
  }
}

// 设为默认
const handleSetDefault = async (row: APIConfigDisplay) => {
  try {
    await configApi.setDefault(row.id)
    ElMessage.success(`已将 "${row.name}" 设为默认配置`)
    await loadConfigs()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '设置默认配置失败'
    ElMessage.error(message)
  }
}

// 测试连接
const handleTestConnection = async (row: APIConfigDisplay) => {
  testingId.value = row.id

  try {
    const response = await configApi.testConnection(row.id)
    const result = response.data
    if (result.success && result.data?.connected) {
      ElMessage.success(`连接测试成功: ${result.data.message || 'API 可用'}`)
    } else {
      ElMessage.error(`连接测试失败: ${result.data?.message || result.error || '未知错误'}`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '连接测试失败'
    ElMessage.error(message)
  } finally {
    testingId.value = null
  }
}
</script>

<style scoped>
.ai-config-view {
  height: 100%;
  padding: 20px;
  background: var(--el-bg-color-page);
  overflow-y: auto;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 18px;
  font-weight: 600;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.api-key-masked {
  font-family: monospace;
  font-size: 12px;
  background-color: var(--el-fill-color-light);
  padding: 2px 6px;
  border-radius: 4px;
}

.form-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}
</style>
