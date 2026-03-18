<template>
  <div class="chat-header">
    <div class="header-left">
      <el-icon :size="24" color="var(--el-color-primary)"><i-ep-chat-dot-round /></el-icon>
      <span class="header-title">统一 AI 助手</span>
      <el-tag v-if="currentConfig" type="success" size="small">
        {{ currentConfigDisplayName }} - {{ currentConfig.model }}
      </el-tag>
      <el-tag 
        :type="knowledgeEnhancedMode ? 'warning' : 'info'" 
        size="small"
        effect="dark"
      >
        {{ knowledgeEnhancedMode ? '知识增强' : '标准模式' }}
      </el-tag>
    </div>
    <div class="header-actions">
      <el-badge 
        v-if="hasCurrentSession" 
        :value="collectedMessagesCount" 
        :hidden="collectedMessagesCount === 0"
        type="warning"
      >
        <el-button
          :icon="StarFilled"
          size="small"
          @click="$emit('open-collected')"
        >
          已收藏
        </el-button>
      </el-badge>
      
      <el-select
        :model-value="selectedConfigId"
        placeholder="选择 AI 配置"
        size="small"
        style="width: 180px"
        @update:model-value="$emit('update:selectedConfigId', String($event))"
        @change="$emit('config-change')"
      >
        <el-option
          v-for="config in configs"
          :key="config.id"
          :label="`${config.name} (${getProviderDisplayName(config.provider)})`"
          :value="config.id"
        />
      </el-select>
      
      <el-tooltip :content="knowledgeEnhancedMode ? '关闭知识增强模式' : '开启知识增强模式'" placement="top">
        <el-switch
          :model-value="knowledgeEnhancedMode"
          @update:model-value="$emit('update:knowledgeEnhancedMode', Boolean($event))"
          active-text="知识增强"
          inactive-text=""
          size="small"
          :active-icon="Collection"
          :inactive-icon="ChatLineSquare"
          style="--el-switch-on-color: var(--el-color-primary)"
        />
      </el-tooltip>
      
      <el-tooltip content="包含 RouterOS 上下文" placement="top">
        <el-switch
          :model-value="includeContext"
          @update:model-value="$emit('update:includeContext', Boolean($event))"
          active-text="上下文"
          size="small"
        />
      </el-tooltip>
      
      <el-button
        :icon="Delete"
        size="small"
        @click="$emit('clear-messages')"
        :disabled="!hasMessages"
      >
        清空对话
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { StarFilled, Collection, ChatLineSquare, Delete } from '@element-plus/icons-vue'
import { type APIConfigDisplay, AIProvider } from '@/api/ai'

const props = defineProps<{
  currentConfig: APIConfigDisplay | null
  knowledgeEnhancedMode: boolean
  includeContext: boolean
  selectedConfigId: string
  configs: APIConfigDisplay[]
  hasMessages: boolean
  collectedMessagesCount: number
  hasCurrentSession: boolean
}>()

defineEmits<{
  (e: 'update:knowledgeEnhancedMode', value: boolean): void
  (e: 'update:includeContext', value: boolean): void
  (e: 'update:selectedConfigId', value: string): void
  (e: 'open-collected'): void
  (e: 'clear-messages'): void
  (e: 'config-change'): void
}>()

const PROVIDER_DISPLAY_NAMES: Record<AIProvider, string> = {
  [AIProvider.OPENAI]: 'OpenAI',
  [AIProvider.GEMINI]: 'Gemini',
  [AIProvider.CLAUDE]: 'Claude',
  [AIProvider.DEEPSEEK]: 'DeepSeek',
  [AIProvider.QWEN]: 'Qwen',
  [AIProvider.ZHIPU]: '智谱AI',
  [AIProvider.CUSTOM]: '自定义'
}

const getProviderDisplayName = (provider: AIProvider): string => {
  return PROVIDER_DISPLAY_NAMES[provider] || provider
}

const currentConfigDisplayName = computed(() => {
  return props.currentConfig ? getProviderDisplayName(props.currentConfig.provider) : ''
})
</script>

<style scoped>
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-bg-color-overlay);
  border-radius: var(--el-border-radius-base) var(--el-border-radius-base) 0 0;
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: nowrap;
}

@media (max-width: 1200px) {
  .header-actions {
    gap: 8px;
  }
  .header-title {
    display: none;
  }
}
</style>
