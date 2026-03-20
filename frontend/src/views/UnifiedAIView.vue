<template>
  <div class="unified-ai-view">
    <!-- Session Sidebar -->
    <SessionSidebar
      ref="sessionSidebar"
      :active-session-id="currentSession?.id"
      v-model:collapsed="sidebarCollapsed"
      @select="handleSelectSession"
      @new-session="handleNewSessionFromSidebar"
      @delete="handleSessionDeleted"
      @clear-all="handleAllSessionsCleared"
    />

    <!-- Collected Messages Button (in header) -->
    <!-- 收藏面板改为抽屉形式，通过按钮触发 -->

    <!-- Chat Container -->
    <div class="chat-container">
      <!-- Chat Header -->
      <ChatHeader
        :current-config="currentConfig"
        v-model:knowledgeEnhancedMode="knowledgeEnhancedMode"
        v-model:includeContext="includeContext"
        v-model:selectedConfigId="selectedConfigId"
        :configs="configs"
        :has-messages="messages.length > 0"
        :collected-messages-count="collectedMessages.length"
        :has-current-session="!!currentSession?.id"
        @open-collected="openCollectedDrawer"
        @clear-messages="handleClearMessages"
        @config-change="handleConfigChange"
      />

      <!-- Messages Area -->
      <MessageList
        ref="messageListRef"
        :messages="messages"
        :is-loading="isLoading"
        :streaming-content="streamingContent"
        :knowledge-enhanced-mode="knowledgeEnhancedMode"
        :is-retrieving="isRetrieving"
        :render-markdown="renderMarkdown"
        @quick-message="sendQuickMessage"
        @toggle-collect="handleToggleCollect"
        @setup-code-delegation="setupCodeBlockEventDelegation"
      />

      <!-- Error Alert -->
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        show-icon
        closable
        class="error-alert"
        @close="error = ''"
      >
        <template #default>
          <el-button type="primary" size="small" @click="handleRetry">
            重试
          </el-button>
        </template>
      </el-alert>

      <!-- Input Area -->
      <ChatInput
        v-model="inputMessage"
        :placeholder="inputPlaceholder"
        :disabled="isLoading || !selectedConfigId"
        :has-config="!!selectedConfigId"
        :is-loading="isLoading"
        @send="handleSend"
        @stop-generation="handleStopGeneration"
      />
    </div>

    <!-- Convert to Knowledge Dialog -->
    <ConvertToKnowledgeDialog
      v-model="convertDialogVisible"
      :qa-pair="convertingQAPair"
      @converted="handleConversionCompleted"
    />

    <!-- Collected Messages Drawer -->
    <el-drawer
      v-model="collectedDrawerVisible"
      title="已收藏的消息"
      direction="rtl"
      size="400px"
    >
      <template #header>
        <div class="drawer-header">
          <span>已收藏的消息</span>
          <el-badge :value="collectedMessages.length" type="warning" />
        </div>
      </template>
      
      <!-- Loading State -->
      <div v-if="loadingCollected" class="collected-loading">
        <el-icon class="is-loading"><i-ep-loading /></el-icon>
        <span>加载中...</span>
      </div>
      
      <!-- Empty State -->
      <div v-else-if="collectedMessages.length === 0" class="collected-empty">
        <el-icon :size="48" color="#c0c4cc"><i-ep-star /></el-icon>
        <p>暂无收藏的消息</p>
        <p class="collected-hint">点击消息旁的星标按钮收藏</p>
      </div>
      
      <!-- Collected Messages List -->
      <div v-else class="collected-drawer-content">
        <!-- Batch Actions -->
        <div class="collected-batch-actions">
          <el-checkbox 
            v-model="selectAllCollected" 
            :indeterminate="isIndeterminate"
            @change="handleSelectAllCollected"
          >
            全选
          </el-checkbox>
          <el-button 
            v-if="selectedCollectedIds.length > 0"
            type="primary" 
            size="small"
            @click="handleBatchConvert"
          >
            批量转换 ({{ selectedCollectedIds.length }})
          </el-button>
        </div>
        
        <!-- Collected Items -->
        <el-checkbox-group v-model="selectedCollectedIds">
          <div 
            v-for="item in collectedMessages" 
            :key="item.id"
            class="collected-item"
          >
            <el-checkbox 
              :value="item.id"
              class="collected-checkbox"
            />
            <div class="collected-item-content">
              <div class="collected-question">
                <el-icon><i-ep-user /></el-icon>
                <span>{{ truncateText(item.question.content, 60) }}</span>
              </div>
              <div class="collected-answer">
                <el-icon><i-ep-monitor /></el-icon>
                <span>{{ truncateText(item.answer.content, 100) }}</span>
              </div>
              <div class="collected-meta">
                <span>{{ formatCollectedTime(item.collectedAt) }}</span>
              </div>
            </div>
            <div class="collected-item-actions">
              <el-tooltip content="转换为知识" placement="top">
                <el-button 
                  :icon="Collection" 
                  size="small" 
                  circle
                  @click="handleConvertSingle(item)"
                />
              </el-tooltip>
              <el-tooltip content="取消收藏" placement="top">
                <el-button 
                  :icon="Delete" 
                  size="small" 
                  circle
                  type="danger"
                  @click="handleUncollectFromPanel(item)"
                />
              </el-tooltip>
            </div>
          </div>
        </el-checkbox-group>
      </div>
      
      <!-- Footer -->
      <template #footer>
        <div v-if="collectedMessages.length > 0" class="drawer-footer">
          <el-button 
            type="info" 
            :icon="Download"
            @click="handleExportCollected"
          >
            导出为 Markdown
          </el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { Collection, Delete, Download } from '@element-plus/icons-vue'

import { ref, computed, onMounted, onActivated, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, ElLoading } from 'element-plus'
import { useDeviceStore } from '@/stores/device'
import { useAuthStore } from '@/stores/auth'

// 定义组件名称，用于 keep-alive
defineOptions({
  name: 'UnifiedAIView'
})

// Simple ID generator for messages
const generateMessageId = (): string => {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}
import {
  configApi,
  sessionApi,
  unifiedAgentApi,
  type APIConfigDisplay,
  type ChatSession,
  type CollectedQAPair,
  type ScriptExecuteResult,
  type UnifiedChatMessage,
  type UnifiedChatSession,
  type AgentToolCall,
  type RAGCitation,
  type ReActStep
} from '@/api/ai'
import { aiOpsApi } from '@/api/ai-ops'
import SessionSidebar from '@/components/SessionSidebar.vue'
import ConvertToKnowledgeDialog from '@/components/ConvertToKnowledgeDialog.vue'
import ChatInput from './ai/components/ChatInput.vue'
import MessageList from './ai/components/MessageList.vue'
import ChatHeader from './ai/components/ChatHeader.vue'
import { handleError, isUserCancelled, getErrorMessage } from '@/utils/errorHandler'

// ==================== 类型定义 ====================



