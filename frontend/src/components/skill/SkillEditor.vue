<template>
  <div class="skill-editor">
    <!-- Tabs for different editing modes -->
    <el-tabs v-model="activeTab" type="border-card">
      <!-- SKILL.md Editor Tab -->
      <el-tab-pane label="SKILL.md 编辑" name="content">
        <div class="editor-toolbar">
          <el-button-group>
            <el-button size="small" @click="insertTemplate('heading')">标题</el-button>
            <el-button size="small" @click="insertTemplate('list')">列表</el-button>
            <el-button size="small" @click="insertTemplate('code')">代码块</el-button>
          </el-button-group>
          <el-button size="small" type="info" @click="showPreview = !showPreview">
            {{ showPreview ? '隐藏预览' : '显示预览' }}
          </el-button>
        </div>
        
        <div class="editor-container" :class="{ 'with-preview': showPreview }">
          <div class="editor-pane">
            <div class="editor-wrapper">
              <textarea
                ref="editorRef"
                v-model="localContent"
                class="code-editor"
                spellcheck="false"
                @input="handleContentChange"
                @keydown="handleKeyDown"
              />
              <pre class="syntax-highlight" v-html="highlightedContent" />
            </div>
          </div>
          <div v-if="showPreview" class="preview-pane">
            <div class="preview-content" v-html="renderedMarkdown" />
          </div>
        </div>
      </el-tab-pane>

      <!-- Tool Configuration Tab -->
      <el-tab-pane label="工具配置" name="tools">
        <div class="tools-section">
          <div class="section-header">
            <span>允许的工具</span>
            <el-checkbox v-model="allowAllTools" @change="(val: string | number | boolean) => handleAllToolsChange(Boolean(val))">
              允许所有工具
            </el-checkbox>
          </div>
          
          <div v-if="!allowAllTools" class="tools-list">
            <div class="tools-hint">拖拽调整工具优先级（上方优先级更高）</div>
            <div
              v-for="(tool, index) in localTools"
              :key="tool.name"
              class="tool-item"
              draggable="true"
              @dragstart="handleDragStart(index, $event)"
              @dragover.prevent="handleDragOver(index, $event)"
              @drop="handleDrop(index)"
              @dragend="handleDragEnd"
              :class="{ 'drag-over': dragOverIndex === index }"
            >
              <el-icon class="drag-handle"><i-ep-rank /></el-icon>
              <span class="tool-priority">{{ index + 1 }}</span>
              <span class="tool-name">{{ tool.name }}</span>
              <el-button
                type="danger"
                size="small"
                text
                @click="removeTool(index)"
              >
                <el-icon><i-ep-delete /></el-icon>
              </el-button>
            </div>
            
            <div class="add-tool">
              <el-select
                v-model="newTool"
                filterable
                allow-create
                placeholder="添加工具"
                style="width: 200px"
              >
                <el-option
                  v-for="tool in availableTools"
                  :key="tool"
                  :label="tool"
                  :value="tool"
                  :disabled="localTools.some(t => t.name === tool)"
                />
              </el-select>
              <el-button type="primary" size="small" @click="addTool" :disabled="!newTool">
                添加
              </el-button>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- File Browser Tab -->
      <el-tab-pane label="文件浏览" name="files">
        <div class="file-browser">
          <div class="file-tree">
            <el-tree
              :data="fileTreeData"
              :props="{ label: 'name', children: 'children' }"
              node-key="path"
              highlight-current
              @node-click="handleFileClick"
            >
              <template #default="{ node, data }">
                <span class="file-node">
                  <el-icon v-if="data.isDir"><i-ep-folder /></el-icon>
                  <el-icon v-else><i-ep-document /></el-icon>
                  <span>{{ node.label }}</span>
                </span>
              </template>
            </el-tree>
          </div>
          <div class="file-content">
            <div v-if="selectedFile" class="file-header">
              <span>{{ selectedFile.path }}</span>
              <el-button size="small" type="primary" @click="saveFile" :loading="savingFile">
                保存
              </el-button>
            </div>
            <textarea
              v-if="selectedFile"
              v-model="selectedFile.content"
              class="file-editor"
              spellcheck="false"
            />
            <el-empty v-else description="选择文件查看内容" />
          </div>
        </div>
      </el-tab-pane>

      <!-- Match Testing Tab -->
      <el-tab-pane label="匹配测试" name="test">
        <div class="match-testing">
          <el-form label-width="80px">
            <el-form-item label="测试消息">
              <el-input
                v-model="testMessage"
                type="textarea"
                :rows="3"
                placeholder="输入测试消息，查看是否匹配此 Skill"
              />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="runMatchTest" :loading="testing">
                测试匹配
              </el-button>
            </el-form-item>
          </el-form>
          
          <div v-if="matchResult" class="match-result">
            <el-descriptions :column="1" border>
              <el-descriptions-item label="匹配 Skill">
                <el-tag :type="matchResult.skill === skillName ? 'success' : 'warning'">
                  {{ matchResult.skill }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="匹配类型">
                {{ matchResult.matchType }}
              </el-descriptions-item>
              <el-descriptions-item label="置信度">
                <el-progress
                  :percentage="Math.round(matchResult.confidence * 100)"
                  :stroke-width="10"
                  :color="getConfidenceColor(matchResult.confidence)"
                />
              </el-descriptions-item>
              <el-descriptions-item label="匹配原因">
                {{ matchResult.matchReason || '-' }}
              </el-descriptions-item>
            </el-descriptions>
            
            <el-alert
              v-if="matchResult.skill === skillName"
              type="success"
              title="匹配成功"
              description="测试消息成功匹配到当前 Skill"
              show-icon
              :closable="false"
            />
            <el-alert
              v-else
              type="warning"
              title="未匹配"
              :description="`测试消息匹配到了 ${matchResult.skill}，而不是当前 Skill`"
              show-icon
              :closable="false"
            />
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- Diff View Dialog -->
    <el-dialog v-model="showDiff" title="变更对比" width="900px" destroy-on-close>
      <div class="diff-view">
        <div class="diff-header">
          <span class="diff-label old">原始内容</span>
          <span class="diff-label new">修改后内容</span>
        </div>
        <div class="diff-content">
          <div class="diff-pane old">
            <pre>{{ originalContent }}</pre>
          </div>
          <div class="diff-pane new">
            <pre>{{ localContent }}</pre>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="showDiff = false">关闭</el-button>
        <el-button type="primary" @click="confirmSave">确认保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { renderMarkdown } from '@/utils/markdown'

import { ElMessage } from 'element-plus'
import api from '@/api'

interface Props {
  skillName: string
  content: string
  config: {
    allowedTools?: string[]
    caps?: { temperature?: number; maxIterations?: number }
  }
  files?: string[]
}

interface Emits {
  (e: 'update:content', value: string): void
  (e: 'update:config', value: object): void
  (e: 'save'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

// State
const activeTab = ref('content')
const showPreview = ref(false)
const showDiff = ref(false)
const localContent = ref('')
const originalContent = ref('')
const localTools = ref<{ name: string }[]>([])
const allowAllTools = ref(false)
const newTool = ref('')
const testMessage = ref('')
const testing = ref(false)
const matchResult = ref<{
  skill: string
  matchType: string
  confidence: number
  matchReason?: string
} | null>(null)
const selectedFile = ref<{ path: string; content: string } | null>(null)
const savingFile = ref(false)
const editorRef = ref<HTMLTextAreaElement | null>(null)

// Drag and drop state
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

// Available tools list
const availableTools = [
  'get_system_info',
  'get_interface_status',
  'get_logs',
  'analyze_metrics',
  'generate_config',
  'validate_config',
  'apply_config',
  'get_firewall_rules',
  'get_users',
  'get_services',
  'check_security',
  'get_routes',
  'get_dhcp_leases',
  'get_dns_cache'
]

// File tree data
const fileTreeData = computed(() => {
  if (!props.files || props.files.length === 0) {
    return []
  }
  
  const root: { name: string; path: string; isDir: boolean; children?: any[] }[] = []
  
  for (const file of props.files) {
    const parts = file.split('/')
    let current = root
    let currentPath = ''
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const isLast = i === parts.length - 1
      
      let existing = current.find(n => n.name === part)
      if (!existing) {
        existing = {
          name: part,
          path: currentPath,
          isDir: !isLast,
          children: isLast ? undefined : []
        }
        current.push(existing)
      }
      
      if (!isLast && existing.children) {
        current = existing.children
      }
    }
  }
  
  return root
})

// Syntax highlighting for Markdown/YAML
const highlightedContent = computed(() => {
  return highlightMarkdown(localContent.value)
})

// Standardized markdown rendering for preview
const renderedMarkdown = computed(() => {
  if (!localContent.value) return ''
  // Remove YAML frontmatter if present
  const content = localContent.value.replace(/^---\n[\s\S]*?\n---\n?/, '')
  return renderMarkdown(content)
})

// Initialize
onMounted(() => {
  localContent.value = props.content
  originalContent.value = props.content
  
  if (props.config.allowedTools?.includes('*')) {
    allowAllTools.value = true
    localTools.value = []
  } else {
    allowAllTools.value = false
    localTools.value = (props.config.allowedTools || []).map(name => ({ name }))
  }
})

// Watch for external changes
watch(() => props.content, (newVal) => {
  if (newVal !== localContent.value) {
    localContent.value = newVal
    originalContent.value = newVal
  }
})

// Methods
const handleContentChange = () => {
  emit('update:content', localContent.value)
}

const handleKeyDown = (e: KeyboardEvent) => {
  // Tab key handling for indentation
  if (e.key === 'Tab') {
    e.preventDefault()
    const textarea = editorRef.value
    if (textarea) {
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const value = localContent.value
      localContent.value = value.substring(0, start) + '  ' + value.substring(end)
      // Set cursor position after tab
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2
      }, 0)
    }
  }
}

