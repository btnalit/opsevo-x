<template>
  <div class="favorite-messages-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>收藏消息</span>
            <span class="header-description">管理收藏的 AI 对话消息，支持批量转化为知识条目</span>
          </div>
          <div class="header-actions">
            <el-button :disabled="!selectedIds.length" @click="showBatchConvert">
              <el-icon><i-ep-document-copy /></el-icon>
              批量转化知识 ({{ selectedIds.length }})
            </el-button>
            <el-button @click="exportFavorites">
              <el-icon><i-ep-download /></el-icon>
              导出
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- 筛选 -->
    <el-card shadow="hover" style="margin-bottom:16px">
      <el-form :inline="true">
        <el-form-item>
          <el-input v-model="searchQuery" placeholder="搜索收藏内容..." clearable style="width:300px" @input="debouncedLoad" />
        </el-form-item>
        <el-form-item label="会话">
          <el-select v-model="sessionFilter" placeholder="全部会话" clearable style="width:200px" @change="loadFavorites">
            <el-option v-for="s in sessions" :key="s.id" :label="s.title || '未命名会话'" :value="s.id" />
          </el-select>
        </el-form-item>
      </el-form>
    </el-card>

    <el-skeleton v-if="loading" :rows="5" animated />
    <el-empty v-else-if="!favorites.length" description="暂无收藏消息" />
    <div v-else class="favorites-list">
      <el-checkbox-group v-model="selectedIds">
        <el-card v-for="msg in favorites" :key="msg.id" shadow="hover" class="favorite-card">
          <div class="favorite-item">
            <el-checkbox :value="msg.id" style="margin-right:12px" />
            <div class="favorite-content">
              <div class="favorite-meta">
                <el-tag size="small" type="info">{{ msg.sessionTitle || '会话' }}</el-tag>
                <span class="favorite-time">{{ formatTime(msg.collectedAt) }}</span>
                <el-tag v-if="msg.converted" size="small" type="success">已转化</el-tag>
              </div>
              <div class="favorite-text" v-html="renderMarkdown(msg.content)"></div>
              <div class="favorite-actions">
                <el-button type="primary" link size="small" @click="showSingleConvert(msg)">转化为知识</el-button>
                <el-button type="danger" link size="small" @click="removeFavorite(msg)">取消收藏</el-button>
              </div>
            </div>
          </div>
        </el-card>
      </el-checkbox-group>
    </div>

    <!-- 知识转化对话框 -->
    <KnowledgeConvertDialog
      v-model:visible="convertDialogVisible"
      :messages="convertMessages"
      @converted="onConverted"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import api from '@/api/index'
import KnowledgeConvertDialog from '@/components/KnowledgeConvertDialog.vue'

interface FavoriteMessage {
  id: string; content: string; sessionId: string; sessionTitle?: string
  collectedAt: string; converted?: boolean; role: string
}
interface Session { id: string; title?: string }

const loading = ref(false)
const favorites = ref<FavoriteMessage[]>([])
const sessions = ref<Session[]>([])
const selectedIds = ref<string[]>([])
const searchQuery = ref('')
const sessionFilter = ref('')
const convertDialogVisible = ref(false)
const convertMessages = ref<FavoriteMessage[]>([])

let searchTimer: ReturnType<typeof setTimeout> | null = null

function formatTime(ts: string | number) { return ts ? new Date(ts).toLocaleString() : '-' }
function renderMarkdown(content: string) {
  return DOMPurify.sanitize(marked(content || '') as string)
}

function debouncedLoad() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(loadFavorites, 300)
}

async function loadFavorites() {
  loading.value = true
  try {
    const res = await api.get('/ai/chat/favorites', {
      params: { search: searchQuery.value || undefined, sessionId: sessionFilter.value || undefined }
    })
    favorites.value = res.data.data || []
  } catch {
    ElMessage.error('加载收藏失败')
  } finally {
    loading.value = false
  }
}

async function loadSessions() {
  try {
    const res = await api.get('/ai/chat/sessions')
    sessions.value = res.data.data || []
  } catch { /* silent */ }
}

function showSingleConvert(msg: FavoriteMessage) {
  convertMessages.value = [msg]
  convertDialogVisible.value = true
}

function showBatchConvert() {
  convertMessages.value = favorites.value.filter(f => selectedIds.value.includes(f.id))
  convertDialogVisible.value = true
}

function onConverted() {
  selectedIds.value = []
  loadFavorites()
}

async function removeFavorite(msg: FavoriteMessage) {
  try {
    await ElMessageBox.confirm('确定取消收藏？', '确认', { type: 'warning' })
    await api.delete(`/ai/chat/favorites/${msg.id}`)
    ElMessage.success('已取消收藏')
    loadFavorites()
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('操作失败')
  }
}

function exportFavorites() {
  const content = favorites.value.map(f => `## ${f.sessionTitle || '会话'} (${formatTime(f.collectedAt)})\n\n${f.content}\n\n---\n`).join('\n')
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = 'favorites.md'; document.body.appendChild(link)
  link.click(); document.body.removeChild(link); URL.revokeObjectURL(url)
  ElMessage.success('导出成功')
}

onMounted(() => { loadFavorites(); loadSessions() })
</script>

<style scoped>
.favorite-messages-view { padding: 20px; background: var(--el-bg-color-page); min-height: 100%; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
.header-description { margin-left: 12px; font-size: 14px; font-weight: normal; color: var(--el-text-color-secondary); }
.header-actions { display: flex; gap: 8px; }
.favorites-list { display: flex; flex-direction: column; gap: 12px; }
.favorite-card { cursor: default; }
.favorite-item { display: flex; align-items: flex-start; }
.favorite-content { flex: 1; }
.favorite-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.favorite-time { font-size: 12px; color: var(--el-text-color-secondary); }
.favorite-text { font-size: 14px; line-height: 1.6; max-height: 200px; overflow: hidden; }
.favorite-text :deep(pre) { background: var(--el-fill-color-light); padding: 8px; border-radius: 4px; }
.favorite-actions { margin-top: 8px; }
</style>
