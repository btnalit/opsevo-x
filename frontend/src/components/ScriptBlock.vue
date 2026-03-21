<template>
  <div class="script-block" :class="{ 'is-executing': isExecuting }">
    <!-- Script Header -->
    <div class="script-header">
      <div class="script-info">
        <el-icon :size="16" color="#67c23a"><i-ep-document /></el-icon>
        <span class="script-language">Device Script</span>
        <el-tag v-if="lineCount > 1" type="info" size="small">
          {{ lineCount }} 行
        </el-tag>
      </div>
      <div class="script-actions">
        <el-tooltip content="复制脚本" placement="top">
          <el-button
            :icon="CopyDocument"
            size="small"
            circle
            @click="handleCopy"
          />
        </el-tooltip>
        <el-tooltip content="执行脚本" placement="top">
          <el-button
            :icon="VideoPlay"
            size="small"
            type="success"
            circle
            :loading="isExecuting"
            @click="handleExecuteClick"
          />
        </el-tooltip>
      </div>
    </div>

    <!-- Script Content -->
    <div class="script-content">
      <pre><code class="hljs language-routeros" v-html="highlightedCode"></code></pre>
    </div>

    <!-- Execution Result -->
    <div v-if="executionResult" class="execution-result" :class="executionResult.success ? 'success' : 'error'">
      <div class="result-header">
        <el-icon v-if="executionResult.success" color="#67c23a"><i-ep-circle-check /></el-icon>
        <el-icon v-else color="#f56c6c"><i-ep-circle-close /></el-icon>
        <span>{{ executionResult.success ? '执行成功' : '执行失败' }}</span>
        <span class="result-time">{{ formatTime(executionResult.executedAt) }}</span>
      </div>
      <div v-if="executionResult.output || executionResult.error" class="result-content">
        <pre>{{ executionResult.output || executionResult.error }}</pre>
      </div>
    </div>

    <!-- Execution Confirmation Dialog -->
    <el-dialog
      v-model="showConfirmDialog"
      title="执行脚本确认"
      width="600px"
      :close-on-click-modal="false"
    >
      <div class="confirm-dialog-content">
        <el-alert
          title="请仔细检查以下脚本内容"
          type="warning"
          :closable="false"
          show-icon
        >
          <template #default>
            执行脚本可能会修改设备配置，请确保您了解脚本的作用。
          </template>
        </el-alert>

        <!-- Dangerous Commands Warning -->
        <el-alert
          v-if="validationResult?.hasDangerousCommands"
          title="检测到危险命令"
          type="error"
          :closable="false"
          show-icon
          class="danger-alert"
        >
          <template #default>
            <div>以下命令可能会影响系统稳定性：</div>
            <ul class="danger-commands">
              <li v-for="cmd in validationResult.dangerousCommands" :key="cmd">
                {{ cmd }}
              </li>
            </ul>
          </template>
        </el-alert>

        <div class="script-preview">
          <div class="preview-header">脚本内容</div>
          <pre><code class="hljs language-routeros" v-html="highlightedCode"></code></pre>
        </div>

        <el-checkbox v-model="confirmChecked" class="confirm-checkbox">
          我已确认脚本内容，了解执行后果
        </el-checkbox>
      </div>

      <template #footer>
        <el-button @click="showConfirmDialog = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!confirmChecked"
          :loading="isValidating"
          @click="handleConfirmExecute"
        >
          确认执行
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { CopyDocument, VideoPlay } from '@element-plus/icons-vue'

import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import hljs from 'highlight.js'
import { scriptApi, type ScriptExecuteResult, type ScriptValidationResult } from '@/api/ai'

// ==================== Props ====================

interface Props {
  /** The device script content */
  script: string
  /** Session ID for tracking execution history */
  sessionId?: string
}

const props = defineProps<Props>()

// ==================== Emits ====================

const emit = defineEmits<{
  /** Emitted when script is copied */
  (e: 'copy', script: string): void
  /** Emitted when script execution starts */
  (e: 'execute-start', script: string): void
  /** Emitted when script execution completes */
  (e: 'execute-complete', result: ScriptExecuteResult): void
  /** Emitted when script execution fails */
  (e: 'execute-error', error: string): void
}>()

// ==================== State ====================

const showConfirmDialog = ref(false)
const confirmChecked = ref(false)
const isValidating = ref(false)
const isExecuting = ref(false)
const validationResult = ref<ScriptValidationResult | null>(null)
const executionResult = ref<ScriptExecuteResult | null>(null)

// ==================== Computed ====================

/** Highlighted code using highlight.js */
const highlightedCode = computed(() => {
  try {
    // Register RouterOS language for syntax highlighting if not already registered
    if (!hljs.getLanguage('routeros')) {
      hljs.registerLanguage('routeros', () => ({
        name: 'DeviceScript',
        keywords: {
          keyword: 'add set remove enable disable print export import find where',
          built_in: 'ip interface system tool user queue firewall routing bridge certificate'
        },
        contains: [
          hljs.COMMENT('#', '$'),
          hljs.QUOTE_STRING_MODE,
          hljs.NUMBER_MODE,
          {
            className: 'variable',
            begin: /\$[\w]+/
          },
          {
            className: 'attr',
            begin: /[\w-]+=(?=\S)/
          }
        ]
      }))
    }
    return hljs.highlight(props.script, { language: 'routeros' }).value
  } catch {
    // If syntax highlighting fails, return escaped plain text to prevent XSS
    return props.script
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }
})