import { renderMarkdown } from '@/utils/markdown'

// ==================== 状态 ====================

const configs = ref<APIConfigDisplay[]>([])
const selectedConfigId = ref<string>('')
const currentSession = ref<UnifiedChatSession | null>(null)
const messages = ref<UnifiedChatMessage[]>([])
const inputMessage = ref('')
const error = ref('')
const includeContext = ref(true)
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)
const lastMessage = ref('')
const sidebarCollapsed = ref(false)
const sessionSidebar = ref<InstanceType<typeof SessionSidebar> | null>(null)

// Collected messages panel state
const collectedDrawerVisible = ref(false)
const collectedMessages = ref<CollectedQAPair[]>([])
const loadingCollected = ref(false)
const selectedCollectedIds = ref<string[]>([])
const selectAllCollected = ref(false)

// Convert to knowledge dialog state
const convertDialogVisible = ref(false)
const convertingQAPair = ref<CollectedQAPair | null>(null)

// 知识检索状态 (部分从 useChat 引入)
const retrievedKnowledge = ref<RAGCitation[]>([])

import { useChat } from '@/composables/useChat'

const {
  sessionStreamStates,
  streamStateVersion,
  knowledgeEnhancedMode,
  isRetrieving,
  getIsLoading,
  getStreamingContent,
  setLoading: _setLoading,
  setStreamingContent: _setStreamingContent,
  setLoadingForSession,
  setStreamingContentForSession,
  getAbortController: _getAbortController,
  setAbortController: _setAbortController,
  setAbortControllerForSession,
  saveMessagesToCache: _saveMessagesToCache,
  addMessageToSession: _addMessageToSession
} = useChat()

// 包装 computed 和方法
const isLoading = computed(() => getIsLoading(currentSession.value?.id).value)
const streamingContent = computed(() => getStreamingContent(currentSession.value?.id).value)

const setLoading = (value: boolean) => _setLoading(currentSession.value?.id, value)
const setStreamingContent = (value: string) => _setStreamingContent(currentSession.value?.id, value)
const getAbortController = () => _getAbortController(currentSession.value?.id)
const setAbortController = (controller: AbortController | null) => _setAbortController(currentSession.value?.id, controller)

const saveMessagesToCache = (sessionId: string) => {
  _saveMessagesToCache(sessionId, messages.value)
}

const addMessageToSession = (sessionId: string, message: UnifiedChatMessage) => {
  _addMessageToSession(sessionId, message, currentSession.value?.id, messages)
}

// ==================== 计算属性 ====================

const currentConfig = computed(() => {
  return configs.value.find(c => c.id === selectedConfigId.value) || null
})

const inputPlaceholder = computed(() => {
  if (knowledgeEnhancedMode.value) {
    return '杈撳叆鎮ㄧ殑闂锛孉I 灏嗙粨鍚堢煡璇嗗簱涓烘偍瑙ｇ瓟...'
  }
  return '输入您的问题，按 Enter 发送，Shift+Enter 换行...'
})

// Computed property for indeterminate checkbox state
const isIndeterminate = computed(() => {
  const selectedCount = selectedCollectedIds.value.length
  return selectedCount > 0 && selectedCount < collectedMessages.value.length
})

// ==================== 生命周期 ====================

// 路由实例
const route = useRoute()
const router = useRouter()
const deviceStore = useDeviceStore()
const authStore = useAuthStore()
const currentDeviceId = computed(() => deviceStore.currentDeviceId)

onMounted(async () => {
  // 先加载配置，让页面快速显示
  await loadConfigs()
  
  // 处理 URL 参数（来自告警页面的深入分析跳转）
  await handleUrlParams()

  // 监听自主意图生成的 SSE 流
  setupIntentListener()
})

// ==================== 智能进化: 自主意图监听 ====================
let intentEventSource: AbortController | null = null

const setupIntentListener = () => {
  try {
    intentEventSource = aiOpsApi.intents.streamAutonomousIntents((event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'intent' && data.data) {
          handleAutonomousIntent(data.data)
        }
      } catch (err) {
        console.error('Failed to parse intent event:', err)
      }
    }, (error: Event) => {
      console.error('Intent stream error:', error)
      // SSE 会自动重连，无需特殊处理，但可以考虑断线一段时间后的处理
    })
  } catch (err) {
    console.error('Failed to setup intent listener:', err)
  }
}

const handleAutonomousIntent = (intentData: any) => {
  // 1. 如果当前没有选中任何配置，尝试选一个默认的
  if (!selectedConfigId.value && configs.value.length > 0) {
    const defaultConfig = configs.value.find(c => c.isDefault)
    selectedConfigId.value = defaultConfig?.id || configs.value[0].id
  }

  // 2. 如果没有当前会话，创建一个新的
  if (!currentSession.value && selectedConfigId.value) {
    // 将状态设为知识增强模式，因为通常诊断需要知识库和工具
    knowledgeEnhancedMode.value = true
    
    // 异步创建会话并发送消息
    sessionApi.create({
      configId: selectedConfigId.value,
      mode: 'knowledge-enhanced'
    }).then(sessionResponse => {
      if (sessionResponse.data.success && sessionResponse.data.data) {
        currentSession.value = {
          ...sessionResponse.data.data,
          mode: 'knowledge-enhanced'
        }
        sessionSidebar.value?.addSession(sessionResponse.data.data)
        
        // 创建系统主动发起的提问卡片 (模拟系统 Prompt)
        pushIntentMessage(intentData)
      }
    }).catch(err => {
      console.error('Failed to create session for intent:', err)
      ElMessage.error('无法为自主意图创建会话')
    })
  } else if (currentSession.value) {
    // 已经有会话，直接推送消息
    pushIntentMessage(intentData)
  }
}

const pushIntentMessage = (intentData: any) => {
  // 构造系统主动弹出的消息
  const systemMessage = `🤖 **系统主动诊断提醒**\n\n${intentData.originalText}\n\n*系统已为您准备好初步排查方案，请问是否现在开始执行？*`

  const aiMessage: UnifiedChatMessage = {
    id: generateMessageId(),
    role: 'assistant', // 使用 assistant 角色展示气泡
    content: systemMessage,
    timestamp: new Date()
  }
  
  // 将消息推送到当前会话
  const sessionId = currentSession.value?.id || '__new__'
  addMessageToSession(sessionId, aiMessage)
  
  // 提示用户有新消息
  ElMessage({
    message: '收到系统主动诊断提醒',
    type: 'warning',
    duration: 5000
  })
}

// 在组件卸载前清理 SSE 连接
import { onBeforeUnmount } from 'vue'
onBeforeUnmount(() => {
  if (intentEventSource) {
    intentEventSource.abort()
    intentEventSource = null
  }
})

