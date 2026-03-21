<template>
  <div class="file-uploader">
    <!-- 拖拽上传区域 -->
    <div
      class="upload-area"
      :class="{ 'is-dragover': isDragover, 'is-uploading': uploading }"
      @dragover.prevent="handleDragover"
      @dragleave.prevent="handleDragleave"
      @drop.prevent="handleDrop"
      @click="triggerFileInput"
    >
      <input
        ref="fileInputRef"
        type="file"
        :accept="acceptedTypes"
        :multiple="multiple"
        class="file-input"
        @change="handleFileSelect"
      />

      <div v-if="uploading" class="upload-progress">
        <el-icon class="uploading-icon" :size="48"><i-ep-loading /></el-icon>
        <div class="progress-text">{{ progressMessage }}</div>
        <el-progress
          :percentage="uploadProgress"
          :stroke-width="8"
          :show-text="false"
          style="width: 80%; margin-top: 12px"
        />
      </div>

      <div v-else class="upload-content">
        <el-icon class="upload-icon" :size="48"><i-ep-upload-filled /></el-icon>
        <div class="upload-text">
          <span class="main-text">将文件拖拽到此处，或 <em>点击上传</em></span>
          <span class="sub-text">支持 {{ supportedTypesText }}</span>
        </div>
      </div>
    </div>

    <!-- 文件大小限制提示 -->
    <div class="upload-tips">
      <el-icon><i-ep-info-filled /></el-icon>
      <span>单个文件最大 {{ maxFileSizeText }}，最多同时上传 {{ maxFiles }} 个文件</span>
    </div>

    <!-- 已选择的文件列表 -->
    <div v-if="selectedFiles.length > 0 && !uploading" class="selected-files">
      <div class="files-header">
        <span>已选择 {{ selectedFiles.length }} 个文件</span>
        <el-button type="danger" text size="small" @click="clearFiles">
          清空
        </el-button>
      </div>
      <el-scrollbar max-height="200px">
        <div
          v-for="(file, index) in selectedFiles"
          :key="index"
          class="file-item"
          :class="{ 'is-invalid': !file.valid }"
        >
          <div class="file-info">
            <el-icon class="file-icon">
              <Document v-if="file.valid" />
              <WarningFilled v-else />
            </el-icon>
            <div class="file-details">
              <span class="file-name">{{ file.name }}</span>
              <span class="file-size">{{ formatFileSize(file.size) }}</span>
            </div>
          </div>
          <div class="file-actions">
            <el-tag v-if="file.valid" type="success" size="small">有效</el-tag>
            <el-tooltip v-else :content="file.error" placement="top">
              <el-tag type="danger" size="small">无效</el-tag>
            </el-tooltip>
            <el-button
              type="danger"
              :icon="Delete"
              circle
              size="small"
              @click="removeFile(index)"
            />
          </div>
        </div>
      </el-scrollbar>
    </div>

    <!-- 上传按钮 -->
    <div v-if="selectedFiles.length > 0 && !uploading" class="upload-actions">
      <el-button @click="clearFiles">取消</el-button>
      <el-button
        type="primary"
        :disabled="validFilesCount === 0"
        @click="startUpload"
      >
        上传 {{ validFilesCount }} 个文件
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Delete } from '@element-plus/icons-vue'

import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { fileUploadApi, type FileTypeInfo, type ProcessedFileResult } from '@/api/rag'

// Props
interface Props {
  multiple?: boolean
  maxFiles?: number
  autoUpload?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  multiple: true,
  maxFiles: 10,
  autoUpload: false
})

// Emits
const emit = defineEmits<{
  (e: 'success', results: ProcessedFileResult[]): void
  (e: 'error', error: string): void
  (e: 'progress', progress: number, message: string): void
  (e: 'preview', results: ProcessedFileResult[]): void
}>()

// State
const fileInputRef = ref<HTMLInputElement | null>(null)
const isDragover = ref(false)
const uploading = ref(false)
const uploadProgress = ref(0)
const progressMessage = ref('')
const supportedTypes = ref<FileTypeInfo[]>([])

interface SelectedFile {
  file: File
  name: string
  size: number
  valid: boolean
  error?: string
}

const selectedFiles = ref<SelectedFile[]>([])

