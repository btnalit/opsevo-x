<template>
  <div class="about-view">
    <div class="about-card">
      <div class="logo-section">
        <div class="logo-box">
          <img src="/favicon.svg" alt="OPSEVO Logo" class="logo-img" />
        </div>
        <h1 class="system-name">OPSEVO</h1>
        <p class="version">Version 1.0.6</p>
      </div>

      <div class="info-section">
        <div class="info-item">
          <el-icon class="icon"><i-ep-user /></el-icon>
          <span class="label">联系方式 (微信):</span>
          <span class="value">zwk85003</span>
        </div>
        <div class="info-item">
          <el-icon class="icon"><i-ep-message /></el-icon>
          <span class="label">电子邮箱:</span>
          <span class="value">admin@btnalit.com</span>
        </div>
      </div>

      <div class="description-section">
        <p>
          OPSEVO 是一个通用智能运维管理平台（AIOps）。
          致力于通过 AI 技术提升运维效率，实现自动化监控、故障自愈和智能分析。
        </p>
      </div>
      
      <div class="copyright">
        &copy; {{ new Date().getFullYear() }} OPSEVO. All rights reserved.
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
</script>

<style scoped>
.about-view {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-bg-color-page);
  padding: 20px;
}

.about-card {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 16px;
  box-shadow: var(--el-box-shadow-light);
  padding: 60px 80px;
  width: 100%;
  max-width: 600px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  transition: transform 0.3s ease;
}

.about-card:hover {
  transform: translateY(-5px);
}

.logo-section {
  margin-bottom: 40px;
}

.logo-box {
  width: 120px;
  height: 120px;
  background: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 20px;
  box-shadow: var(--el-box-shadow-light);
}

.logo-img {
  width: 80px;
  height: 80px;
}

.system-name {
  font-size: 32px;
  font-weight: 700;
  color: var(--el-text-color-primary);
  margin: 0 0 10px;
  letter-spacing: 1px;
}

.version {
  font-size: 16px;
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color-page);
  border: 1px solid var(--el-border-color-lighter);
  padding: 4px 12px;
  border-radius: 12px;
  display: inline-block;
}

.info-section {
  width: 100%;
  margin-bottom: 40px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.info-item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 16px;
  color: var(--el-text-color-regular);
  padding: 12px 20px;
  border-radius: 12px;
  background: var(--el-fill-color-extra-light);
  border: 1px solid var(--el-border-color-lighter);
  transition: all 0.3s ease;
}

.info-item:hover {
  background: var(--el-fill-color-light);
  border-color: var(--el-border-color-light);
}

.icon {
  font-size: 20px;
  color: var(--el-color-primary);
}

.label {
  font-weight: 500;
}

.value {
  color: var(--el-text-color-primary);
  font-weight: 600;
}

.description-section {
  color: var(--el-text-color-regular);
  line-height: 1.6;
  font-size: 15px;
  max-width: 480px;
  margin-bottom: 40px;
}

.copyright {
  font-size: 14px;
  color: var(--el-text-color-secondary);
  margin-top: auto;
}

/* Responsive adjustments */
@media (max-width: 480px) {
  .about-card {
    padding: 40px 20px;
  }
  
  .logo-box {
    width: 100px;
    height: 100px;
  }
  
  .logo-img {
    width: 60px;
    height: 60px;
  }
  
  .system-name {
    font-size: 24px;
  }
}
</style>
