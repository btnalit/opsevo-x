<template>
  <div ref="messagesContainer" class="messages-container">
    <!-- Empty State -->
    <div v-if="messages.length === 0 && !isLoading" class="empty-state">
      <el-icon :size="64" color="var(--el-text-color-placeholder)"><i-ep-chat-line-square /></el-icon>
      <p>开始与 AI 助手对话</p>
      <p class="empty-hint">
        {{ knowledgeEnhancedMode 
          ? 'AI 助手将结合知识库为您提供更精准的回答' 
          : 'AI 助手可以帮助您配置 RouterOS，生成脚本，解答网络问题' 
        }}
      </p>
      <!-- Quick Actions for Knowledge Enhanced Mode -->
      <div v-if="knowledgeEnhancedMode" class="quick-actions">
        <el-button size="small" @click="$emit('quick-message', '分析最近的告警')">
          分析最近告警
        </el-button>
        <el-button size="small" @click="$emit('quick-message', '查看系统状态')">
          查看系统状态
        </el-button>
        <el-button size="small" @click="$emit('quick-message', '搜索知识库')">
          搜索知识库
        </el-button>
      </div>
    </div>

    <!-- Knowledge Retrieval Status (only in knowledge-enhanced mode) -->
    <div v-if="isRetrieving && knowledgeEnhancedMode" class="retrieval-status">
      <el-icon class="is-loading" :size="16"><i-ep-loading /></el-icon>
      <span>正在检索相关知识...</span>
    </div>

    <!-- Message List -->
    <div
      v-for="(message, index) in messages"
      :key="index"
      :class="['message-item', message.role]"
    >
      <div class="message-avatar">
        <el-icon v-if="message.role === 'user'" :size="20"><i-ep-user /></el-icon>
        <el-icon v-else :size="20"><i-ep-monitor /></el-icon>
      </div>
      <div class="message-content">
        <div class="message-role">
          {{ message.role === 'user' ? '您' : 'AI 助手' }}
          <!-- Confidence Badge for Knowledge Enhanced Mode -->
          <el-tag 
            v-if="message.role === 'assistant' && message.confidence !== undefined" 
            :type="getConfidenceType(message.confidence)"
            size="small"
            class="confidence-badge"
          >
            置信度: {{ (message.confidence * 100).toFixed(0) }}%
          </el-tag>
          <!-- Collection Button for Assistant Messages -->
          <el-tooltip 
            v-if="message.role === 'assistant'"
            :content="message.collected ? '取消收藏' : '收藏此回答'"
            placement="top"
          >
            <el-button
              :icon="message.collected ? StarFilled : Star"
              :type="message.collected ? 'warning' : 'default'"
              size="small"
              circle
              class="collect-btn"
              @click="$emit('toggle-collect', message)"
            />
          </el-tooltip>
          <!-- Collection Status Indicator -->
          <el-tag 
            v-if="message.role === 'assistant' && message.collected" 
            type="warning"
            size="small"
            effect="light"
            class="collected-badge"
          >
            已收藏
          </el-tag>
        </div>
        
        <div
          v-if="message.role === 'assistant'"
          class="message-text markdown-body"
          v-html="renderMarkdown(message.content)"
        ></div>
        <div v-else class="message-text">{{ message.content }}</div>

        <!-- Citations for Knowledge Enhanced Mode -->
        <div v-if="message.citations && message.citations.length > 0" class="citations-section glass-panel">
          <el-collapse>
            <el-collapse-item name="citations">
              <template #title>
                <div class="citations-title">
                  <el-icon><i-ep-collection /></el-icon>
                  <span>知识引用 ({{ message.citations.length }})</span>
                </div>
              </template>
              <div class="citations-list">
                <div 
                  v-for="(citation, citIndex) in message.citations" 
                  :key="citIndex"
                  class="citation-item"
                >
                  <div class="citation-header">
                    <el-tag size="small" type="info">{{ citation.type }}</el-tag>
                    <span class="citation-title">{{ citation.title }}</span>
                    <span class="citation-score">相关度: {{ (citation.score * 100).toFixed(1) }}%</span>
                  </div>
                  <div class="citation-content">{{ citation.content }}</div>
                </div>
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>

        <!-- Tool Calls for Knowledge Enhanced Mode -->
        <div v-if="message.toolCalls && message.toolCalls.length > 0" class="tool-calls-section glass-panel">
          <el-collapse>
            <el-collapse-item name="tools">
              <template #title>
                <div class="tool-calls-title">
                  <el-icon><i-ep-operation /></el-icon>
                  <span>工具调用 ({{ message.toolCalls.length }})</span>
                </div>
              </template>
              <div class="tool-calls-list">
                <div 
                  v-for="(call, callIndex) in message.toolCalls" 
                  :key="callIndex"
                  class="tool-call-item"
                >
                  <div class="tool-call-header">
                    <el-tag size="small" type="primary">{{ call.tool }}</el-tag>
                    <span class="tool-duration">{{ call.duration }}ms</span>
                  </div>
                  <div class="tool-call-detail">
                    <div class="tool-input">
                      <span class="label">输入:</span>
                      <pre>{{ JSON.stringify(call.input, null, 2) }}</pre>
                    </div>
                    <div class="tool-output">
                      <span class="label">输出:</span>
                      <pre>{{ formatToolOutput(call.output) }}</pre>
                    </div>
                  </div>
                </div>
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>

        <!-- Reasoning for Knowledge Enhanced Mode -->
        <div v-if="message.reasoning && message.reasoning.length > 0" class="reasoning-section glass-panel">
          <el-collapse>
            <el-collapse-item name="reasoning">
              <template #title>
                <div class="reasoning-title">
                  <el-icon><i-ep-data-analysis /></el-icon>
                  <span>推理过程</span>
                </div>
              </template>
              <ol class="reasoning-list">
                <li v-for="(step, stepIndex) in message.reasoning" :key="stepIndex">
                  {{ step }}
                </li>
              </ol>
            </el-collapse-item>
          </el-collapse>
        </div>

        <!-- ReAct Steps for Knowledge Enhanced Mode -->
        <div v-if="message.reactSteps && message.reactSteps.length > 0" class="react-steps-section glass-panel">
          <el-collapse>
            <el-collapse-item name="react-steps">
              <template #title>
                <div class="react-steps-title">
                  <el-icon><i-ep-data-analysis /></el-icon>
                  <span>ReAct 推理过程 ({{ message.reactSteps.length }})</span>
                </div>
              </template>
              <div class="react-steps-list">
                <div 
                  v-for="(step, stepIndex) in message.reactSteps" 
                  :key="stepIndex"
                  :class="['react-step-item', `react-step-${step.type}`]"
                >
                  <div class="react-step-header">
                    <el-tag 
                      :type="getReactStepTagType(step.type)" 
                      size="small"
                      effect="dark"
                    >
                      {{ getReactStepLabel(step.type) }}
                    </el-tag>
                    <span v-if="step.duration" class="react-step-duration">
                      {{ step.duration }}ms
                    </span>
                    <el-tag 
                      v-if="step.type === 'observation' && step.success !== undefined"
                      :type="step.success ? 'success' : 'danger'"
                      size="small"
                    >
                      {{ step.success ? '成功' : '失败' }}
                    </el-tag>
                  </div>
                  <div class="react-step-content">
                    {{ step.content }}
                  </div>
                  <div v-if="step.type === 'action' && step.toolName" class="react-step-tool">
                    <div class="tool-name">
                      <span class="label">工具:</span>
                      <el-tag size="small" type="primary">{{ step.toolName }}</el-tag>
                    </div>
                    <div v-if="step.toolInput" class="tool-input">
                      <span class="label">参数:</span>
                      <pre>{{ JSON.stringify(step.toolInput, null, 2) }}</pre>
                    </div>
                  </div>
                  <div v-if="step.type === 'observation' && step.toolOutput" class="react-step-output">
                    <span class="label">输出:</span>
                    <pre>{{ formatToolOutput(step.toolOutput) }}</pre>
                  </div>
                </div>
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </div>
    </div>

    <!-- Streaming Response -->
    <div v-if="isLoading && streamingContent" class="message-item assistant">
      <div class="message-avatar">
        <el-icon :size="20"><i-ep-monitor /></el-icon>
      </div>
      <div class="message-content">
        <div class="message-role">AI 助手</div>
        <div class="message-text markdown-body" v-html="renderMarkdown(streamingContent)"></div>
        <span class="typing-cursor"></span>
      </div>
    </div>

    <!-- Loading Indicator -->
    <div v-if="isLoading && !streamingContent" class="loading-indicator">
      <el-icon class="is-loading" :size="20"><i-ep-loading /></el-icon>
      <span>{{ knowledgeEnhancedMode ? 'AI 正在结合知识库思考...' : 'AI 正在思考...' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, watch } from 'vue'
import { StarFilled, Star } from '@element-plus/icons-vue'
import mermaid from 'mermaid'

// Initialize mermaid with default config
mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  securityLevel: 'loose', // Needed because we already DOMPurify the input
})

