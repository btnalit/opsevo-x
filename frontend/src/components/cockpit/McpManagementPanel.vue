<template>
  <el-drawer
    :model-value="visible"
    title="MCP 管理面板"
    direction="rtl"
    size="560px"
    @update:model-value="$emit('update:visible', $event)"
  >
    <el-tabs v-model="activeTab" type="border-card">
      <!-- ── MCP Server 标签页 ── -->
      <el-tab-pane label="MCP Server" name="server">
        <!-- 运行状态卡片 -->
        <el-card shadow="never" class="mcp-status-card">
          <template #header><span>服务状态</span></template>
          <el-descriptions :column="2" size="small" border>
            <el-descriptions-item label="状态">
              <el-tag :type="serverStatus.enabled ? 'success' : 'info'" size="small">
                {{ serverStatus.enabled ? '运行中' : '已停止' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="传输">{{ serverStatus.transport }}</el-descriptions-item>
            <el-descriptions-item label="端点">{{ serverStatus.endpoint }}</el-descriptions-item>
            <el-descriptions-item label="版本">{{ serverStatus.version }}</el-descriptions-item>
          </el-descriptions>
        </el-card>

        <!-- API Key 管理 -->
        <div class="mcp-section">
          <div class="mcp-section-header">
            <span>API Keys</span>
            <el-button type="primary" size="small" @click="showCreateKeyDialog = true">
              创建 Key
            </el-button>
          </div>
          <el-table :data="apiKeys" size="small" stripe style="width: 100%">
            <el-table-column prop="label" label="标签" min-width="100" />
            <el-table-column prop="role" label="角色" width="90">
              <template #default="{ row }">
                <el-tag :type="roleTagType(row.role)" size="small">{{ row.role }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="keyPrefix" label="前缀" width="90" />
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small">
                  {{ row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="创建时间" width="140">
              <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="80" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="row.status === 'active'"
                  type="danger"
                  size="small"
                  link
                  @click="confirmRevokeKey(row)"
                >撤销</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ── MCP Client 标签页 ── -->
      <el-tab-pane label="MCP Client" name="client">
        <div class="mcp-section">
          <div class="mcp-section-header">
            <span>外部 MCP Servers</span>
            <el-button type="primary" size="small" @click="showAddServerDialog = true">
              添加 Server
            </el-button>
          </div>
          <el-table :data="clientServers" size="small" stripe style="width: 100%">
            <el-table-column prop="name" label="名称" min-width="120" />
            <el-table-column prop="transport" label="传输" width="70" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="connStatusType(row.connectionStatus)" size="small">
                  {{ row.connectionStatus }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="toolCount" label="工具数" width="70" />
            <el-table-column label="启用" width="70">
              <template #default="{ row }">
                <el-switch
                  :model-value="row.enabled"
                  size="small"
                  @change="(val: string | number | boolean) => toggleServer(row.serverId, !!val)"
                />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button size="small" link @click="viewServerTools(row)">工具</el-button>
                <el-button type="danger" size="small" link @click="confirmRemoveServer(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <!-- Client 整体状态 -->
        <el-card shadow="never" class="mcp-status-card" style="margin-top: 16px">
          <template #header><span>连接状态</span></template>
          <div v-if="clientConnections.length === 0" class="mcp-empty">暂无连接</div>
          <el-descriptions
            v-for="conn in clientConnections"
            :key="conn.serverId"
            :column="2"
            size="small"
            border
            style="margin-bottom: 8px"
          >
            <el-descriptions-item label="Server">{{ conn.name }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="connStatusType(conn.status)" size="small">{{ conn.status }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="工具数">{{ conn.toolCount }}</el-descriptions-item>
            <el-descriptions-item label="健康">
              <el-tag :type="conn.healthy ? 'success' : 'danger'" size="small">
                {{ conn.healthy ? '健康' : '异常' }}
              </el-tag>
            </el-descriptions-item>
          </el-descriptions>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- 创建 API Key 对话框 -->
    <el-dialog v-model="showCreateKeyDialog" title="创建 API Key" width="400px" append-to-body>
      <el-form :model="newKeyForm" label-width="60px">
        <el-form-item label="标签">
          <el-input v-model="newKeyForm.label" placeholder="Key 用途描述" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="newKeyForm.role" style="width: 100%">
            <el-option label="viewer" value="viewer" />
            <el-option label="operator" value="operator" />
            <el-option label="admin" value="admin" />
          </el-select>
        </el-form-item>
        <el-form-item label="租户">
          <el-input v-model="newKeyForm.tenantId" placeholder="租户 ID" />
        </el-form-item>
      </el-form>
      <!-- 创建成功后显示明文 Key -->
      <div v-if="createdKeyPlaintext" style="margin-top: 12px">
        <el-alert type="success" :closable="false" show-icon title="Key 已创建，请立即保存（仅显示一次）" style="margin-bottom: 8px" />
        <el-input :model-value="createdKeyPlaintext" readonly style="font-family: monospace">
          <template #append>
            <el-button @click="copyKey">复制</el-button>
          </template>
        </el-input>
      </div>
      <template #footer>
        <el-button @click="showCreateKeyDialog = false; createdKeyPlaintext = ''">关闭</el-button>
        <el-button type="primary" :loading="creating" @click="createApiKey" :disabled="!!createdKeyPlaintext">
          创建
        </el-button>
      </template>
    </el-dialog>

    <!-- 添加外部 Server 对话框 -->
    <el-dialog v-model="showAddServerDialog" title="添加外部 MCP Server" width="500px" append-to-body>
      <el-form :model="newServerForm" label-width="90px">
        <el-form-item label="Server ID">
          <el-input v-model="newServerForm.serverId" placeholder="唯一标识符" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="newServerForm.name" placeholder="显示名称" />
        </el-form-item>
        <el-form-item label="传输方式">
          <el-select v-model="newServerForm.transport" style="width: 100%">
            <el-option label="stdio" value="stdio" />
            <el-option label="SSE" value="sse" />
            <el-option label="HTTP" value="http" />
          </el-select>
        </el-form-item>
        <!-- stdio 参数 -->
        <template v-if="newServerForm.transport === 'stdio'">
          <el-form-item label="命令">
            <el-input v-model="newServerForm.connectionParams.command" placeholder="如 npx" />
          </el-form-item>
          <el-form-item label="参数">
            <el-input v-model="stdioArgsStr" placeholder="空格分隔，如 -y @server/pkg" />
          </el-form-item>
        </template>
        <!-- SSE / HTTP 参数 -->
        <template v-if="newServerForm.transport === 'sse' || newServerForm.transport === 'http'">
          <el-form-item label="URL">
            <el-input v-model="newServerForm.connectionParams.url" placeholder="https://..." />
          </el-form-item>
        </template>
        <!-- OAuth 配置（可折叠） -->
        <el-collapse v-model="oauthCollapse" style="margin-top: 8px">
          <el-collapse-item title="OAuth 认证（可选）" name="oauth">
            <el-form-item label="Token URL">
              <el-input v-model="oauthForm.token_url" placeholder="https://auth.example.com/token" />
            </el-form-item>
            <el-form-item label="Grant Type">
              <el-select v-model="oauthForm.grant_type" style="width: 100%">
                <el-option label="client_credentials" value="client_credentials" />
                <el-option label="refresh_token" value="refresh_token" />
              </el-select>
            </el-form-item>
            <el-form-item label="Client ID">
              <el-input v-model="oauthForm.client_id" />
            </el-form-item>
            <el-form-item label="Secret">
              <el-input v-model="oauthForm.client_secret" type="password" show-password />
            </el-form-item>
            <el-form-item label="Scope">
              <el-input v-model="oauthForm.scope" placeholder="可选" />
            </el-form-item>
          </el-collapse-item>
        </el-collapse>
      </el-form>
      <template #footer>
        <el-button @click="showAddServerDialog = false">取消</el-button>
        <el-button type="primary" :loading="addingServer" @click="addServer">添加</el-button>
      </template>
    </el-dialog>

    <!-- Server 工具列表对话框 -->
    <el-dialog v-model="showToolsDialog" :title="`工具列表 — ${toolsDialogServer}`" width="500px" append-to-body>
      <el-table :data="serverToolsList" size="small" stripe max-height="400">
        <el-table-column prop="name" label="工具名称" min-width="160" />
        <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
      </el-table>
    </el-dialog>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/api'

defineProps<{ visible: boolean }>()
defineEmits<{ 'update:visible': [val: boolean] }>()

const activeTab = ref('server')

// ── MCP Server 状态 ──
const serverStatus = ref({ enabled: false, transport: '-', endpoint: '-', version: '-' })
const apiKeys = ref<any[]>([])

async function fetchServerStatus() {
  try {
    const { data } = await api.get('/ai-ops/mcp/server/status')
    if (data.success) serverStatus.value = data.status
  } catch (err) { console.warn('[McpPanel] fetchServerStatus failed:', err) }
}

async function fetchApiKeys() {
  try {
    const { data } = await api.get('/ai-ops/mcp/keys')
    if (data.success) apiKeys.value = data.data || []
  } catch (err) { console.warn('[McpPanel] fetchApiKeys failed:', err) }
}

// ── 创建 API Key ──
const showCreateKeyDialog = ref(false)
const creating = ref(false)
const createdKeyPlaintext = ref('')
const newKeyForm = ref({ tenantId: 'default', role: 'viewer', label: '' })

async function createApiKey() {
  if (!newKeyForm.value.label) {
    ElMessage.warning('请输入标签')
    return
  }
  creating.value = true
  try {
    const { data } = await api.post('/ai-ops/mcp/keys', newKeyForm.value)
    if (data.success) {
      createdKeyPlaintext.value = data.data?.key || data.data || ''
      await fetchApiKeys()
      ElMessage.success('API Key 已创建')
    }
  } catch (err: any) {
    ElMessage.error(err.message || '创建失败')
  } finally {
    creating.value = false
  }
}

function copyKey() {
  navigator.clipboard.writeText(createdKeyPlaintext.value)
  ElMessage.success('已复制到剪贴板')
}

function confirmRevokeKey(row: any) {
  ElMessageBox.confirm(`确认撤销 Key "${row.label}"？撤销后立即生效且不可恢复。`, '撤销确认', {
    type: 'warning',
  }).then(async () => {
    try {
      await api.delete(`/ai-ops/mcp/keys/${row.id}`)
      ElMessage.success('已撤销')
      await fetchApiKeys()
    } catch (err: any) {
      ElMessage.error(err.message || '撤销失败')
    }
  }).catch(() => {})
}

// ── MCP Client ──
const clientServers = ref<any[]>([])
const clientConnections = ref<any[]>([])

async function fetchClientServers() {
  try {
    const { data } = await api.get('/ai-ops/mcp/client/servers')
    if (data.success) clientServers.value = data.data || []
  } catch (err) { console.warn('[McpPanel] fetchClientServers failed:', err) }
}

async function fetchClientStatus() {
  try {
    const { data } = await api.get('/ai-ops/mcp/client/status')
    if (data.success) clientConnections.value = data.data?.servers || []
  } catch (err) { console.warn('[McpPanel] fetchClientStatus failed:', err) }
}

async function toggleServer(serverId: string, enabled: boolean) {
  try {
    await api.put(`/ai-ops/mcp/client/servers/${serverId}/toggle`, { enabled })
    ElMessage.success(enabled ? '已启用' : '已禁用')
    await fetchClientServers()
  } catch (err: any) {
    ElMessage.error(err.message || '操作失败')
  }
}

function confirmRemoveServer(row: any) {
  ElMessageBox.confirm(`确认删除 Server "${row.name}"？`, '删除确认', { type: 'warning' })
    .then(async () => {
      try {
        await api.delete(`/ai-ops/mcp/client/servers/${row.serverId}`)
        ElMessage.success('已删除')
        await fetchClientServers()
      } catch (err: any) {
        ElMessage.error(err.message || '删除失败')
      }
    }).catch(() => {})
}

// ── 添加外部 Server ──
const showAddServerDialog = ref(false)
const addingServer = ref(false)
const stdioArgsStr = ref('')
const oauthCollapse = ref<string[]>([])
const newServerForm = ref({
  serverId: '',
  name: '',
  transport: 'stdio' as 'stdio' | 'sse' | 'http',
  enabled: true,
  connectionParams: { command: '', args: [] as string[], url: '' },
})
const oauthForm = ref({
  token_url: '',
  grant_type: 'client_credentials' as 'client_credentials' | 'refresh_token',
  client_id: '',
  client_secret: '',
  scope: '',
})

async function addServer() {
  const f = newServerForm.value
  if (!f.serverId || !f.name) {
    ElMessage.warning('请填写 Server ID 和名称')
    return
  }
  addingServer.value = true
  try {
    const payload: any = { ...f }
    if (f.transport === 'stdio') {
      payload.connectionParams.args = stdioArgsStr.value.split(/\s+/).filter(Boolean)
    }
    // 附加 OAuth（如果填写了 token_url）
    if (oauthForm.value.token_url) {
      payload.oauth = { ...oauthForm.value }
    }
    const { data } = await api.post('/ai-ops/mcp/client/servers', payload)
    if (data.success) {
      ElMessage.success('Server 已添加')
      showAddServerDialog.value = false
      resetServerForm()
      await fetchClientServers()
    }
  } catch (err: any) {
    ElMessage.error(err.message || '添加失败')
  } finally {
    addingServer.value = false
  }
}

function resetServerForm() {
  newServerForm.value = { serverId: '', name: '', transport: 'stdio', enabled: true, connectionParams: { command: '', args: [], url: '' } }
  oauthForm.value = { token_url: '', grant_type: 'client_credentials', client_id: '', client_secret: '', scope: '' }
  stdioArgsStr.value = ''
  oauthCollapse.value = []
}

// ── Server 工具列表 ──
const showToolsDialog = ref(false)
const toolsDialogServer = ref('')
const serverToolsList = ref<any[]>([])

async function viewServerTools(row: any) {
  toolsDialogServer.value = row.name
  try {
    const { data } = await api.get(`/ai-ops/mcp/client/servers/${row.serverId}/tools`)
    if (data.success) {
      serverToolsList.value = data.tools || []
      showToolsDialog.value = true
    } else {
      ElMessage.error(data.message || '获取工具列表失败')
      serverToolsList.value = []
    }
  } catch (err: any) {
    serverToolsList.value = []
    ElMessage.error(err.message || '获取工具列表失败')
  }
}

// ── 辅助 ──
function roleTagType(role: string) {
  if (role === 'admin') return 'danger'
  if (role === 'operator') return 'warning'
  return 'info'
}

function connStatusType(status: string) {
  if (status === 'connected') return 'success'
  if (status === 'connecting') return 'warning'
  return 'info'
}

function formatTime(ts: number) {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ── 轮询刷新 ──
let pollTimer: ReturnType<typeof setInterval> | null = null

watch(() => activeTab.value, (tab) => {
  if (tab === 'server') { fetchServerStatus(); fetchApiKeys() }
  else { fetchClientServers(); fetchClientStatus() }
}, { immediate: true })

function startPolling() {
  pollTimer = setInterval(() => {
    if (activeTab.value === 'client') fetchClientStatus()
  }, 10000)
}

startPolling()
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<style scoped>
.mcp-status-card {
  margin-bottom: 16px;
}
.mcp-section {
  margin-top: 16px;
}
.mcp-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-weight: 600;
  font-size: 14px;
}
.mcp-empty {
  text-align: center;
  color: var(--el-text-color-secondary);
  padding: 16px 0;
}
</style>
