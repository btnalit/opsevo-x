/**
 * neonDeviceIcons — Neon/Glow 风格网络设备图标集
 *
 * 单色线条 SVG + 发光颜色映射，适配深色主题赛博朋克视觉风格。
 * 每种图标使用等宽描边（1.5-2px）、圆角端点（stroke-linecap: round）、24x24 viewBox。
 * 发光效果通过 G6 节点样式的 shadowBlur / shadowColor 实现。
 *
 * Requirements: 2.1, 2.2, 2.4
 */

/** 设备类型字面量联合 */
export type DeviceType = 'router' | 'switch' | 'server' | 'firewall' | 'endpoint'

/** 单个设备图标配置 */
export interface NeonDeviceIcon {
  /** 完整 SVG 元素字符串 */
  svg: string
  /** 发光颜色（同时用作 SVG stroke 颜色） */
  glowColor: string
}

// ==================== SVG 构建辅助 ====================

function buildSvg(color: string, paths: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ` +
    `fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
    paths +
    `</svg>`
  )
}

// ==================== 图标 SVG 定义 ====================

/**
 * Router — 赛博立体六边形核心
 */
const routerSvg = (c: string) =>
  buildSvg(c, [
    // 外六边形框架
    '<polygon points="12,2 21,7.2 21,16.8 12,22 3,16.8 3,7.2" fill="rgba(0,0,0,0.4)" stroke-width="1.2" />',
    // 内六边形
    '<polygon points="12,5 18,8.5 18,15.5 12,19 6,15.5 6,8.5" stroke-dasharray="2 2" stroke-width="0.8" opacity="0.6" />',
    // 核心光核
    `<circle cx="12" cy="12" r="2.5" fill="${c}" opacity="0.8" />`,
    // 四向数据流
    '<line x1="12" y1="5" x2="12" y2="8" stroke-width="1.5" />',
    '<line x1="12" y1="16" x2="12" y2="19" stroke-width="1.5" />',
    '<line x1="5" y1="12" x2="8" y2="12" stroke-width="1.5" />',
    '<line x1="16" y1="12" x2="19" y2="12" stroke-width="1.5" />',
  ].join(''))

/**
 * Switch — 赛博机架矩阵
 */
const switchSvg = (c: string) =>
  buildSvg(c, [
    // 立体机箱外框
    '<rect x="2" y="5" width="20" height="14" rx="2" fill="rgba(0,0,0,0.4)" stroke-width="1.2" />',
    // 内部电路隔断
    '<line x1="2" y1="12" x2="22" y2="12" stroke-width="0.8" opacity="0.5" />',
    // 端口组（上）
    '<rect x="4" y="7" width="3" height="3" rx="0.5" stroke-width="1" />',
    '<rect x="8" y="7" width="3" height="3" rx="0.5" stroke-width="1" />',
    '<rect x="13" y="7" width="3" height="3" rx="0.5" stroke-width="1" />',
    '<rect x="17" y="7" width="3" height="3" rx="0.5" stroke-width="1" />',
    // 端口组（下） - 带有数据流点亮
    '<rect x="4" y="14" width="3" height="3" rx="0.5" stroke-width="1" />',
    `<circle cx="5.5" cy="15.5" r="1" fill="${c}" stroke="none" />`,
    '<rect x="8" y="14" width="3" height="3" rx="0.5" stroke-width="1" />',
    `<circle cx="9.5" cy="15.5" r="1" fill="${c}" stroke="none" opacity="0.3" />`,
    '<rect x="13" y="14" width="3" height="3" rx="0.5" stroke-width="1" />',
    `<circle cx="14.5" cy="15.5" r="1" fill="${c}" stroke="none" />`,
    '<rect x="17" y="14" width="3" height="3" rx="0.5" stroke-width="1" />',
  ].join(''))

/**
 * Server — 全息数据高塔
 */