const props = defineProps<{
  messages: any[]
  isLoading: boolean
  streamingContent: string
  knowledgeEnhancedMode: boolean
  isRetrieving: boolean
  renderMarkdown: (content: string) => string
}>()

const emit = defineEmits<{
  (e: 'quick-message', message: string): void
  (e: 'toggle-collect', message: any): void
  (e: 'setup-code-delegation', containerDom: HTMLElement): void
}>()

const messagesContainer = ref<HTMLElement | null>(null)

// Expose scroll to bottom for parent component
const scrollToBottom = () => {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// Watch messages and run mermaid
watch(
  () => props.messages,
  async () => {
    await nextTick()
    try {
      if (messagesContainer.value) {
        // Find all unprocessed mermaid divs and run mermaid on them
        const mermaidNodes = messagesContainer.value.querySelectorAll('.mermaid:not([data-processed="true"])')
        if (mermaidNodes.length > 0) {
          await mermaid.run({
            nodes: Array.from(mermaidNodes) as HTMLElement[]
          })
        }
      }
    } catch (err) {
      console.error('Failed to render mermaid diagram:', err)
    }
  },
  { deep: true }
)

defineExpose({
  scrollToBottom
})

onMounted(() => {
  if (messagesContainer.value) {
    emit('setup-code-delegation', messagesContainer.value)
  }
})

// Get confidence type for tag color
const getConfidenceType = (confidence: number): 'success' | 'warning' | 'danger' => {
  if (confidence >= 0.8) return 'success'
  if (confidence >= 0.5) return 'warning'
  return 'danger'
}

// Format tool output
const formatToolOutput = (output: unknown): string => {
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

// Get ReAct step tag type for display
const getReactStepTagType = (stepType: string): 'info' | 'primary' | 'success' | 'warning' => {
  switch (stepType) {
    case 'thought':
      return 'info'
    case 'action':
      return 'primary'
    case 'observation':
      return 'success'
    case 'final_answer':
      return 'warning'
    default:
      return 'info'
  }
}

// Get ReAct step label for display
const getReactStepLabel = (stepType: string): string => {
  switch (stepType) {
    case 'thought':
      return '💭 思考'
    case 'action':
      return '⚡ 行动'
    case 'observation':
      return '👁️ 观察'
    case 'final_answer':
      return '✅ 最终答案'
    default:
      return stepType
  }
}
</script>

<style scoped>
/* Messages Container */
.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  background: var(--el-bg-color);
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--el-text-color-regular);
}

