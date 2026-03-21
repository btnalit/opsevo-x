<template>
  <div class="prompt-template-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>Prompt 模板管理</span>
            <span class="header-description">管理 AI 对话的提示词模板</span>
          </div>
          <div class="header-actions">
            <el-button type="primary" @click="showCreateDialog">
              <el-icon><i-ep-plus /></el-icon>
              创建模板
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- 搜索和筛选 -->
    <el-card class="filter-card" shadow="hover">
      <el-form :inline="true">
        <el-form-item>
          <el-input
            v-model="searchQuery"
            placeholder="搜索模板名称或描述..."
            :prefix-icon="Search"
            clearable
            style="width: 250px"
            @input="handleSearch"
          />
        </el-form-item>
        <el-form-item label="分类">
          <el-select
            v-model="categoryFilter"
            placeholder="全部"
            clearable
            style="width: 120px"
            @change="handleFilterChange"
          >
            <el-option
              v-for="opt in TEMPLATE_CATEGORY_OPTIONS"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 加载状态 -->
    <el-skeleton v-if="loading && !templates.length" :rows="5" animated />

    <!-- 错误状态 -->
    <el-alert
      v-else-if="error"
      :title="error"
      type="error"
      show-icon
      closable
      @close="error = ''"
    >
      <template #default>
        <el-button size="small" @click="loadTemplates">重试</el-button>
      </template>
    </el-alert>

    <!-- 空状态 -->
    <el-empty v-else-if="!filteredTemplates.length" description="暂无模板">
      <el-button type="primary" @click="showCreateDialog">创建模板</el-button>
    </el-empty>

    <!-- 模板列表 -->
    <template v-else>
      <el-table :data="filteredTemplates" stripe>
        <el-table-column prop="name" label="模板名称" min-width="150">
          <template #default="{ row }">
            <div class="template-name-cell">
              <span class="name">{{ row.name }}</span>
              <el-tag v-if="row.isDefault" type="success" size="small">默认</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="category" label="分类" width="100">
          <template #default="{ row }">
            <el-tag size="small">{{ getCategoryLabel(row.category) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="usageLocation" label="使用位置" width="220">
          <template #default="{ row }">
            <div v-if="getUsageLocation(row.name)" class="usage-location-cell">
              <span class="usage-location">
                <el-icon><i-ep-location /></el-icon>
                {{ getUsageLocation(row.name) }}
              </span>
              <el-tag 
                v-if="getOverrideForSystem(row.name)" 
                type="warning" 
                size="small"
                class="override-tag"
              >
                已覆盖
              </el-tag>
            </div>
            <span v-else class="no-usage">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
        <el-table-column prop="updatedAt" label="更新时间" width="180">
          <template #default="{ row }">
            {{ formatTime(row.updatedAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link @click="showEditDialog(row)">编辑</el-button>
            <el-button type="info" link @click="copyTemplate(row)">复制</el-button>
            <el-button
              v-if="!row.isDefault"
              type="success"
              link
              @click="setAsDefault(row)"
            >设为默认</el-button>
            <!-- 覆盖系统模板按钮（仅对非系统模板显示） -->
            <el-button
              v-if="!isSystemTemplate(row.name)"
              type="warning"
              link
              @click="showOverrideDialog(row)"
            >覆盖系统</el-button>
            <!-- 清除覆盖按钮（仅对被覆盖的系统模板显示） -->
            <el-button
              v-if="isSystemTemplate(row.name) && getOverrideForSystem(row.name)"
              type="warning"
              link
              @click="clearOverrideForSystem(row.name)"
            >清除覆盖</el-button>
            <el-button type="danger" link @click="confirmDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <!-- 分页 -->
      <div class="pagination-container">
        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.pageSize"
          :total="pagination.total"
          :page-sizes="[10, 20, 50]"
          layout="total, sizes, prev, pager, next"
          @size-change="loadTemplates"
          @current-change="loadTemplates"
        />
      </div>
    </template>

    <!-- 创建/编辑对话框 -->
    <el-dialog
      v-model="editDialogVisible"
      :title="editingTemplate ? '编辑模板' : '创建模板'"
      width="900px"
      destroy-on-close
    >
      <!-- 系统模板警告 -->
      <el-alert
        v-if="editingTemplate && isSystemTemplate(editingTemplate.name)"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      >
        <template #title>
          <strong>系统模板警告</strong>
        </template>
        <template #default>
          <p style="margin: 4px 0 0 0">
            此模板被后端服务使用（{{ getUsageLocation(editingTemplate.name) }}）。
            <strong>请勿修改模板名称</strong>，否则后端将无法找到该模板并回退到默认值。
          </p>
        </template>
      </el-alert>

      <!-- 模块化接管提示 -->
      <el-alert
        v-if="editingTemplate && isModularManaged(editingTemplate.name)"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
        title="此模板由模块化 Prompt 系统管理，编辑将作为自定义覆盖生效"
      />

      <el-form ref="formRef" :model="formData" :rules="formRules" label-width="100px">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="名称" prop="name">
              <el-input 
                v-model="formData.name" 
                placeholder="输入模板名称"
                :disabled="!!(editingTemplate && isSystemTemplate(editingTemplate.name))"
              />
              <div v-if="editingTemplate && isSystemTemplate(editingTemplate.name)" class="name-disabled-hint">
                系统模板名称不可修改
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="分类" prop="category">
              <el-select v-model="formData.category" placeholder="选择分类" style="width: 100%">
                <el-option
                  v-for="opt in TEMPLATE_CATEGORY_OPTIONS.filter(o => o.value)"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="描述" prop="description">
          <el-input v-model="formData.description" type="textarea" :rows="2" placeholder="输入模板描述" />
        </el-form-item>
        <el-form-item label="设为默认">
          <el-switch v-model="formData.isDefault" />
        </el-form-item>
      </el-form>

      <!-- 占位符列表 -->
      <div class="placeholders-section">
        <h4>可用占位符</h4>
        <div class="placeholder-tags">
          <el-tag
            v-for="ph in placeholders"
            :key="ph.name"
            size="small"
            class="placeholder-tag"
            @click="insertPlaceholder(ph.name)"
          >
            {{ ph.name }}
            <el-tooltip :content="ph.description" placement="top">
              <el-icon><i-ep-info-filled /></el-icon>
            </el-tooltip>
          </el-tag>
          <span v-if="!placeholders.length" class="no-placeholders">暂无可用占位符</span>
        </div>
      </div>

      <!-- Markdown 编辑器 -->
      <div class="editor-section">
        <el-tabs v-model="editorTab">
          <el-tab-pane label="编辑" name="edit">
            <MdEditor
              v-model="formData.content"
              language="zh-CN"
              :preview="false"
              :toolbars="editorToolbars"
              style="height: 400px"
            />
          </el-tab-pane>
          <el-tab-pane label="预览" name="preview">
            <div class="preview-content" v-html="sanitizedPreview"></div>
          </el-tab-pane>
        </el-tabs>
      </div>

      <template #footer>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveTemplate">
          {{ editingTemplate ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 覆盖系统模板对话框 -->
    <el-dialog
      v-model="overrideDialogVisible"
      title="覆盖系统模板"
      width="500px"
      destroy-on-close
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      >
        <template #title>
          选择要覆盖的系统模板
        </template>
        <template #default>
          <p style="margin: 4px 0 0 0">
            选择后，后端服务将使用您的自定义模板 <strong>{{ overrideSourceTemplate?.name }}</strong> 
            来替代系统模板。
          </p>
        </template>
      </el-alert>

      <el-form label-width="100px">
        <el-form-item label="系统模板">
          <el-select 
            v-model="selectedSystemTemplate" 
            placeholder="选择要覆盖的系统模板"
            style="width: 100%"
          >
            <el-option
              v-for="name in systemTemplateNames"
              :key="name"
              :label="name"
              :value="name"
            >
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span>{{ name }}</span>
                <el-tag v-if="overrides[name]" type="warning" size="small">已覆盖</el-tag>
              </div>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item v-if="selectedSystemTemplate" label="使用位置">
          <span class="usage-location">
            <el-icon><i-ep-location /></el-icon>
            {{ getUsageLocation(selectedSystemTemplate) }}
          </span>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="overrideDialogVisible = false">取消</el-button>
        <el-button 
          type="primary" 
          :loading="saving" 
          :disabled="!selectedSystemTemplate"
          @click="confirmOverride"
        >
          确认覆盖
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Search } from '@element-plus/icons-vue'

import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { MdEditor } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import {
  templateApi,
  TEMPLATE_CATEGORY_OPTIONS,
  TEMPLATE_USAGE_LOCATIONS,
  type PromptTemplate,
  type PlaceholderDefinition,
  type TemplateOverrides
} from '@/api/evolution'

// 状态
const templates = ref<PromptTemplate[]>([])
const overrides = ref<TemplateOverrides>({})
const placeholders = ref<PlaceholderDefinition[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const searchQuery = ref('')
const categoryFilter = ref('')
const editDialogVisible = ref(false)
const editingTemplate = ref<PromptTemplate | null>(null)
const editorTab = ref('edit')
const formRef = ref<FormInstance>()

// 覆盖对话框状态
const overrideDialogVisible = ref(false)
const overrideSourceTemplate = ref<PromptTemplate | null>(null)
const selectedSystemTemplate = ref('')

// 系统模板名称列表（从 TEMPLATE_USAGE_LOCATIONS 获取）
const systemTemplateNames = computed(() => Object.keys(TEMPLATE_USAGE_LOCATIONS))

const pagination = reactive({
  page: 1,
  pageSize: 10,
  total: 0
})

const formData = reactive({
  name: '',
  content: '',
  description: '',
  category: '',
  isDefault: false
})

const formRules: FormRules = {
  name: [{ required: true, message: '请输入模板名称', trigger: 'blur' }],
  content: [{ required: true, message: '请输入模板内容', trigger: 'blur' }]
}

import type { ToolbarNames } from 'md-editor-v3'

// 编辑器工具栏配置
const editorToolbars: ToolbarNames[] = [
  'bold', 'underline', 'italic', '-',
  'title', 'strikeThrough', 'sub', 'sup', '-',
  'quote', 'unorderedList', 'orderedList', '-',
  'codeRow', 'code', 'link', '-',
  'revoke', 'next'
]

// 计算属性：过滤后的模板列表
// 注意：搜索和分类过滤现在在后端进行，这里直接返回从后端获取的数据
const filteredTemplates = computed(() => {
  return templates.value
})

// 计算属性：安全的预览内容
const sanitizedPreview = computed(() => {
  if (!formData.content) return '<p class="empty-preview">暂无内容</p>'
  const html = marked(formData.content) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'],
    ALLOWED_ATTR: ['href', 'target', 'rel']
  })
})

// 格式化时间
function formatTime(dateStr: string): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString()
}

// 获取分类标签
function getCategoryLabel(category?: string): string {
  const opt = TEMPLATE_CATEGORY_OPTIONS.find(o => o.value === category)
  return opt?.label || category || '未分类'
}

// 获取使用位置
function getUsageLocation(name: string): string | undefined {
  return TEMPLATE_USAGE_LOCATIONS[name]
}

// 检查是否为系统模板（有使用位置的模板）
function isSystemTemplate(name: string): boolean {
  return !!TEMPLATE_USAGE_LOCATIONS[name]
}

// 判断模板是否被模块化系统接管
const MODULAR_MANAGED_TEMPLATES = [
  'ReAct 循环基础提示词',
  '知识优先 ReAct 提示词',
  '并行执行 ReAct 提示词',
  '设备系统提示词',
  '告警分析提示词',
]

function isModularManaged(name: string): boolean {
  return MODULAR_MANAGED_TEMPLATES.includes(name) || name.startsWith('[模块化]')
}

// 获取系统模板的覆盖模板ID
function getOverrideForSystem(systemTemplateName: string): string | undefined {
  return overrides.value[systemTemplateName]
}

// 插入占位符
function insertPlaceholder(name: string) {
  formData.content += `{{${name}}}`
}

// 搜索处理 - 使用防抖，搜索在后端进行
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
function handleSearch() {
  // 搜索时重置到第一页
  pagination.page = 1
  
  // 防抖处理，避免频繁请求
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }
  searchDebounceTimer = setTimeout(() => {
    loadTemplates()
  }, 300)
}

// 筛选变化处理
function handleFilterChange() {
  pagination.page = 1
  loadTemplates()
}

// 加载模板列表
async function loadTemplates() {
  loading.value = true
  error.value = ''

  try {
    const response = await templateApi.getAll({
      page: pagination.page,
      pageSize: pagination.pageSize,
      category: categoryFilter.value || undefined,
      search: searchQuery.value || undefined
    })
    if (response.data.success) {
      templates.value = response.data.data || []
      if (response.data.pagination) {
        pagination.total = response.data.pagination.total
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载模板失败'
  } finally {
    loading.value = false
  }
}

// 加载占位符列表
async function loadPlaceholders() {
  try {
    const response = await templateApi.getPlaceholders()
    if (response.data.success) {
      placeholders.value = response.data.data || []
    }
  } catch (e) {
    console.error('加载占位符失败:', e)
  }
}

// 加载覆盖配置
async function loadOverrides() {
  try {
    const response = await templateApi.getOverrides()
    if (response.data.success) {
      overrides.value = response.data.data || {}
    }
  } catch (e) {
    console.error('加载覆盖配置失败:', e)
  }
}

// 显示覆盖对话框
function showOverrideDialog(template: PromptTemplate) {
  overrideSourceTemplate.value = template
  selectedSystemTemplate.value = ''
  overrideDialogVisible.value = true
}

// 确认覆盖
async function confirmOverride() {
  if (!overrideSourceTemplate.value || !selectedSystemTemplate.value) return

  saving.value = true
  try {
    await templateApi.setOverride(selectedSystemTemplate.value, overrideSourceTemplate.value.id)
    ElMessage.success(`已将 "${overrideSourceTemplate.value.name}" 设为 "${selectedSystemTemplate.value}" 的覆盖模板`)
    overrideDialogVisible.value = false
    await loadOverrides()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '设置覆盖失败')
  } finally {
    saving.value = false
  }
}

// 清除系统模板的覆盖
async function clearOverrideForSystem(systemTemplateName: string) {
  try {
    await ElMessageBox.confirm(
      `确定要清除 "${systemTemplateName}" 的覆盖配置吗？清除后将恢复使用系统默认模板。`,
      '清除覆盖确认',
      {
        confirmButtonText: '清除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    await templateApi.clearOverride(systemTemplateName)
    ElMessage.success('已清除覆盖配置')
    await loadOverrides()
  } catch (e) {
    if (e !== 'cancel') {
      ElMessage.error('清除覆盖失败')
    }
  }
}

// 显示创建对话框
function showCreateDialog() {
  editingTemplate.value = null
  formData.name = ''
  formData.content = ''
  formData.description = ''
  formData.category = ''
  formData.isDefault = false
  editorTab.value = 'edit'
  editDialogVisible.value = true
}

// 显示编辑对话框
function showEditDialog(template: PromptTemplate) {
  editingTemplate.value = template
  formData.name = template.name
  formData.content = template.content
  formData.description = template.description || ''
  formData.category = template.category || ''
  formData.isDefault = template.isDefault
  editorTab.value = 'edit'
  editDialogVisible.value = true
}

// 保存模板
async function saveTemplate() {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }

  saving.value = true
  try {
    const payload = {
      name: formData.name,
      content: formData.content,
      description: formData.description,
      category: formData.category,
      isDefault: formData.isDefault
    }

    if (editingTemplate.value) {
      await templateApi.update(editingTemplate.value.id, payload)
      ElMessage.success('模板更新成功')
    } else {
      await templateApi.create(payload)
      ElMessage.success('模板创建成功')
    }

    editDialogVisible.value = false
    await loadTemplates()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

// 复制模板
async function copyTemplate(template: PromptTemplate) {
  saving.value = true
  try {
    await templateApi.create({
      name: `${template.name} (副本)`,
      content: template.content,
      description: template.description,
      category: template.category,
      isDefault: false
    })
    ElMessage.success('模板复制成功')
    await loadTemplates()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '复制失败')
  } finally {
    saving.value = false
  }
}

// 设为默认
async function setAsDefault(template: PromptTemplate) {
  try {
    await templateApi.setDefault(template.id)
    ElMessage.success('已设为默认模板')
    await loadTemplates()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '设置失败')
  }
}

// 确认删除
async function confirmDelete(template: PromptTemplate) {
  try {
    await ElMessageBox.confirm(
      `确定要删除模板 "${template.name}" 吗？`,
      '删除确认',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    await templateApi.delete(template.id)
    ElMessage.success('删除成功')
    await loadTemplates()
  } catch (e) {
    if (e !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

onMounted(() => {
  loadTemplates()
  loadPlaceholders()
  loadOverrides()
})
</script>


<style scoped>
.prompt-template-view {
  padding: 20px;
  background: var(--el-bg-color-page);
  min-height: 100%;
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

.header-description {
  margin-left: 12px;
  font-size: 14px;
  font-weight: normal;
  color: var(--el-text-color-secondary);
}

.filter-card {
  margin-bottom: 20px;
}

.template-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.template-name-cell .name {
  font-weight: 500;
}

.usage-location {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--el-color-primary);
  font-size: 13px;
}

.usage-location-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.override-tag {
  width: fit-content;
}

.usage-location .el-icon {
  font-size: 14px;
}

.no-usage {
  color: var(--el-text-color-placeholder);
}

.name-disabled-hint {
  font-size: 12px;
  color: var(--el-color-warning);
  margin-top: 4px;
}

.pagination-container {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
}

.placeholders-section {
  margin: 16px 0;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}

.placeholders-section h4 {
  margin: 0 0 8px 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-regular);
}

.placeholder-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.placeholder-tag {
  cursor: pointer;
  transition: all 0.2s;
}

.placeholder-tag:hover {
  background: var(--el-color-primary);
  color: var(--el-color-white);
}

.placeholder-tag .el-icon {
  margin-left: 4px;
  font-size: 12px;
}

.no-placeholders {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.editor-section {
  margin-top: 16px;
}

.preview-content {
  min-height: 400px;
  padding: 16px;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  overflow: auto;
}

.preview-content :deep(pre) {
  background: var(--el-fill-color-light);
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
}

.preview-content :deep(code) {
  background: var(--el-fill-color-light);
  padding: 2px 6px;
  border-radius: 3px;
  font-family: monospace;
}

.preview-content :deep(blockquote) {
  border-left: 4px solid var(--el-color-primary);
  padding-left: 16px;
  margin-left: 0;
  color: var(--el-text-color-regular);
}

.empty-preview {
  color: var(--el-text-color-secondary);
  text-align: center;
  padding: 40px;
}
</style>
