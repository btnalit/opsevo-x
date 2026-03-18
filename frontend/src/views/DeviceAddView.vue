<template>
  <div class="device-add-view">
    <el-card class="header-card">
      <template #header>
        <div class="card-header">
          <div class="header-left">
            <span>添加设备</span>
          </div>
        </div>
      </template>
    </el-card>

    <el-card shadow="hover">

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="100px"
        style="max-width: 500px"
      >
        <el-form-item label="设备名称" prop="name">
          <el-input v-model="form.name" placeholder="请输入设备名称" />
        </el-form-item>

        <el-form-item label="主机地址" prop="host">
          <el-input v-model="form.host" placeholder="请输入 IP 地址或域名" />
        </el-form-item>

        <el-form-item label="端口" prop="port">
          <el-input-number v-model="form.port" :min="1" :max="65535" style="width: 100%" />
        </el-form-item>

        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" placeholder="请输入用户名" />
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            show-password
          />
        </el-form-item>

        <el-form-item label="使用 TLS">
          <el-switch v-model="form.useTLS" />
        </el-form-item>

        <el-form-item label="标签">
          <el-input
            v-model="form.tagsInput"
            placeholder="多个标签用逗号分隔，如：核心,机房A"
          />
        </el-form-item>

        <el-form-item label="分组">
          <el-input v-model="form.groupName" placeholder="请输入分组名称（可选）" />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="handleSubmit">
            保存
          </el-button>
          <el-button @click="handleCancel">
            取消
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { useDeviceStore } from '@/stores/device'

defineOptions({ name: 'DeviceAddView' })

const router = useRouter()
const deviceStore = useDeviceStore()

const formRef = ref<FormInstance>()
const submitting = ref(false)

const form = reactive({
  name: '',
  host: '',
  port: 8728,
  username: '',
  password: '',
  useTLS: false,
  tagsInput: '',
  groupName: '',
})

const rules: FormRules = {
  name: [
    { required: true, message: '请输入设备名称', trigger: 'blur' },
  ],
  host: [
    { required: true, message: '请输入主机地址', trigger: 'blur' },
  ],
  port: [
    { required: true, message: '请输入端口号', trigger: 'blur' },
  ],
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
  ],
}

async function handleSubmit() {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  try {
    const tags = form.tagsInput
      ? form.tagsInput.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined

    await deviceStore.addDevice({
      name: form.name,
      host: form.host,
      port: form.port,
      username: form.username,
      password: form.password,
      useTLS: form.useTLS,
      tags,
      groupName: form.groupName || undefined,
    })

    ElMessage.success('设备添加成功')
    router.push('/devices')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '添加设备失败'
    ElMessage.error(message)
  } finally {
    submitting.value = false
  }
}

function handleCancel() {
  router.push('/devices')
}
</script>

<style scoped>
.device-add-view {
  height: 100%;
  padding: 20px;
  background: var(--el-bg-color-page);
  overflow-y: auto;
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
</style>
