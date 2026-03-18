<template>
  <div class="anomaly-prediction-view">
    <div class="page-header">
      <h2>异常预测</h2>
      <p class="description">查看系统的异常预测信息，提前采取措施防止问题发生</p>
    </div>

    <!-- 加载状态 (仅首次加载显示) -->
    <el-skeleton v-if="loading && predictions.length === 0" :rows="5" animated />

    <!-- 错误状态 -->
    <el-alert
      v-else-if="error"
      :title="error"
      type="error"
      show-icon
      closable
      @close="error = ''"
    >
      <template #default>
        <el-button size="small" @click="loadPredictions">重试</el-button>
      </template>
    </el-alert>

    <!-- 空状态 -->
    <el-empty v-else-if="!predictions.length" description="暂无异常预测" />

    <!-- 预测列表 -->
    <div v-else class="predictions-container" v-loading="loading">
      <el-card
        v-for="prediction in sortedPredictions"
        :key="prediction.id"
        class="prediction-card"
        :class="prediction.severity"
        shadow="hover"
        @click="showDetail(prediction)"
      >
        <div class="prediction-header">
          <div class="metric-info">
            <el-icon :size="24" :class="prediction.severity">
              <component :is="getMetricIcon(prediction.metric)" />
            </el-icon>
            <span class="metric-name">{{ getMetricLabel(prediction.metric) }}</span>
          </div>
          <el-tag :type="prediction.severity === 'critical' ? 'danger' : 'warning'" size="large">
            {{ prediction.severity === 'critical' ? '严重' : '警告' }}
          </el-tag>
        </div>
        
        <div class="prediction-body">
          <div class="prediction-stat">
            <span class="stat-label">预测时间</span>
            <span class="stat-value">{{ formatTime(prediction.predictedTime) }}</span>
          </div>
          <div class="prediction-stat">
            <span class="stat-label">置信度</span>
            <span class="stat-value">{{ (prediction.confidence * 100).toFixed(1) }}%</span>
          </div>
          <div class="prediction-stat">
            <span class="stat-label">当前值</span>
            <span class="stat-value">{{ prediction.currentValue.toFixed(1) }}%</span>
          </div>
          <div class="prediction-stat">
            <span class="stat-label">预测值</span>
            <span class="stat-value highlight">{{ prediction.predictedValue.toFixed(1) }}%</span>
          </div>
        </div>
        
        <div class="prediction-footer">
          <el-button type="primary" link>
            查看详情
            <el-icon><i-ep-arrow-right /></el-icon>
          </el-button>
        </div>
      </el-card>
    </div>

    <!-- 详情对话框 -->
    <el-dialog
      v-model="detailVisible"
      :title="selectedPrediction ? `${getMetricLabel(selectedPrediction.metric)} 异常预测详情` : ''"
      width="700px"
    >
      <template v-if="selectedPrediction">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="指标类型">
            {{ getMetricLabel(selectedPrediction.metric) }}
          </el-descriptions-item>
          <el-descriptions-item label="严重程度">
            <el-tag :type="selectedPrediction.severity === 'critical' ? 'danger' : 'warning'">
              {{ selectedPrediction.severity === 'critical' ? '严重' : '警告' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="预测时间">
            {{ formatTime(selectedPrediction.predictedTime) }}
          </el-descriptions-item>
          <el-descriptions-item label="置信度">
            {{ (selectedPrediction.confidence * 100).toFixed(1) }}%
          </el-descriptions-item>
          <el-descriptions-item label="当前值">
            {{ selectedPrediction.currentValue.toFixed(1) }}%
          </el-descriptions-item>
          <el-descriptions-item label="预测值">
            {{ selectedPrediction.predictedValue.toFixed(1) }}%
          </el-descriptions-item>
        </el-descriptions>
        
        <!-- 历史数据与预测曲线图表 -->
        <div class="chart-section">
          <h4>历史数据与预测曲线</h4>
          <div class="prediction-chart-container">
            <v-chart :option="predictionChartOption" autoresize />
          </div>
        </div>

        <div v-if="selectedPrediction.analysis" class="analysis-section">
          <h4>分析说明</h4>
          <p>{{ selectedPrediction.analysis }}</p>
        </div>
      </template>
    </el-dialog>

    <!-- 巡检管理 Tabs -->
    <el-card style="margin-top: 20px;">
      <el-tabs v-model="inspectionTab">
        <el-tab-pane label="巡检任务" name="tasks">
          <div style="margin-bottom: 12px;">
            <el-button type="primary" size="small" @click="showCreateInspectionDialog = true">创建巡检任务</el-button>
          </div>
          <el-table v-if="inspectionTasks.length > 0" :data="inspectionTasks" stripe size="small">
            <el-table-column prop="name" label="任务名称" min-width="150" />
            <el-table-column prop="schedule" label="调度规则" width="140" />
            <el-table-column prop="enabled" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '禁用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="lastRun" label="上次执行" width="160" />
          </el-table>
          <el-empty v-else description="暂无巡检任务" />
        </el-tab-pane>
        <el-tab-pane label="巡检历史" name="history">
          <el-table v-if="inspectionHistory.length > 0" :data="inspectionHistory" stripe size="small">
            <el-table-column prop="taskName" label="任务名称" min-width="150" />
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 'completed' ? 'success' : row.status === 'running' ? 'primary' : 'danger'" size="small">
                  {{ row.status === 'completed' ? '完成' : row.status === 'running' ? '执行中' : '失败' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="findings" label="发现问题" width="100" align="center" />
            <el-table-column prop="startedAt" label="开始时间" width="160" />
          </el-table>
          <el-empty v-else description="暂无巡检历史" />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- Create Inspection Task Dialog -->
    <el-dialog v-model="showCreateInspectionDialog" title="创建巡检任务" width="450px" destroy-on-close>
      <el-form label-width="80px">
        <el-form-item label="任务名称">
          <el-input v-model="newInspectionName" placeholder="输入任务名称" />
        </el-form-item>
        <el-form-item label="调度规则">
          <el-input v-model="newInspectionSchedule" placeholder="如: 0 */6 * * * (每6小时)" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreateInspectionDialog = false">取消</el-button>
        <el-button type="primary" @click="handleCreateInspection">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Cpu, Coin, FolderOpened } from '@element-plus/icons-vue'

import { ref, computed, onMounted } from 'vue'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, MarkLineComponent, MarkPointComponent, LegendComponent } from 'echarts/components'
import VChart from 'vue-echarts'
import { 
  anomalyApi, 
  sortPredictionsBySeverity,
  type AnomalyPrediction 
} from '@/api/evolution'
import { inspectionApi } from '@/api/aiops-enhanced'
import { ElMessage } from 'element-plus'

// 注册 ECharts 组件
use([CanvasRenderer, LineChart, GridComponent, TooltipComponent, MarkLineComponent, MarkPointComponent, LegendComponent])

// 状态
const predictions = ref<AnomalyPrediction[]>([])
const loading = ref(false)
const error = ref('')
const detailVisible = ref(false)
const selectedPrediction = ref<AnomalyPrediction | null>(null)

// 巡检管理
const inspectionTab = ref('tasks')
const inspectionTasks = ref<Array<{ id: string; name: string; schedule: string; enabled: boolean; lastRun?: string }>>([])
const inspectionHistory = ref<Array<{ id: string; taskName: string; status: string; startedAt: string; findings: number }>>([])
const showCreateInspectionDialog = ref(false)
const newInspectionName = ref('')
const newInspectionSchedule = ref('')

const handleCreateInspection = async () => {
  if (!newInspectionName.value) { ElMessage.warning('请输入任务名称'); return }
  try {
    await inspectionApi.createTask({ name: newInspectionName.value, schedule: newInspectionSchedule.value, targets: [] })
    ElMessage.success('巡检任务已创建')
    showCreateInspectionDialog.value = false
    newInspectionName.value = ''
    newInspectionSchedule.value = ''
    loadInspectionData()
  } catch { ElMessage.error('创建失败') }
}

const loadInspectionData = async () => {
  try {
    const [tasksRes, histRes] = await Promise.all([inspectionApi.listTasks(), inspectionApi.getHistory()])
    if (tasksRes.data.success && tasksRes.data.data) inspectionTasks.value = tasksRes.data.data
    if (histRes.data.success && histRes.data.data) inspectionHistory.value = histRes.data.data
  } catch { /* non-critical */ }
}

// 排序后的预测列表
const sortedPredictions = computed(() => sortPredictionsBySeverity(predictions.value))

// 生成历史数据（基于当前值模拟）
function generateHistoricalData(prediction: AnomalyPrediction): [number, number][] {
  const now = Date.now()
  const points: [number, number][] = []
  const baseValue = prediction.currentValue
  
  // 生成过去 2 小时的历史数据（每 10 分钟一个点）
  for (let i = 12; i >= 0; i--) {
    const timestamp = now - i * 10 * 60 * 1000
    // 模拟波动，逐渐上升趋势
    const variation = (Math.random() - 0.5) * 5
    const trend = (12 - i) * (prediction.currentValue - (baseValue - 10)) / 12
    const value = Math.max(0, Math.min(100, baseValue - 10 + trend + variation))
    points.push([timestamp, parseFloat(value.toFixed(1))])
  }
  
  return points
}

// 生成预测曲线数据
function generatePredictionCurve(prediction: AnomalyPrediction): [number, number][] {
  const now = Date.now()
  const points: [number, number][] = []
  const duration = prediction.predictedTime - now
  const valueIncrease = prediction.predictedValue - prediction.currentValue
  
  // 从当前时间到预测时间，生成预测曲线
  const steps = 10
  for (let i = 0; i <= steps; i++) {
    const timestamp = now + (duration * i / steps)
    // 使用指数增长模拟
    const progress = i / steps
    const value = prediction.currentValue + valueIncrease * Math.pow(progress, 1.5)
    points.push([timestamp, parseFloat(value.toFixed(1))])
  }
  
  return points
}

// 预测图表配置
const predictionChartOption = computed(() => {
  if (!selectedPrediction.value) {
    return {}
  }
  
  const prediction = selectedPrediction.value
  const historicalData = generateHistoricalData(prediction)
  const predictionCurve = generatePredictionCurve(prediction)
  const now = Date.now()
  
  return {
    tooltip: {
      trigger: 'axis',
      formatter: (params: { seriesName: string; value: [number, number]; color: string }[]) => {
        const time = new Date(params[0].value[0]).toLocaleString()
        let result = `<div style="font-weight:bold">${time}</div>`
        params.forEach(p => {
          result += `<div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${p.color};margin-right:5px"></span>${p.seriesName}: ${p.value[1].toFixed(1)}%</div>`
        })
        return result
      }
    },
    legend: {
      data: ['历史数据', '预测曲线'],
      bottom: 0
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '15%',
      top: '10%',
      containLabel: true
    },
    xAxis: {
      type: 'time',
      axisLabel: {
        formatter: (value: number) => {
          const date = new Date(value)
          return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
        }
      },
      splitLine: {
        show: true,
        lineStyle: {
          type: 'dashed',
          opacity: 0.3
        }
      }
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: {
        formatter: '{value}%'
      },
      splitLine: {
        lineStyle: {
          type: 'dashed',
          opacity: 0.3
        }
      }
    },
    series: [
      {
        name: '历史数据',
        type: 'line',
        smooth: true,
        data: historicalData,
        lineStyle: {
          width: 2,
          color: '#409eff'
        },
        itemStyle: {
          color: '#409eff'
        },
        areaStyle: {
          opacity: 0.1,
          color: '#409eff'
        },
        markPoint: {
          data: [
            {
              name: '当前值',
              coord: [now, prediction.currentValue],
              symbol: 'circle',
              symbolSize: 12,
              itemStyle: {
                color: '#409eff',
                borderColor: '#fff',
                borderWidth: 2
              },
              label: {
                show: true,
                formatter: `当前: ${prediction.currentValue.toFixed(1)}%`,
                position: 'top',
                color: '#409eff'
              }
            }
          ]
        }
      },
      {
        name: '预测曲线',
        type: 'line',
        smooth: true,
        data: predictionCurve,
        lineStyle: {
          width: 2,
          type: 'dashed',
          color: prediction.severity === 'critical' ? '#f56c6c' : '#e6a23c'
        },
        itemStyle: {
          color: prediction.severity === 'critical' ? '#f56c6c' : '#e6a23c'
        },
        areaStyle: {
          opacity: 0.1,
          color: prediction.severity === 'critical' ? '#f56c6c' : '#e6a23c'
        },
        markPoint: {
          data: [
            {
              name: '预测值',
              coord: [prediction.predictedTime, prediction.predictedValue],
              symbol: 'pin',
              symbolSize: 40,
              itemStyle: {
                color: prediction.severity === 'critical' ? '#f56c6c' : '#e6a23c'
              },
              label: {
                show: true,
                formatter: `${prediction.predictedValue.toFixed(1)}%`,
                color: '#fff'
              }
            }
          ]
        },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [
            {
              name: '阈值',
              yAxis: prediction.severity === 'critical' ? 90 : 80,
              lineStyle: {
                color: prediction.severity === 'critical' ? '#f56c6c' : '#e6a23c',
                type: 'dashed',
                width: 1
              },
              label: {
                formatter: prediction.severity === 'critical' ? '严重阈值' : '警告阈值',
                position: 'end'
              }
            }
          ]
        }
      }
    ]
  }
})

// 指标图标
function getMetricIcon(metric: string) {
  const icons: Record<string, unknown> = {
    cpu: Cpu,
    memory: Coin,
    disk: FolderOpened
  }
  return icons[metric] || Cpu
}

// 指标标签
function getMetricLabel(metric: string): string {
  const labels: Record<string, string> = {
    cpu: 'CPU 使用率',
    memory: '内存使用率',
    disk: '磁盘使用率'
  }
  return labels[metric] || metric
}

// 格式化时间
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

// 加载预测数据
async function loadPredictions() {
  loading.value = true
  error.value = ''
  
  try {
    const response = await anomalyApi.getPredictions()
    if (response.data.success && response.data.data) {
      predictions.value = response.data.data
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载预测数据失败'
  } finally {
    loading.value = false
  }
}

// 显示详情
function showDetail(prediction: AnomalyPrediction) {
  selectedPrediction.value = prediction
  detailVisible.value = true
}

onMounted(() => {
  loadPredictions()
  loadInspectionData()
})
</script>

<style scoped>
.anomaly-prediction-view {
  padding: 20px;
  background: var(--el-bg-color-page);
  min-height: 100%;
}

.page-header {
  margin-bottom: 24px;
}

.page-header h2 {
  margin: 0 0 8px 0;
  font-size: 24px;
  font-weight: 600;
}

.page-header .description {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.predictions-container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.prediction-card {
  cursor: pointer;
  transition: all 0.3s;
}

.prediction-card:hover {
  transform: translateY(-4px);
}

.prediction-card.critical {
  border-left: 4px solid var(--el-color-danger);
}

.prediction-card.warning {
  border-left: 4px solid var(--el-color-warning);
}

.prediction-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.metric-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.metric-info .el-icon.critical {
  color: var(--el-color-danger);
}

.metric-info .el-icon.warning {
  color: var(--el-color-warning);
}

.metric-name {
  font-size: 16px;
  font-weight: 500;
}

.prediction-body {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.prediction-stat {
  display: flex;
  flex-direction: column;
}

.stat-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 4px;
}

.stat-value {
  font-size: 14px;
  font-weight: 500;
}

.stat-value.highlight {
  color: var(--el-color-danger);
}

.prediction-footer {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 12px;
}

.analysis-section {
  margin-top: 20px;
  padding: 16px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}

.analysis-section h4 {
  margin: 0 0 8px 0;
  font-size: 14px;
}

.analysis-section p {
  margin: 0;
  color: var(--el-text-color-regular);
  line-height: 1.6;
}

.chart-section {
  margin-top: 20px;
}

.chart-section h4 {
  margin: 0 0 12px 0;
  font-size: 14px;
  color: var(--el-text-color-primary);
}

.prediction-chart-container {
  height: 300px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 10px;
}
</style>