const insertTemplate = (type: string) => {
  const templates: Record<string, string> = {
    heading: '\n## 标题\n\n',
    list: '\n- 项目 1\n- 项目 2\n- 项目 3\n',
    code: '\n```\n代码块\n```\n'
  }
  
  const textarea = editorRef.value
  if (textarea) {
    const start = textarea.selectionStart
    const template = templates[type] || ''
    localContent.value = localContent.value.substring(0, start) + template + localContent.value.substring(start)
    handleContentChange()
  }
}

const handleAllToolsChange = (val: boolean) => {
  if (val) {
    localTools.value = []
  }
  updateConfig()
}

// Drag and drop handlers
const handleDragStart = (index: number, event: DragEvent) => {
  dragIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }
}

const handleDragOver = (index: number, _event: DragEvent) => {
  dragOverIndex.value = index
}

const handleDrop = (targetIndex: number) => {
  if (dragIndex.value === null || dragIndex.value === targetIndex) {
    dragOverIndex.value = null
    return
  }
  
  const item = localTools.value[dragIndex.value]
  localTools.value.splice(dragIndex.value, 1)
  localTools.value.splice(targetIndex, 0, item)
  
  dragIndex.value = null
  dragOverIndex.value = null
  updateConfig()
}

const handleDragEnd = () => {
  dragIndex.value = null
  dragOverIndex.value = null
}