// 处理 URL 参数（来自告警页面的深入分析跳转）
const handleUrlParams = async () => {
  const { message, mode } = route.query
  
  // 如果没有消息参数，直接返回
  if (!message || typeof message !== 'string') {
    return
  }
  
  try {
    // 解码消息
    const decodedMessage = decodeURIComponent(message)
    
    // 设置知识增强模式
    if (mode === 'knowledge-enhanced') {
      knowledgeEnhancedMode.value = true
    }
    
    // 确保配置已加载
    if (configs.value.length === 0) {
      await loadConfigs()
    }
    
    // 确保有配置可用
    if (!selectedConfigId.value && configs.value.length > 0) {
      const defaultConfig = configs.value.find(c => c.isDefault)
      selectedConfigId.value = defaultConfig?.id || configs.value[0].id
    }
    
    // 设置输入消息并发送
    if (selectedConfigId.value) {
      inputMessage.value = decodedMessage
      
      // 清除 URL 参数，避免重复发送
      router.replace({
        path: route.path,
        query: {}
      })
      
      // 等待 DOM 更新后发送消息
      await nextTick()
      handleSend()
    }
  } catch (err) {
    console.error('处理 URL 参数失败:', err)
  }
}

// 当组件被 keep-alive 激活时，强制刷新流式状态显示
onActivated(async () => {
  // 触发响应式更新，确保显示当前会话的流式状态
  streamStateVersion.value++
  // 如果当前会话正在加载，滚动到底部
  if (isLoading.value) {
    scrollToBottom()
  }
  
  // 处理 URL 参数（来自告警页面的深入分析跳转）
  // 在 keep-alive 激活时也需要检查，因为 onMounted 只在首次挂载时执行
  await handleUrlParams()
})

// Watch for messages changes to scroll to bottom (Using length to avoid deep observer penalty)
watch(() => messages.value.length, () => {
  scrollToBottom()
})

watch(streamingContent, () => {
  scrollToBottom()
})

// ==================== 方法 ====================

// Load API configurations
const loadConfigs = async () => {


  try {
    const response = await configApi.getAll()
    const result = response.data
    if (result.success && Array.isArray(result.data)) {
      configs.value = result.data
      // Auto-select default config
      const defaultConfig = configs.value.find(c => c.isDefault)
      if (defaultConfig) {
        selectedConfigId.value = defaultConfig.id
      } else if (configs.value.length > 0) {
        selectedConfigId.value = configs.value[0].id
      }
    }
  } catch (err: unknown) {
    console.error('加载配置失败:', err)
    handleError(err, '加载 AI 配置失败')
  }
}



// Handle config change
const handleConfigChange = () => {
  // Optionally clear messages when switching providers
}

// Send quick message (for knowledge enhanced mode)
const sendQuickMessage = (message: string) => {
  inputMessage.value = message
  handleSend()
}

// Send message
const handleSend = async () => {
  const message = inputMessage.value.trim()
  if (!message || !selectedConfigId.value || isLoading.value) return

  // Add user message
  const userMessage: UnifiedChatMessage = {
    id: generateMessageId(),
    role: 'user',
    content: message,
    timestamp: new Date()
  }
  messages.value.push(userMessage)
  
  lastMessage.value = message
  inputMessage.value = ''
  error.value = ''
  setLoading(true)
  setStreamingContent('')
  
  // 保存当前消息到缓存（用于切换会话时恢复）
  const sessionId = currentSession.value?.id || '__new__'
  saveMessagesToCache(sessionId)

  try {
    // Create session if not exists
    if (!currentSession.value) {
      const sessionMode = knowledgeEnhancedMode.value ? 'knowledge-enhanced' : 'standard'
      const sessionResponse = await sessionApi.create({
        configId: selectedConfigId.value,
        mode: sessionMode
      })
      if (sessionResponse.data.success && sessionResponse.data.data) {
        currentSession.value = {
          ...sessionResponse.data.data,
          mode: sessionMode
        }
        // Update sidebar with new session
        sessionSidebar.value?.addSession(sessionResponse.data.data)
        
        // 更新缓存的会话 ID（从 __new__ 变为实际 ID）
        const newSessionId = sessionResponse.data.data.id
        const oldState = sessionStreamStates.get('__new__')
        if (oldState) {
          sessionStreamStates.set(newSessionId, {
            ...oldState,
            cachedMessages: [...messages.value]
          })
          sessionStreamStates.delete('__new__')
        }
      }
    }

    // Send streaming request based on mode
    if (knowledgeEnhancedMode.value) {
      await sendKnowledgeEnhancedMessage(message)
    } else {
      await sendStandardMessage(message)
    }
  } catch (err: unknown) {
    error.value = getErrorMessage(err, '发送消息失败')
    setLoading(false)
    setStreamingContent('')
  }
}

