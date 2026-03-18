<template>
  <div class="notification-channels-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>通知渠道管理</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" :icon="Plus" @click="showCreateDialog">
              新建渠道
            </el-button>
            <el-button :icon="Refresh" :loading="loading" @click="loadChannels">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Loading State -->
    <el-skeleton v-if="loading && channels.length === 0" :rows="5" animated />

    <!-- Error State -->
    <el-alert
      v-else-if="error"
      :title="error"
      type="error"
      show-icon
      closable
      @close="error = ''"
    >
      <template #default>
        <el-button type="primary" size="small" @click="loadChannels">
          重新加载
        </el-button>
      </template>
    </el-alert>

    <!-- Empty State -->
    <el-card v-else-if="channels.length === 0" shadow="hover">
      <el-empty description="暂无通知渠道">
        <el-button type="primary" @click="showCreateDialog">创建第一个渠道</el-button>
      </el-empty>
    </el-card>

    <!-- Channels Table -->
    <el-card v-else shadow="hover">
      <el-table
        v-loading="loading"
        :data="channels"
        stripe
        style="width: 100%"
        @row-click="handleRowClick"
      >
        <el-table-column prop="name" label="渠道名称" min-width="150" show-overflow-tooltip />
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-tag 
              :type="getChannelTypeTagType(row.type)" 
              size="small"
              style="display: inline-flex; align-items: center; white-space: nowrap"
            >
              <el-icon class="channel-type-icon"><component :is="getChannelTypeIcon(row.type)" /></el-icon>
              {{ getChannelTypeText(row.type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="告警级别过滤" min-width="180">
          <template #default="{ row }">
            <template v-if="row.severityFilter && row.severityFilter.length > 0">
              <el-tag
                v-for="severity in row.severityFilter"
                :key="severity"
                :type="getSeverityType(severity)"
                size="small"
                style="margin-right: 4px"
              >
                {{ getSeverityText(severity) }}
              </el-tag>
            </template>
            <span v-else class="no-filter">全部级别</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">
            {{ formatTime(row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              type="success"
              link
              :loading="testingChannel === row.id"
              @click.stop="testChannel(row)"
            >
              测试
            </el-button>
            <el-button size="small" type="primary" link @click.stop="editChannel(row)">
              编辑
            </el-button>
            <el-button
              size="small"
              :type="row.enabled ? 'warning' : 'success'"
              link
              @click.stop="toggleChannel(row)"
            >
              {{ row.enabled ? '禁用' : '启用' }}
            </el-button>
            <el-popconfirm
              title="确定要删除此渠道吗？"
              confirm-button-text="确定"
              cancel-button-text="取消"
              @confirm="deleteChannel(row)"
            >
              <template #reference>
                <el-button size="small" type="danger" link @click.stop>
                  删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 通知历史 -->
    <el-card style="margin-top: 20px;" shadow="hover">
      <template #header>
        <div class="card-header">
          <span>通知历史</span>
          <el-button size="small" @click="loadNotificationHistory">刷新</el-button>
        </div>
      </template>
      <el-table v-if="notificationHistory.length > 0" :data="notificationHistory" stripe size="small">
        <el-table-column prop="channelName" label="渠道" min-width="120" />
        <el-table-column prop="type" label="类型" width="100">
          <template #default="{ row }"><el-tag size="small">{{ row.type }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="subject" label="主题" min-width="200" show-overflow-tooltip />
        <el-table-column prop="status" label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.status === 'sent' ? 'success' : 'danger'" size="small">{{ row.status === 'sent' ? '已发送' : '失败' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sentAt" label="发送时间" width="160" />
      </el-table>
      <el-empty v-else description="暂无通知记录" />
    </el-card>

    <!-- Create/Edit Dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑通知渠道' : '新建通知渠道'"
      width="650px"
      destroy-on-close
      @close="resetForm"
    >
      <el-form
        ref="formRef"
        :model="formData"
        :rules="formRules"
        label-width="120px"
        label-position="right"
      >
        <el-form-item label="渠道名称" prop="name">
          <el-input v-model="formData.name" placeholder="请输入渠道名称" />
        </el-form-item>

        <el-form-item label="渠道类型" prop="type">
          <el-radio-group v-model="formData.type" :disabled="isEditing">
            <el-radio-button
              v-for="option in channelTypeOptions"
              :key="option.value"
              :value="option.value"
            >
              <el-icon><component :is="option.icon" /></el-icon>
              {{ option.label }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>

        <!-- Web Push Config -->
        <template v-if="formData.type === 'web_push'">
          <el-alert
            title="Web 推送使用浏览器原生通知 API，无需额外配置"
            type="info"
            :closable="false"
            show-icon
            style="margin-bottom: 20px"
          />
        </template>

        <!-- Webhook Config -->
        <template v-if="formData.type === 'webhook'">
          <el-divider content-position="left">Webhook 配置</el-divider>

          <el-form-item label="请求 URL" prop="webhookUrl">
            <el-input v-model="formData.webhookUrl" placeholder="https://example.com/webhook">
              <template #prepend>URL</template>
            </el-input>
            <div class="form-tip">必填，Webhook URL</div>
          </el-form-item>

          <el-form-item label="请求方法" prop="webhookMethod">
            <el-radio-group v-model="formData.webhookMethod">
              <el-radio value="POST">POST</el-radio>
              <el-radio value="PUT">PUT</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-form-item label="请求头">
            <el-input
              v-model="formData.webhookHeaders"
              type="textarea"
              :rows="3"
              :placeholder="webhookHeadersPlaceholder"
            />
            <div class="form-tip">JSON 格式的请求头，示例: {"Content-Type": "application/json", "Authorization": "Bearer token"}</div>
          </el-form-item>

          <el-form-item label="请求体模板">
            <el-input
              v-model="formData.webhookBodyTemplate"
              type="textarea"
              :rows="4"
              :placeholder="webhookBodyPlaceholder"
            />
            <div class="form-tip">
              JSON 格式，支持变量替换。可用变量: title, body, type, severity, timestamp
            </div>
          </el-form-item>
        </template>

        <!-- Email Config -->
        <template v-if="formData.type === 'email'">
          <el-divider content-position="left">SMTP 配置</el-divider>

          <el-form-item label="SMTP 服务器" prop="smtpHost">
            <el-row :gutter="12">
              <el-col :span="16">
                <el-input v-model="formData.smtpHost" placeholder="smtp.example.com" />
              </el-col>
              <el-col :span="8">
                <el-input-number 
                  v-model="formData.smtpPort" 
                  :min="1" 
                  :max="65535" 
                  style="width: 100%"
                  controls-position="right"
                />
              </el-col>
            </el-row>
            <div class="form-tip">服务器地址和端口（如 smtp.qq.com:465）</div>
          </el-form-item>

          <el-form-item label="使用 SSL/TLS">
            <el-switch v-model="formData.smtpSecure" />
          </el-form-item>

          <el-row :gutter="20">
            <el-col :span="12">
              <el-form-item label="用户名" prop="smtpUser">
                <el-input v-model="formData.smtpUser" placeholder="SMTP 用户名" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="密码" prop="smtpPass">
                <el-input v-model="formData.smtpPass" type="password" placeholder="SMTP 密码" show-password />
              </el-form-item>
            </el-col>
          </el-row>

          <el-divider content-position="left">邮件设置</el-divider>

          <el-form-item label="发件人" prop="emailFrom">
            <el-input v-model="formData.emailFrom" placeholder="noreply@example.com" />
          </el-form-item>

          <el-form-item label="收件人" prop="emailTo">
            <el-input v-model="formData.emailTo" placeholder="admin@example.com, ops@example.com" />
            <div class="form-tip">多个收件人用逗号分隔</div>
          </el-form-item>
        </template>

        <el-divider content-position="left">通用设置</el-divider>

        <el-form-item label="告警级别过滤">
          <el-checkbox-group v-model="formData.severityFilter">
            <el-checkbox
              v-for="option in severityOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </el-checkbox>
          </el-checkbox-group>
          <div class="form-tip">不选择则接收所有级别的告警</div>
        </el-form-item>

        <el-form-item label="启用状态">
          <el-switch v-model="formData.enabled" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ isEditing ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- Detail Dialog -->
    <el-dialog
      v-model="detailVisible"
      title="通知渠道详情"
      width="600px"
      destroy-on-close
    >
      <el-descriptions :column="2" border v-if="selectedChannel">
        <el-descriptions-item label="渠道名称" :span="2">{{ selectedChannel.name }}</el-descriptions-item>
        <el-descriptions-item label="渠道类型">
          <el-tag :type="getChannelTypeTagType(selectedChannel.type)" size="small">
            {{ getChannelTypeText(selectedChannel.type) }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="selectedChannel.enabled ? 'success' : 'info'" size="small">
            {{ selectedChannel.enabled ? '启用' : '禁用' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="告警级别过滤" :span="2">
          <template v-if="selectedChannel.severityFilter && selectedChannel.severityFilter.length > 0">
            <el-tag
              v-for="severity in selectedChannel.severityFilter"
              :key="severity"
              :type="getSeverityType(severity)"
              size="small"
              style="margin-right: 4px"
            >
              {{ getSeverityText(severity) }}
            </el-tag>
          </template>
          <span v-else>全部级别</span>
        </el-descriptions-item>
        <el-descriptions-item label="创建时间" :span="2">{{ formatTime(selectedChannel.createdAt) }}</el-descriptions-item>
      </el-descriptions>

      <!-- Type-specific config details -->
      <template v-if="selectedChannel?.type === 'webhook'">
        <el-divider content-position="left">Webhook 配置</el-divider>
        <el-descriptions :column="1" border>
          <el-descriptions-item label="请求 URL">
            {{ (selectedChannel.config as WebhookConfig).url }}
          </el-descriptions-item>
          <el-descriptions-item label="请求方法">
            {{ (selectedChannel.config as WebhookConfig).method }}
          </el-descriptions-item>
          <el-descriptions-item label="请求头" v-if="(selectedChannel.config as WebhookConfig).headers">
            <pre class="config-pre">{{ JSON.stringify((selectedChannel.config as WebhookConfig).headers, null, 2) }}</pre>
          </el-descriptions-item>
          <el-descriptions-item label="请求体模板" v-if="(selectedChannel.config as WebhookConfig).bodyTemplate">
            <pre class="config-pre">{{ (selectedChannel.config as WebhookConfig).bodyTemplate }}</pre>
          </el-descriptions-item>
        </el-descriptions>
      </template>

      <template v-if="selectedChannel?.type === 'email'">
        <el-divider content-position="left">邮件配置</el-divider>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="SMTP 服务器">
            {{ (selectedChannel.config as EmailConfig).smtp?.host }}
          </el-descriptions-item>
          <el-descriptions-item label="端口">
            {{ (selectedChannel.config as EmailConfig).smtp?.port }}
          </el-descriptions-item>
          <el-descriptions-item label="SSL/TLS">
            {{ (selectedChannel.config as EmailConfig).smtp?.secure ? '是' : '否' }}
          </el-descriptions-item>
          <el-descriptions-item label="用户名">
            {{ (selectedChannel.config as EmailConfig).smtp?.auth?.user }}
          </el-descriptions-item>
          <el-descriptions-item label="发件人" :span="2">
            {{ (selectedChannel.config as EmailConfig).from }}
          </el-descriptions-item>
          <el-descriptions-item label="收件人" :span="2">
            {{ (selectedChannel.config as EmailConfig).to?.join(', ') }}
          </el-descriptions-item>
        </el-descriptions>
      </template>

      <template v-if="selectedChannel?.type === 'web_push'">
        <el-divider content-position="left">Web 推送配置</el-divider>
        <el-alert
          title="Web 推送使用浏览器原生通知 API"
          type="info"
          :closable="false"
          show-icon
        />
      </template>

      <template #footer>
        <el-button
          type="success"
          :loading="testingChannel === selectedChannel?.id"
          @click="testChannel(selectedChannel!)"
        >
          测试
        </el-button>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="primary" @click="editChannel(selectedChannel!)">编辑</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Plus, Refresh, Bell, Link, Promotion } from '@element-plus/icons-vue'

import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import {
  notificationChannelsApi,
  type NotificationChannel,
  type CreateNotificationChannelInput,
  type ChannelType,
  type AlertSeverity,
  type WebhookConfig,
  type EmailConfig
} from '@/api/ai-ops'
import { notificationEnhancedApi } from '@/api/aiops-enhanced'

// Placeholder constants for Webhook form
const webhookHeadersPlaceholder = `{
  "Content-Type": "application/json",
  "Authorization": "Bearer your-token"
}`

const webhookBodyPlaceholder = `{
  "title": "{{title}}",
  "body": "{{body}}",
  "type": "{{type}}",
  "severity": "{{severity}}",
  "timestamp": "{{timestamp}}"
}`

// State
const loading = ref(false)
const error = ref('')
const channels = ref<NotificationChannel[]>([])
const notificationHistory = ref<Array<{ id: string; channelName: string; type: string; status: string; sentAt: string; subject?: string }>>([])
const dialogVisible = ref(false)
const detailVisible = ref(false)
const isEditing = ref(false)
const submitting = ref(false)
const testingChannel = ref<string | null>(null)
const selectedChannel = ref<NotificationChannel | null>(null)
const editingChannelId = ref<string | null>(null)
const formRef = ref<FormInstance>()

// Form data
interface FormDataType {
  name: string
  type: ChannelType
  enabled: boolean
  severityFilter: AlertSeverity[]
  // Webhook config
  webhookUrl: string
  webhookMethod: 'POST' | 'PUT'
  webhookHeaders: string
  webhookBodyTemplate: string
  // Email config
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  smtpPass: string
  emailFrom: string
  emailTo: string
}

const getDefaultFormData = (): FormDataType => ({
  name: '',
  type: 'web_push',
  enabled: true,
  severityFilter: [],
  // Webhook config
  webhookUrl: '',
  webhookMethod: 'POST',
  webhookHeaders: '{}',
  webhookBodyTemplate: '',
  // Email config
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpPass: '',
  emailFrom: '',
  emailTo: ''
})

const formData = reactive<FormDataType>(getDefaultFormData())

// Form validation rules
const formRules = computed<FormRules>(() => {
  const rules: FormRules = {
    name: [
      { required: true, message: '请输入渠道名称', trigger: 'blur' },
      { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
    ],
    type: [{ required: true, message: '请选择渠道类型', trigger: 'change' }]
  }

  if (formData.type === 'webhook') {
    rules.webhookUrl = [
      { required: true, message: '请输入 Webhook URL', trigger: 'blur' },
      { type: 'url', message: '请输入有效的 URL', trigger: 'blur' }
    ]
    rules.webhookMethod = [{ required: true, message: '请选择请求方法', trigger: 'change' }]
  }

  if (formData.type === 'email') {
    rules.smtpHost = [{ required: true, message: '请输入 SMTP 服务器地址', trigger: 'blur' }]
    rules.smtpPort = [{ required: true, message: '请输入 SMTP 端口', trigger: 'blur' }]
    rules.smtpUser = [{ required: true, message: '请输入 SMTP 用户名', trigger: 'blur' }]
    rules.smtpPass = [{ required: true, message: '请输入 SMTP 密码', trigger: 'blur' }]
    rules.emailFrom = [
      { required: true, message: '请输入发件人地址', trigger: 'blur' },
      { type: 'email', message: '请输入有效的邮箱地址', trigger: 'blur' }
    ]
    rules.emailTo = [{ required: true, message: '请输入收件人地址', trigger: 'blur' }]
  }

  return rules
})

// Channel type options
const channelTypeOptions = [
  { value: 'web_push', label: 'Web 推送', icon: Bell },
  { value: 'webhook', label: 'Webhook', icon: Link },
  { value: 'email', label: '邮件', icon: Promotion }
]

// Severity options
const severityOptions = [
  { value: 'info', label: '信息' },
  { value: 'warning', label: '警告' },
  { value: 'critical', label: '严重' },
  { value: 'emergency', label: '紧急' }
]

// Load data on mount
onMounted(() => {
  loadChannels()
  loadNotificationHistory()
})

const loadNotificationHistory = async () => {
  try {
    const res = await notificationEnhancedApi.getHistory()
    if (res.data.success && res.data.data) notificationHistory.value = res.data.data
  } catch { /* non-critical */ }
}

// Load notification channels
const loadChannels = async () => {
  loading.value = true
  error.value = ''

  try {
    const response = await notificationChannelsApi.getAll()
    if (response.data.success && response.data.data) {
      channels.value = response.data.data
    } else {
      throw new Error(response.data.error || '获取通知渠道失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取通知渠道失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// Show create dialog
const showCreateDialog = () => {
  isEditing.value = false
  editingChannelId.value = null
  Object.assign(formData, getDefaultFormData())
  dialogVisible.value = true
}

// Edit channel
const editChannel = (channel: NotificationChannel) => {
  isEditing.value = true
  editingChannelId.value = channel.id

  const defaultData = getDefaultFormData()
  Object.assign(formData, {
    ...defaultData,
    name: channel.name,
    type: channel.type,
    enabled: channel.enabled,
    severityFilter: channel.severityFilter ? [...channel.severityFilter] : []
  })

  // Populate type-specific config
  if (channel.type === 'webhook') {
    const config = channel.config as WebhookConfig
    formData.webhookUrl = config.url || ''
    formData.webhookMethod = config.method || 'POST'
    formData.webhookHeaders = config.headers ? JSON.stringify(config.headers, null, 2) : '{}'
    formData.webhookBodyTemplate = config.bodyTemplate || ''
  } else if (channel.type === 'email') {
    const config = channel.config as EmailConfig
    formData.smtpHost = config.smtp?.host || ''
    formData.smtpPort = config.smtp?.port || 587
    formData.smtpSecure = config.smtp?.secure || false
    formData.smtpUser = config.smtp?.auth?.user || ''
    formData.smtpPass = config.smtp?.auth?.pass || ''
    formData.emailFrom = config.from || ''
    formData.emailTo = config.to?.join(', ') || ''
  }

  detailVisible.value = false
  dialogVisible.value = true
}

// Toggle channel enabled/disabled
const toggleChannel = async (channel: NotificationChannel) => {
  try {
    await notificationChannelsApi.update(channel.id, { enabled: !channel.enabled })
    ElMessage.success(channel.enabled ? '渠道已禁用' : '渠道已启用')
    await loadChannels()
  } catch (err) {
    const message = err instanceof Error ? err.message : '操作失败'
    ElMessage.error(message)
  }
}

// Delete channel
const deleteChannel = async (channel: NotificationChannel) => {
  try {
    await notificationChannelsApi.delete(channel.id)
    ElMessage.success('渠道已删除')
    await loadChannels()
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除失败'
    ElMessage.error(message)
  }
}

// Test channel
const testChannel = async (channel: NotificationChannel) => {
  testingChannel.value = channel.id

  try {
    const response = await notificationChannelsApi.test(channel.id)
    if (response.data.success && response.data.data?.success) {
      ElMessage.success(response.data.data.message || '测试通知发送成功')
    } else {
      throw new Error(response.data.data?.message || response.data.error || '测试失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '测试失败'
    ElMessage.error(message)
  } finally {
    testingChannel.value = null
  }
}

// Build config from form data
const buildConfig = (): CreateNotificationChannelInput['config'] => {
  if (formData.type === 'webhook') {
    let headers: Record<string, string> = {}
    try {
      headers = JSON.parse(formData.webhookHeaders)
    } catch {
      headers = {}
    }
    return {
      url: formData.webhookUrl,
      method: formData.webhookMethod,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      bodyTemplate: formData.webhookBodyTemplate || undefined
    } as WebhookConfig
  }

  if (formData.type === 'email') {
    return {
      smtp: {
        host: formData.smtpHost,
        port: formData.smtpPort,
        secure: formData.smtpSecure,
        auth: {
          user: formData.smtpUser,
          pass: formData.smtpPass
        }
      },
      from: formData.emailFrom,
      to: formData.emailTo.split(',').map(e => e.trim()).filter(e => e)
    } as EmailConfig
  }

  // Web Push - empty config
  return {}
}

// Submit form
const submitForm = async () => {
  if (!formRef.value) return

  try {
    await formRef.value.validate()
  } catch {
    return
  }

  submitting.value = true

  try {
    const data: CreateNotificationChannelInput = {
      name: formData.name,
      type: formData.type,
      enabled: formData.enabled,
      config: buildConfig(),
      severityFilter: formData.severityFilter.length > 0 ? formData.severityFilter : undefined
    }

    if (isEditing.value && editingChannelId.value) {
      await notificationChannelsApi.update(editingChannelId.value, data)
      ElMessage.success('渠道已更新')
    } else {
      await notificationChannelsApi.create(data)
      ElMessage.success('渠道已创建')
    }

    dialogVisible.value = false
    await loadChannels()
  } catch (err) {
    const message = err instanceof Error ? err.message : '操作失败'
    ElMessage.error(message)
  } finally {
    submitting.value = false
  }
}

// Reset form
const resetForm = () => {
  formRef.value?.resetFields()
  Object.assign(formData, getDefaultFormData())
}

// Handle row click
const handleRowClick = (row: NotificationChannel) => {
  selectedChannel.value = row
  detailVisible.value = true
}

// Utility functions
const getChannelTypeText = (type: ChannelType): string => {
  const texts: Record<ChannelType, string> = {
    web_push: 'Web 推送',
    webhook: 'Webhook',
    email: '邮件'
  }
  return texts[type] || type
}

const getChannelTypeIcon = (type: ChannelType) => {
  const icons: Record<ChannelType, typeof Bell> = {
    web_push: Bell,
    webhook: Link,
    email: Promotion
  }
  return icons[type] || Bell
}

const getChannelTypeTagType = (type: ChannelType): 'primary' | 'success' | 'warning' => {
  const types: Record<ChannelType, 'primary' | 'success' | 'warning'> = {
    web_push: 'primary',
    webhook: 'success',
    email: 'warning'
  }
  return types[type] || 'primary'
}

const getSeverityType = (severity: AlertSeverity): 'info' | 'warning' | 'danger' => {
  const types: Record<AlertSeverity, 'info' | 'warning' | 'danger'> = {
    info: 'info',
    warning: 'warning',
    critical: 'danger',
    emergency: 'danger'
  }
  return types[severity]
}

const getSeverityText = (severity: AlertSeverity): string => {
  const texts: Record<AlertSeverity, string> = {
    info: '信息',
    warning: '警告',
    critical: '严重',
    emergency: '紧急'
  }
  return texts[severity]
}

const formatTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN')
}

const _getConfigSummary = (channel: NotificationChannel): string => {
  if (channel.type === 'webhook') {
    const config = channel.config as WebhookConfig
    return config.url || '-'
  }
  if (channel.type === 'email') {
    const config = channel.config as EmailConfig
    return config.to?.join(', ') || '-'
  }
  return '浏览器通知'
}

// Export to avoid unused warning
void _getConfigSummary
</script>

<style scoped>
.notification-channels-view {
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  background: var(--el-bg-color-page);
}

.header-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Table */
.channel-type-icon {
  margin-right: 4px;
  vertical-align: middle;
}

.no-filter {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

/* Form */
.form-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}

/* Config display */
.config-pre {
  margin: 0;
  padding: 12px;
  background: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: monospace;
}

/* Responsive */
@media (max-width: 768px) {
  .header-actions {
    flex-direction: column;
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
