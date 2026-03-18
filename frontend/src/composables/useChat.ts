import { ref, computed, reactive } from 'vue'
import type { UnifiedChatMessage } from '@/api/ai'

// ==================== 会话流式状态管理 ====================

// 每个会话独立的流式状态
export interface SessionStreamState {
    isLoading: boolean
    streamingContent: string
    abortController: AbortController | null
    // 缓存的消息列表（用于切换会话时保存进行中的消息）
    cachedMessages: UnifiedChatMessage[]
    // 流式响应完成后待添加的消息
    pendingMessage: UnifiedChatMessage | null
}

export function useChat() {
    // 使用 reactive 包装 Map 以确保响应式更新
    const sessionStreamStates = reactive<Map<string, SessionStreamState>>(new Map())

    // 强制触发响应式更新的计数器
    const streamStateVersion = ref(0)

    // 模式控制
    const knowledgeEnhancedMode = ref(false)

    // 知识检索状态
    const isRetrieving = ref(false)

    // 获取指定会话的流式状态
    const getStreamState = (sessionId: string): SessionStreamState => {
        if (!sessionStreamStates.has(sessionId)) {
            // LRU/容量检查：如果并发缓存的大量状态超过 20 条，淘汰最旧一条避免内存泄漏
            if (sessionStreamStates.size >= 20) {
                const oldestKey = sessionStreamStates.keys().next().value
                if (oldestKey) sessionStreamStates.delete(oldestKey)
            }

            sessionStreamStates.set(sessionId, {
                isLoading: false,
                streamingContent: '',
                abortController: null,
                cachedMessages: [],
                pendingMessage: null
            })
        }
        return sessionStreamStates.get(sessionId)!
    }

    // 获取当前会话的流式状态
    const getCurrentStreamState = (currentSessionId: string | undefined): SessionStreamState => {
        const sessionId = currentSessionId || '__new__'
        return getStreamState(sessionId)
    }

    // 动态计算属性，需要传入 currentSessionId
    const getIsLoading = (currentSessionId: string | undefined) => computed(() => {
        void streamStateVersion.value
        return getCurrentStreamState(currentSessionId).isLoading
    })

    const getStreamingContent = (currentSessionId: string | undefined) => computed(() => {
        void streamStateVersion.value
        return getCurrentStreamState(currentSessionId).streamingContent
    })

    // 设置当前会话的加载状态
    const setLoading = (currentSessionId: string | undefined, value: boolean) => {
        getCurrentStreamState(currentSessionId).isLoading = value
        streamStateVersion.value++ // 触发响应式更新
    }

    // 设置当前会话的流式内容
    const setStreamingContent = (currentSessionId: string | undefined, value: string) => {
        getCurrentStreamState(currentSessionId).streamingContent = value
        streamStateVersion.value++ // 触发响应式更新
    }

    // 设置指定会话的加载状态
    const setLoadingForSession = (sessionId: string, value: boolean) => {
        getStreamState(sessionId).isLoading = value
        streamStateVersion.value++ // 触发响应式更新
    }

    // 设置指定会话的流式内容
    const setStreamingContentForSession = (sessionId: string, value: string) => {
        getStreamState(sessionId).streamingContent = value
        streamStateVersion.value++ // 触发响应式更新
    }

    // 获取/设置当前会话的 AbortController
    const getAbortController = (currentSessionId: string | undefined): AbortController | null => {
        return getCurrentStreamState(currentSessionId).abortController
    }

    const setAbortController = (currentSessionId: string | undefined, controller: AbortController | null) => {
        getCurrentStreamState(currentSessionId).abortController = controller
    }

    // 设置指定会话的 AbortController
    const setAbortControllerForSession = (sessionId: string, controller: AbortController | null) => {
        getStreamState(sessionId).abortController = controller
    }

    // 保存当前会话的消息到缓存
    const saveMessagesToCache = (sessionId: string, currentMessages: UnifiedChatMessage[]) => {
        const state = getStreamState(sessionId)
        state.cachedMessages = [...currentMessages]
    }

    // 添加消息到指定会话（无论是否是当前会话）
    const addMessageToSession = (
        sessionId: string,
        message: UnifiedChatMessage,
        currentSessionId: string | undefined,
        messagesRef: { value: UnifiedChatMessage[] }
    ) => {
        const state = getStreamState(sessionId)
        const effectiveCurrentSessionId = currentSessionId || '__new__'

        if (effectiveCurrentSessionId === sessionId) {
            // 当前会话，直接添加到 messages
            messagesRef.value.push(message)
            state.cachedMessages = [...messagesRef.value]
        } else {
            // 非当前会话，添加到缓存
            state.cachedMessages.push(message)
            state.pendingMessage = null
        }
        streamStateVersion.value++
    }

    return {
        sessionStreamStates,
        streamStateVersion,
        knowledgeEnhancedMode,
        isRetrieving,
        getStreamState,
        getCurrentStreamState,
        getIsLoading,
        getStreamingContent,
        setLoading,
        setStreamingContent,
        setLoadingForSession,
        setStreamingContentForSession,
        getAbortController,
        setAbortController,
        setAbortControllerForSession,
        saveMessagesToCache,
        addMessageToSession
    }
}