/** Number of lines in the script */
const lineCount = computed(() => {
  return props.script.split('\n').length
})

// ==================== Watch ====================

// Reset confirmation when dialog closes
watch(showConfirmDialog, (visible) => {
  if (!visible) {
    confirmChecked.value = false
    validationResult.value = null
  }
})

// ==================== Methods ====================

/** Copy script to clipboard */
const handleCopy = async () => {
  try {
    await navigator.clipboard.writeText(props.script)
    ElMessage.success('脚本已复制到剪贴板')
    emit('copy', props.script)
  } catch {
    ElMessage.error('复制失败，请手动复制')
  }
}

/** Open execution confirmation dialog */
const handleExecuteClick = async () => {
  showConfirmDialog.value = true
  
  // Validate script
  isValidating.value = true
  try {
    const response = await scriptApi.validate(props.script)
    if (response.data.success && response.data.data) {
      validationResult.value = response.data.data
    }
  } catch (err) {
    console.error('脚本验证失败:', err)
  } finally {
    isValidating.value = false
  }
}

/** Confirm and execute script */
const handleConfirmExecute = async () => {
  if (!confirmChecked.value) return
  
  showConfirmDialog.value = false
  isExecuting.value = true
  emit('execute-start', props.script)
  
  try {
    const response = await scriptApi.execute({
      script: props.script,
      sessionId: props.sessionId || 'default'
    })
    
    if (response.data.success && response.data.data) {
      executionResult.value = response.data.data.result
      
      if (response.data.data.result.success) {
        ElMessage.success('脚本执行成功')
        emit('execute-complete', response.data.data.result)
      } else {
        ElMessage.error(`脚本执行失败: ${response.data.data.result.error}`)
        emit('execute-error', response.data.data.result.error || '执行失败')
      }
    } else {
      const errorMsg = response.data.error || '执行失败'
      executionResult.value = {
        success: false,
        error: errorMsg,
        executedAt: new Date()
      }
      ElMessage.error(errorMsg)
      emit('execute-error', errorMsg)
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : '执行失败'
    executionResult.value = {
      success: false,
      error: errorMsg,
      executedAt: new Date()
    }
    ElMessage.error(errorMsg)
    emit('execute-error', errorMsg)
  } finally {
    isExecuting.value = false
  }
}

/** Format execution time */
const formatTime = (date: Date | string): string => {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}
</script>

<style scoped>
.script-block {
  margin: 12px 0;
  border-radius: 8px;
  overflow: hidden;
  background: #1e1e1e;
  border: 2px solid #67c23a;
  transition: all 0.3s ease;
}

.script-block.is-executing {
  border-color: #e6a23c;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(230, 162, 60, 0.4);
  }
  50% {
    box-shadow: 0 0 0 8px rgba(230, 162, 60, 0);
  }
}

/* Header */
.script-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #2d2d2d;
  border-bottom: 1px solid #3d3d3d;
}

.script-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.script-language {
  font-size: 12px;
  color: #67c23a;
  font-weight: 500;
}

.script-actions {
  display: flex;
  gap: 8px;
}

/* Content */
.script-content {
  padding: 0;
  overflow-x: auto;
}

.script-content pre {
  margin: 0;
  padding: 16px;
}

.script-content code {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #d4d4d4;
}

/* Execution Result */
.execution-result {
  border-top: 1px solid #3d3d3d;
  background: #252525;
}

.execution-result.success {
  border-top-color: #67c23a;
}

.execution-result.error {
  border-top-color: #f56c6c;
}

.result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: #c0c4cc;
}

.result-time {
  margin-left: auto;
  font-size: 12px;
  color: #909399;
}

.result-content {
  padding: 0 12px 12px;
}

.result-content pre {
  margin: 0;
  padding: 12px;
  background: #1a1a1a;
  border-radius: 4px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
  color: #c0c4cc;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}

/* Confirm Dialog */
.confirm-dialog-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.danger-alert {
  margin-top: 8px;
}

.danger-commands {
  margin: 8px 0 0;
  padding-left: 20px;
}

.danger-commands li {
  font-family: monospace;
  color: #f56c6c;
}

.script-preview {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  overflow: hidden;
}

.preview-header {
  padding: 8px 12px;
  background: #f5f7fa;
  font-size: 13px;
  font-weight: 500;
  color: #606266;
  border-bottom: 1px solid #ebeef5;
}

.script-preview pre {
  margin: 0;
  padding: 12px;
  background: #1e1e1e;
  max-height: 300px;
  overflow: auto;
}

.script-preview code {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #d4d4d4;
}

.confirm-checkbox {
  margin-top: 8px;
}

/* Highlight.js Theme */
:deep(.hljs-keyword) {
  color: #569cd6;
}

:deep(.hljs-string) {
  color: #ce9178;
}

:deep(.hljs-number) {
  color: #b5cea8;
}

:deep(.hljs-comment) {
  color: #6a9955;
}

:deep(.hljs-variable) {
  color: #9cdcfe;
}

:deep(.hljs-attr) {
  color: #9cdcfe;
}

:deep(.hljs-built_in) {
  color: #4ec9b0;
}
</style>
