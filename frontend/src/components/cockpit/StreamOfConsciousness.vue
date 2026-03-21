<template>
  <div ref="containerRef" class="stream-of-consciousness">
    <div class="stream-header">
      <div class="terminal-dots">
        <span class="dot red"></span>
        <span class="dot yellow"></span>
        <span class="dot green"></span>
      </div>
      <div class="terminal-title">CENTRAL CORTEX :: /var/log/thought_stream</div>
    </div>
    
    <div ref="scrollBoxRef" class="stream-body">
      <div 
        v-for="log in renderLogs" 
        :key="log.id" 
        class="log-entry"
      >
        <span class="log-time">[{{ log.time }}]</span>
        <span :class="['log-level', `level-${log.level}`]">{{ getLevelTag(log.level) }}</span>
        <span class="log-text" :class="[`text-${log.level}`]">{{ log.displayText }}<span v-if="log.isTyping" class="cursor">_</span></span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, onActivated, onDeactivated, nextTick } from 'vue'
import api from '@/api'
import { createAuthEventSource, type AuthEventSourceHandle } from '@/utils/authEventSource'
import { useTopologySSE, type TopologyDiff } from '@/composables/useTopologySSE'
import { useHealthData } from '@/composables/useHealthData'

type ThoughtLevel = 'perceiving' | 'reasoning' | 'deciding' | 'acting' | 'alerting'

interface ThoughtLog {
  id: number
  time: string
  level: ThoughtLevel
  fullText: string
  displayText: string
  isTyping: boolean
}

const scrollBoxRef = ref<HTMLElement | null>(null)
const renderLogs = ref<ThoughtLog[]>([])
let logCounter = 0
let isDestroyed = false

// --- SSE 连接 ---
let intentSSE: AuthEventSourceHandle | null = null
let brainThinkingSSE: AuthEventSourceHandle | null = null

// --- 共享 composable ---
const topologySSE = useTopologySSE()
const healthData = useHealthData()
let unsubscribeTopology: (() => void) | null = null
let unsubscribeHealth: (() => void) | null = null

// --- 定时器 ---
let alertPollTimer: ReturnType<typeof setInterval> | null = null

// --- 状态跟踪 ---
let brainConnectedOnce = false  // 防止 onOpen 重复推送连接消息
let lastHealthScore: number | null = null  // 跟踪健康评分变化
let lastAlertCount = 0  // 跟踪活跃告警数量变化
let knownAlertIds = new Set<string>()  // 已展示过的告警 ID

// --- SSE 事件去重（防止 SSE 重连导致整段事件重播） ---
const recentBrainEvents: string[] = []  // 最近 N 条事件的内容指纹
const BRAIN_DEDUP_WINDOW = 20  // 保留最近 20 条用于去重比对
const BRAIN_DEDUP_TTL = 5000  // 5 秒内相同内容视为重复
let lastBrainEventTime = 0

let scrollRafPending = false
const scrollToBottom = () => {
  if (scrollRafPending) return
  scrollRafPending = true
  requestAnimationFrame(() => {
    scrollRafPending = false
    if (scrollBoxRef.value) {
      scrollBoxRef.value.scrollTop = scrollBoxRef.value.scrollHeight + 100
    }
  })
}

const typeText = async (log: ThoughtLog) => {
  log.isTyping = true
  const chars = Array.from(log.fullText)
  // 批量渲染：每帧追加一批字符，而不是每个字符一个 setTimeout
  const CHARS_PER_TICK = 4
  for (let i = 0; i < chars.length; i += CHARS_PER_TICK) {
    if (isDestroyed) break
    log.displayText += chars.slice(i, i + CHARS_PER_TICK).join('')
    scrollToBottom()
    await new Promise(r => setTimeout(r, 25))
  }
  log.isTyping = false
}

// 思考队列：防止多条消息同时打字
const thoughtQueue: Array<{ level: ThoughtLevel; text: string }> = []
let isProcessingQueue = false

const processQueue = async () => {
  if (isProcessingQueue || isDestroyed) return
  isProcessingQueue = true
  
  while (thoughtQueue.length > 0 && !isDestroyed) {
    // 如果队列积压严重（>5条），跳过打字动画直接显示
    const skipAnimation = thoughtQueue.length > 5
    const item = thoughtQueue.shift()!
    await pushThought(item.level, item.text, skipAnimation)
  }
  
  isProcessingQueue = false
}

