/**
 * EventBus 桥接模块导出
 *
 * 将现有服务（HealthMonitor、AlertEngine）桥接到 EventBus 事件驱动架构。
 */

export { HealthMonitorBridge, type HealthMonitorBridgeConfig } from './healthMonitorBridge';
export { AlertEngineBridge, type AlertEngineBridgeConfig } from './alertEngineBridge';
