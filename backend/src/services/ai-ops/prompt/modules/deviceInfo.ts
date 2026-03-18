/**
 * DeviceInfo 模块 - 设备基础信息
 *
 * 定义设备类型、系统版本和 API 协议说明，
 * 为 LLM 提供目标设备的基础上下文信息。
 * 支持从 RenderContext 动态获取设备信息。
 */

import { PromptModule } from '../types';

export const deviceInfo: PromptModule = {
  name: 'DeviceInfo',
  tokenBudget: 50,
  dependencies: [],
  render(context?: Record<string, unknown>): string {
    const deviceType = context?.deviceType as string || '通用设备';
    const deviceVersion = context?.deviceVersion as string || '';
    const apiProtocol = context?.apiProtocol as string || '设备 API';

    const lines = ['## 设备信息'];
    lines.push(`- 设备类型: ${deviceType}`);
    if (deviceVersion) {
      lines.push(`- 系统版本: ${deviceVersion}`);
    }
    lines.push(`- API 协议: ${apiProtocol}`);
    return lines.join('\n');
  },
};
