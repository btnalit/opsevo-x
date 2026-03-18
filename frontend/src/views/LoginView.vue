<template>
  <div class="login-container">
    <el-card class="login-card" shadow="hover">
      <template #header>
        <div class="card-header">
          <el-icon :size="28" color="#409eff"><i-ep-monitor /></el-icon>
          <h2>Opsevo</h2>
          <p class="subtitle">智能网络运维平台</p>
        </div>
      </template>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="0"
        size="large"
        @submit.prevent="handleLogin"
      >
        <el-form-item prop="username">
          <el-input
            v-model="form.username"
            placeholder="请输入用户名"
            :prefix-icon="User"
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
            @keyup.enter="handleLogin"
          />
        </el-form-item>

        <el-form-item>
          <el-button
            type="primary"
            :loading="authStore.loading"
            style="width: 100%"
            @click="handleLogin"
          >
            登 录
          </el-button>
        </el-form-item>
      </el-form>

      <div class="footer-links">
        <span>还没有账号？</span>
        <router-link to="/register">立即注册</router-link>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { User, Lock } from '@element-plus/icons-vue'

import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()
const formRef = ref<FormInstance>()

const form = reactive({
  username: '',
  password: '',
})

const rules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
  ],
}

async function handleLogin() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  try {
    await authStore.login(form.username, form.password)
    ElMessage.success('登录成功')
    router.push('/devices')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '登录失败')
  }
}
</script>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: var(--el-bg-color);
  position: relative;
  overflow: hidden;
}

.login-container::before {
  content: '';
  position: absolute;
  width: 200%;
  height: 200%;
  background-image: radial-gradient(rgba(0, 242, 255, 0.05) 1px, transparent 1px);
  background-size: 40px 40px;
  transform: rotate(15deg);
  opacity: 0.5;
}

.login-card {
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
