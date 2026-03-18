/**
 * DeviceInfo 模块单元测试
 *
 * 验证设备类型、系统版本、API 协议说明和 Token 预算合规。
 *
 * @see Requirements 1.7 - REACT_LOOP_PROMPT 模块化重构
 */

import { deviceInfo } from './deviceInfo';
import { PromptComposer } from '../promptComposer';

describe('DeviceInfo module', () => {
  it('should have the correct module name', () => {
    expect(deviceInfo.name).toBe('DeviceInfo');
  });

  it('should have a token budget of 50', () => {
    expect(deviceInfo.tokenBudget).toBe(50);
  });

  it('should have no dependencies', () => {
    expect(deviceInfo.dependencies).toEqual([]);
  });

  it('should implement the PromptModule interface correctly', () => {
    expect(typeof deviceInfo.name).toBe('string');
    expect(typeof deviceInfo.tokenBudget).toBe('number');
    expect(Array.isArray(deviceInfo.dependencies)).toBe(true);
    expect(typeof deviceInfo.render).toBe('function');
  });

  it('should return a non-empty string from render()', () => {
    const content = deviceInfo.render();
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it('should include the device info header', () => {
    const content = deviceInfo.render();
    expect(content).toContain('设备信息');
  });

  it('should specify the device type as MikroTik RouterOS', () => {
    const content = deviceInfo.render();
    expect(content).toContain('MikroTik RouterOS');
  });

  it('should specify the system version as RouterOS 7.x', () => {
    const content = deviceInfo.render();
    expect(content).toContain('RouterOS 7.x');
  });

  it('should specify the API protocol as RouterOS API with path format', () => {
    const content = deviceInfo.render();
    expect(content).toContain('RouterOS API');
    expect(content).toContain('路径格式');
  });

  it('should clarify that CLI commands are not used', () => {
    const content = deviceInfo.render();
    expect(content).toContain('非 CLI 命令');
  });

  it('should render content within the 50 token budget', () => {
    const content = deviceInfo.render();
    const composer = new PromptComposer([]);
    const tokens = composer.estimateTokens(content);
    expect(tokens).toBeLessThanOrEqual(deviceInfo.tokenBudget);
  });
});