// Send standard mode message (streaming)
const sendStandardMessage = async (message: string) => {
  // 捕获当前会话 ID，避免切换会话时状态混乱
  const sessionId = currentSession.value?.id || '__new__'
  
  const controller = new AbortController()
  setAbortControllerForSession(sessionId, controller)

  try {
    const response = await fetch(`/api/ai/unified/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authStore.token}`
      },
      body: JSON.stringify({
        configId: selectedConfigId.value,
        sessionId: currentSession.value?.id,
        message,
        includeContext: includeContext.value
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: '请求失败' }))
      throw new Error(errorData.error || `HTTP ${response.status}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('无法读取响应流')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // 解析 SSE 数据
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

        for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue

          try {
            const chunk = JSON.parse(jsonStr)

            if (chunk.error) {
              throw new Error(chunk.error)
            }

            // 支持两种格式：
            // 1. 新格式: { type: 'done' }
            // 2. 旧格式: { done: true, fullContent: ... }
            if (chunk.type === 'done' || chunk.done) {
              // Add assistant message to the correct session
              const finalContent = chunk.fullContent || fullContent
              
              const assistantMessage: UnifiedChatMessage = {
                id: chunk.messageId || generateMessageId(),
                role: 'assistant',
                content: finalContent,
                timestamp: new Date()
              }
              addMessageToSession(sessionId, assistantMessage)
              
              setStreamingContentForSession(sessionId, '')
              setLoadingForSession(sessionId, false)
              setAbortControllerForSession(sessionId, null)
              
              // Setup code block event listeners after render
              nextTick(() => {
                setupCodeBlockListeners()
              })
            } else if (chunk.type === 'content' || chunk.content) {
              fullContent += chunk.content
              setStreamingContentForSession(sessionId, fullContent)
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name !== 'AbortError') {
      throw err
    }
  }
}

// Send knowledge enhanced mode message (streaming)
const sendKnowledgeEnhancedMessage = async (message: string) => {
  // 捕获当前会话 ID，避免切换会话时状态混乱
  const sessionId = currentSession.value?.id || '__new__'
  
  const controller = new AbortController()
  setAbortControllerForSession(sessionId, controller)
  isRetrieving.value = true

  const citations: RAGCitation[] = []
  const toolCalls: AgentToolCall[] = []
  const reasoning: string[] = []
  const reactSteps: ReActStep[] = []
  let confidence = 0.5

  try {
    const response = await fetch(`/api/ai/unified/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authStore.token}`
      },
      body: JSON.stringify({
        configId: selectedConfigId.value,
        sessionId: currentSession.value?.id,
        message,
        mode: 'knowledge-enhanced',
        includeContext: includeContext.value,
        ragOptions: {
          topK: 5,
          minScore: 0.3,
          includeTools: true
        }
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: '请求失败' }))
      throw new Error(errorData.error || `HTTP ${response.status}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('无法读取响应流')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // 解析 SSE 数据
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue

          try {
            const chunk = JSON.parse(jsonStr)

            if (chunk.error) {
              throw new Error(chunk.error)
            }

            switch (chunk.type) {
              case 'start':
                // 收到开始事件，更新状态显示
                isRetrieving.value = true
                break
              case 'content':
                fullContent += chunk.content || ''
                setStreamingContentForSession(sessionId, fullContent)
                isRetrieving.value = false
                break
              case 'citation':
                if (chunk.citation) {
                  citations.push(chunk.citation)
                  retrievedKnowledge.value = [...citations]
                }
                break
              case 'tool_call':
                if (chunk.toolCall) {
                  toolCalls.push(chunk.toolCall)
                }
                break
              case 'reasoning':
                if (chunk.reasoning) {
                  reasoning.push(chunk.reasoning)
                }
                break
              // Requirements: 6.1, 6.2 - 处理 ReAct 步骤事件
              case 'react_step':
                // 收到 react_step 事件，说明正在处理中
                isRetrieving.value = false
                if (chunk.data) {
                  // 从 react_step 事件中构建 ReActStep
                  const step: ReActStep = {
                    type: chunk.data.stepType,
                    content: chunk.data.content,
                    timestamp: Date.now(),
                    toolName: chunk.data.toolName,
                    toolInput: chunk.data.toolInput,
                    toolOutput: chunk.data.toolOutput,
                    duration: chunk.data.duration
                  }
                  reactSteps.push(step)
                }
                break
              case 'done':
                // Requirements: 6.1 - 从完成事件中获取 reactSteps
                const doneReactSteps = chunk.data?.reactSteps || chunk.reactSteps || reactSteps
                // 使用后端返回的消息 ID（如果有），否则生成一个
                const backendMessageId = chunk.messageId || chunk.data?.messageId
                // Add assistant message with all metadata including reactSteps
                const assistantMsg: UnifiedChatMessage = {
                  id: backendMessageId || generateMessageId(),
                  role: 'assistant',
                  content: fullContent,
                  timestamp: new Date(),
                  citations: citations.length > 0 ? citations : undefined,
                  toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                  reasoning: reasoning.length > 0 ? reasoning : undefined,
                  reactSteps: doneReactSteps.length > 0 ? doneReactSteps : undefined,
                  confidence: chunk.confidence !== undefined
                    ? chunk.confidence
                    : (citations.length > 0 
                      ? citations.reduce((sum, c) => sum + c.score, 0) / citations.length 
                      : confidence)
                }
                addMessageToSession(sessionId, assistantMsg)
                
                setStreamingContentForSession(sessionId, '')
                setLoadingForSession(sessionId, false)
                setAbortControllerForSession(sessionId, null)
                isRetrieving.value = false
                
                nextTick(() => {
                  setupCodeBlockListeners()
                })
                break
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    }
  } catch (err: unknown) {
    isRetrieving.value = false
    if (err instanceof Error && err.name !== 'AbortError') {
      throw err
    }
  }
}

// Stop generation
const handleStopGeneration = () => {
  const controller = getAbortController()
  if (controller) {
    controller.abort()
    setAbortController(null)
  }
  
  // Save partial content if any
  if (streamingContent.value) {
    messages.value.push({
      id: generateMessageId(),
      role: 'assistant',
      content: streamingContent.value + '\n\n[生成已停止]',
      timestamp: new Date()
    })
  }
  
  setStreamingContent('')
  setLoading(false)
  isRetrieving.value = false
}

// Retry last message
const handleRetry = () => {
  if (lastMessage.value) {
    // Remove the last user message if it exists
    if (messages.value.length > 0 && messages.value[messages.value.length - 1].role === 'user') {
      messages.value.pop()
    }
    inputMessage.value = lastMessage.value
    error.value = ''
    handleSend()
  }
}

// Toggle message collection status
const handleToggleCollect = async (message: UnifiedChatMessage) => {
  // 如果没有消息 ID，生成一个
  if (!message.id) {
    message.id = generateMessageId()
  }

  // 如果没有会话，先创建会话
  if (!currentSession.value?.id) {
    try {
      const sessionMode = knowledgeEnhancedMode.value ? 'knowledge-enhanced' : 'standard'
      const sessionResponse = await sessionApi.create({
        configId: selectedConfigId.value,
        mode: sessionMode
      })
      if (sessionResponse.data.success && sessionResponse.data.data) {
        currentSession.value = {
          ...sessionResponse.data.data,
          mode: sessionMode
        }
        sessionSidebar.value?.addSession(sessionResponse.data.data)
      } else {
        ElMessage.warning('无法收藏：创建会话失败')
        return
      }
    } catch (err) {
      ElMessage.warning('无法收藏：创建会话失败')
      return
    }
  }

  try {
    if (message.collected) {
      // Uncollect
      await unifiedAgentApi.uncollectMessage(currentSession.value!.id, message.id)
      message.collected = false
      message.collectedAt = undefined
      ElMessage.success('已取消收藏')
    } else {
      // Collect
      await unifiedAgentApi.collectMessage(currentSession.value!.id, message.id)
      message.collected = true
      message.collectedAt = new Date()
      ElMessage.success('已收藏此回答')
      // Refresh collected messages panel
      await loadCollectedMessages()
    }
  } catch (err: unknown) {
    handleError(err, '操作失败')
  }
}

// Open collected drawer
const openCollectedDrawer = () => {
  collectedDrawerVisible.value = true
  if (currentSession.value?.id) {
    loadCollectedMessages()
  }
}

// Load collected messages for current session
const loadCollectedMessages = async () => {
  if (!currentSession.value?.id) return
  
  loadingCollected.value = true
  try {
    const response = await unifiedAgentApi.getCollectedMessages(currentSession.value.id)
    if (response.data.success && response.data.data) {
      collectedMessages.value = response.data.data
    }
  } catch (err: unknown) {
    console.error('加载收藏消息失败:', err)
    // Silent failure - don't show error message to user
  } finally {
    loadingCollected.value = false
  }
}

// Handle select all collected messages
const handleSelectAllCollected = (val: boolean | string | number) => {
  if (val) {
    selectedCollectedIds.value = collectedMessages.value.map(item => item.id)
  } else {
    selectedCollectedIds.value = []
  }
}

