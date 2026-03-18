<template>
  <div class="notification-history-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>通知历史</span>
            <span class="header-description">查看通知发送记录与统计</span>
          </div>
        </div>
      </template>
    </el-card>

    <!-- 统计卡片 -->
    <el-row :gutter="16" style="margin-bottom:20px">
      <el-col :span="6">
        <el-card shadow="hover">
          <el-statistic title="总通知数" :value="stats.total" />
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <el-statistic title="发送成功" :value="stats.sent">
            <template #suffix><span style="color:#67c23a;font-size:14px">✓</span></template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <el-statistic title="发送失败" :value="stats.failed">
            <template #suffix><span style="color:#f56c6c;font-size:14px">✗</span></template>
          </el-statistic>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover">
          <el-statistic title="待发送" :value="stats.pending" />
        </el-card>
      </el-col>
    </el-row>

    <!-- 筛选 -->
    <el-card shadow="hover" style="margin-bottom:16px">
      <el-form :inline="true">
        <el-form-item label="状态">
          <el-select v-model="filterStatus" placeholder="全部" clearable style="width:120px" @change="loadNotifications">
            <el-option label="已发送" value="sent" />
            <el-option label="失败" value="failed" />
            <el-option label="待发送" value="pending" />
          </el-select>
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="filterType" placeholder="全部" clearable style="width:120px" @change="loadNotifications">
            <el-option label="告警" value="alert" />
            <el-option label="恢复" value="recovery" />
            <el-option label="报告" value="report" />
            <el-option label="修复" value="remediation" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button @click="loadNotifications" :loading="loading">刷新</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 通知列表 -->
    <el-skeleton v-if="loading && !notifications.length" :rows="5" animated />
    <el-empty v-else-if="!notifications.length" description="暂无通知记录" />
    <el-table v-else :data="notifications" stripe>
      <el-table-column prop="type" label="类型" width="100">
        <template #default="{ row }">
          <el-tag :type="getTypeTagType(row.type)" size="small">{{ getTypeLabel(row.type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
      <el-table-column prop="channelId" label="渠道" width="150">
        <template #default="{ row }">{{ getChannelName(row.channelId) }}</template>
      </el-table-column>
      <el-table-column prop="status" label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'sent' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'" size="small">
            {{ row.status === 'sent' ? '已发送' : row.status === 'failed' ? '失败' : '待发送' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="retryCount" label="重试" width="80" />
      <el-table-column prop="sentAt" label="发送时间" width="180">
        <template #default="{ row }">{{ row.sentAt ? formatTime(row.sentAt) : '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link size="small" @click="showDetail(row)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 详情对话框 -->
    <el-dialog v-model="detailVisible" title="通知详情" width="600px">
      <el-descriptions v-if="selectedNotification" :column="1" border>
        <el-descriptions-item label="ID">{{ selectedNotification.id }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ getTypeLabel(selectedNotification.type) }}</el-descriptions-item>
        <el-descriptions-item label="标题">{{ selectedNotification.title }}</el-descriptions-item>
        <el-descriptions-item label="内容">{{ selectedNotification.body }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ selectedNotification.status }}</el-descriptions-item>
        <el-descriptions-item label="渠道">{{ getChannelName(selectedNotification.channelId) }}</el-descriptions-item>
        <el-descriptions-item label="重试次数">{{ selectedNotification.retryCount }}</el-descriptions-item>
        <el-descriptions-item v-if="selectedNotification.error" label="错误信息">
          <span class="text-danger">{{ selectedNotification.error }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="发送时间">{{ selectedNotification.sentAt ? formatTime(selectedNotification.sentAt) : '-' }}</el-descriptions-item>
      </el-descriptions>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { notificationChannelsApi, type Notification, type NotificationChannel } from '@/api/ai-ops'

const loading = ref(false)
const notifications = ref<Notification[]>([])
const channels = ref<NotificationChannel[]>([])
const filterStatus = ref('')
const filterType = ref('')
const detailVisible = ref(false)
const selectedNotification = ref<Notification | null>(null)
const stats = reactive({ total: 0, sent: 0, failed: 0, pending: 0 })

const TYPE_LABELS: Record<string, string> = { alert: '告警', recovery: '恢复', report: '报告', remediation: '修复' }
const TYPE_TAG_TYPES: Record<string, 'success' | 'warning' | 'info' | 'danger'> = { alert: 'danger', recovery: 'success', report: 'info', remediation: 'warning' }

function getTypeLabel(type: string) { return TYPE_LABELS[type] || type }
function getTypeTagType(type: string): 'success' | 'warning' | 'info' | 'danger' { return TYPE_TAG_TYPES[type] || 'info' }
function getChannelName(channelId: string) {
  return channels.value.find(c => c.id === channelId)?.name || channelId
}
function formatTime(ts: number) { return new Date(ts).toLocaleString() }

function showDetail(n: Notification) {
  selectedNotification.value = n
  detailVisible.value = true
}

async function loadNotifications() {
  loading.value = true
  try {
    const res = await notificationChannelsApi.getHistory(200)
    let list = res.data.data || []
    if (filterStatus.value) list = list.filter(n => n.status === filterStatus.value)
    if (filterType.value) list = list.filter(n => n.type === filterType.value)
    notifications.value = list
    stats.total = list.length
    stats.sent = list.filter(n => n.status === 'sent').length
    stats.failed = list.filter(n => n.status === 'failed').length
    stats.pending = list.filter(n => n.status === 'pending').length
  } catch {
    ElMessage.error('加载通知历史失败')
  } finally {
    loading.value = false
  }
}

async function loadChannels() {
  try {
    const res = await notificationChannelsApi.getAll()
    channels.value = res.data.data || []
  } catch { /* silent */ }
}

onMounted(() => {
  loadChannels()
  loadNotifications()
})
</script>

<style scoped>
.notification-history-view { padding: 20px; background: var(--el-bg-color-page); min-height: 100%; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
.header-description { margin-left: 12px; font-size: 14px; font-weight: normal; color: var(--el-text-color-secondary); }
.text-danger { color: var(--el-color-danger); }
</style>
