<template>
  <div class="skill-management-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>Skill 管理</span>
            <el-badge v-if="skills.length" :value="skills.length" type="primary" />
          </div>
          <div class="header-actions">
            <el-button type="primary" :icon="Plus" @click="showCreateDialog">
              创建 Skill
            </el-button>
            <el-button :icon="Upload" @click="showImportDialog">
              导入
            </el-button>
            <el-button :icon="Refresh" :loading="loading" @click="loadSkills">
              刷新
            </el-button>
          </div>
        </div>
      </template>
    </el-card>

    <!-- Stats Cards -->
    <el-row :gutter="16" class="stats-cards">
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: var(--el-color-primary);">
              <el-icon :size="24"><i-ep-collection /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ skills.length }}</div>
              <div class="stat-label">总 Skill 数</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: var(--el-color-success);">
              <el-icon :size="24"><i-ep-circle-check /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ builtinCount }}</div>
              <div class="stat-label">内置 Skill</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: var(--el-color-warning);">
              <el-icon :size="24"><i-ep-user /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ customCount }}</div>
              <div class="stat-label">自定义 Skill</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-content">
            <div class="stat-icon" style="background: var(--el-color-danger);">
              <el-icon :size="24"><i-ep-close-bold /></el-icon>
            </div>
            <div class="stat-info">
              <div class="stat-value">{{ disabledCount }}</div>
              <div class="stat-label">已禁用</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- Search and Filter -->
    <el-card class="search-card" shadow="hover">
      <el-form :inline="true" class="search-form">
        <el-form-item>
          <el-input
            v-model="searchQuery"
            placeholder="搜索 Skill..."
            :prefix-icon="Search"
            clearable
            style="width: 250px"
            @input="filterSkills"
          />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="typeFilter" placeholder="全部" clearable style="width: 120px" @change="filterSkills">
            <el-option label="内置" value="builtin" />
            <el-option label="自定义" value="custom" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="statusFilter" placeholder="全部" clearable style="width: 120px" @change="filterSkills">
            <el-option label="启用" value="enabled" />
            <el-option label="禁用" value="disabled" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="selectedSkills.length > 0" class="batch-actions">
          <el-button type="success" size="small" @click="batchEnable">
            <el-icon><i-ep-circle-check /></el-icon> 批量启用 ({{ selectedSkills.length }})
          </el-button>
          <el-button type="warning" size="small" @click="batchDisable">
            <el-icon><i-ep-close-bold /></el-icon> 批量禁用
          </el-button>
          <el-button type="danger" size="small" @click="confirmBatchDelete" :disabled="!canBatchDelete">
            <el-icon><i-ep-delete /></el-icon> 批量删除
          </el-button>
          <el-button type="primary" size="small" @click="batchExport">
            <el-icon><i-ep-download /></el-icon> 批量导出
          </el-button>
          <el-button size="small" @click="clearSelection">清除选择</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- Main Content -->
    <el-card class="main-card" shadow="hover">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="Skill 列表" name="list">
          <el-skeleton v-if="loading && skills.length === 0" :rows="5" animated />
          <el-alert v-else-if="error" :title="error" type="error" show-icon closable @close="error = ''" />
          <el-empty v-else-if="filteredSkills.length === 0" description="暂无 Skill">
            <el-button type="primary" @click="showCreateDialog">创建 Skill</el-button>
          </el-empty>

          <!-- Skills Grid -->
          <div v-else class="skills-grid">
            <el-card
              v-for="skill in filteredSkills"
              :key="skill.name"
              class="skill-card"
              :class="{ disabled: !skill.enabled, selected: isSelected(skill.name) }"
              shadow="hover"
              @click="showSkillDetail(skill)"
            >
              <div class="skill-header">
                <div class="skill-title">
                  <el-checkbox
                    :model-value="isSelected(skill.name)"
                    @click.stop
                    @change="(val: string | number | boolean) => toggleSelection(skill.name, Boolean(val))"
                  />
                  <el-tag :type="skill.isBuiltin ? 'success' : 'warning'" size="small">
                    {{ skill.isBuiltin ? '内置' : '自定义' }}
                  </el-tag>
                  <span class="skill-name">{{ skill.name }}</span>
                </div>
                <el-switch
                  v-model="skill.enabled"
                  :disabled="skill.isBuiltin && skill.name === 'generalist'"
                  @click.stop
                  @change="toggleSkill(skill)"
                />
              </div>
              <div class="skill-description">{{ skill.description }}</div>
              <div class="skill-meta">
                <span v-if="skill.version">v{{ skill.version }}</span>
                <span v-if="skill.author">{{ skill.author }}</span>
              </div>
              <div class="skill-tags" v-if="skill.tags?.length">
                <el-tag v-for="tag in skill.tags.slice(0, 3)" :key="tag" size="small" type="info">
                  {{ tag }}
                </el-tag>
                <span v-if="skill.tags.length > 3" class="more-tags">+{{ skill.tags.length - 3 }}</span>
              </div>
              <div class="skill-actions">
                <el-button size="small" text type="primary" @click.stop="showSkillDetail(skill)">详情</el-button>
                <el-button size="small" text type="info" @click.stop="cloneSkill(skill)">克隆</el-button>
                <el-button size="small" text type="warning" @click.stop="exportSkill(skill)">导出</el-button>
                <el-button
                  v-if="!skill.isBuiltin"
                  size="small"
                  text
                  type="danger"
                  @click.stop="confirmDelete(skill)"
                >删除</el-button>
              </div>
            </el-card>
          </div>
        </el-tab-pane>

        <el-tab-pane label="使用指标" name="metrics">
          <div class="metrics-content">
            <el-table :data="metricsData" stripe style="width: 100%">
              <el-table-column prop="skillName" label="Skill 名称" width="150" />
              <el-table-column prop="usageCount" label="使用次数" width="100" align="center" />
              <el-table-column prop="successRate" label="成功率" width="120" align="center">
                <template #default="{ row }">
                  <el-progress
                    :percentage="Math.round(row.successRate * 100)"
                    :stroke-width="8"
                    :color="getSuccessRateColor(row.successRate)"
                  />
                </template>
              </el-table-column>
              <el-table-column prop="avgResponseTime" label="平均响应时间" width="130" align="center">
                <template #default="{ row }">
                  {{ row.avgResponseTime ? `${row.avgResponseTime.toFixed(0)}ms` : '-' }}
                </template>
              </el-table-column>
              <el-table-column prop="feedbackScore" label="反馈评分" width="120" align="center">
                <template #default="{ row }">
                  <div class="score-cell">
                    <el-icon color="var(--el-color-warning)"><i-ep-star /></el-icon>
                    <span>{{ row.feedbackScore?.toFixed(1) || '-' }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="lastUsed" label="最后使用" width="180">
                <template #default="{ row }">
                  {{ row.lastUsed ? formatDateTime(row.lastUsed) : '-' }}
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>

        <el-tab-pane label="模板" name="templates">
          <div class="templates-grid">
            <el-card
              v-for="template in templates"
              :key="template.id"
              class="template-card"
              shadow="hover"
              @click="createFromTemplate(template)"
            >
              <div class="template-name">{{ template.name }}</div>
              <div class="template-description">{{ template.description }}</div>
              <el-button type="primary" size="small">使用此模板</el-button>
            </el-card>
          </div>
        </el-tab-pane>

        <!-- Skill Capsules Tab -->
        <el-tab-pane label="Skill Capsules" name="capsules">
          <el-table v-if="capsulesList.length > 0" :data="capsulesList" stripe size="small">
            <el-table-column prop="name" label="名称" min-width="120" />
            <el-table-column prop="version" label="版本" width="80" />
            <el-table-column prop="runtime" label="运行时" width="80">
              <template #default="{ row }"><el-tag size="small">{{ row.runtime }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">{{ row.status === 'active' ? '活跃' : '停用' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="capabilities" label="能力标签" min-width="200">
              <template #default="{ row }">
                <el-tag v-for="cap in (row.capabilities || []).slice(0, 3)" :key="cap" size="small" style="margin-right: 4px;">{{ cap }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="暂无 Skill Capsule" />
        </el-tab-pane>

        <!-- MCP 工具 Tab -->
        <el-tab-pane label="MCP 工具" name="mcpTools">
          <el-table v-if="mcpToolsList.length > 0" :data="mcpToolsList" stripe size="small">
            <el-table-column prop="name" label="工具名称" min-width="150" />
            <el-table-column prop="description" label="描述" min-width="250" show-overflow-tooltip />
            <el-table-column prop="server" label="来源 Server" width="140" />
          </el-table>
          <el-empty v-else description="暂无 MCP 工具" />
        </el-tab-pane>

        <!-- 执行历史 Tab -->
        <el-tab-pane label="执行历史" name="execHistory">
          <el-table v-if="execHistoryList.length > 0" :data="execHistoryList" stripe size="small">
            <el-table-column prop="skillName" label="Skill" min-width="120" />
            <el-table-column prop="intent" label="触发意图" min-width="180" show-overflow-tooltip />
            <el-table-column prop="result" label="结果" width="80">
              <template #default="{ row }">
                <el-tag :type="row.result === 'success' ? 'success' : 'danger'" size="small">{{ row.result === 'success' ? '成功' : '失败' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="duration" label="耗时" width="80">
              <template #default="{ row }">{{ row.duration }}ms</template>
            </el-table-column>
            <el-table-column prop="timestamp" label="时间" width="160">
              <template #default="{ row }">{{ new Date(row.timestamp).toLocaleString('zh-CN') }}</template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="暂无执行记录" />
        </el-tab-pane>

        <!-- API Key 管理 Tab -->
        <el-tab-pane label="API Key 管理" name="apiKeys">
          <div style="margin-bottom: 12px;">
            <el-button type="primary" size="small" @click="showCreateApiKeyDialog = true">创建 API Key</el-button>
          </div>
          <el-table v-if="apiKeysList.length > 0" :data="apiKeysList" stripe size="small">
            <el-table-column prop="name" label="名称" min-width="120" />
            <el-table-column prop="role" label="角色" width="100">
              <template #default="{ row }"><el-tag size="small">{{ row.role }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="createdAt" label="创建时间" width="160" />
            <el-table-column label="操作" width="80">
              <template #default="{ row }">
                <el-button type="danger" size="small" link @click="handleDeleteApiKey(row.id)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="暂无 API Key" />
        </el-tab-pane>

        <!-- 工具仪表板 Tab -->
        <el-tab-pane label="工具仪表板" name="toolDashboard">
          <el-row :gutter="16" style="margin-bottom: 16px;">
            <el-col :span="8">
              <el-card shadow="hover">
                <div style="text-align: center;">
                  <div style="font-size: 24px; font-weight: bold; color: var(--el-color-primary);">{{ capsulesList.length }}</div>
                  <div style="color: var(--el-text-color-secondary);">Skill Capsules</div>
                </div>
              </el-card>
            </el-col>
            <el-col :span="8">
              <el-card shadow="hover">
                <div style="text-align: center;">
                  <div style="font-size: 24px; font-weight: bold; color: var(--el-color-success);">{{ mcpToolsList.length }}</div>
                  <div style="color: var(--el-text-color-secondary);">MCP 工具</div>
                </div>
              </el-card>
            </el-col>
            <el-col :span="8">
              <el-card shadow="hover">
                <div style="text-align: center;">
                  <div style="font-size: 24px; font-weight: bold; color: var(--el-color-warning);">{{ capsulesList.length + mcpToolsList.length }}</div>
                  <div style="color: var(--el-text-color-secondary);">工具总数</div>
                </div>
              </el-card>
            </el-col>
          </el-row>
          <el-empty description="统一工具注册中心仪表板开发中" :image-size="80" />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- Create API Key Dialog -->
    <el-dialog v-model="showCreateApiKeyDialog" title="创建 API Key" width="400px" destroy-on-close>
      <el-form label-width="80px">
        <el-form-item label="名称">
          <el-input v-model="newApiKeyName" placeholder="输入 Key 名称" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="newApiKeyRole" style="width: 100%;">
            <el-option label="Viewer" value="viewer" />
            <el-option label="Operator" value="operator" />
            <el-option label="Admin" value="admin" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreateApiKeyDialog = false">取消</el-button>
        <el-button type="primary" :loading="creatingApiKey" @click="handleCreateApiKey">创建</el-button>
      </template>
    </el-dialog>

    <!-- Create/Edit Dialog -->
    <el-dialog v-model="createDialogVisible" :title="editingSkill ? '编辑 Skill' : '创建 Skill'" width="700px" destroy-on-close>
      <el-form ref="formRef" :model="formData" :rules="formRules" label-width="100px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="formData.name" placeholder="输入 Skill 名称" :disabled="!!editingSkill" />
        </el-form-item>
        <el-form-item label="描述" prop="description">
          <el-input v-model="formData.description" type="textarea" :rows="2" placeholder="输入描述" />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input v-model="formData.content" type="textarea" :rows="8" placeholder="输入 Skill 指令内容 (Markdown)" />
        </el-form-item>
        <el-form-item label="允许工具">
          <el-select v-model="formData.allowedTools" multiple filterable allow-create placeholder="选择或输入工具名称" style="width: 100%">
            <el-option label="全部工具 (*)" value="*" />
            <el-option label="get_system_info" value="get_system_info" />
            <el-option label="get_interface_status" value="get_interface_status" />
            <el-option label="get_logs" value="get_logs" />
            <el-option label="analyze_metrics" value="analyze_metrics" />
            <el-option label="generate_config" value="generate_config" />
            <el-option label="apply_config" value="apply_config" />
          </el-select>
        </el-form-item>
        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="Temperature">
              <el-slider v-model="formData.temperature" :min="0" :max="1" :step="0.1" show-input />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="最大迭代">
              <el-input-number v-model="formData.maxIterations" :min="1" :max="20" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveSkill">{{ editingSkill ? '保存' : '创建' }}</el-button>
      </template>
    </el-dialog>

    <!-- Detail Dialog -->
    <el-dialog v-model="detailDialogVisible" title="Skill 详情" width="800px" destroy-on-close>
      <template v-if="selectedSkill">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="名称">{{ selectedSkill.name }}</el-descriptions-item>
          <el-descriptions-item label="类型">
            <el-tag :type="selectedSkill.isBuiltin ? 'success' : 'warning'" size="small">
              {{ selectedSkill.isBuiltin ? '内置' : '自定义' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="描述" :span="2">{{ selectedSkill.description }}</el-descriptions-item>
          <el-descriptions-item label="版本">{{ selectedSkill.version || '-' }}</el-descriptions-item>
          <el-descriptions-item label="作者">{{ selectedSkill.author || '-' }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="selectedSkill.enabled ? 'success' : 'danger'" size="small">
              {{ selectedSkill.enabled ? '启用' : '禁用' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="加载时间">{{ formatDateTime(selectedSkill.loadedAt) }}</el-descriptions-item>
          <el-descriptions-item label="标签" :span="2">
            <el-tag v-for="tag in selectedSkill.tags" :key="tag" size="small" class="tag-item">{{ tag }}</el-tag>
            <span v-if="!selectedSkill.tags?.length">-</span>
          </el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">Skill 内容</el-divider>
        <div class="content-box">
          <pre>{{ selectedSkill.content }}</pre>
        </div>

        <el-divider content-position="left">配置</el-divider>
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="允许工具">
            {{ selectedSkill.config?.allowedTools?.join(', ') || '*' }}
          </el-descriptions-item>
          <el-descriptions-item label="Temperature">
            {{ selectedSkill.config?.caps?.temperature ?? 0.7 }}
          </el-descriptions-item>
          <el-descriptions-item label="最大迭代">
            {{ selectedSkill.config?.caps?.maxIterations ?? 5 }}
          </el-descriptions-item>
          <el-descriptions-item label="需要引用">
            {{ selectedSkill.config?.requireCitations ? '是' : '否' }}
          </el-descriptions-item>
        </el-descriptions>
      </template>
      <template #footer>
        <el-button @click="detailDialogVisible = false">关闭</el-button>
        <el-button v-if="!selectedSkill?.isBuiltin" type="primary" @click="editSkill(selectedSkill!)">编辑</el-button>
      </template>
    </el-dialog>

    <!-- Import Dialog -->
    <el-dialog v-model="importDialogVisible" title="导入 Skill" width="600px" destroy-on-close>
      <el-form label-width="100px">
        <el-form-item label="导入方式">
          <el-radio-group v-model="importMode">
            <el-radio value="zip">ZIP 文件上传</el-radio>
            <el-radio value="json">JSON 数据</el-radio>
          </el-radio-group>
        </el-form-item>
        
        <el-form-item v-if="importMode === 'zip'" label="ZIP 文件">
          <el-upload
            :auto-upload="false"
            :limit="1"
            accept=".zip"
            :on-change="handleFileChange"
            :on-remove="handleFileRemove"
            drag
          >
            <el-icon class="el-icon--upload"><i-ep-upload /></el-icon>
            <div class="el-upload__text">
              拖拽 ZIP 文件到此处，或 <em>点击上传</em>
            </div>
            <template #tip>
              <div class="el-upload__tip">
                ZIP 文件应包含: SKILL.md (必需), config.json (可选), scripts/ 文件夹 (可选)
              </div>
            </template>
          </el-upload>
        </el-form-item>
        
        <el-form-item v-else label="JSON 数据">
          <el-input v-model="importData" type="textarea" :rows="10" placeholder="粘贴导出的 JSON 数据" />
        </el-form-item>
        
        <el-form-item label="覆盖已有">
          <el-switch v-model="importOverwrite" />
          <span class="form-tip">如果 Skill 已存在，是否覆盖</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="importDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="importing" @click="doImport">导入</el-button>
      </template>
    </el-dialog>

    <!-- Clone Dialog -->
    <el-dialog v-model="cloneDialogVisible" title="克隆 Skill" width="400px" destroy-on-close>
      <el-form label-width="100px">
        <el-form-item label="源 Skill">
          <el-input :model-value="cloneSource?.name" disabled />
        </el-form-item>
        <el-form-item label="新名称" required>
          <el-input v-model="cloneNewName" placeholder="输入新 Skill 名称" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cloneDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="cloning" @click="doClone">克隆</el-button>
      </template>
    </el-dialog>

    <!-- Template Dialog -->
    <el-dialog v-model="templateDialogVisible" title="从模板创建" width="500px" destroy-on-close>
      <el-form ref="templateFormRef" :model="templateFormData" :rules="templateFormRules" label-width="100px">
        <el-form-item label="模板">
          <el-input :model-value="selectedTemplate?.name" disabled />
        </el-form-item>
        <el-form-item label="名称" prop="name">
          <el-input v-model="templateFormData.name" placeholder="输入 Skill 名称" />
        </el-form-item>
        <el-form-item label="描述" prop="description">
          <el-input v-model="templateFormData.description" type="textarea" :rows="2" placeholder="输入描述" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="templateDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="creatingFromTemplate" @click="doCreateFromTemplate">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Plus, Upload, Refresh, Search } from '@element-plus/icons-vue'

import { ref, computed, onMounted, reactive } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import api from '@/api'
import { skillEnhancedApi } from '@/api/aiops-enhanced'

// Types
interface SkillSummary {
  name: string
  description: string
  version?: string
  author?: string
  tags?: string[]
  isBuiltin: boolean
  enabled: boolean
  loadedAt?: string
  modifiedAt?: string
}

interface SkillDetail extends SkillSummary {
  content: string
  config: {
    allowedTools?: string[]
    caps?: { temperature?: number; maxIterations?: number }
    requireCitations?: boolean
  }
  files?: string[]
}

interface SkillMetrics {
  skillName: string
  usageCount: number
  successRate: number
  avgResponseTime?: number
  feedbackScore?: number
  lastUsed?: string
}

interface SkillTemplate {
  id: string
  name: string
  description: string
  config: object
}

// State
const loading = ref(false)
const saving = ref(false)
const importing = ref(false)
const cloning = ref(false)
const creatingFromTemplate = ref(false)
const error = ref('')
const skills = ref<SkillSummary[]>([])
const metricsData = ref<SkillMetrics[]>([])
const templates = ref<SkillTemplate[]>([])
const activeTab = ref('list')

// Enhanced tabs data
const capsulesList = ref<Array<{ id: string; name: string; version: string; runtime: string; status: string; capabilities: string[] }>>([])
const mcpToolsList = ref<Array<{ name: string; description: string; server: string }>>([])
const execHistoryList = ref<Array<{ id: string; skillName: string; intent: string; result: string; duration: number; timestamp: number }>>([])
const apiKeysList = ref<Array<{ id: string; name: string; role: string; status: string; createdAt: string }>>([])
const showCreateApiKeyDialog = ref(false)
const newApiKeyName = ref('')
const newApiKeyRole = ref('viewer')
const creatingApiKey = ref(false)

const handleCreateApiKey = async () => {
  if (!newApiKeyName.value) { ElMessage.warning('请输入名称'); return }
  creatingApiKey.value = true
  try {
    await skillEnhancedApi.createApiKey({ name: newApiKeyName.value, role: newApiKeyRole.value })
    ElMessage.success('API Key 已创建')
    showCreateApiKeyDialog.value = false
    newApiKeyName.value = ''
    loadEnhancedData()
  } catch { ElMessage.error('创建失败') }
  finally { creatingApiKey.value = false }
}

const handleDeleteApiKey = async (id: string) => {
  try {
    await ElMessageBox.confirm('确定删除此 API Key？', '确认')
    await skillEnhancedApi.deleteApiKey(id)
    ElMessage.success('已删除')
    loadEnhancedData()
  } catch { /* cancelled or error */ }
}

const loadEnhancedData = async () => {
  try {
    const [capRes, mcpRes, histRes, keyRes] = await Promise.all([
      skillEnhancedApi.listCapsules(),
      skillEnhancedApi.listMcpTools(),
      skillEnhancedApi.getExecutionHistory(),
      skillEnhancedApi.listApiKeys(),
    ])
    if (capRes.data.success && capRes.data.data) capsulesList.value = capRes.data.data
    if (mcpRes.data.success && mcpRes.data.data) mcpToolsList.value = mcpRes.data.data
    if (histRes.data.success && histRes.data.data) execHistoryList.value = histRes.data.data
    if (keyRes.data.success && keyRes.data.data) apiKeysList.value = keyRes.data.data
  } catch { /* non-critical */ }
}

// Batch selection state
const selectedSkills = ref<string[]>([])

// Filters
const searchQuery = ref('')
const typeFilter = ref('')
const statusFilter = ref('')

// Dialogs
const createDialogVisible = ref(false)
const detailDialogVisible = ref(false)
const importDialogVisible = ref(false)
const cloneDialogVisible = ref(false)
const templateDialogVisible = ref(false)

// Form state
const formRef = ref<FormInstance>()
const editingSkill = ref<SkillDetail | null>(null)
const selectedSkill = ref<SkillDetail | null>(null)
const cloneSource = ref<SkillSummary | null>(null)
const cloneNewName = ref('')
const importData = ref('')
const importOverwrite = ref(false)
const importMode = ref<'zip' | 'json'>('zip')
const importFile = ref<File | null>(null)
const selectedTemplate = ref<SkillTemplate | null>(null)
const templateFormRef = ref<FormInstance>()

const formData = reactive({
  name: '',
  description: '',
  content: '',
  allowedTools: ['*'] as string[],
  temperature: 0.7,
  maxIterations: 5
})

const templateFormData = reactive({
  name: '',
  description: ''
})

const formRules: FormRules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  description: [{ required: true, message: '请输入描述', trigger: 'blur' }]
}

const templateFormRules: FormRules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  description: [{ required: true, message: '请输入描述', trigger: 'blur' }]
}

// Computed
const builtinCount = computed(() => skills.value.filter(s => s.isBuiltin).length)
const customCount = computed(() => skills.value.filter(s => !s.isBuiltin).length)
const disabledCount = computed(() => skills.value.filter(s => !s.enabled).length)

const filteredSkills = computed(() => {
  let result = skills.value
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    result = result.filter(s =>
      s.name.toLowerCase().includes(query) ||
      s.description.toLowerCase().includes(query) ||
      s.tags?.some(t => t.toLowerCase().includes(query))
    )
  }
  if (typeFilter.value === 'builtin') result = result.filter(s => s.isBuiltin)
  if (typeFilter.value === 'custom') result = result.filter(s => !s.isBuiltin)
  if (statusFilter.value === 'enabled') result = result.filter(s => s.enabled)
  if (statusFilter.value === 'disabled') result = result.filter(s => !s.enabled)
  return result
})

// Check if batch delete is allowed (only custom skills can be deleted)
const canBatchDelete = computed(() => {
  return selectedSkills.value.some(name => {
    const skill = skills.value.find(s => s.name === name)
    return skill && !skill.isBuiltin
  })
})

// Lifecycle
onMounted(() => {
  loadSkills()
  loadTemplates()
  loadMetrics()
  loadEnhancedData()
})

// API calls
const loadSkills = async () => {
  loading.value = true
  error.value = ''
  try {
    const response = await api.get('/skills')
    if (response.data.success) {
      skills.value = response.data.data
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败'
    ElMessage.error(error.value)
  } finally {
    loading.value = false
  }
}

const loadMetrics = async () => {
  try {
    const response = await api.get('/skills/metrics/all')
    if (response.data.success) {
      metricsData.value = Object.entries(response.data.data).map(([name, data]) => ({
        skillName: name,
        ...(data as object)
      })) as SkillMetrics[]
    }
  } catch (err) {
    console.error('Failed to load metrics:', err)
  }
}

const loadTemplates = async () => {
  try {
    const response = await api.get('/skills/templates/list')
    if (response.data.success) {
      templates.value = response.data.data
    }
  } catch (err) {
    console.error('Failed to load templates:', err)
  }
}

const toggleSkill = async (skill: SkillSummary) => {
  try {
    await api.put(`/skills/${skill.name}/toggle`, { enabled: skill.enabled })
    ElMessage.success(`Skill ${skill.enabled ? '启用' : '禁用'}成功`)
  } catch (err) {
    skill.enabled = !skill.enabled
    ElMessage.error('操作失败')
  }
}

const showSkillDetail = async (skill: SkillSummary) => {
  try {
    const response = await api.get(`/skills/${skill.name}`)
    if (response.data.success) {
      selectedSkill.value = { ...skill, ...response.data.data }
      detailDialogVisible.value = true
    }
  } catch (err) {
    ElMessage.error('获取详情失败')
  }
}

const showCreateDialog = () => {
  editingSkill.value = null
  formData.name = ''
  formData.description = ''
  formData.content = ''
  formData.allowedTools = ['*']
  formData.temperature = 0.7
  formData.maxIterations = 5
  createDialogVisible.value = true
}

const editSkill = (skill: SkillDetail) => {
  editingSkill.value = skill
  formData.name = skill.name
  formData.description = skill.description
  formData.content = skill.content
  formData.allowedTools = skill.config?.allowedTools || ['*']
  formData.temperature = skill.config?.caps?.temperature ?? 0.7
  formData.maxIterations = skill.config?.caps?.maxIterations ?? 5
  detailDialogVisible.value = false
  createDialogVisible.value = true
}

const saveSkill = async () => {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
  } catch { return }

  saving.value = true
  try {
    const payload = {
      name: formData.name,
      description: formData.description,
      content: formData.content,
      config: {
        allowedTools: formData.allowedTools,
        caps: { temperature: formData.temperature, maxIterations: formData.maxIterations }
      }
    }

    if (editingSkill.value) {
      await api.put(`/skills/${formData.name}`, payload)
      ElMessage.success('更新成功')
    } else {
      await api.post('/skills', payload)
      ElMessage.success('创建成功')
    }
    createDialogVisible.value = false
    loadSkills()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  } finally {
    saving.value = false
  }
}

const confirmDelete = async (skill: SkillSummary) => {
  try {
    await ElMessageBox.confirm(`确定要删除 Skill "${skill.name}" 吗？`, '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await api.delete(`/skills/${skill.name}`)
    ElMessage.success('删除成功')
    loadSkills()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

const cloneSkill = (skill: SkillSummary) => {
  cloneSource.value = skill
  cloneNewName.value = `${skill.name}-copy`
  cloneDialogVisible.value = true
}

const doClone = async () => {
  if (!cloneSource.value || !cloneNewName.value) return
  cloning.value = true
  try {
    await api.post(`/skills/${cloneSource.value.name}/clone`, { newName: cloneNewName.value })
    ElMessage.success('克隆成功')
    cloneDialogVisible.value = false
    loadSkills()
  } catch (err) {
    ElMessage.error('克隆失败')
  } finally {
    cloning.value = false
  }
}

const exportSkill = async (skill: SkillSummary) => {
  try {
    // 导出为 ZIP 格式
    const response = await api.get(`/skills/${skill.name}/export?format=zip`, {
      responseType: 'blob',
    })
    const blob = new Blob([response.data], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${skill.name}.skill.zip`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success('导出成功')
  } catch (err) {
    ElMessage.error('导出失败')
  }
}

const showImportDialog = () => {
  importData.value = ''
  importOverwrite.value = false
  importMode.value = 'zip'
  importFile.value = null
  importDialogVisible.value = true
}

const handleFileChange = (uploadFile: { raw?: File }) => {
  if (uploadFile.raw) {
    importFile.value = uploadFile.raw
  }
}

const handleFileRemove = () => {
  importFile.value = null
}

const doImport = async () => {
  importing.value = true
  try {
    if (importMode.value === 'zip') {
      // ZIP 文件上传
      if (!importFile.value) {
        ElMessage.warning('请选择 ZIP 文件')
        importing.value = false
        return
      }
      
      const formData = new FormData()
      formData.append('file', importFile.value)
      formData.append('overwrite', String(importOverwrite.value))
      
      await api.post('/skills/import', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      })
    } else {
      // JSON 数据导入
      if (!importData.value) {
        ElMessage.warning('请输入导入数据')
        importing.value = false
        return
      }
      
      const data = JSON.parse(importData.value)
      await api.post('/skills/import', { data, overwrite: importOverwrite.value })
    }
    
    ElMessage.success('导入成功')
    importDialogVisible.value = false
    loadSkills()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导入失败')
  } finally {
    importing.value = false
  }
}

const createFromTemplate = (template: SkillTemplate) => {
  selectedTemplate.value = template
  templateFormData.name = ''
  templateFormData.description = ''
  templateDialogVisible.value = true
}

const doCreateFromTemplate = async () => {
  if (!templateFormRef.value || !selectedTemplate.value) return
  try {
    await templateFormRef.value.validate()
  } catch { return }

  creatingFromTemplate.value = true
  try {
    await api.post('/skills/from-template', {
      templateId: selectedTemplate.value.id,
      name: templateFormData.name,
      description: templateFormData.description
    })
    ElMessage.success('创建成功')
    templateDialogVisible.value = false
    loadSkills()
  } catch (err) {
    ElMessage.error('创建失败')
  } finally {
    creatingFromTemplate.value = false
  }
}

// Utilities
const filterSkills = () => { /* computed handles filtering */ }

// Batch selection methods
const isSelected = (name: string): boolean => {
  return selectedSkills.value.includes(name)
}

const toggleSelection = (name: string, selected: boolean) => {
  if (selected) {
    if (!selectedSkills.value.includes(name)) {
      selectedSkills.value.push(name)
    }
  } else {
    const index = selectedSkills.value.indexOf(name)
    if (index > -1) {
      selectedSkills.value.splice(index, 1)
    }
  }
}

const clearSelection = () => {
  selectedSkills.value = []
}

const batchEnable = async () => {
  if (selectedSkills.value.length === 0) return
  
  try {
    const response = await api.post('/skills/batch/toggle', {
      names: selectedSkills.value,
      enabled: true
    })
    
    if (response.data.success) {
      const { summary } = response.data.data
      ElMessage.success(`批量启用完成: ${summary.success} 成功, ${summary.failed} 失败`)
      loadSkills()
      clearSelection()
    }
  } catch (err) {
    ElMessage.error('批量启用失败')
  }
}

const batchDisable = async () => {
  if (selectedSkills.value.length === 0) return
  
  try {
    await ElMessageBox.confirm(
      `确定要禁用选中的 ${selectedSkills.value.length} 个 Skill 吗？`,
      '批量禁用确认',
      {
        confirmButtonText: '禁用',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    const response = await api.post('/skills/batch/toggle', {
      names: selectedSkills.value,
      enabled: false
    })
    
    if (response.data.success) {
      const { summary } = response.data.data
      ElMessage.success(`批量禁用完成: ${summary.success} 成功, ${summary.failed} 失败`)
      loadSkills()
      clearSelection()
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('批量禁用失败')
    }
  }
}

const confirmBatchDelete = async () => {
  // 过滤出可删除的 Skill（仅自定义）
  const deletableSkills = selectedSkills.value.filter(name => {
    const skill = skills.value.find(s => s.name === name)
    return skill && !skill.isBuiltin
  })
  
  if (deletableSkills.length === 0) {
    ElMessage.warning('选中的 Skill 都是内置 Skill，无法删除')
    return
  }
  
  const builtinCount = selectedSkills.value.length - deletableSkills.length
  let message = `确定要删除选中的 ${deletableSkills.length} 个自定义 Skill 吗？此操作不可恢复！`
  if (builtinCount > 0) {
    message += `\n\n注意: ${builtinCount} 个内置 Skill 将被跳过。`
  }
  
  try {
    await ElMessageBox.confirm(message, '批量删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'error'
    })
    
    const response = await api.post('/skills/batch/delete', {
      names: deletableSkills
    })
    
    if (response.data.success) {
      const { summary } = response.data.data
      ElMessage.success(`批量删除完成: ${summary.success} 成功, ${summary.failed} 失败`)
      loadSkills()
      clearSelection()
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('批量删除失败')
    }
  }
}

const batchExport = async () => {
  if (selectedSkills.value.length === 0) return
  
  try {
    const response = await api.post('/skills/batch/export', {
      names: selectedSkills.value
    }, {
      responseType: 'blob'
    })
    
    const blob = new Blob([response.data], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `skills-export-${Date.now()}.zip`
    a.click()
    URL.revokeObjectURL(url)
    
    ElMessage.success(`已导出 ${selectedSkills.value.length} 个 Skill`)
  } catch (err) {
    ElMessage.error('批量导出失败')
  }
}

const formatDateTime = (timestamp?: string): string => {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString('zh-CN')
}

const getSuccessRateColor = (rate: number): string => {
  if (rate >= 0.8) return '#67c23a'
  if (rate >= 0.5) return '#e6a23c'
  return '#f56c6c'
}
</script>

<style scoped>
.skill-management-view {
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  background: var(--el-bg-color-page);
}

.header-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.stats-cards {
  margin-bottom: 20px;
}

.stat-card {
  margin-bottom: 16px;
}

.stat-content {
  display: flex;
  align-items: center;
  gap: 16px;
}

.stat-icon {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-color-white);
}

.stat-info .stat-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.stat-info .stat-label {
  font-size: 14px;
  color: var(--el-text-color-secondary);
}

.search-card {
  margin-bottom: 20px;
}

.search-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.main-card {
  min-height: 400px;
}

.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.skill-card {
  cursor: pointer;
  transition: all 0.3s;
}

.skill-card:hover {
  transform: translateY(-2px);
}

.skill-card.disabled {
  opacity: 0.6;
}

.skill-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.skill-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.skill-name {
  font-weight: 600;
  font-size: 16px;
}

.skill-description {
  color: var(--el-text-color-regular);
  font-size: 14px;
  margin-bottom: 8px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.skill-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}

.skill-meta span {
  margin-right: 12px;
}

.skill-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}

.more-tags {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.skill-actions {
  display: flex;
  gap: 4px;
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 8px;
  margin-top: 8px;
}

.templates-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 16px;
}

.template-card {
  cursor: pointer;
  text-align: center;
  padding: 20px;
}

.template-name {
  font-weight: 600;
  font-size: 16px;
  margin-bottom: 8px;
}

.template-description {
  color: var(--el-text-color-regular);
  font-size: 14px;
  margin-bottom: 16px;
}

.content-box {
  background: var(--el-fill-color-light);
  border-radius: 4px;
  padding: 16px;
  max-height: 300px;
  overflow-y: auto;
}

.content-box pre {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
}

.tag-item {
  margin-right: 4px;
  margin-bottom: 4px;
}

.score-cell {
  display: flex;
  align-items: center;
  gap: 4px;
}

.metrics-content {
  padding: 16px 0;
}

.form-tip {
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.el-upload__tip {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-top: 8px;
}

.batch-actions {
  margin-left: auto;
}

.batch-actions .el-button {
  margin-left: 8px;
}

.skill-card.selected {
  border: 2px solid var(--el-color-primary);
  box-shadow: 0 0 8px var(--el-color-primary-light-7);
}

.skill-title .el-checkbox {
  margin-right: 8px;
}
</style>