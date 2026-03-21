<template>
  <div class="prompt-management-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>Prompt 知识管理</span>
            <span class="header-description">管理 Prompt 模板、版本历史与知识条目</span>
          </div>
          <div class="header-actions">
            <el-button @click="activeTab = 'templates'">模板管理</el-button>
            <el-button @click="activeTab = 'knowledge'">知识条目</el-button>
            <el-button type="primary" @click="showUploadDialog">
              <el-icon><i-ep-upload /></el-icon>
              上传知识
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <el-tabs v-model="activeTab" type="border-card">
      <!-- 模板管理 Tab -->
      <el-tab-pane label="Prompt 模板" name="templates">
        <div class="tab-toolbar">
          <el-input v-model="templateSearch" placeholder="搜索模板..." clearable style="width: 250px" @input="debouncedLoadTemplates" />
          <el-select v-model="templateCategory" placeholder="分类" clearable style="width: 120px" @change="loadTemplates">
            <el-option v-for="opt in TEMPLATE_CATEGORY_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </div>
        <el-skeleton v-if="templatesLoading" :rows="5" animated />
        <el-empty v-else-if="!templates.length" description="暂无模板" />
        <el-table v-else :data="templates" stripe>
          <el-table-column prop="name" label="名称" min-width="180">
            <template #default="{ row }">
              <span class="template-name">{{ row.name }}</span>
              <el-tag v-if="row.isDefault" type="success" size="small" style="margin-left:6px">默认</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="category" label="分类" width="100">
            <template #default="{ row }">
              <el-tag size="small">{{ row.category || '未分类' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
          <el-table-column prop="updatedAt" label="更新时间" width="180">
            <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="260" fixed="right">
            <template #default="{ row }">
              <el-button type="primary" link @click="showPreview(row)">预览</el-button>
              <el-button type="info" link @click="showVersionHistory(row)">版本</el-button>
              <el-button type="warning" link @click="editTemplate(row)">编辑</el-button>
              <el-button type="danger" link @click="deleteTemplate(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="pagination-container">
          <el-pagination v-model:current-page="templatePage" v-model:page-size="templatePageSize" :total="templateTotal" :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next" @size-change="loadTemplates" @current-change="loadTemplates" />
        </div>
      </el-tab-pane>

      <!-- 知识条目 Tab -->
      <el-tab-pane label="知识条目" name="knowledge">
        <div class="tab-toolbar">
          <el-input v-model="knowledgeSearch" placeholder="语义搜索知识条目..." clearable style="width: 300px" @keyup.enter="searchKnowledge" />
          <el-button type="primary" @click="searchKnowledge">搜索</el-button>
        </div>
        <el-skeleton v-if="knowledgeLoading" :rows="5" animated />
        <el-empty v-else-if="!knowledgeEntries.length" description="暂无知识条目" />
        <el-table v-else :data="knowledgeEntries" stripe>
          <el-table-column prop="title" label="标题" min-width="200" show-overflow-tooltip />
          <el-table-column prop="category" label="类别" width="120">
            <template #default="{ row }">
              <el-tag size="small">{{ row.category || 'general' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="score" label="评分" width="100">
            <template #default="{ row }">
              <el-rate v-model="row.score" disabled :max="5" size="small" />
            </template>
          </el-table-column>
          <el-table-column prop="deviceTypes" label="适用设备" width="150">
            <template #default="{ row }">
              <el-tag v-for="dt in (row.deviceTypes || [])" :key="dt" size="small" style="margin:2px">{{ dt }}</el-tag>
              <span v-if="!row.deviceTypes?.length" class="text-muted">通用</span>
            </template>
          </el-table-column>
          <el-table-column prop="updatedAt" label="更新时间" width="180">
            <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 版本历史抽屉 -->
    <el-drawer v-model="versionDrawerVisible" title="版本历史" size="500px" direction="rtl">
      <el-timeline v-if="versionHistory.length">
        <el-timeline-item v-for="ver in versionHistory" :key="ver.version" :timestamp="formatTime(ver.updatedAt)" placement="top">
          <el-card shadow="hover">
            <div class="version-header">
              <span>v{{ ver.version }}</span>
              <el-button type="primary" link size="small" @click="rollbackToVersion(ver)">回滚到此版本</el-button>
            </div>
            <p class="version-content">{{ ver.content?.substring(0, 200) }}...</p>
          </el-card>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-else description="暂无版本历史" />
    </el-drawer>

    <!-- 预览对话框 -->
    <el-dialog v-model="previewVisible" title="模板预览" width="700px" destroy-on-close>
      <div class="preview-content" v-html="sanitizedPreview"></div>
    </el-dialog>

    <!-- 上传知识对话框 -->
    <el-dialog v-model="uploadVisible" title="上传自定义知识" width="600px" destroy-on-close>
      <el-form :model="uploadForm" label-width="100px">
        <el-form-item label="标题" required>
          <el-input v-model="uploadForm.title" placeholder="知识条目标题" />
        </el-form-item>
        <el-form-item label="类别">
          <el-select v-model="uploadForm.category" placeholder="选择类别" style="width:100%">
            <el-option label="通用" value="general" />
            <el-option label="诊断" value="diagnostic" />
            <el-option label="修复" value="remediation" />
            <el-option label="配置" value="configuration" />
          </el-select>
        </el-form-item>
        <el-form-item label="内容" required>
          <el-input v-model="uploadForm.content" type="textarea" :rows="8" placeholder="知识内容..." />
        </el-form-item>
        <el-form-item label="适用设备">
          <el-select v-model="uploadForm.deviceTypes" multiple placeholder="留空表示通用" style="width:100%">
            <el-option label="RouterOS" value="routeros" />
            <el-option label="Linux" value="linux" />
            <el-option label="OpenWrt" value="openwrt" />
            <el-option label="SNMP" value="snmp" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="uploadVisible = false">取消</el-button>
        <el-button type="primary" :loading="uploading" @click="submitKnowledge">上传</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import {
  templateApi,
  TEMPLATE_CATEGORY_OPTIONS,
  type PromptTemplate,
} from '@/api/evolution'
import api from '@/api/index'

// State
const activeTab = ref('templates')
const templates = ref<PromptTemplate[]>([])
const templatesLoading = ref(false)
const templateSearch = ref('')
const templateCategory = ref('')
const templatePage = ref(1)
const templatePageSize = ref(10)
const templateTotal = ref(0)

const knowledgeEntries = ref<any[]>([])
const knowledgeLoading = ref(false)
const knowledgeSearch = ref('')

const versionDrawerVisible = ref(false)
const versionHistory = ref<any[]>([])

const previewVisible = ref(false)
const sanitizedPreview = ref('')

const uploadVisible = ref(false)
const uploading = ref(false)
const uploadForm = ref({ title: '', category: 'general', content: '', deviceTypes: [] as string[] })

let searchTimer: ReturnType<typeof setTimeout> | null = null

function formatTime(dateStr: string): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString()
}

function debouncedLoadTemplates() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { templatePage.value = 1; loadTemplates() }, 300)
}

async function loadTemplates() {
  templatesLoading.value = true
  try {
    const res = await templateApi.getAll({
      page: templatePage.value,
      pageSize: templatePageSize.value,
      category: templateCategory.value || undefined,
      search: templateSearch.value || undefined,
    })
    if (res.data.success) {
      templates.value = res.data.data || []
      templateTotal.value = res.data.pagination?.total || 0
    }
  } catch (e) {
    ElMessage.error('加载模板失败')
  } finally {
    templatesLoading.value = false
  }
}

function showPreview(tpl: PromptTemplate) {
  const html = marked(tpl.content || '') as string
  sanitizedPreview.value = DOMPurify.sanitize(html)
  previewVisible.value = true
}

async function showVersionHistory(tpl: PromptTemplate) {
  try {
    const res = await api.get(`/prompt-templates/${tpl.id}/versions`)
    versionHistory.value = res.data.data || [{ version: 1, content: tpl.content, updatedAt: tpl.updatedAt }]
  } catch {
    versionHistory.value = [{ version: 1, content: tpl.content, updatedAt: tpl.updatedAt }]
  }
  versionDrawerVisible.value = true
}

async function rollbackToVersion(ver: any) {
  try {
    await ElMessageBox.confirm(`确定回滚到 v${ver.version}？`, '回滚确认', { type: 'warning' })
    await api.post(`/prompt-templates/${ver.templateId}/rollback`, { version: ver.version })
    ElMessage.success('回滚成功')
    versionDrawerVisible.value = false
    loadTemplates()
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('回滚失败')
  }
}

function editTemplate(_tpl: PromptTemplate) {
  // Navigate to existing PromptTemplateView for editing
  window.location.hash = ''
  window.location.pathname = '/ai-ops/templates'
}

async function deleteTemplate(tpl: PromptTemplate) {
  try {
    await ElMessageBox.confirm(`确定删除模板 "${tpl.name}"？`, '删除确认', { type: 'warning' })
    await templateApi.delete(tpl.id)
    ElMessage.success('删除成功')
    loadTemplates()
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('删除失败')
  }
}

async function searchKnowledge() {
  knowledgeLoading.value = true
  try {
    const res = await api.get('/ai-ops/knowledge/prompts', {
      params: { search: knowledgeSearch.value || undefined, limit: 50 }
    })
    knowledgeEntries.value = res.data.data || []
  } catch {
    ElMessage.error('搜索知识条目失败')
  } finally {
    knowledgeLoading.value = false
  }
}

function showUploadDialog() {
  uploadForm.value = { title: '', category: 'general', content: '', deviceTypes: [] }
  uploadVisible.value = true
}

async function submitKnowledge() {
  if (!uploadForm.value.title || !uploadForm.value.content) {
    ElMessage.warning('请填写标题和内容')
    return
  }
  uploading.value = true
  try {
    await api.post('/ai-ops/knowledge/prompts', uploadForm.value)
    ElMessage.success('知识上传成功')
    uploadVisible.value = false
    searchKnowledge()
  } catch {
    ElMessage.error('上传失败')
  } finally {
    uploading.value = false
  }
}

onMounted(() => {
  loadTemplates()
  searchKnowledge()
})
</script>

<style scoped>
.prompt-management-view { padding: 20px; background: var(--el-bg-color-page); min-height: 100%; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
.header-description { margin-left: 12px; font-size: 14px; font-weight: normal; color: var(--el-text-color-secondary); }
.header-actions { display: flex; gap: 8px; }
.tab-toolbar { display: flex; gap: 12px; margin-bottom: 16px; }
.template-name { font-weight: 500; }
.pagination-container { margin-top: 16px; display: flex; justify-content: flex-end; }
.version-header { display: flex; justify-content: space-between; align-items: center; }
.version-content { color: var(--el-text-color-secondary); font-size: 13px; margin-top: 8px; }
.preview-content { padding: 16px; min-height: 300px; }
.preview-content :deep(pre) { background: var(--el-fill-color-light); padding: 12px; border-radius: 4px; }
.text-muted { color: var(--el-text-color-placeholder); }
</style>
