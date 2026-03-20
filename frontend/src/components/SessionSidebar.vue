<template>
  <div class="session-sidebar" :class="{ collapsed: isCollapsed }">
    <!-- Sidebar Header -->
    <div class="sidebar-header">
      <div class="header-content" v-if="!isCollapsed">
        <el-icon :size="18" color="#409eff"><i-ep-chat-dot-square /></el-icon>
        <span class="header-title">会话历史</span>
      </div>
      <el-button
        :icon="isCollapsed ? Expand : Fold"
        size="small"
        text
        @click="toggleCollapse"
        class="collapse-btn"
      />
    </div>

    <!-- New Session Button -->
    <div class="new-session-wrapper" v-if="!isCollapsed">
      <el-button
        type="primary"
        :icon="Plus"
        class="new-session-btn"
        @click="handleNewSession"
      >
        新建会话
      </el-button>
    </div>
    <div class="new-session-wrapper" v-else>
      <el-tooltip content="新建会话" placement="right">
        <el-button
          type="primary"
          :icon="Plus"
          circle
          size="small"
          @click="handleNewSession"
        />
      </el-tooltip>
    </div>

    <!-- Search Box -->
    <div class="search-wrapper" v-if="!isCollapsed">
      <el-input
        v-model="searchQuery"
        placeholder="搜索会话..."
        :prefix-icon="Search"
        size="small"
        clearable
        @input="handleSearch"
      />
      <!-- Filter by collected -->
      <el-checkbox
        v-model="filterByCollected"
        size="small"
        class="collected-filter"
      >
        仅显示有收藏
      </el-checkbox>
    </div>

    <!-- Session List -->
    <div class="session-list" v-if="!isCollapsed">
      <el-scrollbar>
        <!-- Loading State -->
        <div v-if="isLoading" class="loading-state">
          <el-icon class="is-loading" :size="24"><i-ep-loading /></el-icon>
          <span>加载中...</span>
        </div>

        <!-- Empty State -->
        <div v-else-if="filteredSessions.length === 0" class="empty-state">
          <el-icon :size="32" color="#c0c4cc"><i-ep-chat-line-square /></el-icon>
          <p v-if="searchQuery">未找到匹配的会话</p>
          <p v-else>暂无会话记录</p>
        </div>

        <!-- Session Items -->
        <div
          v-else
          v-for="session in filteredSessions"
          :key="session.id"
          :class="['session-item', { active: session.id === activeSessionId }]"
          @click="handleSelectSession(session)"
        >
          <div class="session-content">
            <div class="session-title" v-if="editingSessionId !== session.id">
              {{ session.title || '新会话' }}
              <!-- Collection Count Badge -->
              <el-badge
                v-if="getSessionCollectedCount(session.id) > 0"
                :value="getSessionCollectedCount(session.id)"
                type="warning"
                class="collected-count-badge"
              />
            </div>
            <el-input
              v-else
              v-model="editingTitle"
              size="small"
              @blur="handleSaveRename(session)"
              @keyup.enter="handleSaveRename(session)"
              @keyup.escape="handleCancelRename"
              ref="renameInput"
              autofocus
            />
            <div class="session-meta">
              <span class="session-provider">{{ getProviderName(session.provider) }}</span>
              <el-tag 
                v-if="session.mode === 'knowledge-enhanced'" 
                type="warning" 
                size="small"
                effect="plain"
                class="session-mode-tag"
              >
                知识增强
              </el-tag>
              <span class="session-time">{{ formatTime(session.updatedAt) }}</span>
            </div>
          </div>
          <div class="session-actions" v-if="editingSessionId !== session.id">
            <el-dropdown trigger="click" @command="(cmd: string) => handleCommand(cmd, session)">
              <el-button :icon="MoreFilled" size="small" text circle />
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="rename" :icon="Edit">
                    重命名
                  </el-dropdown-item>
                  <el-dropdown-item command="export" :icon="Download">
                    导出 Markdown
                  </el-dropdown-item>
                  <el-dropdown-item command="duplicate" :icon="CopyDocument">
                    复制会话
                  </el-dropdown-item>
                  <el-dropdown-item command="delete" :icon="Delete" divided>
                    <span style="color: #f56c6c">删除</span>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </el-scrollbar>
    </div>

    <!-- Collapsed Session List -->
    <div class="collapsed-session-list" v-else>
      <el-scrollbar>
        <el-tooltip
          v-for="session in filteredSessions"
          :key="session.id"
          :content="session.title || '新会话'"
          placement="right"
        >
          <div
            :class="['collapsed-session-item', { active: session.id === activeSessionId }]"
            @click="handleSelectSession(session)"
          >
            <el-icon :size="18"><i-ep-chat-line-round /></el-icon>
          </div>
        </el-tooltip>
      </el-scrollbar>
    </div>

    <!-- Footer Actions -->
    <div class="sidebar-footer" v-if="!isCollapsed && sessions.length > 0">
      <el-button
        type="danger"
        text
        size="small"
        :icon="Delete"
        @click="handleClearAll"
      >
        清空所有会话
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Expand, Fold, Plus, Search, MoreFilled, Edit, Download, CopyDocument, Delete } from '@element-plus/icons-vue'

