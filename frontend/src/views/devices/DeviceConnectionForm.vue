<template>
  <el-form ref="formRef" :model="form" :rules="rules" label-width="100px" style="max-width: 480px">
    <el-form-item label="设备名称" prop="name">
      <el-input v-model="form.name" placeholder="请输入设备名称" />
    </el-form-item>
    <el-form-item label="驱动类型" prop="driverType">
      <el-select v-model="form.driverType" placeholder="选择驱动类型" style="width: 100%">
        <el-option label="API" value="api" />
        <el-option label="SSH" value="ssh" />
        <el-option label="SNMP" value="snmp" />
      </el-select>
    </el-form-item>
    <el-form-item label="主机地址" prop="host">
      <el-input v-model="form.host" placeholder="IP 地址或域名" />
    </el-form-item>
    <el-form-item label="端口" prop="port">
      <el-input-number v-model="form.port" :min="1" :max="65535" style="width: 100%" />
    </el-form-item>

    <!-- API 驱动字段 -->
    <template v-if="form.driverType === 'api'">
      <el-form-item label="用户名" prop="username">
        <el-input v-model="form.username" placeholder="请输入用户名" />
      </el-form-item>
      <el-form-item label="密码" prop="password">
        <el-input v-model="form.password" type="password" show-password placeholder="请输入密码" />
      </el-form-item>
      <el-form-item label="使用 TLS">
        <el-switch v-model="form.useTLS" />
      </el-form-item>
      <el-form-item label="Profile ID">
        <el-input v-model="form.profileId" placeholder="可选，API Profile ID" />
      </el-form-item>
    </template>

    <!-- SSH 驱动字段 -->
    <template v-if="form.driverType === 'ssh'">
      <el-form-item label="用户名" prop="username">
        <el-input v-model="form.username" placeholder="请输入用户名" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input v-model="form.password" type="password" show-password placeholder="密码（或使用密钥）" />
      </el-form-item>
      <el-form-item label="私钥">
        <el-input v-model="form.privateKey" type="textarea" :rows="3" placeholder="SSH 私钥内容（可选）" />
      </el-form-item>
    </template>

    <!-- SNMP 驱动字段 -->
    <template v-if="form.driverType === 'snmp'">
      <el-form-item label="SNMP 版本">
        <el-select v-model="form.snmpVersion" style="width: 100%">
          <el-option label="v2c" value="v2c" />
          <el-option label="v3" value="v3" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="form.snmpVersion === 'v2c'" label="Community">
        <el-input v-model="form.community" placeholder="Community String" />
      </el-form-item>
      <template v-if="form.snmpVersion === 'v3'">
        <el-form-item label="安全名称">
          <el-input v-model="form.securityName" placeholder="Security Name" />
        </el-form-item>
        <el-form-item label="认证协议">
          <el-select v-model="form.authProtocol" style="width: 100%">
            <el-option label="MD5" value="MD5" />
            <el-option label="SHA" value="SHA" />
          </el-select>
        </el-form-item>
        <el-form-item label="加密协议">
          <el-select v-model="form.privProtocol" style="width: 100%">
            <el-option label="DES" value="DES" />
            <el-option label="AES" value="AES" />
          </el-select>
        </el-form-item>
      </template>
    </template>

    <el-form-item label="标签">
      <el-input v-model="form.tagsInput" placeholder="多个标签用逗号分隔" />
    </el-form-item>
    <el-form-item label="分组">
      <el-input v-model="form.groupName" placeholder="分组名称（可选）" />
    </el-form-item>

    <el-form-item>
      <el-button type="success" :loading="testing" @click="handleTestConnection">测试连接</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      <el-button @click="emit('cancel')">取消</el-button>
    </el-form-item>
  </el-form>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { deviceApi, type CreateDeviceRequest } from '@/api/device'

defineOptions({ name: 'DeviceConnectionForm' })

const props = defineProps<{ initialData?: Partial<CreateDeviceRequest & { id?: string }> }>()
const emit = defineEmits<{ submit: [data: CreateDeviceRequest]; cancel: [] }>()

const formRef = ref<FormInstance>()
const submitting = ref(false)
const testing = ref(false)

const form = reactive({
  name: '',
  host: '',
  port: 8728,
  username: '',
  password: '',
  useTLS: false,
  driverType: 'api' as 'api' | 'ssh' | 'snmp',
  profileId: '',
  privateKey: '',
  snmpVersion: 'v2c' as 'v2c' | 'v3',
  community: 'public',
  securityName: '',
  authProtocol: 'SHA',
  privProtocol: 'AES',
  tagsInput: '',
  groupName: '',
})

watch(() => props.initialData, (val) => {
  if (val) Object.assign(form, val)
}, { immediate: true })

watch(() => form.driverType, (t) => {
  if (t === 'api') form.port = 8728
  else if (t === 'ssh') form.port = 22
  else if (t === 'snmp') form.port = 161
})

const rules: FormRules = {
  name: [{ required: true, message: '请输入设备名称', trigger: 'blur' }],
  host: [{ required: true, message: '请输入主机地址', trigger: 'blur' }],
  port: [{ required: true, message: '请输入端口号', trigger: 'blur' }],
  driverType: [{ required: true, message: '请选择驱动类型', trigger: 'change' }],
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

async function handleTestConnection() {
  if (!props.initialData?.id) {
    ElMessage.info('请先保存设备后再测试连接')
    return
  }
  testing.value = true
  try {
    const res = await deviceApi.testConnection(props.initialData.id)
    if (res.data.success) ElMessage.success(`连接成功，延迟 ${res.data.data?.latency ?? '-'}ms`)
    else ElMessage.error(res.data.error || '连接测试失败')
  } catch (e: unknown) {
    ElMessage.error(e instanceof Error ? e.message : '连接测试失败')
  } finally { testing.value = false }
}

async function handleSubmit() {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const tags = form.tagsInput ? form.tagsInput.split(',').map(t => t.trim()).filter(Boolean) : undefined
    emit('submit', {
      name: form.name,
      host: form.host,
      port: form.port,
      username: form.username,
      password: form.password,
      useTLS: form.useTLS,
      driverType: form.driverType,
      profileId: form.profileId || undefined,
      tags,
      groupName: form.groupName || undefined,
    })
  } finally { submitting.value = false }
}
</script>