// Truncate text for display
const truncateText = (text: string, maxLength: number): string => {
  const cleaned = text.replace(/\n/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return cleaned.substring(0, maxLength) + '...'
}

// Format collected time
const formatCollectedTime = (date: Date | string): string => {
  const d = typeof date === 'string' ? new Date(date) : date
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const minutes = Math.floor(diff / (1000 * 60))
  
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}天前`
  
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

// Handle convert single collected message to knowledge
const handleConvertSingle = async (item: CollectedQAPair) => {
  convertingQAPair.value = item
  convertDialogVisible.value = true
}

// Handle conversion completed
const handleConversionCompleted = (_entryId: string) => {
  // Refresh collected messages to update converted status
  loadCollectedMessages()
  ElMessage.success({
    message: '知识条目已创建',
    type: 'success',
    duration: 3000
  })
}

// Handle batch convert collected messages
const handleBatchConvert = async () => {
  if (selectedCollectedIds.value.length === 0) {
    ElMessage.warning('请先选择要转换的消息')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定要将选中的 ${selectedCollectedIds.value.length} 条消息转换为知识条目吗？`,
      '批量转换确认',
      {
        confirmButtonText: '确定转换',
        cancelButtonText: '取消',
        type: 'info'
      }
    )

    // Get selected Q&A pairs
    const selectedPairs = collectedMessages.value.filter(
      item => selectedCollectedIds.value.includes(item.id)
    )

    // Build conversion requests
    const requests = selectedPairs.map(pair => ({
      sessionId: pair.sessionId,
      questionMessageId: pair.question.messageId,
      answerMessageId: pair.answer.messageId
    }))

    // Show loading
    const loadingInstance = ElLoading.service({
      text: `正在转换 ${requests.length} 条消息...`,
      background: 'rgba(255, 255, 255, 0.8)'
    })

    try {
      const response = await unifiedAgentApi.batchConvertToKnowledge(requests)

      loadingInstance.close()

      if (response.data.success && response.data.data) {
        const { succeeded, failed } = response.data.data
        
        if (failed === 0) {
          ElMessage.success(`成功转换 ${succeeded} 条消息为知识条目`)
        } else {
          ElMessage.warning(`转换完成：成功 ${succeeded} 条，失败 ${failed} 条`)
        }

        // Clear selection and refresh
        selectedCollectedIds.value = []
        selectAllCollected.value = false
        await loadCollectedMessages()
      } else {
        ElMessage.error(response.data.error || '批量转换失败')
      }
    } catch (err: unknown) {
      loadingInstance.close()
      throw err
    }
  } catch (err: unknown) {
    if (!isUserCancelled(err)) {
      handleError(err, '批量转换失败')
    }
  }
}

// Handle uncollect from panel
const handleUncollectFromPanel = async (item: CollectedQAPair) => {
  if (!currentSession.value?.id) return
  
  try {
    await unifiedAgentApi.uncollectMessage(currentSession.value.id, item.answer.messageId)
    
    // Update local state
    collectedMessages.value = collectedMessages.value.filter(m => m.id !== item.id)
    selectedCollectedIds.value = selectedCollectedIds.value.filter(id => id !== item.id)
    
    // Update message in chat view
    const message = messages.value.find(m => m.id === item.answer.messageId)
    if (message) {
      message.collected = false
      message.collectedAt = undefined
    }
    
    ElMessage.success('已取消收藏')
  } catch (err: unknown) {
    handleError(err, '操作失败')
  }
}

// Handle export collected messages
const handleExportCollected = async () => {
  if (!currentSession.value?.id) return
  
  try {
    const blob = await unifiedAgentApi.exportCollectedMessages(currentSession.value.id)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `collected-${currentSession.value.title || 'messages'}-${new Date().toISOString().slice(0, 10)}.md`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    ElMessage.success('收藏消息已导出')
  } catch (err: unknown) {
    console.error('导出失败:', err)
    handleError(err, '导出失败')
  }
}

// Clear messages
const handleClearMessages = async () => {
  try {
    await ElMessageBox.confirm(
      '确定要清空当前对话吗？',
      '清空确认',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    // 停止当前会话的流式请求
    const controller = getAbortController()
    if (controller) {
      controller.abort()
      setAbortController(null)
    }
    
    messages.value = []
    setStreamingContent('')
    setLoading(false)
    error.value = ''
    currentSession.value = null
    retrievedKnowledge.value = []
    ElMessage.success('对话已清空')
  } catch {
    // User cancelled
  }
}

// Scroll to bottom of messages
const scrollToBottom = () => {
  messageListRef.value?.scrollToBottom()
}

// Setup event delegation for code block buttons (called once on mount)
const setupCodeBlockEventDelegation = (containerDom?: HTMLElement) => {
  const container = containerDom || document.querySelector('.messages-container')
  if (!container) return

  // Use event delegation to handle dynamically created buttons
  container.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement
    
    // Check if clicked element or its parent is a copy button
    const copyBtn = target.closest('.copy-btn') as HTMLElement
    if (copyBtn) {
      e.preventDefault()
      e.stopPropagation()
      const code = decodeURIComponent(copyBtn.dataset.code || '')
      
      try {
        // Try modern clipboard API first
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(code)
          ElMessage.success('代码已复制到剪贴板')
        } else {
          // Fallback for non-secure contexts or older browsers
          const textArea = document.createElement('textarea')
          textArea.value = code
          textArea.style.position = 'fixed'
          textArea.style.left = '-9999px'
          document.body.appendChild(textArea)
          textArea.focus()
          textArea.select()
          try {
            document.execCommand('copy')
            ElMessage.success('代码已复制到剪贴板')
          } catch (err) {
            console.error('Copy fallback failed:', err)
            ElMessage.error('复制失败，请手动复制')
          }
          document.body.removeChild(textArea)
        }
      } catch (err) {
        console.error('Copy failed:', err)
        ElMessage.error('复制失败')
      }
      return
    }

    // Check if clicked element or its parent is an execute button
    const executeBtn = target.closest('.execute-btn') as HTMLElement
    if (executeBtn) {
      e.preventDefault()
      e.stopPropagation()
      const script = decodeURIComponent(executeBtn.dataset.script || '')
      handleExecuteScript(script)
      return
    }
  })
}

// Setup event listeners for code block buttons (legacy, kept for compatibility)
const setupCodeBlockListeners = () => {
  // Event delegation is now used instead, this function is kept for compatibility
}



