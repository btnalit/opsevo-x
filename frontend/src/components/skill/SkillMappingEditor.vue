<template>
  <div class="skill-mapping-editor">
    <!-- Header -->
    <div class="editor-header">
      <div class="header-left">
        <el-icon :size="24" color="#409eff"><i-ep-connection /></el-icon>
        <span class="header-title">意图-Skill 映射配置</span>
      </div>
      <div class="header-actions">
        <el-button type="primary" :icon="Plus" @click="showAddMappingDialog('intent')">
          添加意图映射
        </el-button>
        <el-button :icon="Plus" @click="showAddMappingDialog('keyword')">
          添加关键词映射
        </el-button>
        <el-button :icon="Refresh" :loading="loading" @click="loadMappingConfig">
          刷新
        </el-button>
        <el-button type="success" :icon="Download" @click="exportConfig">
          导出
        </el-button>
        <el-button :icon="Upload" @click="showImportDialog">
          导入
        </el-button>
      </div>
    </div>

    <!-- Config Cards -->
    <el-row :gutter="16" class="config-cards">
      <el-col :span="8">
        <el-card shadow="hover" class="config-card">
          <div class="config-item">
            <span class="config-label">默认 Skill</span>
            <el-select v-model="config.defaultSkill" @change="saveConfig">
              <el-option
                v-for="skill in availableSkills"
                :key="skill.name"
                :label="skill.name"
                :value="skill.name"
              />
            </el-select>
          </div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover" class="config-card">
          <div class="config-item">
            <span class="config-label">语义匹配阈值</span>
            <el-slider
              v-model="config.semanticMatchThreshold"
              :min="0"
              :max="1"
              :step="0.05"
              show-input
              @change="saveConfig"
            />
          </div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover" class="config-card">
          <div class="config-item">
            <span class="config-label">上下文延续阈值</span>
            <el-slider
              v-model="config.contextContinuationThreshold"
              :min="0"
              :max="1"
              :step="0.05"
              show-input
              @change="saveConfig"
            />
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- Main Content -->
    <el-card class="main-card" shadow="hover">
      <el-tabs v-model="activeTab">
        <!-- Intent Mapping Tab -->
        <el-tab-pane label="意图映射" name="intent">
          <el-table :data="intentMappingList" stripe style="width: 100%">
            <el-table-column prop="intent" label="意图类型" width="200">
              <template #default="{ row }">
                <el-tag type="primary">{{ row.intent }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="skill" label="映射 Skill" width="200">
              <template #default="{ row }">
                <el-select
                  v-model="row.skill"
                  size="small"
                  @change="updateIntentMapping(row.intent, row.skill)"
                >
                  <el-option
                    v-for="skill in availableSkills"
                    :key="skill.name"
                    :label="skill.name"
                    :value="skill.name"
                  />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="Skill 描述">
              <template #default="{ row }">
                <span class="skill-description">{{ getSkillDescription(row.skill) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120" align="center">
              <template #default="{ row }">
                <el-button
                  type="danger"
                  size="small"
                  text
                  :icon="Delete"
                  @click="deleteIntentMapping(row.intent)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- Keyword Mapping Tab -->
        <el-tab-pane label="关键词映射" name="keyword">
          <el-table :data="keywordMappingList" stripe style="width: 100%">
            <el-table-column prop="keyword" label="关键词" width="200">
              <template #default="{ row }">
                <el-tag type="warning">{{ row.keyword }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="skill" label="映射 Skill" width="200">
              <template #default="{ row }">
                <el-select
                  v-model="row.skill"
                  size="small"
                  @change="updateKeywordMapping(row.keyword, row.skill)"
                >
                  <el-option
                    v-for="skill in availableSkills"
                    :key="skill.name"
                    :label="skill.name"
                    :value="skill.name"
                  />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="Skill 描述">
              <template #default="{ row }">
                <span class="skill-description">{{ getSkillDescription(row.skill) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120" align="center">
              <template #default="{ row }">
                <el-button
                  type="danger"
                  size="small"
                  text
                  :icon="Delete"
                  @click="deleteKeywordMapping(row.keyword)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- Test Tab -->
        <el-tab-pane label="匹配测试" name="test">
          <div class="test-panel">
            <el-form :inline="true" class="test-form">
              <el-form-item label="测试消息">
                <el-input
                  v-model="testMessage"
                  placeholder="输入测试消息..."
                  style="width: 400px"
                  @keyup.enter="runMatchTest"
                />
              </el-form-item>
              <el-form-item>
                <el-button type="primary" :loading="testing" @click="runMatchTest">
                  测试匹配
                </el-button>
              </el-form-item>
            </el-form>

            <div v-if="testResult" class="test-result">
              <el-descriptions :column="2" border>
                <el-descriptions-item label="匹配 Skill">
                  <el-tag type="success">{{ testResult.skill }}</el-tag>
                </el-descriptions-item>
                <el-descriptions-item label="匹配类型">
                  <el-tag :type="getMatchTypeTagType(testResult.matchType)">
                    {{ testResult.matchType }}
                  </el-tag>
                </el-descriptions-item>
                <el-descriptions-item label="置信度">
                  <el-progress
                    :percentage="Math.round(testResult.confidence * 100)"
                    :stroke-width="10"
                    :color="getConfidenceColor(testResult.confidence)"
                  />
                </el-descriptions-item>
                <el-descriptions-item label="匹配原因">
                  {{ testResult.matchReason }}
                </el-descriptions-item>
              </el-descriptions>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- Add Mapping Dialog -->
    <el-dialog
      v-model="addDialogVisible"
      :title="addDialogType === 'intent' ? '添加意图映射' : '添加关键词映射'"
      width="500px"
      destroy-on-close
    >
      <el-form ref="addFormRef" :model="addFormData" :rules="addFormRules" label-width="100px">
        <el-form-item
          :label="addDialogType === 'intent' ? '意图类型' : '关键词'"
          prop="key"
        >
          <el-input
            v-if="addDialogType === 'keyword'"
            v-model="addFormData.key"
            placeholder="输入关键词"
          />
          <el-select
            v-else
            v-model="addFormData.key"
            filterable
            allow-create
            placeholder="选择或输入意图类型"
            style="width: 100%"
          >
            <el-option label="TROUBLESHOOTING" value="TROUBLESHOOTING" />
            <el-option label="CONFIGURATION" value="CONFIGURATION" />
            <el-option label="MONITORING" value="MONITORING" />
            <el-option label="HISTORICAL_ANALYSIS" value="HISTORICAL_ANALYSIS" />
            <el-option label="SECURITY_AUDIT" value="SECURITY_AUDIT" />
            <el-option label="OPTIMIZATION" value="OPTIMIZATION" />
            <el-option label="GENERAL" value="GENERAL" />
          </el-select>
        </el-form-item>
        <el-form-item label="映射 Skill" prop="skill">
          <el-select v-model="addFormData.skill" placeholder="选择 Skill" style="width: 100%">
            <el-option
              v-for="skill in availableSkills"
              :key="skill.name"
              :label="`${skill.name} - ${skill.description}`"
              :value="skill.name"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doAddMapping">添加</el-button>
      </template>
    </el-dialog>

    <!-- Import Dialog -->
    <el-dialog v-model="importDialogVisible" title="导入映射配置" width="600px" destroy-on-close>
      <el-form label-width="100px">
        <el-form-item label="JSON 配置">
          <el-input
            v-model="importData"
            type="textarea"
            :rows="12"
            placeholder="粘贴 JSON 配置数据"
          />
        </el-form-item>
        <el-form-item label="合并模式">
          <el-radio-group v-model="importMergeMode">
            <el-radio value="merge">合并（保留现有）</el-radio>
            <el-radio value="replace">替换（覆盖现有）</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="importDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="importing" @click="doImport">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Plus, Refresh, Download, Upload, Delete } from '@element-plus/icons-vue'

import { ref, computed, onMounted, reactive } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import api from '@/api'

// Types
interface MappingConfig {
  intentMapping: Record<string, string>
  keywordMapping: Record<string, string>
  defaultSkill: string
  semanticMatchThreshold: number
  contextContinuationThreshold: number
}

interface SkillSummary {
  name: string
  description: string
}

interface MatchTestResult {
  skill: string
  confidence: number
  matchType: string
  matchReason: string
}

// State
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const importing = ref(false)
const activeTab = ref('intent')

const config = reactive<MappingConfig>({
  intentMapping: {},
  keywordMapping: {},
  defaultSkill: 'generalist',
  semanticMatchThreshold: 0.6,
  contextContinuationThreshold: 0.75,
})

const availableSkills = ref<SkillSummary[]>([])
const testMessage = ref('')
const testResult = ref<MatchTestResult | null>(null)

// Dialogs
const addDialogVisible = ref(false)
const addDialogType = ref<'intent' | 'keyword'>('intent')
const importDialogVisible = ref(false)
const importData = ref('')
const importMergeMode = ref<'merge' | 'replace'>('merge')

// Form
const addFormRef = ref<FormInstance>()
const addFormData = reactive({
  key: '',
  skill: '',
})

const addFormRules: FormRules = {
  key: [{ required: true, message: '请输入', trigger: 'blur' }],
  skill: [{ required: true, message: '请选择 Skill', trigger: 'change' }],
}

// Computed
const intentMappingList = computed(() => {
  return Object.entries(config.intentMapping).map(([intent, skill]) => ({
    intent,
    skill,
  }))
})

const keywordMappingList = computed(() => {
  return Object.entries(config.keywordMapping).map(([keyword, skill]) => ({
    keyword,
    skill,
  }))
})

// Lifecycle
onMounted(() => {
  loadMappingConfig()
  loadSkills()
})

// API calls
const loadMappingConfig = async () => {
  loading.value = true
  try {
    const response = await api.get('/skills/mapping')
    if (response.data.success) {
      Object.assign(config, response.data.data)
    }
  } catch (err) {
    ElMessage.error('加载映射配置失败')
  } finally {
    loading.value = false
  }
}

const loadSkills = async () => {
  try {
    const response = await api.get('/skills')
    if (response.data.success) {
      availableSkills.value = response.data.data.map((s: SkillSummary) => ({
        name: s.name,
        description: s.description,
      }))
    }
  } catch (err) {
    console.error('Failed to load skills:', err)
  }
}

const saveConfig = async () => {
  saving.value = true
  try {
    await api.put('/skills/mapping', config)
    ElMessage.success('配置已保存')
  } catch (err) {
    ElMessage.error('保存失败')
  } finally {
    saving.value = false
  }
}

const updateIntentMapping = async (intent: string, skill: string) => {
  config.intentMapping[intent] = skill
  await saveConfig()
}

const updateKeywordMapping = async (keyword: string, skill: string) => {
  config.keywordMapping[keyword] = skill
  await saveConfig()
}

const deleteIntentMapping = async (intent: string) => {
  delete config.intentMapping[intent]
  await saveConfig()
  ElMessage.success('已删除')
}

const deleteKeywordMapping = async (keyword: string) => {
  delete config.keywordMapping[keyword]
  await saveConfig()
  ElMessage.success('已删除')
}

const showAddMappingDialog = (type: 'intent' | 'keyword') => {
  addDialogType.value = type
  addFormData.key = ''
  addFormData.skill = ''
  addDialogVisible.value = true
}

const doAddMapping = async () => {
  if (!addFormRef.value) return
  try {
    await addFormRef.value.validate()
  } catch {
    return
  }

  // Check for conflicts
  if (addDialogType.value === 'intent') {
    if (config.intentMapping[addFormData.key]) {
      ElMessage.warning('该意图类型已存在映射')
      return
    }
    config.intentMapping[addFormData.key] = addFormData.skill
  } else {
    if (config.keywordMapping[addFormData.key]) {
      ElMessage.warning('该关键词已存在映射')
      return
    }
    config.keywordMapping[addFormData.key] = addFormData.skill
  }

  await saveConfig()
  addDialogVisible.value = false
  ElMessage.success('添加成功')
}

const runMatchTest = async () => {
  if (!testMessage.value.trim()) {
    ElMessage.warning('请输入测试消息')
    return
  }

  testing.value = true
  testResult.value = null
  try {
    const response = await api.post('/skills/test-match', {
      message: testMessage.value,
    })
    if (response.data.success) {
      testResult.value = response.data.data
    }
  } catch (err) {
    ElMessage.error('测试失败')
  } finally {
    testing.value = false
  }
}

const exportConfig = () => {
  const data = JSON.stringify(config, null, 2)
  const blob = new Blob([data], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'skill-mapping-config.json'
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success('导出成功')
}

const showImportDialog = () => {
  importData.value = ''
  importMergeMode.value = 'merge'
  importDialogVisible.value = true
}

const doImport = async () => {
  if (!importData.value.trim()) {
    ElMessage.warning('请输入配置数据')
    return
  }

  importing.value = true
  try {
    const importedConfig = JSON.parse(importData.value)

    if (importMergeMode.value === 'merge') {
      // Merge mode
      if (importedConfig.intentMapping) {
        Object.assign(config.intentMapping, importedConfig.intentMapping)
      }
      if (importedConfig.keywordMapping) {
        Object.assign(config.keywordMapping, importedConfig.keywordMapping)
      }
      if (importedConfig.defaultSkill) {
        config.defaultSkill = importedConfig.defaultSkill
      }
      if (importedConfig.semanticMatchThreshold !== undefined) {
        config.semanticMatchThreshold = importedConfig.semanticMatchThreshold
      }
      if (importedConfig.contextContinuationThreshold !== undefined) {
        config.contextContinuationThreshold = importedConfig.contextContinuationThreshold
      }
    } else {
      // Replace mode
      Object.assign(config, importedConfig)
    }

    await saveConfig()
    importDialogVisible.value = false
    ElMessage.success('导入成功')
  } catch (err) {
    ElMessage.error('JSON 格式错误')
  } finally {
    importing.value = false
  }
}

// Utilities
const getSkillDescription = (skillName: string): string => {
  const skill = availableSkills.value.find(s => s.name === skillName)
  return skill?.description || '-'
}

const getMatchTypeTagType = (matchType: string): 'success' | 'warning' | 'primary' | 'info' | 'danger' => {
  const typeMap: Record<string, 'success' | 'warning' | 'primary' | 'info' | 'danger'> = {
    explicit: 'success',
    trigger: 'warning',
    intent: 'primary',
    semantic: 'info',
    context: 'info',
    fallback: 'danger',
  }
  return typeMap[matchType] || 'info'
}

const getConfidenceColor = (confidence: number): string => {
  if (confidence >= 0.8) return '#67c23a'
  if (confidence >= 0.5) return '#e6a23c'
  return '#f56c6c'
}
</script>

<style scoped>
.skill-mapping-editor {
  padding: 20px;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
  padding: 16px 20px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  color: #303133;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.config-cards {
  margin-bottom: 20px;
}

.config-card {
  height: 100%;
}

.config-item {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.config-label {
  font-size: 14px;
  font-weight: 500;
  color: #606266;
}

.main-card {
  margin-bottom: 20px;
}

.skill-description {
  color: #909399;
  font-size: 13px;
}

.test-panel {
  padding: 20px 0;
}

.test-form {
  margin-bottom: 20px;
}

.test-result {
  margin-top: 20px;
  padding: 16px;
  background: #f5f7fa;
  border-radius: 8px;
}
</style>
