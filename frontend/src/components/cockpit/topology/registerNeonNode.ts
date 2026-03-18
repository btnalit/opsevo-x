/**
 * registerNeonNode — 注册 G6 自定义节点类型 `neon-device`
 *
 * 基于 G6 v5 的 Image 节点扩展，使用 SVG 图标 + shadowBlur/shadowColor 实现发光效果。
 * - pending 状态：opacity 0.45，shadowBlur 0
 * - confirmed 状态：opacity 1.0，shadowBlur 8-12px
 *
 * Requirements: 2.3, 2.5, 2.6
 */

import { register, ExtensionCategory, Image } from '@antv/g6'
import type { ImageStyleProps } from '@antv/g6'
import type { DisplayObjectConfig } from '@antv/g'
import { NEON_DEVICE_ICONS, type DeviceType } from './neonDeviceIcons'

// ==================== SVG → data URI 缓存 ====================

const svgDataUriCache = new Map<DeviceType, string>()

/**
 * 将 SVG 字符串转换为 data URI，用于 G6 Image 节点的 src。
 * 结果会被缓存以避免重复编码。
 */
function getSvgDataUri(deviceType: DeviceType): string {
  const cached = svgDataUriCache.get(deviceType)
  if (cached) return cached

  const icon = NEON_DEVICE_ICONS[deviceType]
  if (!icon) {
    // 回退到 router 图标
    return getSvgDataUri('router')
  }

  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon.svg)}`
  svgDataUriCache.set(deviceType, encoded)
  return encoded
}

// ==================== 自定义节点样式接口 ====================

export interface NeonDeviceStyleProps extends ImageStyleProps {
  /** 设备类型，用于选择对应的 SVG 图标和发光颜色 */
  deviceType?: DeviceType
  /** 节点状态：pending 或 confirmed */
  nodeState?: 'pending' | 'confirmed' | string
}

// ==================== 自定义节点类 ====================

class NeonDeviceNode extends Image {
  static defaultStyleProps: Partial<NeonDeviceStyleProps> = {
    ...Image.defaultStyleProps,
    size: 40,
  }

  constructor(options: DisplayObjectConfig<NeonDeviceStyleProps>) {
    super(options)
  }

  /**
   * 重写 getKeyStyle 以根据 deviceType 设置 SVG 图标源，
   * 并根据 nodeState 应用 opacity 和 shadowBlur/shadowColor。
   */
  protected getKeyStyle(attributes: Required<NeonDeviceStyleProps>) {
    const baseStyle = super.getKeyStyle(attributes)

    const deviceType = (attributes.deviceType || 'router') as DeviceType
    const nodeState = attributes.nodeState || 'confirmed'
    const icon = NEON_DEVICE_ICONS[deviceType] || NEON_DEVICE_ICONS.router

    const isPending = nodeState === 'pending'

    return {
      ...baseStyle,
      src: getSvgDataUri(deviceType),
      opacity: isPending ? 0.45 : 1.0,
      shadowBlur: isPending ? 0 : 10,
      shadowColor: isPending ? 'transparent' : icon.glowColor,
    }
  }
}

// ==================== 注册函数 ====================

let registered = false

/**
 * 注册 `neon-device` 自定义节点类型到 G6。
 * 幂等调用——多次调用只注册一次。
 */
export function registerNeonNode(): void {
  if (registered) return
  register(ExtensionCategory.NODE, 'neon-device', NeonDeviceNode)
  registered = true
}