// Handle script execution
const handleExecuteScript = async (script: string) => {
  try {
    await ElMessageBox.confirm(
      `确定要执行以下脚本吗？\n\n${script}`,
      '执行确认',
      {
        confirmButtonText: '执行',
        cancelButtonText: '取消',
        type: 'warning',
        customClass: 'script-confirm-dialog'
      }
    )
    
    // Execute the script via API (using authenticated instance)
    // Requirements: 1.1, 2.3
    const targetSessionId = currentSession.value?.id || '__new__'
    const statusMsgId = generateMessageId()
    
    // 标记为加载中 (前端显示等待状态)
    setLoadingForSession(targetSessionId, true)

    // 使用 addMessageToSession 添加初始状态消息 (支持后台执行)
    addMessageToSession(targetSessionId, {
      id: statusMsgId,
      role: 'assistant',
      content: '⏳ **正在执行脚本...**',
      timestamp: new Date()
    })
    scrollToBottom()

    // 安全地更新指定会话中的消息 (不影响正在查看的其他会话)
    const updateStatusMessage = (content: string) => {
      if ((currentSession.value?.id || '__new__') === targetSessionId) {
        const statusIdx = messages.value.findIndex(m => m.id === statusMsgId)
        if (statusIdx !== -1) {
          messages.value[statusIdx].content = content
        }
      } else {
        const state = sessionStreamStates.get(targetSessionId)
        if (state) {
          const statusIdx = state.cachedMessages.findIndex(m => m.id === statusMsgId)
          if (statusIdx !== -1) {
            state.cachedMessages[statusIdx].content = content
          }
        }
      }
    }

    // 安全地移除指定会话中的消息
    const removeStatusMessage = () => {
      if ((currentSession.value?.id || '__new__') === targetSessionId) {
        const statusIdx = messages.value.findIndex(m => m.id === statusMsgId)
        if (statusIdx !== -1) {
          messages.value.splice(statusIdx, 1)
        }
      } else {
        const state = sessionStreamStates.get(targetSessionId)
        if (state) {
          const statusIdx = state.cachedMessages.findIndex(m => m.id === statusMsgId)
          if (statusIdx !== -1) {
            state.cachedMessages.splice(statusIdx, 1)
          }
        }
      }
    }

    let analysisReceived = false
    let lastResult: ScriptExecuteResult | null = null

    const abortController = unifiedAgentApi.executeScriptStream(
      {
        script,
        sessionId: targetSessionId === '__new__' ? undefined : targetSessionId,
        configId: selectedConfigId.value || undefined
      },
      {
        onStatus: (message) => {
          updateStatusMessage(`⏳ **${message}**`)
          if ((currentSession.value?.id || '__new__') === targetSessionId) scrollToBottom()
        },
        onResult: (result) => {
          lastResult = result
          if (result.success && result.output) {
            updateStatusMessage('✅ **脚本已执行，等待 AI 分析...**')
            addMessageToSession(targetSessionId, {
              id: generateMessageId(),
              role: 'user',
              content: `我执行了命令 \`${script}\`，以下是输出结果，请帮我整理和分析：\n\n\`\`\`\n${result.output}\n\`\`\``,
              timestamp: new Date()
            })
          } else if (result.success) {
            updateStatusMessage('✅ **脚本执行成功**\n\n命令已成功执行，无输出内容。')
            ElMessage.success('脚本执行成功')
          } else {
            updateStatusMessage(`❌ **脚本执行失败**\n\n**错误信息:**\n\`\`\`\n${result.error || '未知错误'}\n\`\`\``)
            ElMessage.error('脚本执行失败')
          }
          if ((currentSession.value?.id || '__new__') === targetSessionId) scrollToBottom()
        },
        onAnalysis: (analysis) => {
          analysisReceived = true
          removeStatusMessage()
          addMessageToSession(targetSessionId, {
            id: generateMessageId(),
            role: 'assistant',
            content: analysis,
            timestamp: new Date()
          })
          if ((currentSession.value?.id || '__new__') === targetSessionId) scrollToBottom()
        },
        onDone: () => {
          if (!analysisReceived) {
            if (!lastResult) {
              updateStatusMessage('✅ **脚本执行完成**')
            } else if (lastResult.success && lastResult.output) {
              updateStatusMessage('✅ **脚本已执行完成，未进行分析。**')
            }
          }
          setLoadingForSession(targetSessionId, false)
          if ((currentSession.value?.id || '__new__') === targetSessionId) scrollToBottom()
        },
        onError: (errorMsg) => {
          updateStatusMessage(`❌ **执行请求失败**\n\n${errorMsg}`)
          setLoadingForSession(targetSessionId, false)
          if ((currentSession.value?.id || '__new__') === targetSessionId) {
            scrollToBottom()
            handleError(errorMsg, '脚本执行失败')
          }
        }
      }
    )
    
    setAbortControllerForSession(targetSessionId, abortController)
  } catch (err: unknown) {
    // User cancelled or error occurred
    if (!isUserCancelled(err)) {
      handleError(err, '执行失败')
    }
  }
}

// Handle session selection from sidebar
const handleSelectSession = async (session: ChatSession) => {
  // 如果点击的是当前会话，不重新加载
  if (currentSession.value?.id === session.id) {
    return
  }
  
  try {
    error.value = ''
    // 重置检索状态（仅针对当前显示）
    isRetrieving.value = false
    
    // 保存当前会话的消息到缓存（如果有正在进行的流式请求）
    const currentSessionId = currentSession.value?.id || '__new__'
    const currentState = sessionStreamStates.get(currentSessionId)
    if (currentState?.isLoading) {
      saveMessagesToCache(currentSessionId)
    }
    
    // 注意：不中止当前会话的流式请求，让它在后台继续运行
    // 流式响应完成后会自动更新对应会话的状态
    
    // 检查目标会话是否有缓存的消息（正在进行中的会话）
    const targetState = sessionStreamStates.get(session.id)
    if (targetState && targetState.cachedMessages.length > 0) {
      // 从缓存恢复消息
      currentSession.value = {
        id: session.id,
        title: session.title,
        provider: session.provider,
        model: session.model,
        messages: targetState.cachedMessages,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        mode: (session as UnifiedChatSession).mode || 'standard'
      } as UnifiedChatSession
      messages.value = [...targetState.cachedMessages]
      knowledgeEnhancedMode.value = currentSession.value.mode === 'knowledge-enhanced'
    } else {
      // Load full session data from server
      const response = await sessionApi.getById(session.id)
      if (response.data.success && response.data.data) {
        currentSession.value = {
          ...response.data.data,
          mode: (response.data.data as UnifiedChatSession).mode || 'standard'
        }
        messages.value = response.data.data.messages || []
        
        // Restore mode from session
        knowledgeEnhancedMode.value = currentSession.value.mode === 'knowledge-enhanced'
      }
    }
    
    // 触发响应式更新，确保显示新会话的流式状态
    streamStateVersion.value++
    
    // Update selected config if session has a different provider
    const matchingConfig = configs.value.find(c => 
      c.provider === session.provider && c.model === session.model
    )
    if (matchingConfig) {
      selectedConfigId.value = matchingConfig.id
    }
    
    // Reset collected messages panel state
    collectedMessages.value = []
    selectedCollectedIds.value = []
    selectAllCollected.value = false
    
    // Load collected messages if drawer is open
    if (collectedDrawerVisible.value) {
      loadCollectedMessages()
    }
    
    error.value = ''
  } catch (err: unknown) {
    console.error('加载会话失败:', err)
    handleError(err, '加载会话失败')
  }
}

