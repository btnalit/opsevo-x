<template>
  <div class="device-driver-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <span>驱动管理</span>
        </div>
      </template>
    </el-card>

    <el-card v-loading="loading" shadow="hover">
      <el-table :data="drivers" stripe>
        <el-table-column type="expand">
          <template #default="{ row }">
            <div v-if="manifests[row.type]" style="padding: 12px 20px">
              <p><strong>支持操作：</strong>{{ manifests[row.type].operations.join(', ') }}</p>
              <p><strong>支持指标：</strong>{{ manifests[row.type].supportedMetrics.join(', ') }}</p>
              <el-table
                v-if="manifests[row.type].commandPatterns?.length"
                :data="manifests[row.type].commandPatterns"
                size="small"
                style="margin-top: 8px"
              >
                <el-table-column prop="name" label="命令模式" />
                <el-table-column prop="description" label="描述" />
              </el-table>
            </div>
            <div v-else style="padding: 12px 20px">
              <el-button size="small" @click="loadManifest(row.type)">加载能力清单</el-button>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="驱动名称" min-width="160" />
        <el-table-column prop="type" label="类型" width="120">
          <template #default="{ row }">
            <el-tag size="small">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="version" label="版本" width="100" />
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small" effect="dark">
              {{ row.status === 'active' ? '正常' : '异常' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="能力标签" min-width="200">
          <template #default="{ row }">
            <el-tag v-for="cap in (row.capabilities || [])" :key="cap" size="small" style="margin-right: 4px">
              {{ cap }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { driverApi, type Driver, type CapabilityManifest } from '@/api/device'

defineOptions({ name: 'DeviceDriverView' })

const drivers = ref<Driver[]>([])
const manifests = reactive<Record<string, CapabilityManifest>>({})
const loading = ref(false)

async function fetchDrivers() {
  loading.value = true
  try {
    const res = await driverApi.list()
    if (res.data.success && res.data.data) drivers.value = res.data.data
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '获取驱动列表失败')
  } finally { loading.value = false }
}

async function loadManifest(type: string) {
  try {
    const res = await driverApi.getManifest(type)
    if (res.data.success && res.data.data) manifests[type] = res.data.data
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '获取能力清单失败')
  }
}

onMounted(fetchDrivers)
</script>

<style scoped>
.device-driver-view { height: 100%; padding: 20px; background: var(--el-bg-color-page); overflow-y: auto; }
.header-card { margin-bottom: 20px; }
.card-header { font-size: 18px; font-weight: 600; }
</style>