const serverSvg = (c: string) =>
  buildSvg(c, [
    // 高塔外框
    '<rect x="5" y="2" width="14" height="20" rx="1.5" fill="rgba(0,0,0,0.5)" stroke-width="1.2" />',
    // 顶部数据处理阵列
    '<path d="M7 5 L17 5 M7 8 L17 8" stroke-width="1" stroke-dasharray="2 2" />',
    // 中部核心存储盘
    '<rect x="7" y="11" width="10" height="2" rx="0.5" stroke-width="1" />',
    '<rect x="7" y="14" width="10" height="2" rx="0.5" stroke-width="1" />',
    '<rect x="7" y="17" width="10" height="2" rx="0.5" stroke-width="1" />',
    // 侧边动态流光
    `<line x1="15" y1="11" x2="15" y2="18" stroke="${c}" stroke-width="1.5" stroke-linecap="round" />`,
  ].join(''))

/**
 * Firewall — 赛博能量护盾
 */
const firewallSvg = (c: string) =>
  buildSvg(c, [
    // 外层能量护盾
    '<path d="M12 2 L3 6 L3 11 C3 16.5 6.8 21.2 12 23 C17.2 21.2 21 16.5 21 11 L21 6 Z" fill="rgba(0,0,0,0.4)" stroke-width="1.2" />',
    // 内层实心盾牌
    '<path d="M12 5 L6 8 L6 11.5 C6 15.5 8.5 19 12 20 C15.5 19 18 15.5 18 11.5 L18 8 Z" stroke-dasharray="2 3" stroke-width="1" opacity="0.6" />',
    // 核心安全锁定/校验标识
    `<circle cx="12" cy="13" r="3" stroke="${c}" stroke-width="1.5" />`,
    `<path d="M12 10 L12 11 M12 15 L12 16" stroke="${c}" stroke-width="1.5" />`,
  ].join(''))

/**
 * Endpoint — 全息浮空微端
 */
const endpointSvg = (c: string) =>
  buildSvg(c, [
    // 全息投影底座
    '<path d="M6 19 L18 19 L15 22 L9 22 Z" fill="rgba(0,0,0,0.6)" stroke-width="1" />',
    // 向上的全息光束
    `<path d="M8 19 L2 4 M16 19 L22 4" stroke="${c}" stroke-width="0.6" opacity="0.3" stroke-dasharray="2 2" />`,
    // 悬浮显示屏
    '<rect x="3" y="3" width="18" height="11" rx="1" fill="rgba(0,0,0,0.5)" stroke-width="1.2" />',
    // 屏幕内数据波纹
    `<path d="M5 8 C7 6 9 10 11 8 C13 6 15 10 17 8" stroke="${c}" stroke-width="1" opacity="0.8" />`,
    `<line x1="5" y1="11" x2="9" y2="11" stroke="${c}" stroke-width="1" />`,
  ].join(''))

// ==================== 导出图标集 ====================

/**
 * 设备类型 → SVG 内容 + 发光颜色 映射表。
 *
 * 发光颜色规范：
 * - router:   #00f0ff（青色）
 * - switch:   #ad00ff（紫色）
 * - server:   #ff003c（红色）
 * - firewall: #f5d400（黄色）
 * - endpoint: #ffffff（白色）
 */
export const NEON_DEVICE_ICONS: Record<DeviceType, NeonDeviceIcon> = {
  router: {
    svg: routerSvg('#00f0ff'),
    glowColor: '#00f0ff',
  },
  switch: {
    svg: switchSvg('#ad00ff'),
    glowColor: '#ad00ff',
  },
  server: {
    svg: serverSvg('#ff003c'),
    glowColor: '#ff003c',
  },
  firewall: {
    svg: firewallSvg('#f5d400'),
    glowColor: '#f5d400',
  },
  endpoint: {
    svg: endpointSvg('#ffffff'),
    glowColor: '#ffffff',
  },
}

/** 所有支持的设备类型列表 */
export const DEVICE_TYPES: DeviceType[] = ['router', 'switch', 'server', 'firewall', 'endpoint']
