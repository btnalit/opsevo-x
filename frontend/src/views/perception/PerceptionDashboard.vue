<template>
  <div class="perception-dashboard">
    <!-- 统计卡片 -->
    <el-row :gutter="16" class="stats-row">
      <el-col :span="8">
        <el-card shadow="hover">
          <el-statistic title="事件总数" :value="stats.totalEvents" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover">
          <el-statistic title="事件发布总数" :value="stats.totalPublishedCount" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="hover">
          <el-statistic title="活跃感知源" :value="activeSources.length" />
        </el-card>
      </el-col>
    </el-row>

    <!-- 活跃感知源列表 -->
    <el-card shadow="hover" style="margin-top: 16px">
      <template #header>
        <div class="card-header">
          <span>活跃感知源</span>
          <el-button size="small" @click="loadAll">刷新</el-button>
        </div>
      </template>
      <el-table :data="sources" v-loading="loading" stripe>
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column prop="type" label="类型" width="120">
          <template #default="{ row }">
            <el-tag size="small" type="info">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
              {{ row.status === 'active' ? '活跃' : '不活跃' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="eventCount" label="事件数" width="120" align="right" />
        <el-table-column prop="lastEvent" label="最近事件" min-width="170">
          <template #default="{ row }">{{ row.lastEvent ? new Date(row.lastEvent).toLocaleString('zh-CN') : '-' }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 事件趋势图占位 -->
    <el-card shadow="hover" style="margin-top: 16px">
      <template #header><span>事件量趋势</span></template>
      <el-empty description="图表开发中" :image-size="120" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { perceptionApi, type PerceptionSource, type PerceptionStats } from '@/api/perception'

defineOptions({ name: 'PerceptionDashboard' })

const loading = ref(false)
const sources = ref<PerceptionSource[]>([])
const stats = reactive<PerceptionStats>({ totalEvents: 0, eventsByType: {}, totalPublishedCount: 0 })

const activeSources = computed(() => sources.value.filter(s => s.status === 'active'))

async function loadAll() {
  loading.value = true
  try {
    const [srcRes, statsRes] = await Promise.all([perceptionApi.getSources(), perceptionApi.getStats()])
    if (srcRes.data.data) sources.value = srcRes.data.data
    if (statsRes.data.data) Object.assign(stats, statsRes.data.data)
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(loadAll)
</script>

<style scoped>
.perception-dashboard { height: 100%; padding: 20px; overflow-y: auto; background: var(--el-bg-color-page); }
.stats-row .el-card { text-align: center; }
.card-header { display: flex; align-items: center; justify-content: space-between; }
</style>
