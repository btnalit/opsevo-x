<template>
  <div class="snmp-trap-view">
    <el-tabs v-model="activeTab" type="border-card">
      <!-- Tab 1: OID 映射 -->
      <el-tab-pane label="OID 映射" name="oid">
        <el-card shadow="never" class="status-card">
          <template #header><span>SNMP Trap 服务状态</span></template>
          <el-descriptions :column="3" border>
            <el-descriptions-item label="运行状态">
              <el-tag :type="status.running ? 'success' : 'danger'" size="small">
                {{ status.running ? '运行中' : '已停止' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="监听端口">{{ status.port || '-' }}</el-descriptions-item>
            <el-descriptions-item label="Trap 总数">{{ status.trapCount }}</el-descriptions-item>
          </el-descriptions>
        </el-card>

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <div class="card-header">
              <span>OID 映射表</span>
              <el-button type="primary" size="small" @click="showOidDialog()">添加映射</el-button>
            </div>
          </template>
          <el-table :data="oidMappings" v-loading="loading" stripe>
            <el-table-column prop="oid" label="OID" min-width="200" show-overflow-tooltip />
            <el-table-column prop="name" label="名称" min-width="140" />
            <el-table-column prop="event_type" label="事件类型" width="120">
              <template #default="{ row }">
                <el-tag size="small">{{ row.event_type }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="priority" label="优先级" width="100" />
            <el-table-column prop="description" label="描述" min-width="160" show-overflow-tooltip />
            <el-table-column label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" size="small" link @click="showOidDialog(row)">编辑</el-button>
                <el-popconfirm title="确定删除？" @confirm="deleteOid(row.id)">
                  <template #reference>
                    <el-button type="danger" size="small" link>删除</el-button>
                  </template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- Tab 2: v3 认证 -->
      <el-tab-pane label="v3 认证" name="v3">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>SNMPv3 认证凭据</span>
              <el-button type="primary" size="small" @click="showCredDialog()">添加凭据</el-button>
            </div>
          </template>
          <el-table :data="v3Credentials" v-loading="loading" stripe>
            <el-table-column prop="security_name" label="安全名称" min-width="160" />
            <el-table-column prop="auth_protocol" label="认证协议" width="120">
              <template #default="{ row }">
                <el-tag size="small" type="info">{{ row.auth_protocol }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="priv_protocol" label="加密协议" width="120">
              <template #default="{ row }">
                <el-tag size="small" type="info">{{ row.priv_protocol }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="device_id" label="关联设备" width="140" />
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- OID 映射对话框 -->
    <el-dialog v-model="oidDialogVisible" :title="editingOid ? '编辑 OID 映射' : '添加 OID 映射'" width="520px" destroy-on-close>
      <el-form :model="oidForm" label-width="90px">
        <el-form-item label="OID" required>
          <el-input v-model="oidForm.oid" placeholder="如 1.3.6.1.4.1.9.9.43.2.0.1" />
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="oidForm.name" placeholder="映射名称" />
        </el-form-item>
        <el-form-item label="事件类型" required>
          <el-input v-model="oidForm.event_type" placeholder="如 linkDown, configChange" />
        </el-form-item>
        <el-form-item label="优先级">
          <el-select v-model="oidForm.priority" style="width: 100%">
            <el-option label="低" value="low" />
            <el-option label="中" value="medium" />
            <el-option label="高" value="high" />
            <el-option label="紧急" value="critical" />
          </el-select>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="oidForm.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="oidDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveOid">保存</el-button>
      </template>
    </el-dialog>

    <!-- v3 凭据对话框 -->
    <el-dialog v-model="credDialogVisible" title="添加 SNMPv3 凭据" width="480px" destroy-on-close>
      <el-form :model="credForm" label-width="90px">
        <el-form-item label="安全名称" required>
          <el-input v-model="credForm.security_name" />
        </el-form-item>
        <el-form-item label="认证协议" required>
          <el-select v-model="credForm.auth_protocol" style="width: 100%">
            <el-option label="MD5" value="MD5" />
            <el-option label="SHA" value="SHA" />
            <el-option label="SHA-256" value="SHA256" />
          </el-select>
        </el-form-item>
        <el-form-item label="加密协议" required>
          <el-select v-model="credForm.priv_protocol" style="width: 100%">
            <el-option label="DES" value="DES" />
            <el-option label="AES" value="AES" />
            <el-option label="AES-256" value="AES256" />
          </el-select>
        </el-form-item>
        <el-form-item label="关联设备">
          <el-input v-model="credForm.device_id" placeholder="可选，设备 ID" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="credDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveCred">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  snmpTrapApi,
  type SnmpTrapStatus,
  type OidMapping,
  type SnmpV3Credential,
} from '@/api/perception'

defineOptions({ name: 'SNMPTrapView' })

const activeTab = ref('oid')
const loading = ref(false)
const status = reactive<SnmpTrapStatus>({ running: false, port: 0, trapCount: 0 })
const oidMappings = ref<OidMapping[]>([])
const v3Credentials = ref<SnmpV3Credential[]>([])

// OID dialog
const oidDialogVisible = ref(false)
const editingOid = ref<OidMapping | null>(null)
const oidForm = reactive({ oid: '', name: '', event_type: '', priority: 'medium', description: '' })

// Credential dialog
const credDialogVisible = ref(false)
const credForm = reactive({ security_name: '', auth_protocol: 'SHA', priv_protocol: 'AES', device_id: '' })

async function loadAll() {
  loading.value = true
  try {
    const [statusRes, oidRes, credRes] = await Promise.all([
      snmpTrapApi.getStatus(), snmpTrapApi.listOidMappings(), snmpTrapApi.listV3Credentials(),
    ])
    if (statusRes.data.data) Object.assign(status, statusRes.data.data)
    if (oidRes.data.data) oidMappings.value = oidRes.data.data
    if (credRes.data.data) v3Credentials.value = credRes.data.data
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败')
  } finally {
    loading.value = false
  }
}

function showOidDialog(row?: OidMapping) {
  editingOid.value = row || null
  oidForm.oid = row?.oid || ''
  oidForm.name = row?.name || ''
  oidForm.event_type = row?.event_type || ''
  oidForm.priority = row?.priority || 'medium'
  oidForm.description = row?.description || ''
  oidDialogVisible.value = true
}

async function saveOid() {
  try {
    if (editingOid.value) {
      await snmpTrapApi.updateOidMapping(editingOid.value.id, oidForm)
    } else {
      await snmpTrapApi.createOidMapping(oidForm)
    }
    oidDialogVisible.value = false
    ElMessage.success('保存成功')
    loadAll()
  } catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '保存失败') }
}

async function deleteOid(id: string) {
  try { await snmpTrapApi.deleteOidMapping(id); ElMessage.success('已删除'); loadAll() }
  catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '删除失败') }
}

function showCredDialog() { credDialogVisible.value = true }

async function saveCred() {
  try {
    await snmpTrapApi.createV3Credential(credForm)
    credDialogVisible.value = false
    ElMessage.success('保存成功')
    loadAll()
  } catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '保存失败') }
}

onMounted(loadAll)
</script>

<style scoped>
.snmp-trap-view { height: 100%; padding: 20px; overflow-y: auto; background: var(--el-bg-color-page); }
.status-card { margin-bottom: 0; }
.card-header { display: flex; align-items: center; justify-content: space-between; }
</style>