// Computed
const acceptedTypes = computed(() => {
  return supportedTypes.value.map(t => t.extension).join(',')
})

const supportedTypesText = computed(() => {
  return supportedTypes.value.map(t => t.extension).join('、')
})

const maxFileSizeText = computed(() => {
  const maxSize = Math.max(...supportedTypes.value.map(t => t.maxSize), 10 * 1024 * 1024)
  return formatFileSize(maxSize)
})

const validFilesCount = computed(() => {
  return selectedFiles.value.filter(f => f.valid).length
})

// Methods
const loadSupportedTypes = async () => {
  try {
    const response = await fileUploadApi.getSupportedTypes()
    if (response.data.success && response.data.data) {
      supportedTypes.value = response.data.data
    }
  } catch (error) {
    console.error('Failed to load supported types:', error)
    // 使用默认值
    supportedTypes.value = [
      { extension: '.md', mimeTypes: ['text/markdown'], description: 'Markdown 文档', maxSize: 10 * 1024 * 1024 },
      { extension: '.txt', mimeTypes: ['text/plain'], description: '纯文本文件', maxSize: 5 * 1024 * 1024 },
      { extension: '.rsc', mimeTypes: ['text/plain'], description: '设备配置脚本 (.rsc)', maxSize: 5 * 1024 * 1024 },
      { extension: '.json', mimeTypes: ['application/json'], description: 'JSON 文件', maxSize: 10 * 1024 * 1024 }
    ]
  }
}

const triggerFileInput = () => {
  if (!uploading.value) {
    fileInputRef.value?.click()
  }
}

const handleDragover = (_e: DragEvent) => {
  if (!uploading.value) {
    isDragover.value = true
  }
}

const handleDragleave = () => {
  isDragover.value = false
}

const handleDrop = (e: DragEvent) => {
  isDragover.value = false
  if (uploading.value) return

  const files = e.dataTransfer?.files
  if (files) {
    processFiles(Array.from(files))
  }
}

const handleFileSelect = (e: Event) => {
  const input = e.target as HTMLInputElement
  if (input.files) {
    processFiles(Array.from(input.files))
    input.value = '' // 清空 input，允许重复选择同一文件
  }
}

const processFiles = (files: File[]) => {
  const newFiles: SelectedFile[] = []

  for (const file of files) {
    // 检查是否超过最大文件数
    if (selectedFiles.value.length + newFiles.length >= props.maxFiles) {
      ElMessage.warning(`最多只能上传 ${props.maxFiles} 个文件`)
      break
    }

    // 检查是否已存在
    const exists = selectedFiles.value.some(f => f.name === file.name && f.size === file.size)
    if (exists) {
      continue
    }

    // 验证文件
    const validation = validateFile(file)
    newFiles.push({
      file,
      name: file.name,
      size: file.size,
      valid: validation.valid,
      error: validation.error
    })
  }

  selectedFiles.value.push(...newFiles)

  // 如果设置了自动上传且有有效文件
  if (props.autoUpload && newFiles.some(f => f.valid)) {
    startUpload()
  }
}

const validateFile = (file: File): { valid: boolean; error?: string } => {
  const ext = getExtension(file.name)

  // 检查文件类型
  const typeInfo = supportedTypes.value.find(t => t.extension === ext)
  if (!typeInfo) {
    return {
      valid: false,
      error: `不支持的文件类型: ${ext}`
    }
  }

  // 检查文件大小
  if (file.size > typeInfo.maxSize) {
    return {
      valid: false,
      error: `文件大小超过限制: ${formatFileSize(file.size)} > ${formatFileSize(typeInfo.maxSize)}`
    }
  }

  // 检查文件是否为空
  if (file.size === 0) {
    return {
      valid: false,
      error: '文件内容为空'
    }
  }

  return { valid: true }
}