// Handle new session from sidebar
const handleNewSessionFromSidebar = () => {
  // 保存当前会话的消息到缓存（如果有正在进行的流式请求）
  const currentSessionId = currentSession.value?.id || '__new__'
  const currentState = sessionStreamStates.get(currentSessionId)
  if (currentState?.isLoading) {
    // 不中止流式请求，只保存消息到缓存
    saveMessagesToCache(currentSessionId)
  }
  
  currentSession.value = null
  messages.value = []
  error.value = ''
  inputMessage.value = ''
  retrievedKnowledge.value = []
  collectedMessages.value = []
  selectedCollectedIds.value = []
  selectAllCollected.value = false
  // 重置检索状态
  isRetrieving.value = false
  
  // 初始化新会话的流式状态
  const newSessionId = '__new__'
  sessionStreamStates.set(newSessionId, {
    isLoading: false,
    streamingContent: '',
    abortController: null,
    cachedMessages: [],
    pendingMessage: null
  })
  
  // 触发响应式更新
  streamStateVersion.value++
}

// Handle session deleted from sidebar
const handleSessionDeleted = (sessionId: string) => {
  // 停止被删除会话的流式请求
  const state = sessionStreamStates.get(sessionId)
  if (state?.abortController) {
    state.abortController.abort()
  }
  // 清理该会话的流式状态
  sessionStreamStates.delete(sessionId)
  
  if (currentSession.value?.id === sessionId) {
    currentSession.value = null
    messages.value = []
    error.value = ''
    retrievedKnowledge.value = []
    isRetrieving.value = false
  }
}

// Handle all sessions cleared from sidebar
const handleAllSessionsCleared = () => {
  // 停止所有会话的流式请求
  sessionStreamStates.forEach((state) => {
    if (state.abortController) {
      state.abortController.abort()
    }
  })
  // 清空所有会话的流式状态
  sessionStreamStates.clear()
  
  currentSession.value = null
  messages.value = []
  error.value = ''
  retrievedKnowledge.value = []
  isRetrieving.value = false
}
</script>


<style scoped>
.unified-ai-view {
  height: 100%;
  display: flex;
  flex-direction: row;
}

.chat-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color); /* Use standard background */
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  overflow: hidden;
  margin-left: 0;
  border: 1px solid var(--el-border-color-lighter);
}

/* Header styles moved to ChatHeader component */

/* Messages Container */
.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  background: var(--el-bg-color-overlay);
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--el-text-color-secondary);
}

.empty-state p {
  margin: 8px 0;
  font-size: 16px;
}

.empty-hint {
  font-size: 14px !important;
  color: var(--el-text-color-placeholder);
}

.quick-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  flex-wrap: wrap;
  justify-content: center;
}

/* Retrieval Status */
.retrieval-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  background: var(--el-color-warning-light-9);
  border: 1px solid var(--el-color-warning-light-8);
  border-radius: 8px;
  margin-bottom: 16px;
  color: var(--el-color-warning);
  font-size: 14px;
}

/* Message Item */
.message-item {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
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
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.message-item.user .message-avatar {
  background: linear-gradient(135deg, var(--el-color-primary) 0%, var(--el-color-primary-light-3) 100%);
  color: var(--el-color-white);
}

.message-item.assistant .message-avatar {
  background: linear-gradient(135deg, var(--el-color-success) 0%, var(--el-color-success-light-3) 100%);
  color: var(--el-color-white);
}

.message-content {
  max-width: 80%;
  min-width: 100px;
}

.message-role {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.message-item.user .message-role {
  text-align: right;
  justify-content: flex-end;
}

.confidence-badge {
  font-size: 10px;
}

.collect-btn {
  margin-left: 4px;
  padding: 4px;
  font-size: 12px;
  opacity: 1;
  transition: opacity 0.2s, transform 0.2s;
}

.collect-btn:hover {
  opacity: 1;
  transform: scale(1.1);
  color: var(--el-color-warning);
}

.collected-badge {
  margin-left: 4px;
  font-size: 10px;
}

.message-text {
  padding: 12px 16px;
  border-radius: 12px;
  line-height: 1.6;
  word-break: break-word;
}

.message-item.user .message-text {
  background: var(--el-color-primary);
  color: var(--el-color-white);
  border-bottom-right-radius: 4px;
}

.message-item.assistant .message-text {
  background: var(--el-bg-color-overlay);
  color: var(--el-text-color-regular);
  border-bottom-left-radius: 4px;
  box-shadow: var(--el-box-shadow-light);
  border: 1px solid var(--el-border-color-lighter);
}

/* Citations Section */
.citations-section {
  margin-top: 12px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  padding: 8px;
}

.citations-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--el-color-success);
}

.citations-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.citation-item {
  background: var(--el-bg-color-overlay);
  border-radius: 6px;
  padding: 10px;
  border-left: 3px solid var(--el-color-success);
}

.citation-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.citation-title {
  font-weight: 500;
  color: var(--el-text-color-primary);
  flex: 1;
}

.citation-score {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.citation-content {
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.5;
  max-height: 100px;
  overflow-y: auto;
}

/* Tool Calls Section */
.tool-calls-section {
  margin-top: 12px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  padding: 8px;
}

.tool-calls-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--el-color-primary);
}

.tool-calls-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tool-call-item {
  background: var(--el-bg-color-overlay);
  border-radius: 6px;
  padding: 10px;
  border-left: 3px solid var(--el-color-primary);
}

.tool-call-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.tool-duration {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.tool-call-detail {
  font-size: 12px;
}

.tool-input,
.tool-output {
  margin-bottom: 8px;
}

.tool-input .label,
.tool-output .label {
  font-weight: 600;
  color: var(--el-text-color-regular);
  display: block;
  margin-bottom: 4px;
}

.tool-input pre,
.tool-output pre {
  margin: 0;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  overflow-x: auto;
  font-size: 11px;
  max-height: 150px;
  overflow-y: auto;
}

/* Reasoning Section */
.reasoning-section {
  margin-top: 12px;
  background: var(--el-color-warning-light-9);
  border-radius: 8px;
  padding: 8px;
}

.reasoning-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--el-color-warning);
}

.reasoning-list {
  margin: 8px 0 0 20px;
  padding: 0;
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
}

/* Typing Cursor */
.typing-cursor {
  display: inline-block;
  width: 8px;
  height: 16px;
  background: var(--el-color-primary);
  margin-left: 2px;
  animation: blink 1s infinite;
  vertical-align: middle;
}

@keyframes blink {
  0%, 50% {
    opacity: 1;
  }
  51%, 100% {
    opacity: 0;
  }
}

/* Loading Indicator */
.loading-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  color: var(--el-text-color-secondary);
}

/* Error Alert */
.error-alert {
  margin: 0 20px 10px;
}

/* Input area styles moved to ChatInput component */