.empty-state p {
  margin: 12px 0 8px;
  font-size: 16px;
  font-weight: 500;
}

.empty-hint {
  font-size: 14px !important;
  color: var(--el-text-color-secondary) !important;
  font-weight: normal !important;
}

.quick-actions {
  display: flex;
  gap: 12px;
  margin-top: 24px;
  flex-wrap: wrap;
  justify-content: center;
}

/* Retrieval Status */
.retrieval-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px 20px;
  background: var(--el-color-warning-light-9);
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: var(--el-border-radius-base);
  margin-bottom: 24px;
  color: var(--el-color-warning);
  font-size: 14px;
  max-width: fit-content;
  margin-left: auto;
  margin-right: auto;
}

/* Message Item */
.message-item {
  display: flex;
  gap: 16px;
  margin-bottom: 28px;
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message-item.user {
  flex-direction: row-reverse;
}

.message-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: var(--el-box-shadow-light);
}

.message-item.user .message-avatar {
  background: var(--el-color-primary);
  color: var(--el-color-white);
  box-shadow: 0 0 10px var(--el-color-primary-light-5);
}

.message-item.assistant .message-avatar {
  background: var(--el-color-success);
  color: var(--el-color-white);
  box-shadow: 0 0 10px var(--el-color-success-light-5);
}

.message-content {
  max-width: 85%;
  min-width: 100px;
}