import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { sessionApi, unifiedAgentApi, AIProvider, type ChatSession } from '@/api/ai'

// ==================== Props ====================

interface Props {
  /** Currently active session ID */
  activeSessionId?: string
  /** Whether sidebar is collapsed */
  collapsed?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  activeSessionId: '',
  collapsed: false
})

// ==================== Emits ====================

const emit = defineEmits<{
  /** Emitted when a session is selected */
  (e: 'select', session: ChatSession): void
  /** Emitted when a new session is requested */
  (e: 'new-session'): void
  /** Emitted when a session is deleted */
  (e: 'delete', sessionId: string): void
  /** Emitted when all sessions are cleared */
  (e: 'clear-all'): void
  /** Emitted when collapse state changes */
  (e: 'update:collapsed', value: boolean): void
}>()

// ==================== Constants ====================

const PROVIDER_NAMES: Record<AIProvider, string> = {
  [AIProvider.OPENAI]: 'OpenAI',
  [AIProvider.GEMINI]: 'Gemini',
  [AIProvider.CLAUDE]: 'Claude',
  [AIProvider.DEEPSEEK]: 'DeepSeek',
  [AIProvider.QWEN]: 'Qwen',
  [AIProvider.ZHIPU]: '智谱AI',
  [AIProvider.OLLAMA]: 'Ollama',
  [AIProvider.CUSTOM]: '自定义'
}

// ==================== State ====================

const sessions = ref<ChatSession[]>([])
const isLoading = ref(false)
const searchQuery = ref('')
const editingSessionId = ref<string | null>(null)
const editingTitle = ref('')
const isCollapsed = ref(props.collapsed)
const renameInput = ref<HTMLInputElement | null>(null)
const filterByCollected = ref(false)
const sessionCollectionCounts = ref<Map<string, number>>(new Map())

// ==================== Computed ====================

const filteredSessions = computed(() => {
  let result = sessions.value

  // Filter by search query
  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase()
    result = result.filter(session =>
      (session.title || '').toLowerCase().includes(query) ||
      getProviderName(session.provider).toLowerCase().includes(query)
    )
  }

  // Filter by collected
  if (filterByCollected.value) {
    result = result.filter(session => 
      sessionCollectionCounts.value.get(session.id) && 
      sessionCollectionCounts.value.get(session.id)! > 0
    )
  }

  return result
})

// ==================== Watch ====================

watch(() => props.collapsed, (newVal) => {
  isCollapsed.value = newVal
})

// ==================== Lifecycle ====================

onMounted(() => {
  loadSessions()
})

// ==================== Methods ====================

/** Load all sessions from API */
const loadSessions = async () => {
  isLoading.value = true
  try {
    const response = await sessionApi.getAll()
    if (response.data.success && Array.isArray(response.data.data)) {
      // Sort by updatedAt descending (newest first)
      sessions.value = response.data.data.sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
    }
    // Load collection counts
    await loadCollectionCounts()
  } catch (err) {
    console.error('加载会话列表失败:', err)
    ElMessage.error('加载会话列表失败')
  } finally {
    isLoading.value = false
  }
}

/** Load collection counts for all sessions */
const loadCollectionCounts = async () => {
  try {
    const response = await unifiedAgentApi.getSessionsWithCollections()
    if (response.data.success && Array.isArray(response.data.data)) {
      const counts = new Map<string, number>()
      for (const summary of response.data.data) {
        counts.set(summary.sessionId, summary.collectedCount)
      }
      sessionCollectionCounts.value = counts
    }
  } catch (err) {
    console.error('加载收藏计数失败:', err)
  }
}

