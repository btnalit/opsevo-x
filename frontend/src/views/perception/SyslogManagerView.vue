<template>
  <div class="syslog-manager-view">
    <el-tabs v-model="activeTab" type="border-card">
      <!-- Tab 1: 服务状态 & 来源管理 -->
      <el-tab-pane label="服务状态 & 来源" name="sources">
        <el-card shadow="never" class="status-card">
          <template #header><span>Syslog 服务状态</span></template>
          <el-descriptions :column="4" border>
            <el-descriptions-item label="运行状态">
              <el-tag :type="status.running ? 'success' : 'danger'" size="small">
                {{ status.running ? '运行中' : '已停止' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="UDP 端口">{{ status.udpPort || '-' }}</el-descriptions-item>
            <el-descriptions-item label="TCP 端口">{{ status.tcpPort || '-' }}</el-descriptions-item>
            <el-descriptions-item label="消息总数">{{ status.messageCount }}</el-descriptions-item>
          </el-descriptions>
        </el-card>

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <div class="card-header">
              <span>来源列表</span>
              <el-button type="primary" size="small" @click="showSourceDialog()">添加来源</el-button>
            </div>
          </template>
          <el-table :data="sources" v-loading="loading" stripe>
            <el-table-column prop="source_ip" label="来源 IP" min-width="140" />
            <el-table-column prop="source_cidr" label="CIDR" width="140" />
            <el-table-column prop="device_id" label="关联设备" width="140" />
            <el-table-column prop="description" label="描述" min-width="160" show-overflow-tooltip />
            <el-table-column prop="created_at" label="创建时间" width="170">
              <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" size="small" link @click="showSourceDialog(row)">编辑</el-button>
                <el-popconfirm title="确定删除？" @confirm="deleteSource(row.id)">
                  <template #reference>
                    <el-button type="danger" size="small" link>删除</el-button>
                  </template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- Tab 2: 解析规则 -->
      <el-tab-pane label="解析规则" name="rules">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>解析规则</span>
              <el-button type="primary" size="small" @click="showRuleDialog()">添加规则</el-button>
            </div>
          </template>
          <el-table :data="rules" v-loading="loading" stripe>
            <el-table-column prop="name" label="规则名称" min-width="140" />
            <el-table-column prop="type" label="类型" width="100">
              <template #default="{ row }">
                <el-tag size="small">{{ row.type }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="pattern" label="匹配模式" min-width="200" show-overflow-tooltip />
            <el-table-column prop="priority" label="优先级" width="80" align="center" />
            <el-table-column label="状态" width="80" align="center">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
                  {{ row.enabled ? '启用' : '禁用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button type="success" size="small" link @click="testRule(row)">测试</el-button>
                <el-button type="primary" size="small" link @click="showRuleDialog(row)">编辑</el-button>
                <el-popconfirm title="确定删除？" @confirm="deleteRule(row.id)">
                  <template #reference>
                    <el-button type="danger" size="small" link>删除</el-button>
                  </template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- Tab 3: 过滤规则 -->
      <el-tab-pane label="过滤规则" name="filters">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>过滤规则</span>
              <el-button type="primary" size="small" @click="showFilterDialog()">添加过滤</el-button>
            </div>
          </template>
          <el-table :data="filters" v-loading="loading" stripe>
            <el-table-column prop="name" label="规则名称" min-width="140" />
            <el-table-column prop="source_ip" label="来源 IP" width="140" />
            <el-table-column prop="facility" label="Facility" width="120" />
            <el-table-column prop="severity" label="Severity" width="100" />
            <el-table-column prop="keyword" label="关键词" min-width="140" show-overflow-tooltip />
            <el-table-column prop="action" label="动作" width="100">
              <template #default="{ row }">
                <el-tag :type="row.action === 'accept' ? 'success' : 'danger'" size="small">
                  {{ row.action === 'accept' ? '接受' : '丢弃' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- 来源编辑对话框 -->
    <el-dialog v-model="sourceDialogVisible" :title="editingSource ? '编辑来源' : '添加来源'" width="480px" destroy-on-close>
      <el-form :model="sourceForm" label-width="90px">
        <el-form-item label="来源 IP" required>
          <el-input v-model="sourceForm.source_ip" placeholder="如 192.168.1.1" />
        </el-form-item>
        <el-form-item label="CIDR">
          <el-input v-model="sourceForm.source_cidr" placeholder="如 192.168.1.0/24" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="sourceForm.description" placeholder="来源描述" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="sourceDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveSource">保存</el-button>
      </template>
    </el-dialog>

    <!-- 规则编辑对话框 -->
    <el-dialog v-model="ruleDialogVisible" :title="editingRule ? '编辑规则' : '添加规则'" width="520px" destroy-on-close>
      <el-form :model="ruleForm" label-width="90px">
        <el-form-item label="规则名称" required>
          <el-input v-model="ruleForm.name" />
        </el-form-item>
        <el-form-item label="类型" required>
          <el-select v-model="ruleForm.type" style="width: 100%">
            <el-option label="正则表达式" value="regex" />
            <el-option label="Grok" value="grok" />
          </el-select>
        </el-form-item>
        <el-form-item label="匹配模式" required>
          <el-input v-model="ruleForm.pattern" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="优先级">
          <el-input-number v-model="ruleForm.priority" :min="0" :max="100" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="ruleForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveRule">保存</el-button>
      </template>
    </el-dialog>

    <!-- 过滤编辑对话框 -->
    <el-dialog v-model="filterDialogVisible" title="添加过滤规则" width="480px" destroy-on-close>
      <el-form :model="filterForm" label-width="90px">
        <el-form-item label="规则名称" required>
          <el-input v-model="filterForm.name" />
        </el-form-item>
        <el-form-item label="来源 IP">
          <el-input v-model="filterForm.source_ip" placeholder="可选" />
        </el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="filterForm.keyword" placeholder="可选" />
        </el-form-item>
        <el-form-item label="动作" required>
          <el-select v-model="filterForm.action" style="width: 100%">
            <el-option label="接受" value="accept" />
            <el-option label="丢弃" value="drop" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="filterDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveFilter">保存</el-button>
      </template>
    </el-dialog>

    <!-- 规则测试对话框 -->
    <el-dialog v-model="testDialogVisible" title="测试解析规则" width="520px" destroy-on-close>
      <el-form label-width="90px">
        <el-form-item label="测试消息">
          <el-input v-model="testMessage" type="textarea" :rows="3" placeholder="输入 Syslog 消息进行测试" />
        </el-form-item>
        <el-form-item label="测试结果" v-if="testResult">
          <el-tag :type="testResult.matched ? 'success' : 'danger'">
            {{ testResult.matched ? '匹配成功' : '未匹配' }}
          </el-tag>
          <pre v-if="testResult.result" class="test-result-pre">{{ JSON.stringify(testResult.result, null, 2) }}</pre>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="testDialogVisible = false">关闭</el-button>
        <el-button type="primary" @click="executeTest">执行测试</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  syslogApi,
  type SyslogStatus,
  type SyslogSource,
  type SyslogParseRule,
  type SyslogFilter,
} from '@/api/perception'

defineOptions({ name: 'SyslogManagerView' })

const activeTab = ref('sources')
const loading = ref(false)
const status = reactive<SyslogStatus>({ running: false, udpPort: 0, tcpPort: 0, messageCount: 0 })
const sources = ref<SyslogSource[]>([])
const rules = ref<SyslogParseRule[]>([])
const filters = ref<SyslogFilter[]>([])

// Source dialog
const sourceDialogVisible = ref(false)
const editingSource = ref<SyslogSource | null>(null)
const sourceForm = reactive({ source_ip: '', source_cidr: '', description: '' })

// Rule dialog
const ruleDialogVisible = ref(false)
const editingRule = ref<SyslogParseRule | null>(null)
const ruleForm = reactive({ name: '', type: 'regex' as const, pattern: '', priority: 0, enabled: true })

// Filter dialog
const filterDialogVisible = ref(false)
const filterForm = reactive({ name: '', source_ip: '', keyword: '', action: 'accept' as const })

// Test dialog
const testDialogVisible = ref(false)
const testMessage = ref('')
const testResult = ref<{ matched: boolean; result?: Record<string, string> } | null>(null)
let testingRuleId = ''

const formatTime = (ts: string) => ts ? new Date(ts).toLocaleString('zh-CN') : '-'

async function loadAll() {
  loading.value = true
  try {
    const [statusRes, sourcesRes, rulesRes, filtersRes] = await Promise.all([
      syslogApi.getStatus(), syslogApi.listSources(), syslogApi.listRules(), syslogApi.listFilters(),
    ])
    if (statusRes.data.data) Object.assign(status, statusRes.data.data)
    if (sourcesRes.data.data) sources.value = sourcesRes.data.data
    if (rulesRes.data.data) rules.value = rulesRes.data.data
    if (filtersRes.data.data) filters.value = filtersRes.data.data
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败')
  } finally {
    loading.value = false
  }
}

function showSourceDialog(row?: SyslogSource) {
  editingSource.value = row || null
  sourceForm.source_ip = row?.source_ip || ''
  sourceForm.source_cidr = row?.source_cidr || ''
  sourceForm.description = row?.description || ''
  sourceDialogVisible.value = true
}

async function saveSource() {
  try {
    if (editingSource.value) {
      await syslogApi.updateSource(editingSource.value.id, sourceForm)
    } else {
      await syslogApi.createSource(sourceForm)
    }
    sourceDialogVisible.value = false
    ElMessage.success('保存成功')
    loadAll()
  } catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '保存失败') }
}

async function deleteSource(id: string) {
  try { await syslogApi.deleteSource(id); ElMessage.success('已删除'); loadAll() }
  catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '删除失败') }
}

function showRuleDialog(row?: SyslogParseRule) {
  editingRule.value = row || null
  ruleForm.name = row?.name || ''
  ruleForm.type = row?.type || 'regex'
  ruleForm.pattern = row?.pattern || ''
  ruleForm.priority = row?.priority || 0
  ruleForm.enabled = row?.enabled ?? true
  ruleDialogVisible.value = true
}

async function saveRule() {
  try {
    if (editingRule.value) {
      await syslogApi.updateRule(editingRule.value.id, ruleForm)
    } else {
      await syslogApi.createRule(ruleForm)
    }
    ruleDialogVisible.value = false
    ElMessage.success('保存成功')
    loadAll()
  } catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '保存失败') }
}

async function deleteRule(id: string) {
  try { await syslogApi.deleteRule(id); ElMessage.success('已删除'); loadAll() }
  catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '删除失败') }
}

function testRule(row: SyslogParseRule) {
  testingRuleId = row.id
  testMessage.value = ''
  testResult.value = null
  testDialogVisible.value = true
}

async function executeTest() {
  try {
    const res = await syslogApi.testRule(testingRuleId, testMessage.value)
    testResult.value = res.data.data || { matched: false }
  } catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '测试失败') }
}

function showFilterDialog() { filterDialogVisible.value = true }

async function saveFilter() {
  try {
    await syslogApi.createFilter(filterForm)
    filterDialogVisible.value = false
    ElMessage.success('保存成功')
    loadAll()
  } catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '保存失败') }
}

onMounted(loadAll)
</script>

<style scoped>
.syslog-manager-view { height: 100%; padding: 20px; overflow-y: auto; background: var(--el-bg-color-page); }
.status-card { margin-bottom: 0; }
.card-header { display: flex; align-items: center; justify-content: space-between; }
.test-result-pre { margin-top: 8px; padding: 8px; background: var(--el-fill-color-light); border-radius: 4px; font-size: 12px; white-space: pre-wrap; }
</style>