const getExtension = (filename: string): string => {
  const lastDot = filename.lastIndexOf('.')
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : ''
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const removeFile = (index: number) => {
  selectedFiles.value.splice(index, 1)
}

const clearFiles = () => {
  selectedFiles.value = []
}

const startUpload = async () => {
  const validFiles = selectedFiles.value.filter(f => f.valid)
  if (validFiles.length === 0) {
    ElMessage.warning('没有有效的文件可上传')
    return
  }

  uploading.value = true
  uploadProgress.value = 0
  progressMessage.value = '准备上传...'

  try {
    const files = validFiles.map(f => f.file)
    const results: ProcessedFileResult[] = []

    if (files.length === 1) {
      // 单文件上传
      progressMessage.value = `正在上传 ${files[0].name}...`
      uploadProgress.value = 30

      const response = await fileUploadApi.uploadFile(files[0])
      uploadProgress.value = 100

      if (response.data.success && response.data.data) {
        results.push(response.data.data)
        progressMessage.value = '上传成功！'
        ElMessage.success(`成功创建 ${response.data.data.entries.length} 个知识条目`)
      } else {
        throw new Error(response.data.error || '上传失败')
      }
    } else {
      // 批量上传
      progressMessage.value = `正在上传 ${files.length} 个文件...`

      const response = await fileUploadApi.uploadFiles(files)
      uploadProgress.value = 100

      if (response.data.success && response.data.data) {
        results.push(...response.data.data)
        const summary = response.data.summary
        progressMessage.value = `上传完成: ${summary?.success || 0} 成功, ${summary?.failed || 0} 失败`

        if (summary?.success && summary.success > 0) {
          ElMessage.success(`成功处理 ${summary.success} 个文件，创建 ${summary.entriesCreated || 0} 个知识条目`)
        }
        if (summary?.failed && summary.failed > 0) {
          ElMessage.warning(`${summary.failed} 个文件处理失败`)
        }
      } else {
        throw new Error(response.data.error || '批量上传失败')
      }
    }

    // 清空已选文件
    selectedFiles.value = []

    // 触发预览事件（如果有结果）
    if (results.length > 0) {
      emit('preview', results)
    }

    // 触发成功事件
    emit('success', results)
  } catch (error) {
    const message = error instanceof Error ? error.message : '上传失败'
    progressMessage.value = message
    ElMessage.error(message)
    emit('error', message)
  } finally {
    setTimeout(() => {
      uploading.value = false
      uploadProgress.value = 0
      progressMessage.value = ''
    }, 1500)
  }
}

// Lifecycle
onMounted(() => {
  loadSupportedTypes()
})
</script>


<style scoped>
.file-uploader {
  width: 100%;
}

/* 上传区域 */
.upload-area {
  border: 2px dashed #dcdfe6;
  border-radius: 8px;
  padding: 40px 20px;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s;
  background: #fafafa;
}

.upload-area:hover {
  border-color: #409eff;
  background: #f5f7fa;
}

.upload-area.is-dragover {
  border-color: #409eff;
  background: #ecf5ff;
}

.upload-area.is-uploading {
  cursor: default;
  border-color: #409eff;
  background: #f5f7fa;
}

.file-input {
  display: none;
}

/* 上传内容 */
.upload-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.upload-icon {
  color: #c0c4cc;
}

.upload-area:hover .upload-icon {
  color: #409eff;
}

.upload-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.main-text {
  font-size: 14px;
  color: #606266;
}

.main-text em {
  color: #409eff;
  font-style: normal;
}

.sub-text {
  font-size: 12px;
  color: #909399;
}

/* 上传进度 */
.upload-progress {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.uploading-icon {
  color: #409eff;
  animation: rotate 1s linear infinite;
}

@keyframes rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.progress-text {
  font-size: 14px;
  color: #606266;
}

/* 提示信息 */
.upload-tips {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  font-size: 12px;
  color: #909399;
}

/* 已选文件列表 */
.selected-files {
  margin-top: 16px;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  overflow: hidden;
}

.files-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #f5f7fa;
  border-bottom: 1px solid #ebeef5;
  font-size: 14px;
  color: #606266;
}

.file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #ebeef5;
  transition: background 0.2s;
}

.file-item:last-child {
  border-bottom: none;
}

.file-item:hover {
  background: #f5f7fa;
}

.file-item.is-invalid {
  background: #fef0f0;
}

.file-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.file-icon {
  font-size: 20px;
  color: #409eff;
}

.file-item.is-invalid .file-icon {
  color: #f56c6c;
}

.file-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.file-name {
  font-size: 14px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  font-size: 12px;
  color: #909399;
}

.file-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 上传按钮 */
.upload-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 16px;
}
</style>
