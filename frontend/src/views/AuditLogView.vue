<template>
  <div class="audit-log-view">
    <!-- Header -->
    <el-card class="header-card">
      <div class="card-header">
        <div class="header-left">
          <span>审计日志</span>
        </div>
        <div class="header-actions">
          <span v-if="cacheInfo" class="cache-info">
            <el-tag size="small" type="info">
              缓存: {{ cacheInfo.count }} 条
            </el-tag>
          </span>
          <el-button :icon="Refresh" :loading="loading" @click="refreshLogs">
            刷新
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- Filter Card -->
    <el-card class="filter-card" shadow="hover">
      <el-form :inline="true" class="filter-form">
        <el-form-item label="时间范围">
          <el-date-picker
            v-model="dateRange"
            type="datetimerange"
            range-separator="至"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            :shortcuts="dateShortcuts"
            value-format="x"
            @change="handleFilterChange"
          />
        </el-form-item>
        <el-form-item label="操作类型">
          <el-select
            v-model="actionFilter"
            placeholder="全部"
            clearable
            style="width: 160px"
            @change="handleFilterChange"
          >
            <el-option
              v-for="action in actionOptions"
              :key="action.value"
              :label="action.label"
              :value="action.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="执行者">
          <el-select
            v-model="actorFilter"
            placeholder="全部"
            clearable
            style="width: 120px"
            @change="handleFilterChange"
          >
            <el-option label="系统" value="system" />
            <el-option label="用户" value="user" />
          </el-select>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- Loading State -->
    <el-skeleton v-if="loading && paginatedLogs.length === 0" :rows="5" animated />

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
        <el-button type="primary" size="small" @click="() => loadLogs()">
          重新加载
        </el-button>
      </template>
    </el-alert>

    <!-- Empty State -->
    <el-card v-else-if="filteredLogs.length === 0" shadow="hover">
      <el-empty description="暂无审计日志" />
    </el-card>

    <!-- Logs Table with Pagination -->
    <el-card v-else shadow="hover">
      <el-table 
        :data="paginatedLogs" 
        stripe 
        style="width: 100%"
        v-loading="loading"
      >
        <el-table-column label="时间" width="180">
          <template #default="{ row }">
            {{ formatTime(row.timestamp) }}
          </template>
        </el-table-column>
        <el-table-column label="操作类型" width="150">
          <template #default="{ row }">
            <el-tag :type="getActionTagType(row.action)" size="small">
              {{ getActionText(row.action) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="执行者" width="100">
          <template #default="{ row }">
            <el-tag :type="row.actor === 'system' ? 'info' : 'success'" size="small">
              {{ row.actor === 'system' ? '系统' : '用户' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="详情" min-width="300">
          <template #default="{ row }">
            <div class="log-details">
              <span v-if="row.details.trigger" class="detail-item">
                <el-icon><i-ep-connection /></el-icon>
                触发: {{ row.details.trigger }}
              </span>
              <span v-if="row.details.result" class="detail-item result">
                <el-icon><i-ep-circle-check-filled /></el-icon>
                结果: {{ row.details.result }}
              </span>
              <span v-if="row.details.error" class="detail-item error">
                <el-icon><i-ep-circle-close-filled /></el-icon>
                错误: {{ row.details.error }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" text @click="showLogDetail(row)">
              详情
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- Pagination -->
      <div class="pagination-wrapper">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[20, 50, 100, 200]"
          :total="filteredLogs.length"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
    </el-card>

    <!-- Log Detail Dialog -->
    <el-dialog
      v-model="detailVisible"
      title="审计日志详情"
      width="600px"
      destroy-on-close
    >
      <template v-if="selectedLog">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="日志 ID" :span="2">
            {{ selectedLog.id }}
          </el-descriptions-item>
          <el-descriptions-item label="时间">
            {{ formatTime(selectedLog.timestamp) }}
          </el-descriptions-item>
          <el-descriptions-item label="执行者">
            <el-tag :type="selectedLog.actor === 'system' ? 'info' : 'success'" size="small">
              {{ selectedLog.actor === 'system' ? '系统' : '用户' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="操作类型" :span="2">
            <el-tag :type="getActionTagType(selectedLog.action)" size="small">
              {{ getActionText(selectedLog.action) }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item v-if="selectedLog.details.trigger" label="触发原因" :span="2">
            {{ selectedLog.details.trigger }}
          </el-descriptions-item>
          <el-descriptions-item v-if="selectedLog.details.result" label="执行结果" :span="2">
            <span class="result-text">{{ selectedLog.details.result }}</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="selectedLog.details.error" label="错误信息" :span="2">
            <span class="error-text">{{ selectedLog.details.error }}</span>
          </el-descriptions-item>
        </el-descriptions>

        <!-- Script Section -->
        <div v-if="selectedLog.details.script" class="script-section">
          <el-divider content-position="left">
            <el-icon><i-ep-document /></el-icon>
            执行脚本
          </el-divider>
          <pre class="script-content">{{ selectedLog.details.script }}</pre>
        </div>

        <!-- Metadata Section -->
        <div v-if="selectedLog.details.metadata && Object.keys(selectedLog.details.metadata).length > 0" class="metadata-section">
          <el-divider content-position="left">
            <el-icon><i-ep-info-filled /></el-icon>
            元数据
          </el-divider>
          <pre class="metadata-content">{{ JSON.stringify(selectedLog.details.metadata, null, 2) }}</pre>
        </div>
      </template>

      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { auditApi, type AuditLog, type AuditAction } from '@/api/ai-ops'

// ==================== 缓存管理 ====================
interface CacheEntry {
  data: AuditLog[]
  timestamp: number
  from: number
  to: number
}

const CACHE_TTL = 5 * 60 * 1000 // 5分钟缓存有效期
const cache = ref<Map<string, CacheEntry>>(new Map())

// 生成缓存键
const getCacheKey = (from: number, to: number, action?: string): string => {
  return `${from}-${to}-${action || 'all'}`
}

// 检查缓存是否有效
const isCacheValid = (entry: CacheEntry): boolean => {
  return Date.now() - entry.timestamp < CACHE_TTL
}

// 获取缓存
const getFromCache = (from: number, to: number, action?: string): AuditLog[] | null => {
  const key = getCacheKey(from, to, action)
  const entry = cache.value.get(key)
  if (entry && isCacheValid(entry)) {
    return entry.data
  }
  // 清理过期缓存
  if (entry) {
    cache.value.delete(key)
  }
  return null
}

// 设置缓存
const setCache = (from: number, to: number, action: string | undefined, data: AuditLog[]): void => {
  const key = getCacheKey(from, to, action)
  cache.value.set(key, {
    data,
    timestamp: Date.now(),
    from,
    to
  })
}

// 清理所有缓存
const clearCache = (): void => {
  cache.value.clear()
}

// ==================== 状态管理 ====================
const loading = ref(false)
const error = ref('')
const allLogs = ref<AuditLog[]>([])
const detailVisible = ref(false)
const selectedLog = ref<AuditLog | null>(null)

// 分页状态
const currentPage = ref(1)
const pageSize = ref(50)

// 筛选状态
const dateRange = ref<[number, number] | null>(null)
const actionFilter = ref<AuditAction | ''>('')
const actorFilter = ref<'system' | 'user' | ''>('')

// 缓存信息
const cacheInfo = computed(() => {
  if (cache.value.size === 0) return null
  let totalCount = 0
  cache.value.forEach(entry => {
    totalCount += entry.data.length
  })
  return { count: totalCount }
})

// 筛选后的日志
const filteredLogs = computed(() => {
  let result = allLogs.value

  // 按执行者筛选（客户端筛选）
  if (actorFilter.value) {
    result = result.filter(log => log.actor === actorFilter.value)
  }

  // 按时间戳降序排序
  return result.sort((a, b) => b.timestamp - a.timestamp)
})

// 分页后的日志
const paginatedLogs = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return filteredLogs.value.slice(start, end)
})

// Action options for filter
const actionOptions: { value: AuditAction; label: string }[] = [
  { value: 'script_execute', label: '脚本执行' },
  { value: 'config_change', label: '配置变更' },
  { value: 'alert_trigger', label: '告警触发' },
  { value: 'alert_resolve', label: '告警解决' },
  { value: 'remediation_execute', label: '修复执行' },
  { value: 'config_restore', label: '配置恢复' },
  { value: 'snapshot_create', label: '快照创建' }
]

// Date shortcuts
const dateShortcuts = [
  {
    text: '最近1小时',
    value: () => {
      const end = Date.now()
      const start = end - 3600 * 1000
      return [start, end]
    }
  },
  {
    text: '最近24小时',
    value: () => {
      const end = Date.now()
      const start = end - 24 * 3600 * 1000
      return [start, end]
    }
  },
  {
    text: '最近7天',
    value: () => {
      const end = Date.now()
      const start = end - 7 * 24 * 3600 * 1000
      return [start, end]
    }
  },
  {
    text: '最近30天',
    value: () => {
      const end = Date.now()
      const start = end - 30 * 24 * 3600 * 1000
      return [start, end]
    }
  },
  {
    text: '最近90天',
    value: () => {
      const end = Date.now()
      const start = end - 90 * 24 * 3600 * 1000
      return [start, end]
    }
  }
]

// ==================== 生命周期 ====================
onMounted(() => {
  // 设置默认时间范围为最近24小时（减少初始加载量）
  const end = Date.now()
  const start = end - 24 * 3600 * 1000
  dateRange.value = [start, end]

  loadLogs()
})

onUnmounted(() => {
  // 组件卸载时清理缓存
  clearCache()
})

// ==================== 数据加载 ====================
const loadLogs = async (forceRefresh = false) => {
  if (!dateRange.value) return

  const [from, to] = dateRange.value
  const action = actionFilter.value || undefined

  // 检查缓存（非强制刷新时）
  if (!forceRefresh) {
    const cachedData = getFromCache(from, to, action)
    if (cachedData) {
      allLogs.value = cachedData
      currentPage.value = 1
      return
    }
  }

  loading.value = true
  error.value = ''

  try {
    const params: {
      from?: number
      to?: number
      action?: AuditAction
      limit?: number
    } = {
      from,
      to,
      limit: 1000 // 增加限制以获取更多数据
    }

    if (action) {
      params.action = action as AuditAction
    }

    const response = await auditApi.query(params)

    if (response.data.success && response.data.data) {
      allLogs.value = response.data.data
      // 存入缓存
      setCache(from, to, action, response.data.data)
      // 重置到第一页
      currentPage.value = 1
    } else {
      throw new Error(response.data.error || '获取审计日志失败')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '获取审计日志失败'
    error.value = message
    ElMessage.error(message)
  } finally {
    loading.value = false
  }
}

// 强制刷新（清除缓存）
const refreshLogs = () => {
  if (dateRange.value) {
    const [from, to] = dateRange.value
    const action = actionFilter.value || undefined
    const key = getCacheKey(from, to, action)
    cache.value.delete(key)
  }
  loadLogs(true)
}

// 筛选条件变化
const handleFilterChange = () => {
  currentPage.value = 1
  loadLogs()
}

// 分页大小变化
const handleSizeChange = () => {
  currentPage.value = 1
}

// 页码变化
const handleCurrentChange = () => {
  // 分页是客户端处理，无需重新加载
}

// ==================== 详情展示 ====================
const showLogDetail = (log: AuditLog) => {
  selectedLog.value = log
  detailVisible.value = true
}

// ==================== 工具函数 ====================
const getActionText = (action: AuditAction): string => {
  const texts: Record<AuditAction, string> = {
    script_execute: '脚本执行',
    config_change: '配置变更',
    alert_trigger: '告警触发',
    alert_resolve: '告警解决',
    remediation_execute: '修复执行',
    config_restore: '配置恢复',
    snapshot_create: '快照创建'
  }
  return texts[action] || action
}

const getActionTagType = (action: AuditAction): 'primary' | 'success' | 'warning' | 'danger' | 'info' => {
  const types: Record<AuditAction, 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
    script_execute: 'primary',
    config_change: 'warning',
    alert_trigger: 'danger',
    alert_resolve: 'success',
    remediation_execute: 'primary',
    config_restore: 'warning',
    snapshot_create: 'info'
  }
  return types[action] || 'info'
}

const formatTime = (timestamp: number): string => {
  if (!timestamp || timestamp <= 0) {
    return '未知'
  }
  try {
    const date = new Date(timestamp)
    if (isNaN(date.getTime())) {
      return '未知'
    }
    return date.toLocaleString('zh-CN')
  } catch {
    return '未知'
  }
}
</script>

<style scoped>
.audit-log-view {
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
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}



.cache-info {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* Filter Card */
.filter-card {
  margin-bottom: 20px;
}

.filter-form {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.filter-form :deep(.el-form-item) {
  margin-bottom: 0;
}

/* Pagination */
.pagination-wrapper {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

/* Log Details */
.log-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.detail-item.result {
  color: var(--el-color-success);
}

.detail-item.error {
  color: var(--el-color-danger);
}

/* Dialog Sections */
.script-section,
.metadata-section {
  margin-top: 20px;
}

.script-content,
.metadata-content {
  margin: 0;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  font-size: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}

.result-text {
  color: var(--el-color-success);
}

.error-text {
  color: var(--el-color-danger);
}

/* Responsive */
@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    gap: 12px;
  }

  .header-actions {
    width: 100%;
    justify-content: flex-end;
  }

  .filter-form {
    flex-direction: column;
  }

  .filter-form :deep(.el-form-item) {
    width: 100%;
  }

  .filter-form :deep(.el-select),
  .filter-form :deep(.el-date-editor) {
    width: 100% !important;
  }

  .pagination-wrapper {
    justify-content: center;
  }
}
</style>
