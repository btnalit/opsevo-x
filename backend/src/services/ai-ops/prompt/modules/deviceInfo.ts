/**
 * DeviceInfo 模块 - 设备基础信息
 *
 * 定义设备类型、系统版本和 API 协议说明，
 * 为 LLM 提供目标设备的基础上下文信息。
 *
 * @see Requirements 1.7 - REACT_LOOP_PROMPT 模块化重构
 */

import { PromptModule } from '../types';

export const deviceInfo: PromptModule = {
  name: 'DeviceInfo',
  tokenBudget: 50,
  dependencies: [],
  render(): string {
    return `## 设备信息
- 设备类型: MikroTik RouterOS
- 系统版本: RouterOS 7.x
- API 协议: RouterOS API（路径格式，非 CLI 命令）`;
  },
};
