<template>
  <div class="register-container">
    <el-card class="register-card" shadow="hover">
      <template #header>
        <div class="card-header">
          <el-icon :size="28" color="#409eff"><i-ep-monitor /></el-icon>
          <h2>创建账号</h2>
          <p class="subtitle">注册 Opsevo 平台</p>
        </div>
      </template>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="0"
        size="large"
        @submit.prevent="handleRegister"
      >
        <el-form-item prop="username">
          <el-input
            v-model="form.username"
            placeholder="请输入用户名"
            :prefix-icon="User"
            clearable
          />
        </el-form-item>

        <el-form-item prop="email">
          <el-input
            v-model="form.email"
            placeholder="请输入邮箱"
            :prefix-icon="Message"
            clearable
          />
        </el-form-item>

        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            :prefix-icon="Lock"
            show-password
            clearable
          />
        </el-form-item>

        <el-form-item prop="confirmPassword">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            placeholder="请确认密码"
            :prefix-icon="Lock"
            show-password
            clearable
            @keyup.enter="handleRegister"
          />
        </el-form-item>

        <el-form-item prop="invitationCode">
          <el-input
            v-model="form.invitationCode"
            placeholder="请输入邀请码"
            :prefix-icon="Key"
            clearable
          />
        </el-form-item>

        <el-form-item>
          <el-button
            type="primary"
            :loading="authStore.loading"
            style="width: 100%"
            @click="handleRegister"
          >
            注 册
          </el-button>
        </el-form-item>
      </el-form>

      <div class="footer-links">
        <span>已有账号？</span>
        <router-link to="/login">返回登录</router-link>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { User, Message, Lock, Key } from '@element-plus/icons-vue'

import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()
const formRef = ref<FormInstance>()

const form = reactive({
  username: '',
  email: '',
  password: '',
  confirmPassword: '',
  invitationCode: '',
})

const validateConfirmPassword = (_rule: unknown, value: string, callback: (error?: Error) => void) => {
  if (value !== form.password) {
    callback(new Error('两次输入的密码不一致'))
  } else {
    callback()
  }
}

const rules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 32, message: '用户名长度为 3-32 个字符', trigger: 'blur' },
  ],
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '请输入有效的邮箱地址', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码长度不能少于 6 个字符', trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: '请确认密码', trigger: 'blur' },
    { validator: validateConfirmPassword, trigger: 'blur' },
  ],
  invitationCode: [
    { required: true, message: '请输入邀请码', trigger: 'blur' },
  ],
}

async function handleRegister() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  try {
    await authStore.register(form.username, form.email, form.password, form.invitationCode)
    ElMessage.success('注册成功，请登录')
    router.push('/login')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '注册失败')
  }
}
</script>

<style scoped>
.register-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: var(--el-bg-color);
  position: relative;
  overflow: hidden;
}

.register-container::before {
  content: '';
  position: absolute;
  width: 200%;
  height: 200%;
  background-image: radial-gradient(rgba(0, 242, 255, 0.05) 1px, transparent 1px);
  background-size: 40px 40px;
  transform: rotate(15deg);
  opacity: 0.5;
}

.register-card {
  width: 420px;
  background: var(--el-bg-color-overlay) !important;
  backdrop-filter: blur(12px);
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  box-shadow: var(--el-box-shadow);
  z-index: 1;
}

.card-header {
  text-align: center;
}

.card-header h2 {
  margin: 12px 0 6px;
  font-size: 28px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  letter-spacing: 2px;
  text-shadow: 0 0 10px rgba(64, 158, 255, 0.3);
}

.card-header .subtitle {
  margin: 0;
  font-size: 14px;
  color: var(--el-text-color-secondary);
  letter-spacing: 1px;
}

.footer-links {
  text-align: center;
  font-size: 14px;
  color: var(--el-text-color-secondary);
  margin-top: 20px;
}

.footer-links a {
  color: var(--el-color-primary);
  text-decoration: none;
  font-weight: 600;
  margin-left: 6px;
}

.footer-links a:hover {
  text-decoration: underline;
  text-shadow: 0 0 8px rgba(0, 242, 255, 0.4);
}
</style>