const MAX_QUEUE_SIZE = 15

const enqueueThought = (level: ThoughtLevel, text: string) => {
  // 防止队列无限增长：超出上限时丢弃最旧的条目
  while (thoughtQueue.length >= MAX_QUEUE_SIZE) {
    thoughtQueue.shift()
  }
  thoughtQueue.push({ level, text })
  processQueue()
}

const pushThought = async (level: ThoughtLevel, text: string, skipAnimation = false) => {
  const now = new Date()
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`
  
  const newLog: ThoughtLog = {
    id: ++logCounter,
    time: timeStr,
    level,
    fullText: text,
    displayText: skipAnimation ? text : '',
    isTyping: false
  }
  
  renderLogs.value.push(newLog)
  if (renderLogs.value.length > 50) renderLogs.value.shift()
  
  await nextTick()
  if (skipAnimation) {
    scrollToBottom()
  } else {
    await typeText(newLog)
  }
}

// ==================== SSE 连接：自主意图 ====================
const connectIntentSSE = () => {
  try {
    intentSSE = createAuthEventSource('/api/ai-ops/intents/stream', {
      onAuthFailed: () => {
        enqueueThought('alerting', '意图事件流认证失败。')
      },
    })

    intentSSE.setOnMessage((event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        // 忽略心跳和连接事件
        if (data.type === 'heartbeat' || data.type === 'connected') return
        if (data.type === 'error') {
          console.warn('[StreamOfConsciousness] Intent SSE error:', data.message)
          return
        }
        if (data.type === 'intent' && data.data) {
          const intent = data.data
          enqueueThought('deciding', `生成防护策略: Intent(action="${intent.action}", target="${intent.target || 'system'}")。风险等级: ${intent.riskLevel || 'MEDIUM'}。`)
        }
      } catch (error) { console.warn('[StreamOfConsciousness] Failed to parse intent event:', error) }
    })
  } catch {
    console.warn('Failed to connect intent SSE')
  }
}

// ==================== SSE 连接：大脑思考过程 ====================
const connectBrainThinkingSSE = () => {
  try {
    brainThinkingSSE = createAuthEventSource('/api/ai-ops/brain/thinking/stream', {
      onOpen: () => {
        // FIX: 仅首次连接时推送消息，避免重连时重复刷屏
        if (!brainConnectedOnce) {
          brainConnectedOnce = true
          enqueueThought('reasoning', '已连接大脑思考事件流 — OODA 推理过程实时可见。')
        }
      },
      onAuthFailed: () => {
        enqueueThought('alerting', '大脑思考事件流认证失败。')
      },
    })

    // 处理心跳和连接数据事件（通过 onmessage 到达的未命名事件）
    brainThinkingSSE.setOnMessage((event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        // 忽略心跳和连接事件 — 这些仅用于保活
        if (data.type === 'heartbeat' || data.type === 'connected') return
        if (data.type === 'error') {
          console.warn('[StreamOfConsciousness] Brain SSE error:', data.message)
          return
        }
      } catch { /* ignore parse errors for non-JSON data */ }
    })

    brainThinkingSSE.addEventListener('brain-thinking', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        const phase = data.phase as string
        const message = data.message as string
        if (!message) return

        // SSE 去重：在短时间窗口内跳过完全相同的 phase+message
        const fingerprint = `${phase}:${message}`
        const now = Date.now()
        if (now - lastBrainEventTime < BRAIN_DEDUP_TTL && recentBrainEvents.includes(fingerprint)) {
          return // 重复事件，跳过
        }
        lastBrainEventTime = now
        recentBrainEvents.push(fingerprint)
        if (recentBrainEvents.length > BRAIN_DEDUP_WINDOW) {
          recentBrainEvents.shift()
        }

        // OODA 阶段映射到意识流思考级别
        const levelMap: Record<string, ThoughtLevel> = {
          observe: 'perceiving',
          orient: 'reasoning',
          decide: 'deciding',
          act: 'acting',
          learn: 'reasoning',
          error: 'alerting',
        }
        const level = levelMap[phase] || 'reasoning'
        const phaseTag = phase === 'error' ? '⚠️' : `[${phase.toUpperCase()}]`
        enqueueThought(level, `${phaseTag} ${message}`)
      } catch (error) { console.warn('[StreamOfConsciousness] Failed to parse brain-thinking event:', error) }
    })
  } catch {
    console.warn('Failed to connect brain thinking SSE')
  }
}

// ==================== 共享 SSE：拓扑变化（通过 useTopologySSE） ====================
const subscribeTopology = () => {
  if (unsubscribeTopology) return // 已订阅
  unsubscribeTopology = topologySSE.subscribe((diff: TopologyDiff) => {
    const parts: string[] = []
    if (diff.nodesAdded?.length) parts.push(`${diff.nodesAdded.length} 设备上线`)
    if (diff.nodesRemoved?.length) parts.push(`${diff.nodesRemoved.length} 设备离线`)
    if (diff.edgesAdded?.length) parts.push(`${diff.edgesAdded.length} 链路新增`)
    if (diff.edgesRemoved?.length) parts.push(`${diff.edgesRemoved.length} 链路断开`)

    if (parts.length > 0) {
      enqueueThought('perceiving', `拓扑变化: ${parts.join(', ')}`)
    }
  })
}

// ==================== 共享健康数据（通过 useHealthData） ====================
const subscribeHealth = () => {
  if (unsubscribeHealth) return // 已订阅
  unsubscribeHealth = healthData.onChange((h) => {
    const score = h.score
    const level = h.level

    // 仅在评分变化时推送（避免重复消息）
    if (lastHealthScore === null) {
      lastHealthScore = score
      enqueueThought('perceiving', `系统健康评分: ${score}/100 (${level})。`)
    } else if (Math.abs(score - lastHealthScore) >= 5) {
      const direction = score > lastHealthScore ? '↑' : '↓'
      enqueueThought(
        score < 60 ? 'alerting' : 'perceiving',
        `健康评分变化: ${lastHealthScore} → ${score}/100 ${direction} (${level})`
      )
      lastHealthScore = score
    }
  })
}

// ==================== 轮询：活跃告警 ====================
const pollAlerts = async () => {
  try {
    const alertRes = await api.get('/ai-ops/alerts/events/active')
    if (!alertRes.data?.success) return

    const alerts = alertRes.data.data || []
    const currentCount = alerts.length

    // 检测新增告警
    for (const alert of alerts) {
      const alertId = alert.id || alert.eventId
      if (alertId && !knownAlertIds.has(alertId)) {
        knownAlertIds.add(alertId)
        const severity = alert.severity || alert.level || 'warning'
        const source = alert.source || alert.deviceName || 'unknown'
        const msg = alert.message || alert.description || alert.title || '未知告警'
        const shortMsg = msg.length > 80 ? msg.slice(0, 80) + '...' : msg
        enqueueThought('alerting', `[${severity.toUpperCase()}] ${source}: ${shortMsg}`)
      }
    }

    // 告警数量变化提示
    if (lastAlertCount > 0 && currentCount === 0) {
      enqueueThought('acting', '所有活跃告警已清除。')
    }
    lastAlertCount = currentCount

    // 防止 knownAlertIds 无限增长：清理已解决的告警 ID
    const activeIds = new Set(alerts.map((a: Record<string, string>) => a.id || a.eventId))
    for (const id of knownAlertIds) {
      if (!activeIds.has(id)) knownAlertIds.delete(id)
    }
  } catch (error) {
    // 认证失败时停止轮询，避免请求风暴
    const msg = error instanceof Error ? error.message : ''
    if (msg.includes('认证已过期') || msg.includes('刷新令牌失败')) {
      if (alertPollTimer) { clearInterval(alertPollTimer); alertPollTimer = null }
    }
  }
}

// ==================== 检查大脑服务状态 ====================
const checkBrainStatus = async () => {
  try {
    const configRes = await api.get('/ai-ops/evolution/config')
    if (configRes.data?.success && configRes.data.data) {
      const brainConfig = configRes.data.data.autonomousBrain
      if (!brainConfig?.enabled) {
        enqueueThought('reasoning', '自主大脑服务未启用 — OODA 推理循环处于休眠状态。可在智能进化配置中开启。')
      }
    }
  } catch { /* 静默失败 */ }
}

// ==================== 生命周期 ====================
onMounted(async () => {
  // 初始化：推送启动消息
  await pushThought('perceiving', '中央皮层初始化... 正在连接后端数据流。')
  
  // 连接 SSE 数据流
  connectIntentSSE()
  connectBrainThinkingSSE()
  subscribeTopology()  // 通过共享 SSE 管理器订阅拓扑变化
  
  // 订阅共享健康数据变化
  subscribeHealth()

  // 检查大脑服务状态 + 获取初始告警
  await Promise.allSettled([checkBrainStatus(), pollAlerts()])

  // 启动定时轮询：活跃告警（30秒）
  alertPollTimer = setInterval(pollAlerts, 30000)
})

onUnmounted(() => {
  isDestroyed = true
  if (intentSSE) { intentSSE.close(); intentSSE = null }
  if (brainThinkingSSE) { brainThinkingSSE.close(); brainThinkingSSE = null }
  if (unsubscribeTopology) { unsubscribeTopology(); unsubscribeTopology = null }
  if (unsubscribeHealth) { unsubscribeHealth(); unsubscribeHealth = null }
  if (alertPollTimer) { clearInterval(alertPollTimer); alertPollTimer = null }
  thoughtQueue.length = 0
})

// keep-alive 支持：切换到其他 tab 时断开 SSE，切回来时重连
onActivated(() => {
  isDestroyed = false
  if (!intentSSE) connectIntentSSE()
  if (!brainThinkingSSE) { connectBrainThinkingSSE() }
  subscribeTopology()  // 重新订阅共享拓扑 SSE
  subscribeHealth()    // 重新订阅共享健康数据
  if (!alertPollTimer) alertPollTimer = setInterval(pollAlerts, 30000)
})

onDeactivated(() => {
  if (intentSSE) { intentSSE.close(); intentSSE = null }
  if (brainThinkingSSE) { brainThinkingSSE.close(); brainThinkingSSE = null }
  if (unsubscribeTopology) { unsubscribeTopology(); unsubscribeTopology = null }
  if (unsubscribeHealth) { unsubscribeHealth(); unsubscribeHealth = null }
  if (alertPollTimer) { clearInterval(alertPollTimer); alertPollTimer = null }
  thoughtQueue.length = 0
})

const getLevelTag = (level: string) => {
  switch (level) {
    case 'perceiving': return '[👁️ PERCEIVING]'
    case 'reasoning': return '[🧠 REASONING ]'
    case 'deciding': return '[⚖️ DECIDING  ]'
    case 'acting': return '[⚡ ACTING    ]'
    case 'alerting': return '[🚨 ALERTING  ]'
    default: return '[UNKNOWN]'
  }
}
</script>

<style scoped>
.stream-of-consciousness {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  background-color: var(--el-bg-color-overlay);
}

.stream-header {
  height: 36px;
  background-color: var(--el-fill-color-darker);
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
  flex-shrink: 0;
}

.terminal-dots {
  display: flex;
  gap: 6px;
  margin-right: 16px;
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.dot.red { background-color: #ff5f56; }
.dot.yellow { background-color: #ffbd2e; }
.dot.green { background-color: #27c93f; }

.terminal-title {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  font-weight: 500;
  letter-spacing: 0.5px;
}

.stream-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  scrollbar-width: thin;
  scrollbar-color: var(--el-border-color-lighter) transparent;
}

.stream-body::-webkit-scrollbar {
  width: 6px;
}
.stream-body::-webkit-scrollbar-thumb {
  background-color: var(--el-border-color-lighter);
}

.log-entry {
  margin-bottom: 8px;
  line-height: 1.6;
  font-size: 14px;
  overflow-wrap: break-word;
}

.log-time {
  color: var(--el-text-color-secondary);
  margin-right: 12px;
  opacity: 0.6;
}

.log-level {
  font-weight: 600;
  margin-right: 12px;
  width: 140px;
  display: inline-block;
}

.level-perceiving { color: #409eff; }
.level-reasoning { color: #e6a23c; }
.level-deciding { color: #b37feb; text-shadow: 0 0 8px rgba(179, 127, 235, 0.4); }
.level-acting { color: #67c23a; }
.level-alerting { color: #f56c6c; }

.log-text {
  color: var(--el-text-color-primary);
}

.text-perceiving { color: #c6e2ff; }
.text-reasoning { color: #fdf6ec; }
.text-deciding { color: #f4f4f5; font-weight: 600; }
.text-acting { color: #e1f3d8; }
.text-alerting { color: #fde2e2; font-weight: 600; }

.cursor {
  display: inline-block;
  width: 8px;
  animation: blink 1s step-end infinite;
  background-color: currentColor;
  vertical-align: bottom;
  margin-left: 2px;
  opacity: 0.8;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
</style>