const addTool = () => {
  if (newTool.value && !localTools.value.some(t => t.name === newTool.value)) {
    localTools.value.push({ name: newTool.value })
    newTool.value = ''
    updateConfig()
  }
}

const removeTool = (index: number) => {
  localTools.value.splice(index, 1)
  updateConfig()
}

const updateConfig = () => {
  const config = {
    ...props.config,
    allowedTools: allowAllTools.value ? ['*'] : localTools.value.map(t => t.name)
  }
  emit('update:config', config)
}

const handleFileClick = async (data: { path: string; isDir: boolean }) => {
  if (data.isDir) return
  
  try {
    const response = await api.get(`/skills/${props.skillName}/files/${data.path}`)
    if (response.data.success) {
      selectedFile.value = {
        path: data.path,
        content: response.data.data.content
      }
    }
  } catch (err) {
    ElMessage.error('读取文件失败')
  }
}

const saveFile = async () => {
  if (!selectedFile.value) return
  
  savingFile.value = true
  try {
    await api.put(`/skills/${props.skillName}/files/${selectedFile.value.path}`, {
      content: selectedFile.value.content
    })
    ElMessage.success('文件保存成功')
  } catch (err) {
    ElMessage.error('保存文件失败')
  } finally {
    savingFile.value = false
  }
}

const runMatchTest = async () => {
  if (!testMessage.value) {
    ElMessage.warning('请输入测试消息')
    return
  }
  
  testing.value = true
  matchResult.value = null
  
  try {
    const response = await api.post('/skills/test-match', {
      message: testMessage.value
    })
    
    if (response.data.success) {
      matchResult.value = response.data.data
    }
  } catch (err) {
    ElMessage.error('测试失败')
  } finally {
    testing.value = false
  }
}

const getConfidenceColor = (confidence: number): string => {
  if (confidence >= 0.8) return '#67c23a'
  if (confidence >= 0.5) return '#e6a23c'
  return '#f56c6c'
}

const showDiffView = () => {
  showDiff.value = true
}

const confirmSave = () => {
  showDiff.value = false
  emit('save')
}

