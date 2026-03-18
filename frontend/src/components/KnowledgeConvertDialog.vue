<template>
  <el-dialog :model-value="visible" @update:model-value="$emit('update:visible', $event)" title="转化为知识条目" width="650px" destroy-on-close>
    <el-alert type="info" :closable="false" show-icon style="margin-bottom:16px">
      将 {{ messages.length }} 条收藏消息转化为知识条目，存入 Prompt 知识库供 AI 检索使用。
    </el-alert>

    <el-form :model="form" label-width="100px">
      <el-form-item label="知识标题" required>
        <el-input v-model="form.title" placeholder="为这条知识起个标题" />
      </el-form-item>
      <el-form-item label="类别">
        <el-select v-model="form.category" placeholder="选择类别" style="width:100%">
          <el-option label="通用经验" value="general" />
          <el-option label="诊断方法" value="diagnostic" />
          <el-option label="修复方案" value="remediation" />
          <el-option label="配置模板" value="configuration" />
          <el-option label="最佳实践" value="best_practice" />
        </el-select>
      </el-form-item>
      <el-form-item label="内容预览">
        <el-input v-model="form.content" type="textarea" :rows="8" placeholder="知识内容（已自动从收藏消息提取）" />
      </el-form-item>
      <el-form-item label="适用设备">
        <el-select v-model="form.deviceTypes" multiple placeholder="留空表示通用" style="width:100%">
          <el-option label="RouterOS" value="routeros" />
          <el-option label="Linux" value="linux" />
          <el-option label="SNMP 设备" value="snmp" />
          <el-option label="API 设备" value="api" />
        </el-select>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button type="primary" :loading="converting" @click="convert">转化</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/api/index'

const props = defineProps<{
  visible: boolean
  messages: Array<{ id: string; content: string; sessionTitle?: string }>
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'converted': []
}>()

const converting = ref(false)
const form = reactive({
  title: '',
  category: 'general',
  content: '',
  deviceTypes: [] as string[],
})

watch(() => props.messages, (msgs) => {
  if (msgs.length === 1) {
    form.title = `来自对话: ${msgs[0].sessionTitle || '会话'}`
    form.content = msgs[0].content
  } else if (msgs.length > 1) {
    form.title = `批量转化 (${msgs.length} 条)`
    form.content = msgs.map(m => m.content).join('\n\n---\n\n')
  }
}, { immediate: true })

async function convert() {
  if (!form.title || !form.content) {
    ElMessage.warning('请填写标题和内容')
    return
  }
  converting.value = true
  try {
    await api.post('/ai-ops/knowledge/convert', {
      title: form.title,
      category: form.category,
      content: form.content,
      deviceTypes: form.deviceTypes,
      sourceMessageIds: props.messages.map(m => m.id),
    })
    ElMessage.success('知识转化成功')
    emit('update:visible', false)
    emit('converted')
  } catch {
    ElMessage.error('转化失败')
  } finally {
    converting.value = false
  }
}
</script>