/* Markdown Styles */
.markdown-body {
  font-size: 14px;
  line-height: 1.8;
}

.markdown-body :deep(p) {
  margin: 0 0 12px;
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 8px 0;
  padding-left: 20px;
}

.markdown-body :deep(li) {
  margin: 4px 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 16px 0 8px;
  font-weight: 600;
}

.markdown-body :deep(h1) {
  font-size: 1.5em;
}

.markdown-body :deep(h2) {
  font-size: 1.3em;
}

.markdown-body :deep(h3) {
  font-size: 1.1em;
}

.markdown-body :deep(blockquote) {
  margin: 12px 0;
  padding: 8px 16px;
  border-left: 4px solid var(--el-color-primary);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
}

.markdown-body :deep(code:not(.hljs)) {
  padding: 2px 6px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  color: var(--el-color-warning);
}

.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
  border: 1.5px solid var(--el-border-color); /* Thicker and higher contrast border */
  border-radius: 8px;
  overflow: hidden;
  background: var(--el-bg-color-overlay);
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  padding: 10px 14px;
  border: 1px solid var(--el-border-color-light); /* Clearer grid lines */
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--el-fill-color-light);
  font-weight: 600;
  color: var(--el-text-color-primary);
  border-bottom: 2px solid var(--el-border-color-light);
}

.markdown-body :deep(tr:nth-child(even)) {
  background-color: var(--el-fill-color-lighter);
}

.markdown-body :deep(tr:hover) {
  background-color: var(--el-fill-color-light);
}

/* Code Block Styles */
.markdown-body :deep(.code-block) {
  margin: 20px 0;
  border-radius: 8px;
  overflow: hidden;
  background: var(--ai-code-bg);
  border: 1.5px solid var(--el-border-color-light); /* Higher contrast border for dark theme */
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.markdown-body :deep(.code-block.device-script-block) {
  border: 2px solid var(--el-color-success);
  box-shadow: 0 2px 12px rgba(103, 194, 58, 0.15);
}

.markdown-body :deep(.code-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--ai-code-header-bg);
  border-bottom: 1px solid var(--el-border-color-extra-light);
}

.markdown-body :deep(.code-language) {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-transform: uppercase;
}

.markdown-body :deep(.code-actions) {
  display: flex;
  gap: 8px;
}

.markdown-body :deep(.code-action-btn) {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 4px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.markdown-body :deep(.code-action-btn:hover) {
  background: var(--el-fill-color);
  border-color: var(--el-text-color-secondary);
  color: var(--el-color-white);
}

.markdown-body :deep(.code-action-btn.execute-btn) {
  background: var(--el-color-success);
  border-color: var(--el-color-success);
  color: var(--el-color-white);
}

.markdown-body :deep(.code-action-btn.execute-btn:hover) {
  background: var(--el-color-success-light-3);
}

.markdown-body :deep(.code-block pre) {
  margin: 0;
  padding: 16px;
  overflow-x: auto;
}

.markdown-body :deep(.code-block code) {
  color: var(--ai-code-text, #d4d4d4);
}

/* Highlight.js Theme Overrides */
.markdown-body :deep(.hljs-keyword) { color: var(--ai-code-keyword); }
.markdown-body :deep(.hljs-string) { color: var(--ai-code-string); }
.markdown-body :deep(.hljs-number) { color: var(--ai-code-number); }
.markdown-body :deep(.hljs-comment) { color: var(--ai-code-comment); }
.markdown-body :deep(.hljs-function) { color: var(--ai-code-function); }
.markdown-body :deep(.hljs-variable) { color: var(--ai-code-variable); }
.markdown-body :deep(.hljs-attr) { color: var(--ai-code-variable); }
.markdown-body :deep(.hljs-built_in) { color: var(--ai-code-builtin); }

/* Drawer Header Styles */
.drawer-header {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 16px;
  font-weight: 600;
}

.drawer-footer {
  display: flex;
  justify-content: center;
  padding: 12px 0;
}

/* Collected Drawer Content Styles */
.collected-drawer-content {
  padding: 0 4px;
}

.collected-loading,
.collected-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  color: var(--el-text-color-secondary);
  gap: 12px;
}

.collected-empty p {
  margin: 0;
  font-size: 14px;
}

.collected-hint {
  font-size: 12px !important;
  color: var(--el-text-color-placeholder);
}

.collected-batch-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  margin-bottom: 12px;
}

.collected-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  background: var(--el-fill-color-extra-light);
  border-radius: 8px;
  border: 1px solid var(--el-border-color-lighter);
  transition: all 0.2s;
  margin-bottom: 10px;
}

.collected-item:hover {
  background: var(--el-fill-color-light);
  border-color: var(--el-color-warning);
}

.collected-checkbox {
  flex-shrink: 0;
  margin-top: 2px;
}

.collected-item-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.collected-question,
.collected-answer {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
  margin-bottom: 6px;
}

.collected-question {
  color: var(--el-color-primary);
}

.collected-answer {
  color: var(--el-color-success);
}

.collected-question span,
.collected-answer span {
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.collected-meta {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  margin-top: 6px;
}

.collected-item-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}

.collected-item:hover .collected-item-actions {
  opacity: 1;
}

.collected-footer {
  padding: 8px 0;
  border-top: 1px solid var(--el-border-color-lighter);
  margin-top: 8px;
  text-align: center;
}

/* ReAct Steps Section - Requirements: 6.1, 6.2, 6.3, 6.4 */
.react-steps-section {
  margin-top: 12px;
  background: var(--el-color-primary-light-9);
  border-radius: 8px;
  padding: 8px;
}

.react-steps-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--el-color-primary);
}

.react-steps-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.react-step-item {
  background: var(--el-bg-color-overlay);
  border-radius: 8px;
  padding: 12px;
  border-left: 4px solid var(--el-text-color-secondary);
  transition: all 0.2s;
}

.react-step-item:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

/* Step type specific colors - Requirements: 6.2 */
.react-step-thought {
  border-left-color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
}

.react-step-action {
  border-left-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.react-step-observation {
  border-left-color: var(--el-color-success);
  background: var(--el-color-success-light-9);
}

.react-step-final_answer {
  border-left-color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}

.react-step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.react-step-duration {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: auto;
}

.react-step-content {
  font-size: 13px;
  color: var(--el-text-color-primary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Tool info for Action steps - Requirements: 6.3 */
.react-step-tool {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.react-step-tool .tool-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.react-step-tool .tool-input {
  margin-top: 8px;
}

.react-step-tool .label,
.react-step-output .label {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  display: block;
  margin-bottom: 4px;
}

.react-step-tool pre,
.react-step-output pre {
  margin: 0;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  overflow-x: auto;
  font-size: 11px;
  max-height: 150px;
  overflow-y: auto;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}

/* Tool output for Observation steps - Requirements: 6.4 */
.react-step-output {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--el-border-color-lighter);
}
</style>