/** Get session collected count */
const getSessionCollectedCount = (sessionId: string): number => {
  return sessionCollectionCounts.value.get(sessionId) || 0
}

/** Get provider display name */
const getProviderName = (provider: AIProvider): string => {
  return PROVIDER_NAMES[provider] || provider
}

/** Format timestamp */
const formatTime = (date: Date | string): string => {
  const d = typeof date === 'string' ? new Date(date) : date
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days === 0) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } else if (days === 1) {
    return '昨天'
  } else if (days < 7) {
    return `${days}天前`
  } else {
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }
}

/** Toggle sidebar collapse */
const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value
  emit('update:collapsed', isCollapsed.value)
}

/** Handle new session */
const handleNewSession = () => {
  emit('new-session')
}

/** Handle search input */
const handleSearch = () => {
  // Debounce is handled by Vue's reactivity
}

/** Handle session selection */
const handleSelectSession = (session: ChatSession) => {
  emit('select', session)
}

/** Handle dropdown command */
const handleCommand = (command: string, session: ChatSession) => {
  switch (command) {
    case 'rename':
      handleStartRename(session)
      break
    case 'export':
      handleExport(session)
      break
    case 'duplicate':
      handleDuplicate(session)
      break
    case 'delete':
      handleDelete(session)
      break
  }
}

/** Start renaming a session */
const handleStartRename = (session: ChatSession) => {
  editingSessionId.value = session.id
  editingTitle.value = session.title || ''
  nextTick(() => {
    if (renameInput.value) {
      (renameInput.value as unknown as { focus: () => void }).focus()
    }
  })
}

/** Save renamed session */
const handleSaveRename = async (session: ChatSession) => {
  const newTitle = editingTitle.value.trim()
  if (!newTitle || newTitle === session.title) {
    handleCancelRename()
    return
  }

  try {
    const response = await sessionApi.rename(session.id, newTitle)
    if (response.data.success) {
      // Update local session
      const index = sessions.value.findIndex(s => s.id === session.id)
      if (index !== -1) {
        sessions.value[index].title = newTitle
      }
      ElMessage.success('会话已重命名')
    } else {
      ElMessage.error(response.data.error || '重命名失败')
    }
  } catch (err) {
    console.error('重命名失败:', err)
    ElMessage.error('重命名失败')
  } finally {
    handleCancelRename()
  }
}

/** Cancel renaming */
const handleCancelRename = () => {
  editingSessionId.value = null
  editingTitle.value = ''
}