// Syntax highlighting helper
const highlightMarkdown = (text: string): string => {
  if (!text) return ''
  
  let result = text
    // Escape HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // YAML frontmatter
    .replace(/^---\n([\s\S]*?)\n---/m, '<span class="hl-frontmatter">---\n$1\n---</span>')
    // Headers
    .replace(/^(#{1,6})\s+(.*)$/gm, '<span class="hl-heading">$1 $2</span>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<span class="hl-bold">**$1**</span>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<span class="hl-italic">*$1*</span>')
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<span class="hl-code">```$1\n$2```</span>')
    // Inline code
    .replace(/`([^`]+)`/g, '<span class="hl-inline-code">`$1`</span>')
    // Lists
    .replace(/^(\s*[-*+])\s+/gm, '<span class="hl-list">$1</span> ')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="hl-link">[$1]($2)</span>')
  
  return result
}



// Expose methods for parent component
defineExpose({
  showDiffView
})
</script>


<style scoped>
.skill-editor {
  height: 100%;
}

.editor-toolbar {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #ebeef5;
}

.editor-container {
  display: flex;
  gap: 16px;
  height: 400px;
}

.editor-container.with-preview .editor-pane {
  width: 50%;
}

.editor-pane {
  flex: 1;
  position: relative;
}

.editor-wrapper {
  position: relative;
  height: 100%;
  overflow: hidden;
}

.code-editor {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  padding: 12px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.5;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  resize: none;
  background: transparent;
  color: transparent;
  caret-color: #303133;
  z-index: 1;
}

.code-editor:focus {
  outline: none;
  border-color: #409eff;
}

.syntax-highlight {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  padding: 12px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.5;
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow: auto;
  background: #fafafa;
  border: 1px solid transparent;
  border-radius: 4px;
  pointer-events: none;
}

.syntax-highlight :deep(.hl-frontmatter) {
  color: #6a737d;
}

.syntax-highlight :deep(.hl-heading) {
  color: #0366d6;
  font-weight: bold;
}

.syntax-highlight :deep(.hl-bold) {
  color: #24292e;
  font-weight: bold;
}

.syntax-highlight :deep(.hl-italic) {
  color: #24292e;
  font-style: italic;
}

.syntax-highlight :deep(.hl-code) {
  color: #032f62;
  background: #f6f8fa;
}

.syntax-highlight :deep(.hl-inline-code) {
  color: #e36209;
  background: #fff5b1;
}

.syntax-highlight :deep(.hl-list) {
  color: #e36209;
}

.syntax-highlight :deep(.hl-link) {
  color: #0366d6;
}

.preview-pane {
  width: 50%;
  padding: 12px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  background: #fff;
  overflow: auto;
}

.preview-content {
  font-size: 14px;
  line-height: 1.6;
}

.preview-content :deep(h1),
.preview-content :deep(h2),
.preview-content :deep(h3) {
  margin-top: 16px;
  margin-bottom: 8px;
}

.preview-content :deep(code) {
  background: #f6f8fa;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: monospace;
}

.preview-content :deep(pre) {
  background: #f6f8fa;
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
}

.tools-section {
  padding: 16px 0;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  font-weight: 600;
}

.tools-list {
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 12px;
}

.tools-hint {
  font-size: 12px;
  color: #909399;
  margin-bottom: 12px;
}

.tool-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: #f5f7fa;
  border-radius: 4px;
  margin-bottom: 8px;
}

.tool-item:last-child {
  margin-bottom: 0;
}

.tool-item.drag-over {
  border: 2px dashed #409eff;
  background: #ecf5ff;
}

.drag-handle {
  cursor: move;
  color: #909399;
}

.tool-priority {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #409eff;
  color: #fff;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 600;
}

.tool-name {
  flex: 1;
  font-family: monospace;
}

.add-tool {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.file-browser {
  display: flex;
  gap: 16px;
  height: 400px;
}

.file-tree {
  width: 200px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 8px;
  overflow: auto;
}

.file-node {
  display: flex;
  align-items: center;
  gap: 4px;
}

.file-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  border: 1px solid #ebeef5;
  border-radius: 4px;
}

.file-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #f5f7fa;
  border-bottom: 1px solid #ebeef5;
  font-size: 13px;
  color: #606266;
}

.file-editor {
  flex: 1;
  padding: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  line-height: 1.5;
  border: none;
  resize: none;
}

.file-editor:focus {
  outline: none;
}

.match-testing {
  padding: 16px 0;
}

.match-result {
  margin-top: 20px;
}

.match-result .el-alert {
  margin-top: 16px;
}

.diff-view {
  height: 500px;
  display: flex;
  flex-direction: column;
}

.diff-header {
  display: flex;
  margin-bottom: 8px;
}

.diff-label {
  flex: 1;
  padding: 8px 12px;
  font-weight: 600;
  text-align: center;
}

.diff-label.old {
  background: #ffeef0;
  color: #cb2431;
}

.diff-label.new {
  background: #e6ffed;
  color: #22863a;
}

.diff-content {
  flex: 1;
  display: flex;
  gap: 8px;
  overflow: hidden;
}

.diff-pane {
  flex: 1;
  overflow: auto;
  border: 1px solid #ebeef5;
  border-radius: 4px;
}

.diff-pane pre {
  margin: 0;
  padding: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.diff-pane.old {
  background: #ffeef0;
}

.diff-pane.new {
  background: #e6ffed;
}
</style>