.message-role {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.message-item.user .message-role {
  text-align: right;
  justify-content: flex-end;
}

.confidence-badge {
  font-size: 11px;
}

.collect-btn {
  margin-left: 4px;
  padding: 4px;
  font-size: 13px;
  opacity: 0.8;
  transition: opacity 0.2s, transform 0.2s;
}

.collect-btn:hover {
  opacity: 1;
  transform: scale(1.1);
}

.collected-badge {
  margin-left: 4px;
  font-size: 11px;
}

.message-text {
  padding: 14px 18px;
  border-radius: 12px;
  line-height: 1.6;
  word-break: break-word;
  font-size: 15px;
}

.message-item.user .message-text {
  background: var(--el-color-primary);
  color: var(--el-color-white);
  border-top-right-radius: 4px;
  box-shadow: 0 4px 12px var(--el-color-primary-light-7);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.message-item.assistant .message-text {
  background: #1e2530; /* Darker than the chat container to pop */
  color: var(--el-text-color-primary);
  border-top-left-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  border: 1.5px solid var(--el-border-color-light);
  backdrop-filter: blur(12px);
}

/* Citations Section */
.citations-section, .tool-calls-section, .reasoning-section, .react-steps-section {
  margin-top: 16px;
  background: var(--el-fill-color-light);
  border-radius: var(--el-border-radius-base);
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
}

.citations-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--el-color-success);
  font-weight: 500;
}

.citations-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}

.citation-item {
  background: var(--el-bg-color-overlay);
  border-radius: var(--el-border-radius-base);
  padding: 12px;
  border-left: 3px solid var(--el-color-success);
  box-shadow: var(--el-box-shadow-light);
}

.citation-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.citation-title {
  font-weight: 500;
  color: var(--el-text-color-primary);
  flex: 1;
  font-size: 14px;
}

.citation-score {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.citation-content {
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
  max-height: 120px;
  overflow-y: auto;
  padding-right: 8px;
}

/* Tool Calls Section */
.tool-calls-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--el-color-primary);
  font-weight: 500;
}

.tool-calls-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}

.tool-call-item {
  background: var(--el-bg-color-overlay);
  border-radius: var(--el-border-radius-base);
  padding: 12px;
  border-left: 3px solid var(--el-color-primary);
  box-shadow: var(--el-box-shadow-light);
}

.tool-call-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.tool-duration {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.tool-call-detail {
  font-size: 13px;
}

.tool-input, .tool-output {
  margin-top: 8px;
}

.tool-input .label, .tool-output .label {
  font-weight: 500;
  color: var(--el-text-color-regular);
  display: inline-block;
  margin-bottom: 6px;
}

.tool-input pre, .tool-output pre {
  background: var(--el-fill-color);
  padding: 10px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-wrap: break-word;
  color: var(--el-text-color-primary);
  border: 1px solid var(--el-border-color-lighter);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  max-height: 200px;
  overflow-y: auto;
}

/* Reasoning Section */
.reasoning-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--el-color-warning);
  font-weight: 500;
}

.reasoning-list {
  margin: 12px 0 0 24px;
  padding: 0;
  color: var(--el-text-color-regular);
  font-size: 14px;
  line-height: 1.6;
}

.reasoning-list li {
  margin-bottom: 6px;
}

/* ReAct Steps Section */
.react-steps-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--el-color-info);
  font-weight: 500;
}

.react-steps-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.react-step-item {
  background: var(--el-bg-color-overlay);
  border-radius: var(--el-border-radius-base);
  padding: 12px;
  box-shadow: var(--el-box-shadow-light);
  border-left: 3px solid;
}

.react-step-thought { border-left-color: var(--el-color-info); }
.react-step-action { border-left-color: var(--el-color-primary); }
.react-step-observation { border-left-color: var(--el-color-success); }
.react-step-final_answer { border-left-color: var(--el-color-warning); }

.react-step-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.react-step-duration {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.react-step-content {
  font-size: 14px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
  white-space: pre-wrap;
}

.react-step-tool, .react-step-output {
  margin-top: 12px;
  background: var(--el-fill-color-light);
  padding: 10px;
  border-radius: 4px;
  border: 1px solid var(--el-border-color-lighter);
}

.tool-name, .react-step-output .label {
  font-weight: 500;
  font-size: 13px;
  margin-bottom: 8px;
  color: var(--el-text-color-primary);
  display: block;
}

.react-step-tool pre, .react-step-output pre {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--el-text-color-regular);
  max-height: 200px;
  overflow-y: auto;
}

/* Loading Indicator */
.loading-indicator {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.loading-indicator .is-loading {
  color: var(--el-color-primary);
}

.typing-cursor {
  display: inline-block;
  width: 6px;
  height: 18px;
  background-color: var(--el-color-primary);
  animation: blink 1s step-end infinite;
  vertical-align: text-bottom;
  margin-left: 4px;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

:deep(.el-collapse-item__header) {
  height: auto;
  line-height: normal;
  padding: 10px 0;
  background-color: transparent;
  border-bottom: none;
}

:deep(.el-collapse-item__wrap) {
  background-color: transparent;
  border-bottom: none;
}

:deep(.el-collapse-item__content) {
  padding-bottom: 10px;
}
</style>
