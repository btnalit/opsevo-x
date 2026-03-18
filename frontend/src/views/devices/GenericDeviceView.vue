<template>
  <div class="generic-device-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <span>设备管理</span>
          <div class="header-actions">
            <el-button type="danger" size="small" :disabled="!selectedIds.length" @click="handleBatchDelete">
              批量删除
            </el-button>
            <el-button type="primary" :icon="Plus" @click="showAddDialog = true">
              添加设备
            </el-button>
          </div>
        </div>
      </template>

      <!-- 筛选栏 -->
      <div class="filter-bar">
        <el-input v-model="filters.keyword" placeholder="搜索名称/地址" clearable style="width: 200px" />
        <el-select v-model="filters.status" placeholder="状态" clearable style="width: 120px">
          <el-option label="在线" value="online" />
          <el-option label="离线" value="offline" />
          <el-option label="错误" value="error" />
        </el-select>
        <el-select v-model="filters.driverType" placeholder="驱动类型" clearable style="width: 140px">
          <el-option label="API" value="api" />
          <el-option label="SSH" value="ssh" />
          <el-option label="SNMP" value="snmp" />
        </el-select>
      </div>
    </el-card>

    <el-card shadow="hover">
      <el-table
        v-loading="deviceStore.loading"
        :data="filteredDevices"
        stripe
        @selection-change="onSelectionChange"
        @sort-change="onSortChange"
      >
        <el-table-column type="selection" width="40" />
        <el-table-column prop="name" label="设备名称" sortable="custom" min-width="140" />
        <el-table-column label="地址" min-width="160" sortable="custom" prop="host">
          <template #default="{ row }">{{ row.host }}:{{ row.port }}</template>
        </el-table-column>
        <el-table-column label="驱动类型" width="110" align="center">
          <template #default="{ row }">
            <el-tag size="small">{{ row.driver_type || 'api' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center" sortable="custom" prop="status">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small" effect="dark">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" align="center" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" link @click="goToDetail(row)">详情</el-button>
            <el-button
              v-if="row.status !== 'online'"
              type="success" size="small" link
              :loading="row.status === 'connecting'"
              @click="handleConnect(row)"
            >连接</el-button>
            <el-button v-else type="warning" size="small" link @click="handleDisconnect(row)">断开</el-button>
            <el-popconfirm title="确定删除？" @confirm="handleDelete(row)">
              <template #reference>
                <el-button type="danger" size="small" link>删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 添加设备对话框 -->
    <el-dialog v-model="showAddDialog" title="添加设备" width="560px" destroy-on-close>
      <DeviceConnectionForm ref="addFormRef" @submit="handleAddDevice" @cancel="showAddDialog = false" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useDeviceStore } from '@/stores/device'
import type { Device, CreateDeviceRequest } from '@/api/device'
import DeviceConnectionForm from './DeviceConnectionForm.vue'

defineOptions({ name: 'GenericDeviceView' })

const router = useRouter()
const deviceStore = useDeviceStore()

const showAddDialog = ref(false)
const addFormRef = ref()
const selectedIds = ref<string[]>([])
const filters = ref({ keyword: '', status: '', driverType: '' })
const sortState = ref({ prop: '', order: '' })

onMounted(() => { deviceStore.fetchDevices() })

const filteredDevices = computed(() => {
  let list = [...deviceStore.devices]
  const { keyword, status, driverType } = filters.value
  if (keyword) {
    const kw = keyword.toLowerCase()
    list = list.filter(d => d.name.toLowerCase().includes(kw) || d.host.toLowerCase().includes(kw))
  }
  if (status) list = list.filter(d => d.status === status)
  if (driverType) list = list.filter(d => (d.driver_type || 'api') === driverType)
  if (sortState.value.prop && sortState.value.order) {
    const prop = sortState.value.prop as keyof Device
    const asc = sortState.value.order === 'ascending' ? 1 : -1
    list.sort((a, b) => String(a[prop] ?? '').localeCompare(String(b[prop] ?? '')) * asc)
  }
  return list
})

function statusTagType(s: Device['status']) {
  return s === 'online' ? 'success' : s === 'error' ? 'danger' : s === 'connecting' ? 'primary' : 'info'
}
function statusLabel(s: Device['status']) {
  return { online: '在线', offline: '离线', connecting: '连接中', error: '错误' }[s] || s
}

function onSelectionChange(rows: Device[]) { selectedIds.value = rows.map(r => r.id) }
function onSortChange({ prop, order }: { prop: string; order: string }) {
  sortState.value = { prop: prop || '', order: order || '' }
}

function goToDetail(row: Device) { router.push(`/devices/${row.id}`) }

async function handleConnect(row: Device) {
  try { await deviceStore.connectDevice(row.id); ElMessage.success('连接成功') }
  catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '连接失败') }
}
async function handleDisconnect(row: Device) {
  try { await deviceStore.disconnectDevice(row.id); ElMessage.success('已断开') }
  catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '断开失败') }
}
async function handleDelete(row: Device) {
  try { await deviceStore.removeDevice(row.id); ElMessage.success('已删除') }
  catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '删除失败') }
}
async function handleBatchDelete() {
  for (const id of selectedIds.value) {
    try { await deviceStore.removeDevice(id) } catch { /* skip */ }
  }
  selectedIds.value = []
  ElMessage.success('批量删除完成')
}
async function handleAddDevice(data: CreateDeviceRequest) {
  try {
    await deviceStore.addDevice(data)
    showAddDialog.value = false
    ElMessage.success('设备添加成功')
  } catch (e: unknown) { ElMessage.error(e instanceof Error ? e.message : '添加失败') }
}
</script>

<style scoped>
.generic-device-view { height: 100%; padding: 20px; background: var(--el-bg-color-page); overflow-y: auto; }
.header-card { margin-bottom: 20px; }
.card-header { display: flex; align-items: center; justify-content: space-between; font-size: 18px; font-weight: 600; }
.header-actions { display: flex; gap: 8px; }
.filter-bar { display: flex; gap: 12px; flex-wrap: wrap; }
</style>