/** Export session as markdown */
const handleExport = async (session: ChatSession) => {
  try {
    const blob = await sessionApi.export(session.id)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${session.title || 'chat-session'}-${new Date().toISOString().slice(0, 10)}.md`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    ElMessage.success('会话已导出')
  } catch (err) {
    console.error('导出失败:', err)
    ElMessage.error('导出失败')
  }
}

/** Duplicate session */
const handleDuplicate = async (session: ChatSession) => {
  try {
    const response = await sessionApi.duplicate(session.id)
    if (response.data.success && response.data.data) {
      sessions.value.unshift(response.data.data)
      ElMessage.success('会话已复制')
    } else {
      ElMessage.error(response.data.error || '复制失败')
    }
  } catch (err) {
    console.error('复制失败:', err)
    ElMessage.error('复制失败')
  }
}

/** Delete session */
const handleDelete = async (session: ChatSession) => {
  try {
    const collectedCount = getSessionCollectedCount(session.id)
    let confirmMessage = `确定要删除会话 "${session.title || '新会话'}" 吗？`
    
    // Warn about unconverted collections
    if (collectedCount > 0) {
      confirmMessage = `会话 "${session.title || '新会话'}" 中有 ${collectedCount} 条未转换的收藏消息。\n\n确定要删除吗？删除后收藏内容将丢失。`
    }

    await ElMessageBox.confirm(
      confirmMessage,
      '删除确认',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: collectedCount > 0 ? 'warning' : 'info'
      }
    )

    const response = await sessionApi.delete(session.id)
    if (response.data.success) {
      sessions.value = sessions.value.filter(s => s.id !== session.id)
      sessionCollectionCounts.value.delete(session.id)
      emit('delete', session.id)
      ElMessage.success('会话已删除')
    } else {
      ElMessage.error(response.data.error || '删除失败')
    }
  } catch (err) {
    // User cancelled or error
    if (err !== 'cancel' && (err as Error).message !== 'cancel') {
      console.error('删除失败:', err)
      ElMessage.error('删除失败')
    }
  }
}

/** Clear all sessions */
const handleClearAll = async () => {
  try {
    await ElMessageBox.confirm(
      '确定要删除所有会话吗？此操作不可恢复。',
      '清空确认',
      {
        confirmButtonText: '全部删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    const response = await sessionApi.deleteAll()
    if (response.data.success) {
      sessions.value = []
      emit('clear-all')
      ElMessage.success('所有会话已清空')
    } else {
      ElMessage.error(response.data.error || '清空失败')
    }
  } catch (err) {
    // User cancelled or error
    if (err !== 'cancel' && (err as Error).message !== 'cancel') {
      console.error('清空失败:', err)
      ElMessage.error('清空失败')
    }
  }
}

/** Refresh sessions list (exposed for parent component) */
const refresh = () => {
  loadSessions()
}

/** Add a new session to the list (exposed for parent component) */
const addSession = (session: ChatSession) => {
  sessions.value.unshift(session)
}

/** Update a session in the list (exposed for parent component) */
const updateSession = (session: ChatSession) => {
  const index = sessions.value.findIndex(s => s.id === session.id)
  if (index !== -1) {
    sessions.value[index] = session
  }
}

// Expose methods for parent component
defineExpose({
  refresh,
  addSession,
  updateSession
})
</script>

<style scoped>
.session-sidebar {
  display: flex;
  flex-direction: column;
  width: 280px;
  height: 100%;
  background: var(--ai-sidebar-bg);
  border-right: 1px solid var(--el-border-color-lighter);
  transition: width 0.3s ease;
}

.session-sidebar.collapsed {
  width: 60px;
}

/* Header */
.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color-overlay);
}

.header-content {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.collapse-btn {
  flex-shrink: 0;
}

/* New Session Button */
.new-session-wrapper {
  padding: 12px 16px;
}

.new-session-btn {
  width: 100%;
}

.collapsed .new-session-wrapper {
  padding: 12px 8px;
  display: flex;
  justify-content: center;
}

/* Search */
.search-wrapper {
  padding: 0 16px 12px;
}

.collected-filter {
  margin-top: 8px;
  font-size: 12px;
}

.collected-filter :deep(.el-checkbox__label) {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* Session List */
.session-list {
  flex: 1;
  overflow: hidden;
}

.session-list :deep(.el-scrollbar__view) {
  padding: 0 8px;
}

/* Loading State */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--el-text-color-secondary);
  gap: 12px;
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--el-text-color-secondary);
}

.empty-state p {
  margin: 8px 0 0;
  font-size: 13px;
}

/* Session Item */
.session-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px;
  margin-bottom: 4px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.session-item:hover {
  background: var(--el-fill-color-light);
}

.session-item.active {
  background: var(--el-fill-color);
  border-left: 3px solid var(--el-color-primary);
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.2);
}

.session-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.session-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.collected-count-badge {
  flex-shrink: 0;
}

.collected-count-badge :deep(.el-badge__content) {
  font-size: 10px;
  height: 16px;
  line-height: 16px;
  padding: 0 5px;
}

.session-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  flex-wrap: wrap;
}

.session-provider {
  padding: 1px 6px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}

.session-mode-tag {
  font-size: 10px;
  padding: 0 4px;
  height: 18px;
  line-height: 16px;
}

.session-actions {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.2s;
}

.session-item:hover .session-actions {
  opacity: 1;
}

/* Collapsed Session List */
.collapsed-session-list {
  flex: 1;
  overflow: hidden;
  padding: 8px 0;
}

.collapsed-session-list :deep(.el-scrollbar__view) {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.collapsed-session-item {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  cursor: pointer;
  color: #606266;
  transition: all 0.2s;
}

.collapsed-session-item:hover {
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
}

.collapsed-session-item.active {
  background: var(--el-fill-color);
  color: var(--el-color-primary);
}

/* Footer */
.sidebar-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--ai-sidebar-bg);
}

.sidebar-footer .el-button {
  width: 100%;
}
</style>
